import { BlobSource, Conversion, Input, MPEG_TS, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { t } from '../shared/i18n';
import type { MediaCandidate } from '../shared/media';
import { parseHlsPlaylist, probeHls, inferHlsOutput, type HlsByteRange, type HlsMediaPlaylist, type HlsProbe } from './hls-playlist';
import { saveLiveTask, type LiveTaskPhase, type LiveTaskRecord, type StoredDirectoryHandle, type StoredFileHandle } from './live-task-store';
import { installPlaybackContextRule, removePlaybackContextRule } from './playback-context';
import { assertNotAborted, HlsProcessingError } from './hls-encryption';
import { fetchHlsBytes, retryHls, waitHls } from './hls-http';
import { HlsKeyManager } from './hls-key-manager';
import { writeHlsSegment, type HlsWriteState } from './hls-segment-writer';

export type LiveRecorderStage = 'preparing' | 'fetching-key' | 'decrypting' | 'recording' | 'waiting' | 'stopping' | 'remuxing' | 'completed';
export interface LiveRecorderProgress {
  stage: LiveRecorderStage;
  startedAt: number;
  bytesWritten: number;
  segmentsWritten: number;
  retryCount: number;
  lastSequence?: number;
  targetDuration: number;
  finalBytesWritten?: number;
  finalizeProgress?: number;
}
export interface HlsRecordingResult {
  taskId: string;
  bytesWritten: number;
  segmentsWritten: number;
  lastSequence?: number;
  stoppedByUser: boolean;
  endedNaturally: boolean;
  finalFileName?: string;
}
export interface ProbeHlsCandidateOptions { candidate: MediaCandidate; sourcePageUrl?: string; preferredVariantKey?: string; }
export interface RecordHlsOptions extends ProbeHlsCandidateOptions {
  probe: HlsProbe;
  suggestedName: string;
  signal?: AbortSignal;
  onProgress?: (progress: LiveRecorderProgress) => void;
}
export interface ResumeHlsOptions extends ProbeHlsCandidateOptions {
  task: LiveTaskRecord;
  signal?: AbortSignal;
  onProgress?: (progress: LiveRecorderProgress) => void;
}
interface SaveFilePickerOptionsLike { suggestedName?: string; types?: Array<{ description?: string; accept: Record<string, string[]> }>; }
type ShowSaveFilePicker = (options?: SaveFilePickerOptionsLike) => Promise<StoredFileHandle>;
type ShowDirectoryPicker = (options?: { id?: string; mode?: 'readwrite' }) => Promise<StoredDirectoryHandle>;
interface RecordingSessionOptions extends ProbeHlsCandidateOptions {
  taskId: string;
  fileHandle: StoredFileHandle;
  directoryHandle?: StoredDirectoryHandle;
  workingFileName?: string;
  finalFileName?: string;
  suggestedName: string;
  probe: HlsProbe;
  mediaUrl: string;
  startedAt: number;
  initialBytesWritten: number;
  initialSegmentsWritten: number;
  initialRetryCount: number;
  initialLastSequence?: number;
  initialLastMapKey?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: LiveRecorderProgress) => void;
}

function ensureMp4Name(value: string): string { return value.replace(/\.(?:ts|mp4)$/i, '') + '.mp4'; }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function checkProbe(probe: HlsProbe): void {
  if (probe.media.encryptionError) throw new HlsProcessingError(probe.media.encryptionError);
  if (probe.separateAudio) throw new Error(t('errorHlsSeparateAudio'));
}
function mediaDomains(urls: string[]): string[] {
  return [...new Set(urls.flatMap((value) => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? [url.hostname] : []; }
    catch { return []; }
  }))];
}
function urlsInMedia(media: HlsMediaPlaylist): string[] {
  return media.segments.flatMap((segment) => [segment.url, ...(segment.map ? [segment.map.url] : [])]);
}
async function playbackRule(options: ProbeHlsCandidateOptions, urls: string[]): Promise<number | null> {
  return installPlaybackContextRule({ sourcePageUrl: options.sourcePageUrl,
    fallbackPageUrls: [options.candidate.pageUrl], requestDomains: mediaDomains(urls) });
}
async function ensureWritePermission(handle: StoredFileHandle | StoredDirectoryHandle): Promise<void> {
  const descriptor = { mode: 'readwrite' as const };
  const permission = await handle.queryPermission?.(descriptor);
  if (permission === 'granted' || permission == null) return;
  if (await handle.requestPermission?.(descriptor) !== 'granted') throw new Error(t('errorHlsResumePermission'));
}
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  return new TextDecoder().decode(await fetchHlsBytes(url, { signal, maxBytes: 4 * 1024 * 1024 }));
}
async function fetchBytes(url: string, byteRange: HlsByteRange | undefined, signal: AbortSignal | undefined, onRetry: () => void): Promise<Uint8Array> {
  if (byteRange && byteRange.offset == null) throw new Error(t('errorHlsImplicitByteRange'));
  const range = byteRange ? { offset: byteRange.offset!, length: byteRange.length } : undefined;
  return retryHls(() => fetchHlsBytes(url, { signal, range, maxBytes: 64 * 1024 * 1024 }), signal, onRetry);
}
export async function probeHlsCandidate(options: ProbeHlsCandidateOptions): Promise<HlsProbe> {
  return probeHls(options.candidate.url, async (url) => {
    const ruleId = await playbackRule(options, [url]);
    try { return await fetchText(url); } finally { await removePlaybackContextRule(ruleId); }
  }, options.preferredVariantKey);
}

