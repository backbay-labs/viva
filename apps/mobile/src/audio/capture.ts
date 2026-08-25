import { VIVA_LEARNER_LOOP_MAX_TURN_MS } from "@viva/core";
import {
  computeRms,
  createVoiceLevelMeter,
  pcm16FrameByteLength,
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_DEFAULT_FRAME_DURATION_MS,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  VIVA_PCM16_BYTES_PER_SAMPLE,
  type VivaAudioCaptureEndReason,
  type VivaAudioCaptureSource,
  type VivaPcm16StreamingCaptureController,
  type VoiceLevelMeterOptions,
} from "@/agent/shared-web";
import {
  createMobileVivaAudioCaptureSource,
  type MobileVivaAudioCaptureSourceOptions,
} from "@/audio/capture-source";

const FRAME_BYTE_LENGTH = pcm16FrameByteLength({ sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ });
const MAX_TURN_FRAMES = Math.max(
  1,
  Math.floor(VIVA_LEARNER_LOOP_MAX_TURN_MS / VIVA_AUDIO_DEFAULT_FRAME_DURATION_MS),
);

export type MobileCaptureSessionOptions = {
  captureSourceOptions?: Omit<MobileVivaAudioCaptureSourceOptions, "onError">;
  meterOptions?: VoiceLevelMeterOptions;
  onEnded?: (reason: VivaAudioCaptureEndReason) => void;
  onError?: (error: unknown) => void;
  source?: VivaAudioCaptureSource;
  sourceFactory?: (options: { onError: (error: unknown) => void }) => VivaAudioCaptureSource;
};

export type MobileCaptureSession = {
  cancel: () => Promise<void>;
  getFrames: () => readonly Uint8Array[];
  getInputLevel: () => number;
  isActive: () => boolean;
  reset: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  teardown: () => Promise<void>;
};

/**
 * One capture owner for a mobile learner turn.
 *
 * This module deliberately accepts only an audio source and local diagnostic
 * callbacks. It has no controller, socket, or transport callback in its API;
 * captured PCM stays in this bounded ledger until a later protocol-v5 owner
 * explicitly consumes it.
 */
