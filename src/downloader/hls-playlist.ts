import { t } from '../shared/i18n';
import { encryptionIssue, HlsProcessingError, parseHlsSequence, resolveKeyUri, type HlsEncryption } from './hls-encryption';

export interface HlsByteRange { length: number; offset?: number; }
export interface HlsMap { url: string; byteRange?: HlsByteRange; encryption?: HlsEncryption; }
export interface HlsSegment {
  sequence: number;
  url: string;
  duration: number;
  byteRange?: HlsByteRange;
  map?: HlsMap;
  discontinuity: boolean;
  encryption?: HlsEncryption;
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
export interface HlsMasterPlaylist { kind: 'master'; variants: HlsVariant[]; }
export interface HlsMediaPlaylist {
  kind: 'media';
  targetDuration: number;
  mediaSequence: number;
  playlistType?: 'EVENT' | 'VOD';
  endList: boolean;
  encrypted: boolean;
  encryptionMethod?: string;
  encryptionError?: string;
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
      if (comma < 0) { value = raw.slice(index).trim(); index = raw.length; }
      else { value = raw.slice(index, comma).trim(); index = comma + 1; }
    }
    if (key) attributes[key.toUpperCase()] = value;
  }
  return attributes;
}

function parseResolution(value?: string): { width?: number; height?: number } {
  const match = value && /^(\d+)x(\d+)$/i.exec(value.trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : {};
}

function parseByteRange(value?: string): HlsByteRange | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) throw new HlsProcessingError('errorHlsByteRange');
  const length = Number(match[1]);
  const offset = match[2] == null ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || (offset !== undefined
    && (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + length)))) throw new HlsProcessingError('errorHlsByteRange');
  return { length, offset };
}

const HLS_INHERITED_QUERY_PARAMS = new Set(['pkey', 'safety_id']);
function absoluteUrl(value: string, baseUrl: string): string {
  const resolved = new URL(value, baseUrl);
  const base = new URL(baseUrl);
  // Preserve the existing same-origin CDN adapter for media only, never keys.
  if (resolved.origin === base.origin) {
    for (const [key, value] of base.searchParams) {
      if (HLS_INHERITED_QUERY_PARAMS.has(key) && !resolved.searchParams.has(key)) resolved.searchParams.set(key, value);
    }
  }
  return resolved.href;
}

export function parseHlsPlaylist(text: string, playlistUrl: string): HlsPlaylist {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error(t('errorHlsInvalidPlaylist'));
  const variants: HlsVariant[] = [];
  let pendingVariant: Record<string, string> | null = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (pendingVariant && !line.startsWith('#')) {
      variants.push({ url: absoluteUrl(line, playlistUrl), bandwidth: parsePositiveNumber(pendingVariant.BANDWIDTH),
        averageBandwidth: parsePositiveNumber(pendingVariant['AVERAGE-BANDWIDTH']),
        ...parseResolution(pendingVariant.RESOLUTION), codecs: pendingVariant.CODECS, audioGroup: pendingVariant.AUDIO });
      pendingVariant = null;
    }
  }
  if (variants.length > 0) return { kind: 'master', variants };

  let targetDuration = 6;
  let mediaSequence = 0;
  let playlistType: 'EVENT' | 'VOD' | undefined;
  let endList = false;
  let pendingDuration: number | null = null;
  let pendingByteRange: HlsByteRange | undefined;
  let currentMap: HlsMap | undefined;
  let pendingDiscontinuity = false;
  let previousRangeUrl: string | null = null;
  let previousRangeEnd: number | undefined;
  let keyDeclaration = 0;
  const activeKeys = new Map<string, HlsEncryption>();
  const segments: HlsSegment[] = [];
  const currentEncryption = (): HlsEncryption | undefined => {
    // Conservative initial profile: report simultaneous non-identity declarations.
    const key = [...activeKeys.values()].find((value) => value.method !== 'AES-128' || value.keyFormat !== 'identity')
      ?? activeKeys.get('identity');
    return key ? { ...key } : undefined;
  };

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parsePositiveNumber(line.slice('#EXT-X-TARGETDURATION:'.length)) ?? targetDuration;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseHlsSequence(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim());
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const type = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
      if (type === 'EVENT' || type === 'VOD') playlistType = type;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') { endList = true; continue; }
    if (line === '#EXT-X-DISCONTINUITY') { pendingDiscontinuity = true; continue; }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = attrs.METHOD?.toUpperCase();
      if (!method) throw new HlsProcessingError('errorHlsKeyTag');
      if (method === 'NONE') {
        if (Object.keys(attrs).length !== 1) throw new HlsProcessingError('errorHlsKeyTag');
        activeKeys.clear();
      } else {
        const keyFormat = attrs.KEYFORMAT ?? 'identity';
        const uri = attrs.URI && method === 'AES-128' && keyFormat === 'identity' ? resolveKeyUri(attrs.URI, playlistUrl) : attrs.URI;
        activeKeys.set(keyFormat, { method, keyFormat, uri, iv: attrs.IV,
          keyFormatVersions: attrs.KEYFORMATVERSIONS, epoch: `${mediaSequence}:${keyDeclaration++}` });
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (!attrs.URI) throw new HlsProcessingError('errorHlsKeyTag');
      currentMap = { url: absoluteUrl(attrs.URI, playlistUrl), byteRange: parseByteRange(attrs.BYTERANGE), encryption: currentEncryption() };
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) { pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length)); continue; }
    if (line.startsWith('#EXTINF:')) { pendingDuration = parsePositiveNumber(line.slice('#EXTINF:'.length).split(',', 1)[0]) ?? 0; continue; }
    if (line.startsWith('#') || pendingDuration == null) continue;
    const url = absoluteUrl(line, playlistUrl);
    let byteRange = pendingByteRange;
    if (byteRange && byteRange.offset == null && previousRangeUrl === url && previousRangeEnd != null) byteRange = { ...byteRange, offset: previousRangeEnd };
    if (byteRange?.offset != null) { previousRangeUrl = url; previousRangeEnd = byteRange.offset + byteRange.length; }
    else { previousRangeUrl = null; previousRangeEnd = undefined; }
    const sequence = mediaSequence + segments.length;
    if (!Number.isSafeInteger(sequence)) throw new HlsProcessingError('errorHlsSequence');
    segments.push({ sequence, url, duration: pendingDuration, byteRange, map: currentMap,
      discontinuity: pendingDiscontinuity, encryption: currentEncryption() });
    pendingDuration = null;
    pendingByteRange = undefined;
    pendingDiscontinuity = false;
  }
  const encryptedSegments = segments.filter((segment) => segment.encryption || segment.map?.encryption);
  const current = currentEncryption();
  const methods = new Set(encryptedSegments.flatMap((segment) => [segment.encryption?.method, segment.map?.encryption?.method].filter(Boolean)));
  if (current) methods.add(current.method);
  const encryptionError = segments.map(encryptionIssue).find(Boolean)
    ?? (current ? encryptionIssue({ url: playlistUrl, encryption: current }) : undefined);
  return { kind: 'media', targetDuration: Math.max(1, targetDuration), mediaSequence, playlistType, endList,
    encrypted: encryptedSegments.length > 0 || Boolean(current), encryptionMethod: [...methods].join(', ') || undefined,
    encryptionError, segments };
}

