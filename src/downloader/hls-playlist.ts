import { t } from '../shared/i18n';

export interface HlsByteRange {
  length: number;
  offset?: number;
}

export interface HlsMap {
  url: string;
  byteRange?: HlsByteRange;
}

export interface HlsSegment {
  sequence: number;
  url: string;
  duration: number;
  byteRange?: HlsByteRange;
  map?: HlsMap;
  discontinuity: boolean;
}

export interface HlsVariant {
  url: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioGroup?: string;
}

export interface HlsMasterPlaylist {
  kind: 'master';
  variants: HlsVariant[];
}

export interface HlsMediaPlaylist {
  kind: 'media';
  targetDuration: number;
  mediaSequence: number;
  playlistType?: 'EVENT' | 'VOD';
  endList: boolean;
  encrypted: boolean;
  encryptionMethod?: string;
  segments: HlsSegment[];
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export interface HlsProbe {
  sourceUrl: string;
  mediaUrl: string;
  media: HlsMediaPlaylist;
  variants: HlsVariant[];
  variant?: HlsVariant;
  variantKey?: string;
  isLive: boolean;
  outputExtension: 'ts' | 'mp4';
  mimeType: 'video/mp2t' | 'video/mp4';
  separateAudio: boolean;
}

function parsePositiveNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;

  while (index < raw.length) {
    while (raw[index] === ',' || raw[index] === ' ') index += 1;
    const equals = raw.indexOf('=', index);
    if (equals < 0) break;

    const key = raw.slice(index, equals).trim();
    index = equals + 1;
    let value = '';

    if (raw[index] === '"') {
      index += 1;
      const start = index;
      while (index < raw.length && raw[index] !== '"') index += 1;
      value = raw.slice(start, index);
      if (raw[index] === '"') index += 1;
    } else {
      const comma = raw.indexOf(',', index);
      if (comma < 0) {
        value = raw.slice(index).trim();
        index = raw.length;
      } else {
        value = raw.slice(index, comma).trim();
        index = comma + 1;
      }
    }

    if (key) attributes[key.toUpperCase()] = value;
  }

  return attributes;
}

function parseResolution(value?: string): { width?: number; height?: number } {
  if (!value) return {};
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) return {};
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10)
  };
}

function parseByteRange(value?: string): HlsByteRange | undefined {
  if (!value) return undefined;
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    length: Number.parseInt(match[1], 10),
    offset: match[2] == null ? undefined : Number.parseInt(match[2], 10)
  };
}

const HLS_INHERITED_QUERY_PARAMS = new Set(['pkey', 'safety_id']);

function absoluteUrl(value: string, baseUrl: string): string {
  const resolved = new URL(value, baseUrl);
  const base = new URL(baseUrl);

  // Some signed HLS CDNs (notably AcFun's tx-safety-video endpoint) put
  // authorization tokens on the playlist URL while using relative URIs for
  // variants, init maps and media segments. URL resolution intentionally drops
  // the parent's query string, which makes those child requests fail. Carry the
  // known signing parameters forward for same-origin child resources unless the
  // child URI already supplied its own value.
  if (resolved.origin === base.origin) {
    for (const [key, value] of base.searchParams) {
      if (HLS_INHERITED_QUERY_PARAMS.has(key) && !resolved.searchParams.has(key)) {
        resolved.searchParams.set(key, value);
      }
    }
  }

  return resolved.href;
}

