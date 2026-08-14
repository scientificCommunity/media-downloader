import {
  ALL_FORMATS,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  type StreamTargetChunk
} from 'mediabunny';
import { t } from '../shared/i18n';
import type { MediaCandidate } from '../shared/media';
import {
  installPlaybackContextRule,
  removePlaybackContextRule,
  requestDomains
} from './playback-context';

export type MuxStage = 'preparing' | 'transferring' | 'finalizing' | 'completed';

export interface MuxProgress {
  stage: MuxStage;
  video: number;
  audio: number;
  outputBytes: number;
}

export interface MuxTracksOptions {
  video: MediaCandidate;
  audio: MediaCandidate;
  suggestedName: string;
  sourcePageUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: MuxProgress) => void;
}

interface SaveFilePickerHandle {
  createWritable(): Promise<WritableStream<unknown>>;
}

interface SaveFilePickerOptionsLike {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptionsLike) => Promise<SaveFilePickerHandle>;

function getSaveFilePicker(): ShowSaveFilePicker | null {
  const picker = (globalThis as typeof globalThis & {
    showSaveFilePicker?: ShowSaveFilePicker;
  }).showSaveFilePicker;
  return picker ?? null;
}

function createInput(candidate: MediaCandidate): Input {
  return new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(candidate.url, {
      requestInit: {
        credentials: 'include',
        cache: 'no-store'
      },
      parallelism: 4,
      maxCacheSize: 16 * 1024 * 1024,
      getRetryDelay(previousAttempts) {
        if (previousAttempts >= 3) return null;
        return Math.min(4, 0.5 * (2 ** previousAttempts));
      }
    })
  });
}

function abortError(): DOMException {
  return new DOMException(t('errorDownloadCanceled'), 'AbortError');
}

export async function muxTracksToMp4(options: MuxTracksOptions): Promise<void> {
  const picker = getSaveFilePicker();
  if (!picker) {
    throw new Error(t('errorFilePickerUnavailable'));
  }
  if (options.signal?.aborted) throw abortError();

  const fileHandle = await picker({
    suggestedName: options.suggestedName,
    types: [{
      description: t('mp4Video'),
      accept: { 'video/mp4': ['.mp4'] }
    }]
  });

  if (options.signal?.aborted) throw abortError();

  const candidates = [options.video, options.audio];
  const playbackRuleId = await installPlaybackContextRule({
    sourcePageUrl: options.sourcePageUrl,
    fallbackPageUrls: candidates.map((candidate) => candidate.pageUrl),
    requestDomains: requestDomains(candidates)
  });

  const writable = await fileHandle.createWritable();
  const target = new StreamTarget(
    writable as unknown as WritableStream<StreamTargetChunk>,
    {
      chunked: true,
      chunkSize: 8 * 1024 * 1024
    }
  );

  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 2
    }),
    target
  });

  const videoInput = createInput(options.video);
  const audioInput = createInput(options.audio);

  let videoProgress = 0;
  let audioProgress = 0;
  let outputBytes = 0;
  let stage: MuxStage = 'preparing';
  let videoConversion: Conversion | null = null;
  let audioConversion: Conversion | null = null;

  const report = () => {
    options.onProgress?.({
      stage,
      video: videoProgress,
      audio: audioProgress,
      outputBytes
    });
  };

  target.on('write', ({ end }) => {
    outputBytes = Math.max(outputBytes, end);
    report();
  });

  const cancelWork = () => {
    void Promise.allSettled([
      videoConversion?.cancel(),
      audioConversion?.cancel(),
      output.cancel()
    ].filter((promise): promise is Promise<void> => promise instanceof Promise));
  };

  options.signal?.addEventListener('abort', cancelWork, { once: true });
  report();

  try {
    videoConversion = await Conversion.init({
      input: videoInput,
      output,
      tracks: 'primary',
      audio: { discard: true },
      composable: true
    });

    audioConversion = await Conversion.init({
      input: audioInput,
      output,
      tracks: 'primary',
      video: { discard: true },
      composable: true
    });

    if (videoConversion.utilizedTracks.length === 0) {
      throw new Error(t('errorVideoTrackUnusable'));
    }
    if (audioConversion.utilizedTracks.length === 0) {
      throw new Error(t('errorAudioTrackUnusable'));
    }
    if (options.signal?.aborted) throw abortError();

    videoConversion.onProgress = (progress) => {
      videoProgress = progress;
      report();
    };
    audioConversion.onProgress = (progress) => {
      audioProgress = progress;
      report();
    };

    await output.start();
    stage = 'transferring';
    report();

    for (let until = 5; ; until += 5) {
      if (options.signal?.aborted) throw abortError();

      await Promise.all([
        videoConversion.state === 'done'
          ? Promise.resolve()
          : videoConversion.execute({ until }),
        audioConversion.state === 'done'
          ? Promise.resolve()
          : audioConversion.execute({ until })
      ]);

      if (videoConversion.state === 'done' && audioConversion.state === 'done') {
        break;
      }
    }

    stage = 'finalizing';
    report();
    await output.finalize();

    videoProgress = 1;
    audioProgress = 1;
    stage = 'completed';
    report();
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined);
    }

    if (options.signal?.aborted) throw abortError();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancelWork);
    videoInput.dispose();
    audioInput.dispose();
    await removePlaybackContextRule(playbackRuleId);
  }
}
