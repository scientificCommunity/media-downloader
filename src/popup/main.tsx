import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { formatLocalizedNumber, initDocumentLocale, t } from '../shared/i18n';
import type { MediaCandidate, MediaKind } from '../shared/media';
import './popup.css';

interface BackgroundResponse {
  candidates?: MediaCandidate[];
}

interface DomMediaCandidate {
  id: string;
  url: string;
  kind: MediaKind;
  source: 'dom';
  pageUrl: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

function scanDomMedia(): DomMediaCandidate[] {
  const classify = (url: string): MediaKind => {
    const lowerUrl = url.toLowerCase().split('#', 1)[0];
    if (lowerUrl.includes('.m3u8')) return 'hls';
    if (lowerUrl.includes('.mpd')) return 'dash';
    if (/\.(m4s|cmfv|cmfa|ts)(\?|$)/i.test(lowerUrl)) return 'segment';
    if (/\.(mp4|webm|mov|m4v|mp3|m4a|aac|ogg)(\?|$)/i.test(lowerUrl)) return 'direct';
    return 'unknown';
  };

  const urls = new Set<string>();
  document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
    if (media.currentSrc) urls.add(media.currentSrc);
    if (media.src) urls.add(media.src);
    media.querySelectorAll<HTMLSourceElement>('source[src]').forEach((source) => {
      if (source.src) urls.add(source.src);
    });
  });

  const now = Date.now();
  const results: DomMediaCandidate[] = [];

  urls.forEach((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const kind = classify(url);
    if (kind === 'unknown') return;

    results.push({
      id: `dom:${kind}:${url}`,
      url,
      kind,
      source: 'dom',
      pageUrl: location.href,
      firstSeenAt: now,
      lastSeenAt: now
    });
  });

  return results;
}

