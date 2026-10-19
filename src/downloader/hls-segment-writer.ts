import { assertEncryptionSupported, assertNotAborted, HlsProcessingError } from './hls-encryption';
import { decryptHlsSegment } from './hls-decryptor';
import type { HlsKeyManager } from './hls-key-manager';
import type { HlsByteRange, HlsSegment } from './hls-playlist';
import type { StoredFileHandle } from './live-task-store';

export interface HlsWriteState {
  bytesWritten: number;
  segmentsWritten: number;
  lastSequence?: number;
  lastMapKey: string | null;
}

/** Prepare one complete segment before any disk write. Checkpoint only after close. */
export async function writeHlsSegment(options: {
  segment: HlsSegment;
  state: HlsWriteState;
  file: StoredFileHandle;
  keys: HlsKeyManager;
  fetchBytes: (url: string, range?: HlsByteRange) => Promise<Uint8Array>;
  checkpoint: (next: HlsWriteState) => Promise<void>;
  signal?: AbortSignal;
  onDecrypting?: () => void;
}): Promise<HlsWriteState> {
  const { segment, state } = options;
  assertNotAborted(options.signal);
  assertEncryptionSupported(segment);
  if (state.lastSequence != null && segment.sequence !== state.lastSequence + 1) throw new HlsProcessingError('errorHlsSegmentGap');
  if (state.segmentsWritten > 0 && segment.discontinuity) throw new HlsProcessingError('errorHlsDiscontinuity');
  const mapKey = segment.map ? `${segment.map.url}|${segment.map.byteRange?.offset ?? ''}|${segment.map.byteRange?.length ?? ''}` : null;
  if (state.segmentsWritten > 0 && mapKey !== state.lastMapKey) throw new HlsProcessingError('errorHlsMapChanged');
  const mapBytes = segment.map && mapKey !== state.lastMapKey ? await options.fetchBytes(segment.map.url, segment.map.byteRange) : null;
  const key = segment.encryption ? await options.keys.get(segment.encryption) : null;
  let bytes = await options.fetchBytes(segment.url, segment.byteRange);
  if (segment.encryption && key) {
    options.onDecrypting?.();
    bytes = await decryptHlsSegment(bytes, segment.encryption, segment.sequence, key, options.signal);
  }
  assertNotAborted(options.signal);
  if (!bytes.byteLength) throw new HlsProcessingError('errorHlsResourceEmpty');
  const next: HlsWriteState = { bytesWritten: state.bytesWritten + (mapBytes?.byteLength ?? 0) + bytes.byteLength,
    segmentsWritten: state.segmentsWritten + 1, lastSequence: segment.sequence, lastMapKey: mapKey };
  if (!Number.isSafeInteger(next.bytesWritten)) throw new HlsProcessingError('errorHlsResourceSize');
  const existing = await options.file.getFile?.();
  if (state.bytesWritten > 0 && (!existing || existing.size < state.bytesWritten)) throw new HlsProcessingError('errorHlsResumeFile');
  const writable = await options.file.createWritable({ keepExistingData: state.bytesWritten > 0 });
  try {
    if (state.bytesWritten > 0) {
      // A crash between file close and IndexedDB commit may leave an extra tail.
      if (existing && existing.size > state.bytesWritten && !writable.truncate) throw new HlsProcessingError('errorHlsResumeFile');
      await writable.truncate?.(state.bytesWritten);
      await writable.seek(state.bytesWritten);
    }
    if (mapBytes) await writable.write(mapBytes);
    await writable.write(bytes);
    assertNotAborted(options.signal);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    assertNotAborted(options.signal);
    if (error instanceof HlsProcessingError) throw error;
    throw new HlsProcessingError('errorHlsWriteFailed');
  }
  await options.checkpoint(next);
  return next;
}
