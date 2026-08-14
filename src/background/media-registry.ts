import { inferTrackKindFromUrl } from '../detector/classify';
import type { MediaCandidate } from '../shared/media';

const keyForTab = (tabId: number) => `media-candidates:${tabId}`;
const MAX_CANDIDATES_PER_TAB = 200;

function isStreamTrack(candidate: MediaCandidate): boolean {
  return candidate.kind === 'segment' || candidate.statusCode === 206 || Boolean(candidate.contentRange);
}

function reconcileTrackKinds(candidates: MediaCandidate[]): MediaCandidate[] {
  const next = candidates.map((candidate) => ({ ...candidate }));
  const streamIndexes = next
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isStreamTrack(candidate));

  // Strong URL hints win over MIME because some CDNs return video/mp4 for an
  // audio-only fMP4 resource.
  for (const { candidate, index } of streamIndexes) {
    const urlKind = inferTrackKindFromUrl(candidate.url);
    if (urlKind !== 'unknown') {
      next[index] = { ...candidate, trackKind: urlKind };
    }
  }

  if (streamIndexes.some(({ index }) => next[index].trackKind === 'audio')) {
    return next;
  }

  const sizedTracks = streamIndexes
    .map(({ index }) => ({ index, candidate: next[index] }))
    .filter(({ candidate }) => (candidate.contentLength ?? 0) >= 64 * 1024)
    .sort((a, b) => (a.candidate.contentLength ?? 0) - (b.candidate.contentLength ?? 0));

  if (sizedTracks.length < 2) return next;

  const smallest = sizedTracks[0];
  const second = sizedTracks[1];
  const largest = sizedTracks[sizedTracks.length - 1];
  const smallestSize = smallest.candidate.contentLength ?? 0;
  const secondSize = second.candidate.contentLength ?? 0;
  const largestSize = largest.candidate.contentLength ?? 0;

  // Generic fallback for MSE/DASH players where both audio and video are
  // served with an indistinguishable video/mp4 MIME type. We only infer audio
  // when one contemporaneous range resource is substantially smaller than the
  // peer video resource(s). This avoids blindly classifying every small file.
  const clearTwoTrackSplit = sizedTracks.length === 2 && smallestSize <= largestSize * 0.62;
  const clearMultiTrackSplit = sizedTracks.length > 2
    && smallestSize <= secondSize * 0.48
    && smallestSize <= largestSize * 0.35;

  const smallestUrlKind = inferTrackKindFromUrl(smallest.candidate.url);
  if ((clearTwoTrackSplit || clearMultiTrackSplit) && smallestUrlKind !== 'video') {
    next[smallest.index] = { ...next[smallest.index], trackKind: 'audio' };

    const hasVideo = sizedTracks.some(({ index }) => next[index].trackKind === 'video');
    if (!hasVideo && largest.index !== smallest.index && largestSize >= smallestSize * 1.5) {
      next[largest.index] = { ...next[largest.index], trackKind: 'video' };
    }
  }

  return next;
}

export async function addCandidate(candidate: MediaCandidate): Promise<void> {
  const key = keyForTab(candidate.tabId);
  const stored = await chrome.storage.session.get(key);
  const existing = (stored[key] as MediaCandidate[] | undefined) ?? [];

  const sameIndex = existing.findIndex((item) =>
    item.url === candidate.url &&
    item.kind === candidate.kind &&
    (item.trackKind ?? 'unknown') === (candidate.trackKind ?? 'unknown')
  );

  let next: MediaCandidate[];

  if (sameIndex >= 0) {
    const current = existing[sameIndex];
    const updated: MediaCandidate = {
      ...current,
      ...candidate,
      id: current.id,
      firstSeenAt: current.firstSeenAt,
      lastSeenAt: Date.now(),
      requestCount: (current.requestCount ?? 1) + 1
    };
    next = [...existing];
    next[sameIndex] = updated;
  } else {
    next = [{ ...candidate, requestCount: candidate.requestCount ?? 1 }, ...existing]
      .slice(0, MAX_CANDIDATES_PER_TAB);
  }

  await chrome.storage.session.set({ [key]: next });
}

export async function getCandidates(tabId: number): Promise<MediaCandidate[]> {
  const key = keyForTab(tabId);
  const stored = await chrome.storage.session.get(key);
  const candidates = (stored[key] as MediaCandidate[] | undefined) ?? [];
  return reconcileTrackKinds(candidates);
}

export async function clearCandidates(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyForTab(tabId));
}
