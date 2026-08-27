import {
  BlobSource,
  Conversion,
  Input,
  MPEG_TS,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk
} from 'mediabunny';
import { t } from '../shared/i18n';
import type { MediaCandidate } from '../shared/media';
import {
  parseHlsPlaylist,
  probeHls,
  type HlsByteRange,
  type HlsMap,
  type HlsMediaPlaylist,
  type HlsProbe,
  type HlsSegment
} from './hls-playlist';
import {
  saveLiveTask,
  type LiveTaskPhase,
  type LiveTaskRecord,
  type StoredDirectoryHandle,
  type StoredFileHandle
} from './live-task-store';
import { installPlaybackContextRule, removePlaybackContextRule } from './playback-context';

export type LiveRecorderStage = 'preparing' | 'recording' | 'waiting' | 'stopping' | 'remuxing' | 'completed';

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

export interface ProbeHlsCandidateOptions {
  candidate: MediaCandidate;
  sourcePageUrl?: string;
  preferredVariantKey?: string;
}

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

interface SaveFilePickerOptionsLike {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface DirectoryPickerOptionsLike {
  id?: string;
  mode?: 'readwrite';
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptionsLike) => Promise<StoredFileHandle>;
type ShowDirectoryPicker = (options?: DirectoryPickerOptionsLike) => Promise<StoredDirectoryHandle>;

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
  initialPhase?: LiveTaskPhase;
  signal?: AbortSignal;
  onProgress?: (progress: LiveRecorderProgress) => void;
}

