import {
  computeRms,
  pcm16FrameByteLength,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  VIVA_PCM16_BYTES_PER_SAMPLE,
  type VivaAudioCaptureSource,
  type VivaAudioCaptureStartOptions,
} from "@/agent/shared-web";

/**
 * Result returned by react-native-audio-api's native-facing methods.
 *
 * The package currently returns a synchronous Result from registration and a
 * Promise<Result> from recorder start/stop. The adapter keeps the Result
 * boundary explicit so a native failure cannot be mistaken for a successful
 * microphone session.
 */
export type AudioApiResult = { status: "success" } | { status: "error"; message: string };

export type AudioRecorderBuffer = {
  getChannelData: (channel: number) => Float32Array;
  sampleRate?: number;
};

export type AudioRecorderReadyEvent = {
  buffer: AudioRecorderBuffer;
};

/** Permission values returned by react-native-audio-api 0.13.3. */
export type PermissionStatus = "Undetermined" | "Denied" | "Granted";

export class MobileAudioPermissionError extends Error {
  readonly status: unknown;

  constructor(status: unknown) {
    const renderedStatus = String(status);
    super(
      renderedStatus === "Denied"
        ? "Microphone recording permission denied (status: Denied)"
        : `Microphone recording permission not granted (status: ${renderedStatus})`,
    );
    this.name = "MobileAudioPermissionError";
    this.status = status;
  }
}

export type AudioRecorderLike = {
  clearOnAudioReady: () => void;
  clearOnError: () => void;
  onAudioReady: (
    options: { bufferLength: number; channelCount: number; sampleRate: number },
    callback: (event: AudioRecorderReadyEvent) => void,
  ) => AudioApiResult;
  onError: (callback: (error: unknown) => void) => void;
  start: () => Promise<AudioApiResult>;
  stop: () => Promise<AudioApiResult>;
};

export type AudioManagerLike = {
  requestRecordingPermissions: () => Promise<PermissionStatus>;
  setAudioSessionActivity: (enabled: boolean) => Promise<void>;
  setAudioSessionOptions: (options: {
    iosCategory: "playAndRecord";
    iosOptions: ["defaultToSpeaker"];
  }) => void;
};

export type MobileVivaAudioCaptureStartOptions = VivaAudioCaptureStartOptions & {
  /** Receives recorder and teardown failures without being a transport hook. */
  onError?: (error: unknown) => void;
};

