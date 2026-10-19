import { assertNotAborted, assertEncryptionSupported, resolveKeyUri, HlsProcessingError, type HlsEncryption } from './hls-encryption';
import { fetchHlsBytes, retryHls } from './hls-http';

interface KeyManagerOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onLoading?: () => void;
  onRetry?: () => void;
  /** Suspend task-specific media header rules while retrieving a key. */
  beforeRequest?: () => Promise<void>;
  afterRequest?: () => Promise<void>;
}

/** Task-local, bounded, non-extractable keys. No persistence and no key logging. */
export class HlsKeyManager {
  private readonly cache = new Map<string, Promise<CryptoKey>>();
  private disposed = false;
  constructor(private readonly options: KeyManagerOptions = {}) {}
  beginPlaylist(): void { this.cache.clear(); }
  dispose(): void { this.disposed = true; this.cache.clear(); }

  async get(encryption: HlsEncryption): Promise<CryptoKey> {
    assertNotAborted(this.options.signal);
    if (this.disposed) throw new DOMException('Key manager closed.', 'AbortError');
    assertEncryptionSupported({ url: '', encryption });
    const uri = resolveKeyUri(encryption.uri!, encryption.uri!);
    const id = JSON.stringify([uri, encryption.epoch, encryption.keyFormatVersions]);
    let promise = this.cache.get(id);
    if (!promise) {
      promise = this.load(uri);
      this.cache.set(id, promise);
      if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
    }
    try {
      const key = await promise;
      assertNotAborted(this.options.signal);
      if (this.disposed) throw new DOMException('Key manager closed.', 'AbortError');
      return key;
    } catch (error) {
      if (this.cache.get(id) === promise) this.cache.delete(id);
      throw error;
    }
  }

  private async load(uri: string): Promise<CryptoKey> {
    this.options.onLoading?.();
    await this.options.beforeRequest?.();
    let raw: Uint8Array<ArrayBuffer> | undefined;
    try {
      raw = await retryHls(() => fetchHlsBytes(uri, {
        keyRequest: true, maxBytes: 16, timeoutMs: 15_000,
        signal: this.options.signal, fetcher: this.options.fetcher
      }), this.options.signal, this.options.onRetry);
      if (raw.byteLength !== 16) throw new HlsProcessingError('errorHlsKeyLength');
      assertNotAborted(this.options.signal);
      return await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    } finally {
      raw?.fill(0);
      await this.options.afterRequest?.();
    }
  }
}