function getSaveFilePicker(): ShowSaveFilePicker | null {
  return (globalThis as typeof globalThis & { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker ?? null;
}

function getDirectoryPicker(): ShowDirectoryPicker | null {
  return (globalThis as typeof globalThis & { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker ?? null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException(t('errorDownloadCanceled'), 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException(t('errorDownloadCanceled'), 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function requestInit(signal?: AbortSignal, byteRange?: HlsByteRange): RequestInit {
  const headers = new Headers();
  if (byteRange) {
    if (byteRange.offset == null) throw new Error(t('errorHlsImplicitByteRange'));
    headers.set('Range', `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`);
  }
  return { credentials: 'include', cache: 'no-store', signal, headers };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, requestInit(signal));
  if (!response.ok) throw new Error(t('errorHttpFetch', [url, String(response.status)]));
  return response.text();
}

async function fetchBytes(
  url: string,
  byteRange: HlsByteRange | undefined,
  signal: AbortSignal | undefined,
  onRetry: () => void
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (signal?.aborted) throw new DOMException(t('errorDownloadCanceled'), 'AbortError');
    try {
      const response = await fetch(url, requestInit(signal, byteRange));
      if (!response.ok) throw new Error(t('errorHttpFetch', [url, String(response.status)]));
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      lastError = error;
      if (attempt === 4) break;
      onRetry();
      await wait(Math.min(8000, 500 * (2 ** attempt)), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function mapKey(map?: HlsMap): string | null {
  if (!map) return null;
  return `${map.url}|${map.byteRange?.offset ?? ''}|${map.byteRange?.length ?? ''}`;
}

function chooseInitialSegments(media: HlsMediaPlaylist, isLive: boolean): HlsSegment[] {
  if (!isLive) return media.segments;
  return media.segments.length <= 3 ? media.segments : media.segments.slice(-3);
}

function ensureMp4Name(value: string): string {
  return value.replace(/\.(?:ts|mp4)$/i, '') + '.mp4';
}

function workingTsName(taskId: string): string {
  return `video-helper-${taskId}.partial.ts`;
}

function mp4PickerType(): SaveFilePickerOptionsLike['types'] {
  return [{ description: t('mp4Video'), accept: { 'video/mp4': ['.mp4'] } }];
}

async function installHlsPlaybackRule(options: ProbeHlsCandidateOptions): Promise<number | null> {
  return installPlaybackContextRule({
    sourcePageUrl: options.sourcePageUrl,
    fallbackPageUrls: [options.candidate.pageUrl]
  });
}

async function ensureWritePermission(fileHandle: StoredFileHandle): Promise<void> {
  const descriptor = { mode: 'readwrite' as const };
  const current = await fileHandle.queryPermission?.(descriptor);
  if (current === 'granted' || current == null) return;
  const requested = await fileHandle.requestPermission?.(descriptor);
  if (requested !== 'granted') throw new Error(t('errorHlsResumePermission'));
}

async function ensureDirectoryWritePermission(directoryHandle: StoredDirectoryHandle): Promise<void> {
  const descriptor = { mode: 'readwrite' as const };
  const current = await directoryHandle.queryPermission?.(descriptor);
  if (current === 'granted' || current == null) return;
  const requested = await directoryHandle.requestPermission?.(descriptor);
  if (requested !== 'granted') throw new Error(t('errorHlsResumePermission'));
}

export async function probeHlsCandidate(options: ProbeHlsCandidateOptions): Promise<HlsProbe> {
  const ruleId = await installHlsPlaybackRule(options);
  try {
    return await probeHls(
      options.candidate.url,
      (url) => fetchText(url),
      options.preferredVariantKey
    );
  } finally {
    await removePlaybackContextRule(ruleId);
  }
}

async function remuxTsToMp4(
  task: LiveTaskRecord,
  onProgress?: (finalBytesWritten: number, progress?: number) => void
): Promise<string> {
  const directory = task.directoryHandle;
  const finalFileName = task.finalFileName ?? ensureMp4Name(task.suggestedName);
  if (!directory || !task.fileHandle.getFile) {
    throw new Error(t('errorHlsRemuxUnavailable'));
  }

  await ensureWritePermission(task.fileHandle);
  await ensureDirectoryWritePermission(directory);

  const sourceFile = await task.fileHandle.getFile();
  const finalHandle = await directory.getFileHandle(finalFileName, { create: true });
  const writable = await finalHandle.createWritable();
  const input = new Input({
    formats: [MPEG_TS],
    source: new BlobSource(sourceFile)
  });
  const target = new StreamTarget(
    writable as unknown as WritableStream<StreamTargetChunk>,
    { chunked: true, chunkSize: 8 * 1024 * 1024 }
  );
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 2
    }),
    target
  });

  let finalBytesWritten = 0;
  target.on('write', ({ end }) => {
    finalBytesWritten = Math.max(finalBytesWritten, end);
    onProgress?.(finalBytesWritten);
  });

  try {
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) throw new Error(t('errorHlsRemuxUnsupported'));
    conversion.onProgress = (progress) => onProgress?.(finalBytesWritten, progress);
    await conversion.execute();

    if (task.workingFileName && directory.removeEntry) {
      await directory.removeEntry(task.workingFileName).catch(() => undefined);
    }
    return finalFileName;
  } catch (error) {
    if (directory.removeEntry) {
      await directory.removeEntry(finalFileName).catch(() => undefined);
    }
    throw error;
  } finally {
    input.dispose();
  }
}

async function runRecording(options: RecordingSessionOptions): Promise<HlsRecordingResult> {
  if (options.probe.media.encrypted) {
    throw new Error(t('errorHlsEncrypted', options.probe.media.encryptionMethod ?? 'UNKNOWN'));
  }
  if (options.probe.separateAudio) throw new Error(t('errorHlsSeparateAudio'));

  const playbackRuleId = await installHlsPlaybackRule(options);
  let bytesWritten = options.initialBytesWritten;
  let segmentsWritten = options.initialSegmentsWritten;
  let retryCount = options.initialRetryCount;
  let lastSequence = options.initialLastSequence;
  let lastMapKey = options.initialLastMapKey ?? null;
  let mediaUrl = options.mediaUrl;
  let media = options.probe.media;
  let stoppedByUser = false;
  let endedNaturally = false;
  let phase: LiveTaskPhase = options.initialPhase ?? 'capture';
  let finalBytesWritten = 0;
  let finalizeProgress: number | undefined;

  const taskSnapshot = (status: LiveTaskRecord['status'], error?: string): LiveTaskRecord => ({
    id: options.taskId,
    sourceUrl: options.probe.sourceUrl,
    mediaUrl,
    sourcePageUrl: options.sourcePageUrl,
    suggestedName: options.suggestedName,
    outputExtension: options.probe.outputExtension,
    variantKey: options.probe.variantKey,
    phase,
    workingFileName: options.workingFileName,
    finalFileName: options.finalFileName,
    directoryHandle: options.directoryHandle,
    status,
    startedAt: options.startedAt,
    updatedAt: Date.now(),
    bytesWritten,
    segmentsWritten,
    retryCount,
    lastSequence,
    lastMapKey,
    error,
    fileHandle: options.fileHandle
  });

  const checkpoint = async (status: LiveTaskRecord['status'], error?: string) => {
    await saveLiveTask(taskSnapshot(status, error));
  };

  const report = (stage: LiveRecorderStage) => {
    options.onProgress?.({
      stage,
      startedAt: options.startedAt,
      bytesWritten,
      segmentsWritten,
      retryCount,
      lastSequence,
      targetDuration: media.targetDuration,
      finalBytesWritten,
      finalizeProgress
    });
  };

  const markRetry = () => {
    retryCount += 1;
    report('waiting');
  };

  const appendBytes = async (bytes: Uint8Array) => {
    try {
      const writable = await options.fileHandle.createWritable({ keepExistingData: bytesWritten > 0 });
      if (bytesWritten > 0) await writable.seek(bytesWritten);
      await writable.write(bytes);
      await writable.close();
      bytesWritten += bytes.byteLength;
    } catch (error) {
      throw new Error(t('errorHlsDiskWrite', error instanceof Error ? error.message : String(error)));
    }
  };

  const writeMapIfNeeded = async (segment: HlsSegment) => {
    const key = mapKey(segment.map);
    if (!segment.map || key === lastMapKey) return;
    const bytes = await fetchBytes(segment.map.url, segment.map.byteRange, options.signal, markRetry);
    await appendBytes(bytes);
    lastMapKey = key;
    await checkpoint('recording');
  };

  const writeSegment = async (segment: HlsSegment) => {
    await writeMapIfNeeded(segment);
    const bytes = await fetchBytes(segment.url, segment.byteRange, options.signal, markRetry);
    await appendBytes(bytes);
    segmentsWritten += 1;
    lastSequence = segment.sequence;
    await checkpoint('recording');
    report('recording');
  };

  const refreshMedia = async (): Promise<HlsMediaPlaylist> => {
    let attempt = 0;
    for (;;) {
      if (options.signal?.aborted) throw new DOMException(t('errorDownloadCanceled'), 'AbortError');
      try {
        const text = await fetchText(mediaUrl, options.signal);
        const parsed = parseHlsPlaylist(text, mediaUrl);
        if (parsed.kind !== 'media') throw new Error(t('errorHlsNestedMaster'));
        return parsed;
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) throw error;
        markRetry();
        attempt += 1;
        try {
          const refreshed = await probeHls(
            options.probe.sourceUrl,
            (url) => fetchText(url, options.signal),
            options.probe.variantKey
          );
          mediaUrl = refreshed.mediaUrl;
        } catch {
          // Retry the last known media URL if the master is temporarily unreachable.
        }
        await checkpoint('recording');
        await wait(Math.min(15000, 750 * (2 ** Math.min(attempt, 5))), options.signal);
      }
    }
  };

  report('preparing');
  await checkpoint('recording');

  let captureError: unknown;
  try {
    const initialSegments = lastSequence == null
      ? chooseInitialSegments(media, options.probe.isLive)
      : media.segments.filter((segment) => segment.sequence > lastSequence!);

    for (const segment of initialSegments) {
      if (options.signal?.aborted) {
        stoppedByUser = true;
        break;
      }
      await writeSegment(segment);
    }

    while (!stoppedByUser) {
      if (options.signal?.aborted) {
        stoppedByUser = true;
        break;
      }
      if (media.endList) {
        endedNaturally = true;
        break;
      }

      report('waiting');
      const pollMs = Math.max(1000, Math.min(10000, media.targetDuration * 600));
      await wait(pollMs, options.signal);
      media = await refreshMedia();

      if (media.encrypted) {
        throw new Error(t('errorHlsEncrypted', media.encryptionMethod ?? 'UNKNOWN'));
      }

      const nextSegments = media.segments.filter((segment) => lastSequence == null || segment.sequence > lastSequence);
      for (const segment of nextSegments) {
        if (options.signal?.aborted) {
          stoppedByUser = true;
          break;
        }
        await writeSegment(segment);
      }

      if (media.endList && nextSegments.length === 0) {
        endedNaturally = true;
        break;
      }
    }
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      stoppedByUser = true;
    } else {
      captureError = error;
    }
  }

  try {
    if (captureError) {
      await checkpoint('failed', captureError instanceof Error ? captureError.message : String(captureError));
      throw captureError;
    }

    report('stopping');

    if (options.probe.outputExtension === 'ts' && options.directoryHandle && options.finalFileName) {
      phase = 'remux';
      await checkpoint('recording');
      report('remuxing');
      try {
        const finalFileName = await remuxTsToMp4(taskSnapshot('recording'), (nextBytes, nextProgress) => {
          finalBytesWritten = nextBytes;
          finalizeProgress = nextProgress;
          report('remuxing');
        });
        options.finalFileName = finalFileName;
      } catch (error) {
        await checkpoint('failed', error instanceof Error ? error.message : String(error)).catch(() => undefined);
        throw error;
      }
    }

    await checkpoint(stoppedByUser ? 'stopped' : 'completed');
    report('completed');

    return {
      taskId: options.taskId,
      bytesWritten,
      segmentsWritten,
      lastSequence,
      stoppedByUser,
      endedNaturally,
      finalFileName: options.finalFileName ?? options.suggestedName
    };
  } finally {
    await removePlaybackContextRule(playbackRuleId);
  }
}

export async function recordHlsLive(options: RecordHlsOptions): Promise<HlsRecordingResult> {
  const taskId = crypto.randomUUID();
  const finalFileName = ensureMp4Name(options.suggestedName);
  const startedAt = Date.now();

  if (options.probe.outputExtension === 'ts') {
    const picker = getDirectoryPicker();
    if (!picker) throw new Error(t('errorDirectoryPickerUnavailable'));
    const directoryHandle = await picker({ id: 'video-helper-live', mode: 'readwrite' });
    const workingFileName = workingTsName(taskId);
    const fileHandle = await directoryHandle.getFileHandle(workingFileName, { create: true });

    return runRecording({
      ...options,
      taskId,
      fileHandle,
      directoryHandle,
      workingFileName,
      finalFileName,
      suggestedName: finalFileName,
      mediaUrl: options.probe.mediaUrl,
      startedAt,
      initialBytesWritten: 0,
      initialSegmentsWritten: 0,
      initialRetryCount: 0,
      initialPhase: 'capture'
    });
  }

  const picker = getSaveFilePicker();
  if (!picker) throw new Error(t('errorFilePickerUnavailable'));
  const fileHandle = await picker({
    suggestedName: finalFileName,
    types: mp4PickerType()
  });

  return runRecording({
    ...options,
    taskId,
    fileHandle,
    finalFileName,
    suggestedName: finalFileName,
    mediaUrl: options.probe.mediaUrl,
    startedAt,
    initialBytesWritten: 0,
    initialSegmentsWritten: 0,
    initialRetryCount: 0,
    initialPhase: 'capture'
  });
}

async function resumeRemuxOnly(options: ResumeHlsOptions): Promise<HlsRecordingResult> {
  const task = options.task;
  if (!task.directoryHandle) throw new Error(t('errorHlsRemuxUnavailable'));
  await ensureWritePermission(task.fileHandle);
  await ensureDirectoryWritePermission(task.directoryHandle);

  let finalBytesWritten = 0;
  let finalizeProgress: number | undefined;
  const report = () => options.onProgress?.({
    stage: 'remuxing',
    startedAt: task.startedAt,
    bytesWritten: task.bytesWritten,
    segmentsWritten: task.segmentsWritten,
    retryCount: task.retryCount,
    lastSequence: task.lastSequence,
    targetDuration: 0,
    finalBytesWritten,
    finalizeProgress
  });

  report();
  try {
    const finalFileName = await remuxTsToMp4(task, (nextBytes, nextProgress) => {
      finalBytesWritten = nextBytes;
      finalizeProgress = nextProgress;
      report();
    });
    await saveLiveTask({
      ...task,
      phase: 'remux',
      status: 'completed',
      finalFileName,
      error: undefined,
      updatedAt: Date.now()
    });
    options.onProgress?.({
      stage: 'completed',
      startedAt: task.startedAt,
      bytesWritten: task.bytesWritten,
      segmentsWritten: task.segmentsWritten,
      retryCount: task.retryCount,
      lastSequence: task.lastSequence,
      targetDuration: 0,
      finalBytesWritten,
      finalizeProgress: 1
    });
    return {
      taskId: task.id,
      bytesWritten: task.bytesWritten,
      segmentsWritten: task.segmentsWritten,
      lastSequence: task.lastSequence,
      stoppedByUser: false,
      endedNaturally: true,
      finalFileName
    };
  } catch (error) {
    await saveLiveTask({
      ...task,
      phase: 'remux',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now()
    }).catch(() => undefined);
    throw error;
  }
}

export async function resumeHlsLive(options: ResumeHlsOptions): Promise<HlsRecordingResult> {
  if ((options.task.phase ?? 'capture') === 'remux') return resumeRemuxOnly(options);

  const probe = await probeHlsCandidate({
    candidate: options.candidate,
    sourcePageUrl: options.sourcePageUrl ?? options.task.sourcePageUrl,
    preferredVariantKey: options.task.variantKey
  });
  const task = options.task;
  await ensureWritePermission(task.fileHandle);
  if (task.directoryHandle) await ensureDirectoryWritePermission(task.directoryHandle);

  return runRecording({
    ...options,
    probe,
    taskId: task.id,
    fileHandle: task.fileHandle,
    directoryHandle: task.directoryHandle,
    workingFileName: task.workingFileName,
    finalFileName: task.finalFileName,
    suggestedName: task.suggestedName,
    mediaUrl: probe.mediaUrl,
    startedAt: task.startedAt,
    initialBytesWritten: task.bytesWritten,
    initialSegmentsWritten: task.segmentsWritten,
    initialRetryCount: task.retryCount,
    initialLastSequence: task.lastSequence,
    initialLastMapKey: task.lastMapKey,
    initialPhase: task.phase ?? 'capture'
  });
}
