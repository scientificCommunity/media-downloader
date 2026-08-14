import { addCandidate, clearCandidates, getCandidates } from './media-registry';
import { classifyMedia, inferTrackKind, normalizeContentType } from '../detector/classify';
import type { BackgroundMessage, MediaCandidate, MediaKind } from '../shared/media';

const MEDIA_FILTER: chrome.webRequest.RequestFilter = {
  urls: ['http://*/*', 'https://*/*']
};

const GENERIC_BINARY_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/mp4'
]);

function candidateId(tabId: number, url: string, kind: string, trackKind: string): string {
  return `${tabId}:${kind}:${trackKind}:${url}`;
}

function headerValue(headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === normalized)?.value;
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseTotalLength(contentRange?: string, contentLength?: string): number | undefined {
  if (contentRange) {
    const match = /\/([0-9]+)$/.exec(contentRange.trim());
    if (match) {
      const total = parsePositiveInteger(match[1]);
      if (total !== undefined) return total;
    }
  }
  return parsePositiveInteger(contentLength);
}

function shouldPromoteUnknownRangeResponse(
  kind: MediaKind,
  details: chrome.webRequest.OnHeadersReceivedDetails,
  contentType: string | undefined,
  contentRange: string | undefined,
  totalLength: number | undefined
): boolean {
  if (kind !== 'unknown' || details.statusCode !== 206 || !contentRange) return false;

  const normalizedType = normalizeContentType(contentType);
  if (normalizedType?.startsWith('video/') || normalizedType?.startsWith('audio/')) return true;

  // A native media request with a byte range is a strong signal even when the
  // CDN uses an opaque URL or generic binary MIME type.
  if (details.type === 'media') return true;

  const lowerUrl = details.url.toLowerCase();
  if (/(?:video|audio|media|stream|segment|frag|dash|m4s|mp4)/.test(lowerUrl)) return true;

  // MSE players often fetch fMP4 through XHR/fetch. Keep sufficiently large
  // ranged binary resources instead of dropping them solely because the CDN
  // reports application/octet-stream.
  return details.type === 'xmlhttprequest'
    && (totalLength ?? 0) >= 256 * 1024
    && (!normalizedType || GENERIC_BINARY_CONTENT_TYPES.has(normalizedType));
}

function shouldTreatDirectAsStream(
  kind: MediaKind,
  statusCode: number,
  contentRange?: string
): boolean {
  return kind === 'direct' && statusCode === 206 && Boolean(contentRange);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return undefined;

    const contentType = headerValue(details.responseHeaders, 'content-type');
    const contentRange = headerValue(details.responseHeaders, 'content-range');
    const contentLengthHeader = headerValue(details.responseHeaders, 'content-length');
    const acceptRangesHeader = headerValue(details.responseHeaders, 'accept-ranges');
    const totalLength = parseTotalLength(contentRange, contentLengthHeader);

    let kind = classifyMedia(details.url, contentType);
    if (shouldPromoteUnknownRangeResponse(kind, details, contentType, contentRange, totalLength)) {
      kind = 'segment';
    }
    if (shouldTreatDirectAsStream(kind, details.statusCode, contentRange)) {
      kind = 'segment';
    }
    if (kind === 'unknown') return undefined;

    const trackKind = inferTrackKind(details.url, contentType);
    const now = Date.now();
    const candidate: MediaCandidate = {
      id: candidateId(details.tabId, details.url, kind, trackKind),
      url: details.url,
      kind,
      trackKind,
      source: 'network',
      tabId: details.tabId,
      contentType: normalizeContentType(contentType),
      contentLength: totalLength,
      contentRange,
      acceptRanges: acceptRangesHeader?.toLowerCase() === 'bytes',
      statusCode: details.statusCode,
      requestType: details.type,
      pageUrl: details.initiator && details.initiator !== 'null' ? details.initiator : undefined,
      firstSeenAt: now,
      lastSeenAt: now
    };

    void addCandidate(candidate);
    return undefined;
  },
  MEDIA_FILTER,
  ['responseHeaders']
);

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type === 'GET_MEDIA_CANDIDATES') {
    void getCandidates(message.tabId).then((candidates) => sendResponse({ candidates }));
    return true;
  }

  if (message.type === 'CLEAR_MEDIA_CANDIDATES') {
    void clearCandidates(message.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void clearCandidates(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearCandidates(tabId);
});
