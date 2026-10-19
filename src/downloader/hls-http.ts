import { assertNotAborted, HlsProcessingError } from './hls-encryption';

interface HlsFetchOptions {
  signal?: AbortSignal;
  maxBytes: number;
  timeoutMs?: number;
  range?: { offset: number; length: number };
  keyRequest?: boolean;
  fetcher?: typeof fetch;
}

/** Bounded streaming reads, timeout and errors which never contain signed URLs. */
export async function fetchHlsBytes(url: string, options: HlsFetchOptions): Promise<Uint8Array<ArrayBuffer>> {
  assertNotAborted(options.signal);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    const range = options.range;
    const headers = new Headers();
    if (range) headers.set('Range', `bytes=${range.offset}-${range.offset + range.length - 1}`);
    response = await (options.fetcher ?? fetch)(url, {
      credentials: 'include', cache: 'no-store', signal: controller.signal, headers,
      redirect: options.keyRequest ? 'error' : 'follow', referrerPolicy: 'no-referrer'
    });
    if (!response.ok) {
      const code = options.keyRequest
        ? (response.status === 401 || response.status === 403 ? 'errorHlsKeyAccess' : 'errorHlsKeyHttp')
        : 'errorHlsResourceHttp';
      throw new HlsProcessingError(code, String(response.status), response.status === 408 || response.status === 429 || response.status >= 500);
    }
    if (range) {
      const expected = `bytes ${range.offset}-${range.offset + range.length - 1}/`;
      if (response.status !== 206 || !response.headers.get('content-range')?.startsWith(expected)) throw new HlsProcessingError('errorHlsByteRange');
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > options.maxBytes) throw new HlsProcessingError(options.keyRequest ? 'errorHlsKeyLength' : 'errorHlsResourceSize');
    if (!response.body) throw new HlsProcessingError('errorHlsResourceEmpty');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      assertNotAborted(options.signal);
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) throw new HlsProcessingError(options.keyRequest ? 'errorHlsKeyLength' : 'errorHlsResourceSize');
      chunks.push(value);
    }
    if (range && size !== range.length) throw new HlsProcessingError('errorHlsByteRange');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    assertNotAborted(options.signal);
    if (error instanceof HlsProcessingError) throw error;
    throw new HlsProcessingError(timedOut ? 'errorHlsRequestTimeout' : 'errorHlsRequestFailed', undefined, true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else await response?.body?.cancel().catch(() => undefined);
  }
}

export function waitHls(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Canceled.', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function retryHls<T>(operation: () => Promise<T>, signal?: AbortSignal, onRetry?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    assertNotAborted(signal);
    try { return await operation(); } catch (error) {
      assertNotAborted(signal);
      if (!(error instanceof HlsProcessingError) || !error.retryable || attempt >= 2) throw error;
      onRetry?.();
      await waitHls(500 * (2 ** attempt), signal);
    }
  }
}