async function remuxTsToMp4(task: LiveTaskRecord, onProgress?: (bytes: number, progress?: number) => void): Promise<string> {
  const directory = task.directoryHandle;
  const finalFileName = task.finalFileName ?? ensureMp4Name(task.suggestedName);
  if (!directory || !task.fileHandle.getFile) throw new Error(t('errorHlsRemuxUnavailable'));
  await ensureWritePermission(task.fileHandle);
  await ensureWritePermission(directory);
  const sourceFile = await task.fileHandle.getFile();
  if (sourceFile.size < task.bytesWritten) throw new HlsProcessingError('errorHlsResumeFile');
  const finalHandle = await directory.getFileHandle(finalFileName, { create: true });
  const writable = await finalHandle.createWritable();
  const input = new Input({ formats: [MPEG_TS], source: new BlobSource(sourceFile.slice(0, task.bytesWritten)) });
  const target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true, chunkSize: 8 * 1024 * 1024 });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }), target });
  let finalBytesWritten = 0;
  target.on('write', ({ end }) => { finalBytesWritten = Math.max(finalBytesWritten, end); onProgress?.(finalBytesWritten); });
  try {
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) throw new Error(t('errorHlsRemuxUnsupported'));
    conversion.onProgress = (progress) => onProgress?.(finalBytesWritten, progress);
    await conversion.execute();
    return finalFileName;
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    await directory.removeEntry?.(finalFileName).catch(() => undefined);
    throw error;
  } finally { input.dispose(); }
}
async function removeWorkingFile(task: LiveTaskRecord): Promise<void> {
  if (task.workingFileName) await task.directoryHandle?.removeEntry?.(task.workingFileName).catch(() => undefined);
}
async function withTaskLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return operation();
  return navigator.locks.request(`media-downloader-hls:${id}`, { ifAvailable: true }, (lock) => {
    if (!lock) throw new HlsProcessingError('errorHlsTaskBusy');
    return operation();
  });
}

