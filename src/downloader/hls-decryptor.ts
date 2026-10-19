import { assertNotAborted, encryptionIv, HlsProcessingError, type HlsEncryption } from './hls-encryption';

/** Structural sanity check only; CBC is not authenticated encryption. */
export function assertMpegTs(bytes: Uint8Array): void {
  if (bytes.byteLength < 188 || bytes.byteLength % 188 !== 0) throw new HlsProcessingError('errorHlsDecryptedMedia');
  for (let i = 0; i < bytes.byteLength; i += 188) {
    if (bytes[i] !== 0x47) throw new HlsProcessingError('errorHlsDecryptedMedia');
  }
}

export async function decryptHlsSegment(ciphertext: Uint8Array, encryption: HlsEncryption,
  sequence: number, key: CryptoKey, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  assertNotAborted(signal);
  if (!ciphertext.byteLength || ciphertext.byteLength % 16 !== 0) throw new HlsProcessingError('errorHlsCiphertext');
  const iv = encryptionIv(encryption, sequence);
  let plaintext: ArrayBuffer;
  try {
    // Web Crypto validates and removes PKCS#7. Do not remove padding twice.
    plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, Uint8Array.from(ciphertext));
  } catch {
    assertNotAborted(signal);
    throw new HlsProcessingError('errorHlsDecryptFailed');
  }
  assertNotAborted(signal);
  const bytes = new Uint8Array(plaintext);
  assertMpegTs(bytes);
  return bytes;
}
