import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { probeHlsCandidate, recordHlsLive, resumeHlsLive, type LiveRecorderProgress } from '../downloader/hls-recorder';
import { hlsVariantKey, type HlsProbe, type HlsVariant } from '../downloader/hls-playlist';
import { getLatestResumableLiveTask, type LiveTaskRecord } from '../downloader/live-task-store';
import { muxTracksToMp4, type MuxProgress } from '../downloader/track-muxer';
import { formatLocalizedNumber, initDocumentLocale, t } from '../shared/i18n';
import type { MediaCandidate } from '../shared/media';
import './manager.css';

interface BackgroundResponse { candidates?: MediaCandidate[]; }
type JobState = 'idle' | 'running' | 'completed' | 'failed' | 'canceled';
type ProbeState = 'idle' | 'loading' | 'ready' | 'failed';
function formatBytes(value?: number): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${formatLocalizedNumber(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) { size /= 1024; unitIndex += 1; }
  return `${formatLocalizedNumber(size >= 10 ? Math.round(size) : Number(size.toFixed(1)))} ${units[unitIndex]}`;
}
function formatBitrate(value?: number): string {
  if (!value || !Number.isFinite(value)) return t('unknown');
  return value >= 1_000_000 ? `${formatLocalizedNumber(Number((value / 1_000_000).toFixed(1)))} Mbps`
    : `${formatLocalizedNumber(Math.round(value / 1000))} Kbps`;
}
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}
function formatRecordingStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}
function trackLabel(candidate: MediaCandidate): string {
  if (candidate.trackKind === 'video') return t('videoTrack');
  if (candidate.trackKind === 'audio') return t('audioTrack');
  return candidate.kind === 'segment' ? t('mediaTrack') : t('sourceKind', candidate.kind.toUpperCase());
}
function rankTrack(a: MediaCandidate, b: MediaCandidate): number {
  return ((b.contentLength ?? 0) - (a.contentLength ?? 0))
    || ((b.requestCount ?? 1) - (a.requestCount ?? 1)) || (b.lastSeenAt - a.lastSeenAt);
}
function sanitizeFilename(value: string, extension = 'mp4'): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  return `${(cleaned || 'video-helper').replace(/\.(?:mp4|ts)$/i, '').slice(0, 140)}.${extension}`;
}
function stageLabel(progress: MuxProgress | null): string {
  switch (progress?.stage) {
    case 'preparing': return t('preparingTracks');
    case 'transferring': return t('downloadingMuxing');
    case 'finalizing': return t('finalizingMp4');
    case 'completed': return t('mp4SavedSuccessfully');
    default: return t('ready');
  }
}
function liveStageLabel(progress: LiveRecorderProgress | null, state: JobState, isLive: boolean): string {
  if (state === 'completed') return t('mp4SavedSuccessfully');
  if (state === 'failed') return t('liveRecordingFailed');
  switch (progress?.stage) {
    case 'preparing': return t('livePreparing');
    case 'fetching-key': return t('hlsFetchingKey');
    case 'decrypting': return t('hlsDecrypting');
    case 'recording': return t(isLive ? 'liveRecording' : 'downloadingMuxing');
    case 'waiting': return t('liveWaiting');
    case 'stopping': return t('liveStopping');
    case 'remuxing': return t('finalizingMp4');
    case 'completed': return t('liveRecordingSaved');
    default: return t(isLive ? 'liveReady' : 'ready');
  }
}
function variantLabel(variant: HlsVariant): string {
  return [variant.height ? `${variant.height}p` : '',
    variant.averageBandwidth || variant.bandwidth ? formatBitrate(variant.averageBandwidth ?? variant.bandwidth) : '',
    variant.codecs ?? ''].filter(Boolean).join(' · ') || t('unknown');
}
function sortedVariants(variants: HlsVariant[]): HlsVariant[] {
  return [...variants].sort((a, b) => ((b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))
    || ((b.averageBandwidth ?? b.bandwidth ?? 0) - (a.averageBandwidth ?? a.bandwidth ?? 0)));
}
function displaySourceUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`; }
  catch { return t('unknown'); }
}

function App() {
  const [selected, setSelected] = useState<MediaCandidate | null>(null);
  const [related, setRelated] = useState<MediaCandidate[]>([]);
  const [sourceTitle, setSourceTitle] = useState('video-helper');
  const [sourcePageUrl, setSourcePageUrl] = useState<string | undefined>();
  const [jobState, setJobState] = useState<JobState>('idle');
  const [progress, setProgress] = useState<MuxProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [hlsProbeState, setHlsProbeState] = useState<ProbeState>('idle');
  const [hlsProbe, setHlsProbe] = useState<HlsProbe | null>(null);
  const [hlsProbeError, setHlsProbeError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<JobState>('idle');
  const [liveProgress, setLiveProgress] = useState<LiveRecorderProgress | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [resumableTask, setResumableTask] = useState<LiveTaskRecord | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [savedHlsName, setSavedHlsName] = useState<string | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);
  const recordingStampRef = useRef(formatRecordingStamp(new Date()));
  useEffect(() => {
    if (liveState !== 'running') return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveState]);
  useEffect(() => {
    void chrome.storage.session.get('download-manager:selected').then(async (value) => {
      const candidate = (value['download-manager:selected'] as MediaCandidate | undefined) ?? null;
      setSelected(candidate);
      if (!candidate) return;
      const [response, sourceTab] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_MEDIA_CANDIDATES', tabId: candidate.tabId }) as Promise<BackgroundResponse>,
        chrome.tabs.get(candidate.tabId).catch(() => null)
      ]);
      setRelated((response.candidates ?? []).filter((item) => item.kind === 'segment' || Boolean(item.contentRange)));
      setSourceTitle(sourceTab?.title || 'video-helper');
      const pageUrl = sourceTab?.url?.startsWith('http://') || sourceTab?.url?.startsWith('https://') ? sourceTab.url : candidate.pageUrl;
      setSourcePageUrl(pageUrl);
      if (candidate.kind === 'hls') {
        // Local MP4 finalization must remain available even after the live URL expires.
        void getLatestResumableLiveTask(candidate.url).then(setResumableTask).catch(() => undefined);
        setHlsProbeState('loading');
        try {
          setHlsProbe(await probeHlsCandidate({ candidate, sourcePageUrl: pageUrl }));
          setHlsProbeState('ready');
        } catch (cause) {
          setHlsProbeState('failed'); setHlsProbeError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  const pairing = useMemo(() => ({
    video: related.filter((candidate) => candidate.trackKind === 'video').sort(rankTrack),
    audio: related.filter((candidate) => candidate.trackKind === 'audio').sort(rankTrack),
    unknown: related.filter((candidate) => !candidate.trackKind || candidate.trackKind === 'unknown')
  }), [related]);
  const chosenPair = useMemo(() => ({
    video: (selected?.trackKind === 'video' ? selected : null) ?? pairing.video[0] ?? null,
    audio: (selected?.trackKind === 'audio' ? selected : null) ?? pairing.audio[0] ?? null
  }), [pairing, selected]);
  const totalProgress = progress ? Math.max(0, Math.min(1, (progress.video + progress.audio) / 2)) : 0;
  const hlsSuggestedName = sanitizeFilename(`${sourceTitle} ${recordingStampRef.current}`, 'mp4');
  async function refreshResumable(candidate: MediaCandidate) {
    setResumableTask(await getLatestResumableLiveTask(candidate.url).catch(() => null));
  }
  async function changeHlsVariant(variantKey: string) {
    if (!selected || selected.kind !== 'hls' || liveState === 'running') return;
    setHlsProbeState('loading'); setHlsProbeError(null); setLiveError(null);
    try {
      setHlsProbe(await probeHlsCandidate({ candidate: selected, sourcePageUrl, preferredVariantKey: variantKey }));
      setHlsProbeState('ready');
    } catch (cause) {
      setHlsProbeState('failed'); setHlsProbeError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function startDownload() {
    if (!chosenPair.video || !chosenPair.audio || jobState === 'running') return;
    const controller = new AbortController(); abortRef.current = controller;
    setJobState('running'); setError(null); setProgress({ stage: 'preparing', video: 0, audio: 0, outputBytes: 0 });
    try {
      await muxTracksToMp4({ video: chosenPair.video, audio: chosenPair.audio, suggestedName: sanitizeFilename(sourceTitle),
        sourcePageUrl, signal: controller.signal, onProgress: setProgress });
      setJobState('completed');
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) { setJobState('canceled'); setError(null); }
      else { setJobState('failed'); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally { abortRef.current = null; }
  }
  async function startLiveRecording() {
    if (!selected || selected.kind !== 'hls' || !hlsProbe || hlsProbe.media.encryptionError || liveState === 'running') return;
    const controller = new AbortController(); liveAbortRef.current = controller;
    setResumableTask(null); setSavedHlsName(null); setLiveState('running'); setLiveError(null); setClock(Date.now());
    setLiveProgress({ stage: 'preparing', startedAt: Date.now(), bytesWritten: 0, segmentsWritten: 0, retryCount: 0, targetDuration: hlsProbe.media.targetDuration });
    try {
      const result = await recordHlsLive({ candidate: selected, sourcePageUrl, probe: hlsProbe,
        suggestedName: hlsSuggestedName, signal: controller.signal,
        onProgress: (next) => { setLiveProgress(next); setClock(Date.now()); } });
      setSavedHlsName(result.finalFileName ?? null);
      setLiveState(result.stoppedByUser ? 'canceled' : 'completed');
    } catch (cause) {
      setLiveState('failed'); setLiveError(cause instanceof Error ? cause.message : String(cause)); await refreshResumable(selected);
    } finally { liveAbortRef.current = null; }
  }
  async function resumeLiveRecording() {
    if (!selected || selected.kind !== 'hls' || !resumableTask || liveState === 'running') return;
    const controller = new AbortController(); liveAbortRef.current = controller;
    setLiveState('running'); setSavedHlsName(null); setLiveError(null); setClock(Date.now());
    setLiveProgress({ stage: resumableTask.phase === 'remux' ? 'remuxing' : 'preparing', startedAt: resumableTask.startedAt,
      bytesWritten: resumableTask.bytesWritten, segmentsWritten: resumableTask.segmentsWritten, retryCount: resumableTask.retryCount,
      lastSequence: resumableTask.lastSequence, targetDuration: hlsProbe?.media.targetDuration ?? 6 });
    try {
      const result = await resumeHlsLive({ candidate: selected, sourcePageUrl, task: resumableTask, signal: controller.signal,
        onProgress: (next) => { setLiveProgress(next); setClock(Date.now()); } });
      setResumableTask(null); setSavedHlsName(result.finalFileName ?? null);
      setLiveState(result.stoppedByUser ? 'canceled' : 'completed');
    } catch (cause) {
      setLiveState('failed'); setLiveError(cause instanceof Error ? cause.message : String(cause)); await refreshResumable(selected);
    } finally { liveAbortRef.current = null; }
  }
  const hlsCanRecord = Boolean(hlsProbe && !hlsProbe.media.encryptionError && !hlsProbe.separateAudio);
  const qualityVariants = hlsProbe ? sortedVariants(hlsProbe.variants) : [];
  const remuxing = liveState === 'running' && liveProgress?.stage === 'remuxing';
  return (
    <main className="manager">
      <div className="titleBlock"><h1>{t('downloadManager')}</h1><p>{t('managerSubtitle')}</p></div>
      {selected ? (
        <section>
          <div className="sectionHeading"><div><span className="eyebrow">{t('selectedSource')}</span><h2>{trackLabel(selected)}</h2></div><span className="kindBadge">{selected.kind.toUpperCase()}</span></div>
          <div className="metadataGrid">
            <div><span>{t('track')}</span><strong>{selected.trackKind ? t(selected.trackKind) : t('unknown')}</strong></div>
            <div><span>{t('type')}</span><strong>{selected.contentType ?? t('unknown')}</strong></div>
            <div><span>{t('size')}</span><strong>{formatBytes(selected.contentLength) ?? t('unknown')}</strong></div>
            <div><span>{t('status')}</span><strong>{selected.statusCode ?? t('unknown')}</strong></div>
            <div><span>{t('requestType')}</span><strong>{selected.requestType ?? t('unknown')}</strong></div>
            <div><span>{t('requests')}</span><strong>{formatLocalizedNumber(selected.requestCount ?? 1)}</strong></div>
          </div>
          {selected.contentRange && <p className="rangeInfo">{t('latestContentRange', selected.contentRange)}</p>}
          <p className="sourceUrl">{displaySourceUrl(selected.url)}</p>
        </section>
      ) : <p>{t('noStreamSelected')}</p>}
      {selected?.kind === 'hls' && (
        <section>
          <div className="sectionHeading">
            <div><span className="eyebrow">HLS</span><h2>{t('hlsDownloadTitle')}</h2></div>
            {hlsProbe && <span className={`kindBadge ${hlsProbe.isLive ? 'liveBadge' : ''}`}>{t(hlsProbe.isLive ? 'liveBadge' : 'vodBadge')}</span>}
          </div>
          {hlsProbeState === 'loading' && <p>{t('probingHls')}</p>}
          {hlsProbeState === 'failed' && <p className="errorNote">{hlsProbeError}</p>}
          {resumableTask && liveState !== 'running' && (
            <div className="resumeCard">
              <div><strong>{t(resumableTask.phase === 'remux' ? 'finalizingMp4' : 'resumePreviousRecording')}</strong>
                <span>{t('resumeRecordingHint', [formatBytes(resumableTask.bytesWritten) ?? '0 B', resumableTask.lastSequence == null ? '—' : formatLocalizedNumber(resumableTask.lastSequence)])}</span></div>
              <button className="secondaryButton" onClick={() => void resumeLiveRecording()}>{t(resumableTask.phase === 'remux' ? 'retryDownload' : 'resumeRecording')}</button>
            </div>
          )}
          {hlsProbeState === 'ready' && hlsProbe && (
            <>
              {qualityVariants.length > 1 && (
                <div className="qualityControl"><label htmlFor="hls-quality">{t('resolution')}</label>
                  <select id="hls-quality" value={hlsProbe.variantKey ?? ''} disabled={liveState === 'running'} onChange={(event) => void changeHlsVariant(event.target.value)}>
                    {qualityVariants.map((variant) => <option key={hlsVariantKey(variant)} value={hlsVariantKey(variant)}>{variantLabel(variant)}</option>)}
                  </select>
                </div>
              )}
              <div className="liveMetadataGrid">
                <div><span>{t('resolution')}</span><strong>{hlsProbe.variant?.width && hlsProbe.variant?.height ? `${hlsProbe.variant.width}×${hlsProbe.variant.height}` : t('unknown')}</strong></div>
                <div><span>{t('bitrate')}</span><strong>{formatBitrate(hlsProbe.variant?.averageBandwidth ?? hlsProbe.variant?.bandwidth)}</strong></div>
                <div><span>{t('segmentFormat')}</span><strong>{hlsProbe.outputExtension === 'mp4' ? 'fMP4' : 'MPEG-TS'}</strong></div>
                <div><span>{t('type')}</span><strong>MP4</strong></div>
                <div><span>{t('targetDuration')}</span><strong>{t('secondsValue', formatLocalizedNumber(hlsProbe.media.targetDuration))}</strong></div>
                <div><span>{t('hlsEncryption')}</span><strong>{hlsProbe.media.encrypted ? hlsProbe.media.encryptionMethod : t('hlsUnencrypted')}</strong></div>
              </div>
              {hlsProbe.media.encryptionError ? <p className="errorNote">{t(hlsProbe.media.encryptionError)}</p>
                : hlsProbe.media.encrypted && <p className="mutedNote">{t('hlsAesHint')}</p>}
              {hlsProbe.separateAudio && <p className="errorNote">{t('errorHlsSeparateAudio')}</p>}
            </>
          )}
          {(hlsCanRecord || liveState === 'running' || liveProgress) && (
            <div className="livePanel">
              <div className="downloadHeading"><div><strong>{liveStageLabel(liveProgress, liveState, hlsProbe?.isLive ?? true)}</strong><span>{savedHlsName ?? hlsSuggestedName}</span></div>
                {liveProgress && <span>{formatElapsed(clock - liveProgress.startedAt)}</span>}</div>
              {liveProgress?.stage === 'remuxing' && liveProgress.finalizeProgress != null && (
                <div className="progressTrack" aria-label={t('downloadProgress')}><div className="progressFill" style={{ width: `${Math.max(0, Math.min(1, liveProgress.finalizeProgress)) * 100}%` }} /></div>
              )}
              <div className="liveStats">
                <div><span>{t('recordedSize')}</span><strong>{formatBytes(liveProgress?.bytesWritten ?? 0) ?? '0 B'}</strong></div>
                <div><span>{t('segments')}</span><strong>{formatLocalizedNumber(liveProgress?.segmentsWritten ?? 0)}</strong></div>
                <div><span>{t('retries')}</span><strong>{formatLocalizedNumber(liveProgress?.retryCount ?? 0)}</strong></div>
                <div><span>{t('lastSequence')}</span><strong>{liveProgress?.lastSequence == null ? '—' : formatLocalizedNumber(liveProgress.lastSequence)}</strong></div>
                {remuxing && <div><span>MP4</span><strong>{formatBytes(liveProgress?.finalBytesWritten ?? 0) ?? '0 B'}</strong></div>}
              </div>
              {liveState === 'completed' && <p className="successNote">{t('mp4SavedSuccessfully')}</p>}
              {liveState === 'canceled' && <p className="successNote">{t('liveStoppedSaved')}</p>}
              <div className="buttonRow">
                {liveState === 'running' ? (remuxing ? <button className="primaryButton" disabled>{t('finalizingMp4')}</button>
                  : <button className="stopButton" onClick={() => liveAbortRef.current?.abort()}>{t('stopAndSave')}</button>)
                  : hlsCanRecord && hlsProbeState === 'ready' && <button className="primaryButton" onClick={() => void startLiveRecording()}>{t(liveState === 'failed' ? 'retryRecording' : hlsProbe?.isLive ? 'startRecording' : 'downloadMergeMp4')}</button>}
              </div>
            </div>
          )}
          {liveError && <p className="errorNote" role="alert">{liveError}</p>}
        </section>
      )}
      {related.length > 0 && selected?.kind !== 'hls' && (
        <section>
          <div className="sectionHeading"><div><span className="eyebrow">{t('currentTab')}</span><h2>{t('detectedStreamTracks')}</h2></div><span className="kindBadge">{t('resourcesCount', formatLocalizedNumber(related.length))}</span></div>
          <div className="pairingSummary">
            <div><strong>{formatLocalizedNumber(pairing.video.length)}</strong><span>{t('video')}</span></div>
            <div><strong>{formatLocalizedNumber(pairing.audio.length)}</strong><span>{t('audio')}</span></div>
            <div><strong>{formatLocalizedNumber(pairing.unknown.length)}</strong><span>{t('unknown')}</span></div>
          </div>
          {chosenPair.video && chosenPair.audio ? (
            <>
              <div className="pairCard">
                <div><span>{t('video')}</span><strong>{formatBytes(chosenPair.video.contentLength) ?? t('unknownSize')}</strong><small>{chosenPair.video.contentType ?? t('unknownType')}</small></div>
                <div><span>{t('audio')}</span><strong>{formatBytes(chosenPair.audio.contentLength) ?? t('unknownSize')}</strong><small>{chosenPair.audio.contentType ?? t('unknownType')}</small></div>
              </div>
              <div className="downloadPanel">
                <div className="downloadHeading"><div><strong>{stageLabel(progress)}</strong><span>{sanitizeFilename(sourceTitle)}</span></div>{progress && <span>{formatLocalizedNumber(Math.round(totalProgress * 100))}%</span>}</div>
                <div className="progressTrack" aria-label={t('downloadProgress')}><div className="progressFill" style={{ width: `${totalProgress * 100}%` }} /></div>
                {progress && <div className="progressMeta">
                  <span>{t('trackProgress', [t('video'), formatLocalizedNumber(Math.round(progress.video * 100))])}</span>
                  <span>{t('trackProgress', [t('audio'), formatLocalizedNumber(Math.round(progress.audio * 100))])}</span>
                  <span>{t('bytesWritten', formatBytes(progress.outputBytes) ?? '0 B')}</span>
                </div>}
                {jobState === 'canceled' && <p className="mutedNote">{t('downloadCanceled')}</p>}
                {jobState === 'completed' && <p className="successNote">{t('muxSavedSuccess')}</p>}
                <div className="buttonRow">
                  <button className="primaryButton" disabled={jobState === 'running'} onClick={() => void startDownload()}>{t(jobState === 'failed' || jobState === 'canceled' ? 'retryDownload' : 'downloadMergeMp4')}</button>
                  {jobState === 'running' && <button className="secondaryButton" onClick={() => abortRef.current?.abort()}>{t('cancel')}</button>}
                </div>
              </div>
            </>
          ) : <p>{t('playVideoHint')}</p>}
        </section>
      )}
      {error && <p className="errorNote" role="alert">{error}</p>}
      <section><h2>{t('currentCapability')}</h2><ul>
        {['capDirect', 'capHlsDash', 'capHlsLive', 'hlsAesCapability', 'capMse', 'capAutoPair', 'capReferer', 'capStreamingMux', 'capDrmUnsupported']
          .map((key) => <li key={key}>{t(key)}</li>)}
      </ul></section>
    </main>
  );
}
initDocumentLocale();
document.title = t('downloadManager');
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