function uniqueCandidates(items: MediaCandidate[]): MediaCandidate[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.trackKind ?? 'unknown'}:${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatBytes(value?: number): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${formatLocalizedNumber(value)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const displaySize = size >= 10 ? Math.round(size) : Number(size.toFixed(1));
  return `${formatLocalizedNumber(displaySize)} ${units[unitIndex]}`;
}

function mediaLabel(candidate: MediaCandidate): string {
  if (candidate.kind !== 'segment') return candidate.kind.toUpperCase();
  if (candidate.trackKind === 'video') return t('videoTrack');
  if (candidate.trackKind === 'audio') return t('audioTrack');
  return t('mediaTrack');
}

function metadata(candidate: MediaCandidate): string[] {
  const values: string[] = [];
  if (candidate.contentType) values.push(candidate.contentType);
  const size = formatBytes(candidate.contentLength);
  if (size) values.push(size);
  if (candidate.statusCode === 206 || candidate.contentRange) values.push(t('rangeStream'));
  if ((candidate.requestCount ?? 1) > 1) {
    values.push(t('requestsCount', formatLocalizedNumber(candidate.requestCount ?? 1)));
  }
  return values;
}

function candidatePriority(candidate: MediaCandidate): number {
  if (candidate.kind === 'dash' || candidate.kind === 'hls') return 0;
  if (candidate.kind === 'segment' && candidate.trackKind === 'video') return 1;
  if (candidate.kind === 'segment' && candidate.trackKind === 'audio') return 2;
  if (candidate.kind === 'segment') return 3;
  return 4;
}

function App() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [candidates, setCandidates] = useState<MediaCandidate[]>([]);
  const [status, setStatus] = useState(t('scanningPage'));

  const streamStats = useMemo(() => {
    const tracks = candidates.filter((candidate) => candidate.kind === 'segment' || Boolean(candidate.contentRange));
    return {
      total: tracks.length,
      video: tracks.filter((candidate) => candidate.trackKind === 'video').length,
      audio: tracks.filter((candidate) => candidate.trackKind === 'audio').length,
      unknown: tracks.filter((candidate) => !candidate.trackKind || candidate.trackKind === 'unknown').length
    };
  }, [candidates]);

  const visibleCandidates = useMemo(() => (
    [...candidates]
      .sort((a, b) => candidatePriority(a) - candidatePriority(b) || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 24)
  ), [candidates]);

  const refresh = useCallback(async (currentTab: chrome.tabs.Tab) => {
    if (currentTab.id == null) return;

    const response = await chrome.runtime.sendMessage({
      type: 'GET_MEDIA_CANDIDATES',
      tabId: currentTab.id
    }) as BackgroundResponse;

    let domCandidates: MediaCandidate[] = [];
    try {
      const injection = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: scanDomMedia
      });

      const raw = injection.flatMap((item) => Array.isArray(item.result) ? item.result : []) as DomMediaCandidate[];
      domCandidates = raw.map((item) => ({ ...item, tabId: currentTab.id! }));
    } catch {
      // Restricted Chrome pages can reject script injection.
    }

    const merged = uniqueCandidates([...(response.candidates ?? []), ...domCandidates]);
    setCandidates(merged);

    const trackCount = merged.filter((candidate) => candidate.kind === 'segment' || Boolean(candidate.contentRange)).length;
    if (trackCount > 0) {
      setStatus(t('streamingTracksDetected', formatLocalizedNumber(trackCount)));
    } else {
      setStatus(merged.length
        ? t('mediaSourcesDetected', formatLocalizedNumber(merged.length))
        : t('noDownloadableMedia'));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!currentTab) {
        setStatus(t('noActiveTab'));
        return;
      }

      setTab(currentTab);
      await refresh(currentTab);
    })();
  }, [refresh]);

  async function openManager(candidate: MediaCandidate) {
    await chrome.storage.session.set({ 'download-manager:selected': candidate });
    await chrome.tabs.create({ url: chrome.runtime.getURL('download.html') });
  }

  async function download(candidate: MediaCandidate) {
    const simpleDirectFile = candidate.kind === 'direct' && !candidate.contentRange;
    if (!simpleDirectFile) {
      await openManager(candidate);
      return;
    }

    await chrome.downloads.download({
      url: candidate.url,
      saveAs: true
    });
  }

  return (
    <main className="popup">
      <header>
        <div>
          <h1>{t('appName')}</h1>
          <p>{status}</p>
        </div>
        {tab && (
          <button className="iconButton" onClick={() => void refresh(tab)} title={t('rescan')} aria-label={t('rescan')}>↻</button>
        )}
      </header>

      {streamStats.total > 0 && (
        <section className="streamSummary">
          <strong>{t('dashMseDetected')}</strong>
          <p>
            {t('streamSummary', [formatLocalizedNumber(streamStats.video), formatLocalizedNumber(streamStats.audio)])}
            {streamStats.unknown > 0 ? ` · ${t('unclassifiedCount', formatLocalizedNumber(streamStats.unknown))}` : ''}
          </p>
          <span>{t('separateTracksMuxHint')}</span>
        </section>
      )}

      <section className="candidateList">
        {visibleCandidates.map((candidate) => {
          const meta = metadata(candidate);
          const simpleDirectFile = candidate.kind === 'direct' && !candidate.contentRange;

          return (
            <article className="candidate" key={`${candidate.kind}:${candidate.trackKind ?? 'unknown'}:${candidate.url}`}>
              <div className="candidateMain">
                <span className={`kind kind-${candidate.kind}`}>{mediaLabel(candidate)}</span>
                {meta.length > 0 && <span className="meta">{meta.join(' · ')}</span>}
                <span className="url" title={candidate.url}>{candidate.url}</span>
              </div>
              <button onClick={() => void download(candidate)}>
                {simpleDirectFile ? t('download') : t('openManager')}
              </button>
            </article>
          );
        })}
      </section>

      {candidates.length > visibleCandidates.length && (
        <p className="moreNotice">{t('showingRelevantResources', formatLocalizedNumber(visibleCandidates.length))}</p>
      )}

      <footer>{t('drmUnsupportedFooter')}</footer>
    </main>
  );
}

initDocumentLocale();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