async function runRecording(options: RecordingSessionOptions): Promise<HlsRecordingResult> {
  return withTaskLock(options.taskId, async () => {
    checkProbe(options.probe);
    if (options.initialLastSequence != null && !Number.isSafeInteger(options.initialLastSequence)) throw new HlsProcessingError('errorHlsSequence');
    let state: HlsWriteState = { bytesWritten: options.initialBytesWritten, segmentsWritten: options.initialSegmentsWritten,
      lastSequence: options.initialLastSequence, lastMapKey: options.initialLastMapKey ?? null };
    let retryCount = options.initialRetryCount;
    let mediaUrl = options.mediaUrl;
    let media = options.probe.media;
    let phase: LiveTaskPhase = 'capture';
    let finalBytesWritten = 0;
    let finalizeProgress: number | undefined;
    let stoppedByUser = false;
    let endedNaturally = false;
    let ruleId: number | null = null;
    const snapshot = (status: LiveTaskRecord['status'], error?: string, next = state): LiveTaskRecord => ({
      id: options.taskId, sourceUrl: options.probe.sourceUrl, mediaUrl, sourcePageUrl: options.sourcePageUrl,
      suggestedName: options.suggestedName, outputExtension: options.probe.outputExtension, variantKey: options.probe.variantKey,
      phase, workingFileName: options.workingFileName, finalFileName: options.finalFileName, directoryHandle: options.directoryHandle,
      status, startedAt: options.startedAt, updatedAt: Date.now(), ...next, retryCount, error, fileHandle: options.fileHandle
    });
    const report = (stage: LiveRecorderStage) => options.onProgress?.({ stage, startedAt: options.startedAt,
      ...state, retryCount, targetDuration: media.targetDuration, finalBytesWritten, finalizeProgress });
    const onRetry = () => { retryCount += 1; report('waiting'); };
    const removeRule = async () => { await removePlaybackContextRule(ruleId); ruleId = null; };
    const setMediaRule = async () => {
      await removeRule();
      ruleId = await playbackRule(options, [options.probe.sourceUrl, mediaUrl, ...urlsInMedia(media)]);
    };
    const keys = new HlsKeyManager({ signal: options.signal, onLoading: () => report('fetching-key'), onRetry,
      beforeRequest: removeRule, afterRequest: async () => { if (!options.signal?.aborted) await setMediaRule(); } });
    const validateMedia = () => {
      if (media.encryptionError) throw new HlsProcessingError(media.encryptionError);
      if (media.segments.length && inferHlsOutput(media).outputExtension !== options.probe.outputExtension) throw new Error(t('errorHlsResumeFormatChanged'));
    };
    const refresh = async (): Promise<HlsMediaPlaylist> => {
      for (;;) {
        assertNotAborted(options.signal);
        try {
          const parsed = parseHlsPlaylist(await fetchText(mediaUrl, options.signal), mediaUrl);
          if (parsed.kind !== 'media') throw new Error(t('errorHlsNestedMaster'));
          return parsed;
        } catch (error) {
          if (!(error instanceof HlsProcessingError) || !error.retryable) throw error;
          onRetry();
          try {
            const refreshed = await probeHls(options.probe.sourceUrl, (url) => fetchText(url, options.signal), options.probe.variantKey);
            checkProbe(refreshed);
            if (refreshed.outputExtension !== options.probe.outputExtension) throw new Error(t('errorHlsResumeFormatChanged'));
            mediaUrl = refreshed.mediaUrl;
            return refreshed.media;
          } catch (retryError) {
            if (!(retryError instanceof HlsProcessingError) || !retryError.retryable) throw retryError;
          }
          await waitHls(5000, options.signal);
        }
      }
    };
    const write = async (segment: HlsMediaPlaylist['segments'][number]) => {
      state = await writeHlsSegment({ segment, state, file: options.fileHandle, keys, signal: options.signal,
        fetchBytes: (url, range) => fetchBytes(url, range, options.signal, onRetry),
        onDecrypting: () => report('decrypting'), checkpoint: (next) => saveLiveTask(snapshot('recording', undefined, next)) });
      report('recording');
    };
    try {
      report('preparing');
      await saveLiveTask(snapshot('recording'));
      await setMediaRule();
      // Re-read a possibly stale popup probe before choosing the live start window.
      media = await refresh();
      validateMedia();
      await setMediaRule();
      keys.beginPlaylist();
      let pending = state.lastSequence == null
        ? (options.probe.isLive ? media.segments.slice(-3) : media.segments)
        : media.segments.filter((segment) => segment.sequence > state.lastSequence!);
      try {
        for (;;) {
          for (const segment of pending) { assertNotAborted(options.signal); await write(segment); }
          if (media.endList) { endedNaturally = true; break; }
          report('waiting');
          await waitHls(Math.max(1000, Math.min(10000, media.targetDuration * 600)), options.signal);
          media = await refresh();
          validateMedia();
          await setMediaRule();
          keys.beginPlaylist();
          pending = media.segments.filter((segment) => state.lastSequence == null || segment.sequence > state.lastSequence);
        }
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) stoppedByUser = true;
        else throw error;
      }
      keys.dispose();
      if (state.segmentsWritten === 0) throw new HlsProcessingError('errorHlsNothingRecorded');
      report('stopping');
      if (options.probe.outputExtension === 'ts' && options.directoryHandle && options.finalFileName) {
        phase = 'remux';
        await saveLiveTask(snapshot('recording'));
        report('remuxing');
        options.finalFileName = await remuxTsToMp4(snapshot('recording'), (bytes, progress) => {
          finalBytesWritten = bytes;
          if (progress != null) finalizeProgress = progress;
          report('remuxing');
        });
      }
      const completed = snapshot(stoppedByUser ? 'stopped' : 'completed');
      await saveLiveTask(completed);
      if (phase === 'remux') await removeWorkingFile(completed);
      report('completed');
      return { taskId: options.taskId, ...state, stoppedByUser, endedNaturally, finalFileName: options.finalFileName ?? options.suggestedName };
    } catch (error) {
      await saveLiveTask(snapshot('failed', error instanceof Error ? error.message : t('errorHlsRequestFailed'))).catch(() => undefined);
      throw error;
    } finally {
      keys.dispose();
      await removeRule();
    }
  });
}