export type MobileVivaAudioCaptureSourceOptions = {
  audioManager?: AudioManagerLike;
  audioManagerFactory?: () => AudioManagerLike;
  onError?: (error: unknown) => void;
  recorderFactory?: () => AudioRecorderLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resultError(operation: string, result: unknown): Error {
  const message =
    isRecord(result) && typeof result.message === "string" ? result.message : "unknown error";
  return new Error(`${operation} failed: ${message}`);
}

function inspectResult(operation: string, result: unknown): void {
  // The native package always returns Result. Accepting undefined here keeps
  // the structural test seam compatible with older mocks while still failing
  // closed on every explicit native error Result.
  if (isRecord(result) && result.status === "error") {
    throw resultError(operation, result);
  }
  if (isRecord(result) && result.status === "success") return;
  if (result === undefined) return;
  throw new Error(`${operation} returned an invalid Result`);
}

function errorFromUnknown(error: unknown): Error {
  if (error instanceof Error) return error;
  if (isRecord(error) && typeof error.message === "string") return new Error(error.message);
  return new Error(String(error));
}

function validSampleRate(sampleRate: number | undefined): sampleRate is number {
  return sampleRate !== undefined && Number.isFinite(sampleRate) && sampleRate > 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function finiteRms(samples: Float32Array): number {
  const rms = computeRms(samples);
  return Number.isFinite(rms) && rms >= 0 ? rms : 0;
}

function defaultRecorderFactory(): AudioRecorderLike {
  // Native JSI modules must stay out of Bun and Metro module evaluation. This
  // require runs only after a real capture has been started.
  const audioApi = require("react-native-audio-api") as {
    AudioRecorder: new () => AudioRecorderLike;
  };
  return new audioApi.AudioRecorder();
}

function defaultAudioManagerFactory(): AudioManagerLike {
  const audioApi = require("react-native-audio-api") as {
    AudioManager: AudioManagerLike;
  };
  return audioApi.AudioManager;
}

function invokeSafely(callback: (() => void) | undefined): void {
  try {
    const result = callback?.() as unknown;
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Native event handlers must not let consumer callbacks escape into the
    // JSI event emitter. The adapter's own error path remains deterministic.
  }
}

type CaptureGeneration = {
  cancelled: boolean;
  id: number;
  promise: Promise<void>;
};

export function createMobileVivaAudioCaptureSource(
  options: MobileVivaAudioCaptureSourceOptions = {},
): VivaAudioCaptureSource {
  let recorder: AudioRecorderLike | null = null;
  let audioManager: AudioManagerLike | null = null;
  let active = false;
  let audioSessionActive = false;
  let callbacksCleared = true;
  let teardownPromise: Promise<void> | null = null;
  let generationId = 0;
  let currentGeneration: CaptureGeneration | null = null;
  let endHandler: ((reason: "devicechange" | "processor_error" | "stopped") => void) | undefined;
  let errorHandler: ((error: unknown) => void) | undefined;

  const reportError = (error: unknown): void => {
    try {
      const result = errorHandler?.(error) as unknown;
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Error reporting is intentionally best effort. In particular, a stop
      // failure must never become an unhandled rejection.
    }
    try {
      const result = options.onError?.(error) as unknown;
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // See the errorHandler guard above.
    }
  };

  const clearCallbacks = (): void => {
    if (callbacksCleared || !recorder) return;
    callbacksCleared = true;
    try {
      recorder.clearOnAudioReady();
    } catch (error) {
      reportError(error);
    }
    try {
      recorder.clearOnError();
    } catch (error) {
      reportError(error);
    }
  };

  const deactivateAudioSession = async (): Promise<void> => {
    if (!audioSessionActive || !audioManager) return;
    audioSessionActive = false;
    try {
      const result = await audioManager.setAudioSessionActivity(false);
      inspectResult("AudioManager.setAudioSessionActivity(false)", result);
    } catch (error) {
      reportError(error);
    }
  };

  const ownsGeneration = (generation: CaptureGeneration): boolean =>
    currentGeneration === generation &&
    currentGeneration.id === generation.id &&
    !generation.cancelled;

  const cleanupResources = async (): Promise<void> => {
    const currentRecorder = recorder;
    if (currentRecorder) {
      try {
        const result = await currentRecorder.stop();
        inspectResult("AudioRecorder.stop", result);
      } catch (error) {
        reportError(error);
      }
    }
    await deactivateAudioSession();
    recorder = null;
    audioManager = null;
    endHandler = undefined;
    errorHandler = undefined;
  };

  const teardown = (
    generation: CaptureGeneration | null = currentGeneration,
    waitForStart = true,
  ): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    if (generation) generation.cancelled = true;
    active = false;
    clearCallbacks();

    const pendingStart = waitForStart ? generation?.promise : undefined;
    teardownPromise = (async () => {
      if (pendingStart) await pendingStart.catch(() => undefined);
      await cleanupResources();
      if (currentGeneration === generation) currentGeneration = null;
    })();
    return teardownPromise;
  };

  const notifyEnded = (reason: "devicechange" | "processor_error" | "stopped"): void => {
    invokeSafely(() => endHandler?.(reason));
  };

  const source: VivaAudioCaptureSource = {
    sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
    start(onSamples, startOptions?: MobileVivaAudioCaptureStartOptions) {
      if (active) return Promise.resolve();
      if (currentGeneration && !currentGeneration.cancelled) {
        return currentGeneration.promise;
      }
      if (teardownPromise) {
        const pendingTeardown = teardownPromise;
        return pendingTeardown.then(() => {
          if (teardownPromise === pendingTeardown) teardownPromise = null;
          return source.start(onSamples, startOptions);
        });
      }

      const generation: CaptureGeneration = {
        cancelled: false,
        id: ++generationId,
        promise: Promise.resolve(),
      };
      currentGeneration = generation;

      const runStart = async (): Promise<void> => {
        try {
          const nextAudioManager =
            options.audioManager ?? options.audioManagerFactory?.() ?? defaultAudioManagerFactory();
          const permission = await nextAudioManager.requestRecordingPermissions();
          if (!ownsGeneration(generation)) return;
          if (permission !== "Granted") {
            throw new MobileAudioPermissionError(permission);
          }

          if (!ownsGeneration(generation)) return;
          const nextRecorder = (options.recorderFactory ?? defaultRecorderFactory)();
          recorder = nextRecorder;
          audioManager = nextAudioManager;
          active = true;
          callbacksCleared = false;
          endHandler = startOptions?.onEnded;
          errorHandler = startOptions?.onError;

          inspectResult(
            "AudioManager.setAudioSessionOptions",
            audioManager.setAudioSessionOptions({
              iosCategory: "playAndRecord",
              iosOptions: ["defaultToSpeaker"],
            }),
          );
          const activityResult = await audioManager.setAudioSessionActivity(true);
          inspectResult("AudioManager.setAudioSessionActivity(true)", activityResult);
          audioSessionActive = true;
          if (!ownsGeneration(generation)) return;

          const bufferLength =
            pcm16FrameByteLength({ sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ }) /
            VIVA_PCM16_BYTES_PER_SAMPLE;
          inspectResult(
            "AudioRecorder.onAudioReady",
            nextRecorder.onAudioReady(
              {
                bufferLength,
                channelCount: 1,
                sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ,
              },
              (event) => {
                if (!active || !ownsGeneration(generation) || recorder !== nextRecorder) return;
                try {
                  const samples = event.buffer.getChannelData(0);
                  const sampleRateHz = validSampleRate(event.buffer.sampleRate)
                    ? event.buffer.sampleRate
                    : VIVA_AUDIO_SAMPLE_RATE_HZ;
                  const frame = {
                    rms: finiteRms(samples),
                    sampleRateHz,
                    samples,
                  };
                  onSamples(samples, sampleRateHz, frame);
                } catch (error) {
                  reportError(error);
                  active = false;
                  clearCallbacks();
                  notifyEnded("processor_error");
                  void teardown(generation);
                }
              },
            ),
          );

          nextRecorder.onError((error) => {
            if (!active || !ownsGeneration(generation)) return;
            reportError(error);
            active = false;
            clearCallbacks();
            notifyEnded("processor_error");
            void teardown(generation);
          });

          if (!ownsGeneration(generation)) return;
          const startResult = await nextRecorder.start();
          inspectResult("AudioRecorder.start", startResult);
          if (!ownsGeneration(generation)) return;
        } catch (error) {
          if (generation.cancelled || currentGeneration !== generation || teardownPromise) return;
          const startError = errorFromUnknown(error);
          await teardown(generation, false);
          throw startError;
        }
      };

      const startPromise = runStart();
      generation.promise = startPromise;
      return startPromise;
    },
    stop() {
      if (!active && !currentGeneration && !teardownPromise) return Promise.resolve();
      return teardown(currentGeneration);
    },
  };

  return source;
}