export function parseHlsPlaylist(text: string, playlistUrl: string): HlsPlaylist {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0] !== '#EXTM3U') {
    throw new Error(t('errorHlsInvalidPlaylist'));
  }

  const variants: HlsVariant[] = [];
  let pendingVariant: Record<string, string> | null = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (pendingVariant && !line.startsWith('#')) {
      const resolution = parseResolution(pendingVariant.RESOLUTION);
      variants.push({
        url: absoluteUrl(line, playlistUrl),
        bandwidth: parsePositiveNumber(pendingVariant.BANDWIDTH),
        averageBandwidth: parsePositiveNumber(pendingVariant['AVERAGE-BANDWIDTH']),
        width: resolution.width,
        height: resolution.height,
        codecs: pendingVariant.CODECS,
        audioGroup: pendingVariant.AUDIO
      });
      pendingVariant = null;
    }
  }

  if (variants.length > 0) {
    return { kind: 'master', variants };
  }

  let targetDuration = 6;
  let mediaSequence = 0;
  let playlistType: 'EVENT' | 'VOD' | undefined;
  let endList = false;
  let encrypted = false;
  let encryptionMethod: string | undefined;
  let pendingDuration: number | null = null;
  let pendingByteRange: HlsByteRange | undefined;
  let currentMap: HlsMap | undefined;
  let pendingDiscontinuity = false;
  let previousRangeUrl: string | null = null;
  let previousRangeEnd: number | undefined;
  const segments: HlsSegment[] = [];

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parsePositiveNumber(line.slice('#EXT-X-TARGETDURATION:'.length)) ?? targetDuration;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Math.floor(parsePositiveNumber(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) ?? 0);
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const type = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
      if (type === 'EVENT' || type === 'VOD') playlistType = type;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = attrs.METHOD?.toUpperCase();
      if (method && method !== 'NONE') {
        encrypted = true;
        encryptionMethod = method;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        currentMap = {
          url: absoluteUrl(attrs.URI, playlistUrl),
          byteRange: parseByteRange(attrs.BYTERANGE)
        };
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const rawDuration = line.slice('#EXTINF:'.length).split(',', 1)[0];
      pendingDuration = parsePositiveNumber(rawDuration) ?? 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pendingDuration == null) continue;

    const url = absoluteUrl(line, playlistUrl);
    let byteRange = pendingByteRange;
    if (byteRange && byteRange.offset == null && previousRangeUrl === url && previousRangeEnd != null) {
      byteRange = { ...byteRange, offset: previousRangeEnd };
    }
    if (byteRange?.offset != null) {
      previousRangeUrl = url;
      previousRangeEnd = byteRange.offset + byteRange.length;
    } else {
      previousRangeUrl = null;
      previousRangeEnd = undefined;
    }

    segments.push({
      sequence: mediaSequence + segments.length,
      url,
      duration: pendingDuration,
      byteRange,
      map: currentMap,
      discontinuity: pendingDiscontinuity
    });

    pendingDuration = null;
    pendingByteRange = undefined;
    pendingDiscontinuity = false;
  }

  return {
    kind: 'media',
    targetDuration: Math.max(1, targetDuration),
    mediaSequence,
    playlistType,
    endList,
    encrypted,
    encryptionMethod,
    segments
  };
}

function variantScore(variant: HlsVariant): number {
  return variant.averageBandwidth ?? variant.bandwidth ?? ((variant.width ?? 0) * (variant.height ?? 0));
}

export function selectBestVariant(variants: HlsVariant[]): HlsVariant | undefined {
  return [...variants].sort((a, b) => variantScore(b) - variantScore(a))[0];
}

export function hlsVariantKey(variant: HlsVariant): string {
  return [
    variant.width ?? 0,
    variant.height ?? 0,
    variant.averageBandwidth ?? variant.bandwidth ?? 0,
    variant.codecs ?? '',
    variant.audioGroup ?? ''
  ].join('|');
}

function findVariant(variants: HlsVariant[], preferredVariantKey?: string): HlsVariant | undefined {
  if (preferredVariantKey) {
    const exact = variants.find((variant) => hlsVariantKey(variant) === preferredVariantKey);
    if (exact) return exact;
  }
  return selectBestVariant(variants);
}

function inferOutput(media: HlsMediaPlaylist): Pick<HlsProbe, 'outputExtension' | 'mimeType'> {
  const first = media.segments[0];
  const lower = first?.url.toLowerCase() ?? '';
  if (first?.map || /\.(m4s|mp4|cmfv)(?:\?|$)/i.test(lower)) {
    return { outputExtension: 'mp4', mimeType: 'video/mp4' };
  }
  return { outputExtension: 'ts', mimeType: 'video/mp2t' };
}

export async function probeHls(
  sourceUrl: string,
  fetchText: (url: string) => Promise<string>,
  preferredVariantKey?: string
): Promise<HlsProbe> {
  const sourceText = await fetchText(sourceUrl);
  const source = parseHlsPlaylist(sourceText, sourceUrl);

  let mediaUrl = sourceUrl;
  let variant: HlsVariant | undefined;
  let variants: HlsVariant[] = [];
  let media: HlsMediaPlaylist;

  if (source.kind === 'master') {
    variants = source.variants;
    variant = findVariant(variants, preferredVariantKey);
    if (!variant) throw new Error(t('errorHlsNoVariant'));
    mediaUrl = variant.url;
    const mediaText = await fetchText(mediaUrl);
    const parsed = parseHlsPlaylist(mediaText, mediaUrl);
    if (parsed.kind !== 'media') {
      throw new Error(t('errorHlsNestedMaster'));
    }
    media = parsed;
  } else {
    media = source;
  }

  const output = inferOutput(media);
  return {
    sourceUrl,
    mediaUrl,
    media,
    variants,
    variant,
    variantKey: variant ? hlsVariantKey(variant) : undefined,
    isLive: !media.endList,
    outputExtension: output.outputExtension,
    mimeType: output.mimeType,
    separateAudio: Boolean(variant?.audioGroup)
  };
}