export async function recordHlsLive(options: RecordHlsOptions): Promise<HlsRecordingResult> {
  // Keep the save picker directly in the user gesture; no prior network awaits.
  checkProbe(options.probe);
  assertNotAborted(options.signal);
  const taskId = crypto.randomUUID();
  const finalFileName = ensureMp4Name(options.suggestedName);
  const common = { ...options, taskId, finalFileName, suggestedName: finalFileName, mediaUrl: options.probe.mediaUrl,
    startedAt: Date.now(), initialBytesWritten: 0, initialSegmentsWritten: 0, initialRetryCount: 0 };
  if (options.probe.outputExtension === 'ts') {
    const picker = (globalThis as typeof globalThis & { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker;
    if (!picker) throw new Error(t('errorDirectoryPickerUnavailable'));
    const directoryHandle = await picker({ id: 'video-helper-live', mode: 'readwrite' });
    const workingFileName = `video-helper-${taskId}.partial.ts`;
    const fileHandle = await directoryHandle.getFileHandle(workingFileName, { create: true });
    const uniqueName = finalFileName.replace(/\.mp4$/i, `-${taskId.slice(0, 8)}.mp4`);
    return runRecording({ ...common, finalFileName: uniqueName, fileHandle, directoryHandle, workingFileName });
  }
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (!picker) throw new Error(t('errorFilePickerUnavailable'));
  const fileHandle = await picker({ suggestedName: finalFileName, types: [{ description: t('mp4Video'), accept: { 'video/mp4': ['.mp4'] } }] });
  return runRecording({ ...common, fileHandle });
}

async function resumeRemuxOnly(options: ResumeHlsOptions): Promise<HlsRecordingResult> {
  return withTaskLock(options.task.id, async () => {
    const task = options.task;
    if (!task.directoryHandle) throw new Error(t('errorHlsRemuxUnavailable'));
    await ensureWritePermission(task.fileHandle);
    await ensureWritePermission(task.directoryHandle);
    let finalBytesWritten = 0;
    let finalizeProgress: number | undefined;
    const report = (stage: LiveRecorderStage) => options.onProgress?.({ stage, startedAt: task.startedAt,
      bytesWritten: task.bytesWritten, segmentsWritten: task.segmentsWritten, retryCount: task.retryCount,
      lastSequence: task.lastSequence, targetDuration: 0, finalBytesWritten, finalizeProgress });
    try {
      report('remuxing');
      const finalFileName = await remuxTsToMp4(task, (bytes, progress) => {
        finalBytesWritten = bytes;
        if (progress != null) finalizeProgress = progress;
        report('remuxing');
      });
      await saveLiveTask({ ...task, phase: 'remux', status: 'completed', finalFileName, error: undefined, updatedAt: Date.now() });
      await removeWorkingFile(task);
      finalizeProgress = 1;
      report('completed');
      return { taskId: task.id, bytesWritten: task.bytesWritten, segmentsWritten: task.segmentsWritten,
        lastSequence: task.lastSequence, stoppedByUser: false, endedNaturally: false, finalFileName };
    } catch (error) {
      await saveLiveTask({ ...task, phase: 'remux', status: 'failed',
        error: error instanceof Error ? error.message : t('errorHlsRequestFailed'), updatedAt: Date.now() }).catch(() => undefined);
      throw error;
    }
  });
}

export async function resumeHlsLive(options: ResumeHlsOptions): Promise<HlsRecordingResult> {
  if (options.task.phase === 'remux') return resumeRemuxOnly(options);
  await ensureWritePermission(options.task.fileHandle);
  if (options.task.directoryHandle) await ensureWritePermission(options.task.directoryHandle);
  const sourcePageUrl = options.sourcePageUrl ?? options.task.sourcePageUrl;
  const probe = await probeHlsCandidate({ ...options, sourcePageUrl, preferredVariantKey: options.task.variantKey });
  if (probe.outputExtension !== options.task.outputExtension) throw new Error(t('errorHlsResumeFormatChanged'));
  return runRecording({ ...options, sourcePageUrl, taskId: options.task.id, fileHandle: options.task.fileHandle,
    directoryHandle: options.task.directoryHandle, workingFileName: options.task.workingFileName,
    finalFileName: options.task.finalFileName, suggestedName: options.task.suggestedName,
    probe, mediaUrl: probe.mediaUrl, startedAt: options.task.startedAt,
    initialBytesWritten: options.task.bytesWritten, initialSegmentsWritten: options.task.segmentsWritten,
    initialRetryCount: options.task.retryCount, initialLastSequence: options.task.lastSequence, initialLastMapKey: options.task.lastMapKey });
}
