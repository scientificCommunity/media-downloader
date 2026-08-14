import type { MediaKind, MediaTrackKind } from '../shared/media';

const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl'
]);

const DASH_CONTENT_TYPES = new Set(['application/dash+xml']);
const SEGMENT_EXTENSIONS = /\.(m4s|cmfv|cmfa|ts)(\?|$)/i;
const DIRECT_EXTENSIONS = /\.(mp4|webm|mov|m4v|mp3|m4a|aac|ogg)(\?|$)/i;

export function normalizeContentType(rawContentType?: string): string | undefined {
  return rawContentType?.split(';', 1)[0]?.trim().toLowerCase();
}

export function classifyMedia(url: string, rawContentType?: string): MediaKind {
  const contentType = normalizeContentType(rawContentType);
  const lowerUrl = url.toLowerCase().split('#', 1)[0];

  if (contentType && HLS_CONTENT_TYPES.has(contentType)) return 'hls';
  if (contentType && DASH_CONTENT_TYPES.has(contentType)) return 'dash';

  if (lowerUrl.includes('.m3u8')) return 'hls';
  if (lowerUrl.includes('.mpd')) return 'dash';

  // fMP4/TS media fragments should be kept as stream tracks instead of being
  // treated as ordinary direct-download files. MSE/DASH players commonly feed
  // these resources into SourceBuffer and expose only a blob: URL in the DOM.
  if (SEGMENT_EXTENSIONS.test(lowerUrl)) return 'segment';

  if (contentType?.startsWith('video/') || contentType?.startsWith('audio/')) {
    return 'direct';
  }

  if (DIRECT_EXTENSIONS.test(lowerUrl)) return 'direct';

  return 'unknown';
}

export function inferTrackKindFromUrl(url: string): MediaTrackKind {
  const lowerUrl = url.toLowerCase();

  if (/(^|[\/_?&=.-])(audio|sound|aac|mp3|m4a)([\/_?&=.-]|$)/i.test(lowerUrl)) {
    return 'audio';
  }

  if (/(^|[\/_?&=.-])(video|avc|h264|h265|hevc|av1|vp9)([\/_?&=.-]|$)/i.test(lowerUrl)) {
    return 'video';
  }

  if (inferBilibiliAudioTrack(url)) {
    return 'audio';
  }

  return 'unknown';
}

export function inferTrackKind(url: string, rawContentType?: string): MediaTrackKind {
  const urlKind = inferTrackKindFromUrl(url);
  if (urlKind !== 'unknown') return urlKind;

  const contentType = normalizeContentType(rawContentType);
  if (contentType?.startsWith('audio/')) return 'audio';
  if (contentType?.startsWith('video/')) return 'video';

  return 'unknown';
}

export function isRangeLikeMediaResponse(
  kind: MediaKind,
  statusCode?: number,
  contentRange?: string,
  acceptRanges?: string
): boolean {
  if (kind === 'segment') return true;
  if (statusCode === 206 && Boolean(contentRange)) return true;
  return acceptRanges?.toLowerCase() === 'bytes' && kind === 'direct';
}

const BILIBILI_AUDIO_FORMAT_IDS = new Set([
  '30216',
  '30232',
  '30280'
]);

function inferBilibiliAudioTrack(url: string): boolean {
  let pathname: string;

  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?', 1)[0];
  }

  const match = /-(\d+)\.m4s$/i.exec(pathname);

  return Boolean(
    match &&
    BILIBILI_AUDIO_FORMAT_IDS.has(match[1])
  );
}