import { t } from '../shared/i18n';

/** Metadata only. Raw keys must never enter a playlist or checkpoint. */
export interface HlsEncryption {
  method: string;
  keyFormat: string;
  keyFormatVersions?: string;
  uri?: string;
  iv?: string;
  epoch: string;
}

export class HlsProcessingError extends Error {
  constructor(public readonly code: string, substitutions?: string | string[], public readonly retryable = false) {
    super(t(code, substitutions));
    this.name = 'HlsProcessingError';
  }
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(t('errorDownloadCanceled'), 'AbortError');
}

export function parseHlsSequence(raw: string): number {
  if (!/^\d+$/.test(raw) || raw.length > 20) throw new HlsProcessingError('errorHlsSequence');
  const value = BigInt(raw);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new HlsProcessingError('errorHlsSequence');
  return Number(value);
}

/** RFC 8216 section 5.2: explicit IV, or the original sequence in big-endian. */
export function encryptionIv(encryption: HlsEncryption, sequence: number): Uint8Array<ArrayBuffer> {
  let value: bigint;
  if (encryption.iv !== undefined) {
    if (!/^0[xX][0-9a-fA-F]{1,32}$/.test(encryption.iv)) throw new HlsProcessingError('errorHlsIv');
    value = BigInt(encryption.iv);
  } else {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new HlsProcessingError('errorHlsSequence');
    value = BigInt(sequence);
  }
  const iv = new Uint8Array(16);
  for (let i = 15; i >= 0; i -= 1) { iv[i] = Number(value & 255n); value >>= 8n; }
  return iv;
}

export function resolveKeyUri(value: string, playlistUrl: string): string {
  try {
    if (!value.trim()) throw new Error();
    const base = new URL(playlistUrl);
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (base.protocol === 'https:' && url.protocol !== 'https:')) throw new Error();
    url.hash = '';
    // Deliberately do not inherit playlist signing parameters or embedded credentials.
    return url.href;
  } catch { throw new HlsProcessingError('errorHlsKeyUri'); }
}

export interface EncryptedResource {
  url: string;
  encryption?: HlsEncryption;
  byteRange?: { length: number; offset?: number };
  map?: { encryption?: HlsEncryption };
}

/** Initial supported profile: complete identity AES-128 MPEG-TS segments. */
export function encryptionIssue(resource: EncryptedResource): string | undefined {
  const keys = [resource.encryption, resource.map?.encryption].filter((key): key is HlsEncryption => Boolean(key));
  for (const key of keys) {
    if (key.method !== 'AES-128') return 'errorHlsEncryptionMethod';
    if (key.keyFormat !== 'identity' || (key.keyFormatVersions !== undefined && key.keyFormatVersions !== '1')) return 'errorHlsKeyFormat';
    if (!key.uri) return 'errorHlsKeyUri';
    if (key.iv !== undefined && !/^0[xX][0-9a-fA-F]{1,32}$/.test(key.iv)) return 'errorHlsIv';
  }
  if (keys.length && resource.map) return 'errorHlsEncryptedFmp4';
  if (keys.length && resource.byteRange) return 'errorHlsEncryptedByteRange';
  if (keys.length && /\.(m4s|mp4|cmfv|cmfa)(?:[?#]|$)/i.test(resource.url)) return 'errorHlsEncryptedFmp4';
  return undefined;
}

export function assertEncryptionSupported(resource: EncryptedResource): void {
  const issue = encryptionIssue(resource);
  if (issue) throw new HlsProcessingError(issue);
}