function variantScore(variant: HlsVariant): number {
  return variant.averageBandwidth ?? variant.bandwidth ?? ((variant.width ?? 0) * (variant.height ?? 0));
}
export function selectBestVariant(variants: HlsVariant[]): HlsVariant | undefined {
  return [...variants].sort((a, b) => variantScore(b) - variantScore(a))[0];
}
export function hlsVariantKey(variant: HlsVariant): string {
  return [variant.width ?? 0, variant.height ?? 0, variant.averageBandwidth ?? variant.bandwidth ?? 0,
    variant.codecs ?? '', variant.audioGroup ?? ''].join('|');
}
function findVariant(variants: HlsVariant[], preferredVariantKey?: string): HlsVariant | undefined {
  return (preferredVariantKey && variants.find((variant) => hlsVariantKey(variant) === preferredVariantKey)) || selectBestVariant(variants);
}
export function inferHlsOutput(media: HlsMediaPlaylist): Pick<HlsProbe, 'outputExtension' | 'mimeType'> {
  const first = media.segments[0];
  if (first?.map || /\.(m4s|mp4|cmfv)(?:\?|$)/i.test(first?.url ?? '')) return { outputExtension: 'mp4', mimeType: 'video/mp4' };
  return { outputExtension: 'ts', mimeType: 'video/mp2t' };
}
export async function probeHls(sourceUrl: string, fetchText: (url: string) => Promise<string>, preferredVariantKey?: string): Promise<HlsProbe> {
  const source = parseHlsPlaylist(await fetchText(sourceUrl), sourceUrl);
  let mediaUrl = sourceUrl;
  let variant: HlsVariant | undefined;
  let variants: HlsVariant[] = [];
  let media: HlsMediaPlaylist;
  if (source.kind === 'master') {
    variants = source.variants;
    variant = findVariant(variants, preferredVariantKey);
    if (!variant) throw new Error(t('errorHlsNoVariant'));
    mediaUrl = variant.url;
    const parsed = parseHlsPlaylist(await fetchText(mediaUrl), mediaUrl);
    if (parsed.kind !== 'media') throw new Error(t('errorHlsNestedMaster'));
    media = parsed;
  } else { media = source; }
  return { sourceUrl, mediaUrl, media, variants, variant, variantKey: variant ? hlsVariantKey(variant) : undefined,
    isLive: !media.endList, ...inferHlsOutput(media), separateAudio: Boolean(variant?.audioGroup) };
}