export function createMobileCaptureSession(
  options: MobileCaptureSessionOptions = {},
): MobileCaptureSession {
  const frames: Uint8Array[] = [];
  const meter = createVoiceLevelMeter(options.meterOptions);
  let controller: VivaPcm16StreamingCaptureController | null = null;
  let active = false;
  let stopPromise: Promise<void> = Promise.resolve();
  let startupPromise: Promise<void> | null = null;
  let resolveStartup: (() => void) | null = null;
  let rejectStartup: ((error: unknown) => void) | null = null;
  let startupSettled = false;

  const invokeSafely = (callback: (() => void) | undefined): void => {
    try {
      const result = callback?.() as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined);
      }
    } catch {
      // Lifecycle and diagnostic callbacks must not create unhandled native
      // event rejections.
    }
  };

  const notifyError = (error: unknown): void => {
    invokeSafely(() => options.onError?.(error));
  };

  const reportError = (error: unknown): void => {
    notifyError(error);
    if (!startupSettled) {
      startupSettled = true;
      rejectStartup?.(error);
      resolveStartup = null;
      rejectStartup = null;
    }
  };

  const clearLedger = (): void => {
    frames.length = 0;
    meter.reset();
  };

  const settleStartup = (error?: unknown): void => {
    if (startupSettled) return;
    startupSettled = true;
    if (error === undefined) resolveStartup?.();
    else rejectStartup?.(error);
    resolveStartup = null;
    rejectStartup = null;
  };

  const sourceFactory = (): VivaAudioCaptureSource => {
    if (options.source) return options.source;
    if (options.sourceFactory) {
      return options.sourceFactory({ onError: notifyError });
    }
    return createMobileVivaAudioCaptureSource({
      ...options.captureSourceOptions,
      onError: notifyError,
    });
  };

  const wrappedSource = (source: VivaAudioCaptureSource): VivaAudioCaptureSource => ({
    sampleRateHz: source.sampleRateHz,
    start: async (onSamples, startOptions) => {
      await source.start(onSamples, startOptions);
      settleStartup();
    },
    stop: () => {
      const result = source.stop();
      stopPromise = Promise.resolve(result).then(
        () => undefined,
        (error) => {
          notifyError(error);
        },
      );
      return stopPromise;
    },
  });

  const finishUnderlying = (kind: "stop" | "cancel" | "teardown"): Promise<void> => {
    const current = controller;
    controller = null;
    active = false;
    if (!current) {
      if (kind !== "stop") clearLedger();
      return stopPromise;
    }
    if (kind === "stop") current.stop();
    else current.cancel();
    if (kind !== "stop") clearLedger();
    return stopPromise;
  };

  const session: MobileCaptureSession = {
    async start() {
      if (!active && startupPromise) {
        // Cancellation makes the public session inactive synchronously, but a
        // permission/native start can still be unwinding. Do not replace its
        // shared resolver or controller until both startup and stop settle.
        const previousStartup = startupPromise;
        await previousStartup.catch(() => undefined);
        const previousStop = stopPromise;
        await previousStop;
        if (startupPromise === previousStartup) startupPromise = null;
      }
      if (active && startupPromise) return startupPromise;
      if (active) return;
      // A new start begins a new turn. The previous normal stop remains
      // inspectable until this explicit next-start boundary.
      clearLedger();
      const source = wrappedSource(sourceFactory());
      startupSettled = false;
      const nextStartup = new Promise<void>((resolve, reject) => {
        resolveStartup = resolve;
        rejectStartup = reject;
      });
      startupPromise = nextStartup;
      active = true;

      try {
        controller = startVivaPcm16StreamingCapture({
          onEnded: (reason) => {
            active = false;
            controller = null;
            clearLedger();
            settleStartup(new Error(`audio capture ended: ${reason}`));
            invokeSafely(() => options.onEnded?.(reason));
          },
          onError: (error) => {
            active = false;
            controller = null;
            reportError(error);
            clearLedger();
          },
          onFrame: (frame) => {
            if (!active || frame.byteLength !== FRAME_BYTE_LENGTH) return;
            if (frames.length >= MAX_TURN_FRAMES) return;
            frames.push(frame.pcm16Bytes.slice());
            if (frames.length === MAX_TURN_FRAMES) {
              active = false;
              controller?.stop();
              invokeSafely(() => options.onEnded?.("stopped"));
            }
          },
          onSampleFrame: (frame) => {
            if (!active) return;
            const measuredRms =
              Number.isFinite(frame.rms) && frame.rms >= 0 ? frame.rms : computeRms(frame.samples);
            const rms = Number.isFinite(measuredRms) && measuredRms >= 0 ? measuredRms : 0;
            meter.pushRms(rms);
          },
          source,
          sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        });
      } catch (error) {
        active = false;
        controller = null;
        reportError(error);
      }

      await nextStartup;
    },
    cancel() {
      return finishUnderlying("cancel");
    },
    getFrames() {
      return frames.map((frame) => frame.slice());
    },
    getInputLevel() {
      return meter.get();
    },
    isActive() {
      return active && (controller?.isActive() ?? false);
    },
    reset() {
      const promise = finishUnderlying("teardown");
      clearLedger();
      return promise;
    },
    stop() {
      return finishUnderlying("stop");
    },
    teardown() {
      return finishUnderlying("teardown");
    },
  };

  return session;
}

export const MOBILE_CAPTURE_FRAME_BYTE_LENGTH = FRAME_BYTE_LENGTH;
export const MOBILE_CAPTURE_MAX_TURN_FRAMES = MAX_TURN_FRAMES;
export const MOBILE_CAPTURE_FRAME_SAMPLE_LENGTH = FRAME_BYTE_LENGTH / VIVA_PCM16_BYTES_PER_SAMPLE;

// Naming aliases keep the mobile-facing surface explicit while allowing the
// session hook to refer to the same single owner as a Viva capture session.
export type MobileVivaCaptureSession = MobileCaptureSession;
export const createMobileVivaCaptureSession = createMobileCaptureSession;
