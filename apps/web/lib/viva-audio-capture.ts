import { VIVA_AUDIO_SAMPLE_RATE_HZ } from "@viva/core";

// Re-exported verbatim: `packages/core` owns the single 24 kHz literal for the
// whole protocol-v5 surface, so the browser capture path never re-declares it.
export { VIVA_AUDIO_SAMPLE_RATE_HZ };

export const VIVA_PCM16_BYTES_PER_SAMPLE = 2;
export const VIVA_AUDIO_DEFAULT_FRAME_DURATION_MS = 20;

export type VivaPcm16ChunkOptions = {
  sampleRateHz?: number;
  frameDurationMs?: number;
  includeFinalPartialFrame?: boolean;
};

export type VivaPcm16Chunk = {
  bytes: Uint8Array;
  byteOffset: number;
  byteLength: number;
  sequence: number;
};

export type VivaAudioCaptureEndReason = "devicechange" | "processor_error" | "stopped";

export type VivaAudioCaptureSampleFrame = {
  samples: Float32Array;
  sampleRateHz: number;
  rms: number;
};

export type VivaAudioCaptureStartOptions = {
  onEnded?: (reason: VivaAudioCaptureEndReason) => void;
};

export type VivaAudioCaptureSource = {
  sampleRateHz: number;
  start: (
    onSamples: (
      samples: Float32Array,
      sampleRateHz: number,
      frame?: VivaAudioCaptureSampleFrame,
    ) => void,
    options?: VivaAudioCaptureStartOptions,
  ) => void | Promise<void>;
  stop: () => void | Promise<void>;
};

export type VivaAudioCaptureFrame = {
  pcm16Base64: string;
  pcm16Bytes: Uint8Array;
  sequence: number;
  byteLength: number;
};

export type VivaPcm16StreamingCaptureOptions = {
  source: VivaAudioCaptureSource;
  onFrame: (frame: VivaAudioCaptureFrame) => void;
  onSampleFrame?: (frame: VivaAudioCaptureSampleFrame) => void;
  onEnded?: (reason: VivaAudioCaptureEndReason) => void;
  onError?: (error: unknown) => void;
  sampleRateHz?: number;
  frameDurationMs?: number;
};

export type VivaPcm16StreamingCaptureController = {
  /**
   * Emit the buffered tail as one final chunk and keep capturing.
   *
   * A turn boundary is not a capture-lifecycle boundary: the microphone stays
   * open across the whole session while each answer is delimited by the turn
   * controller. `stop`/`end`/`cancel` all release the source — in the browser
   * that stops every `MediaStream` track and closes the `AudioContext`, which
   * cannot be undone without a fresh user gesture and permission prompt.
   */
  flush: () => void;
  stop: () => void;
  cancel: () => void;
  end: () => void;
  isActive: () => boolean;
};

export type VivaBrowserAudioCaptureOptions = {
  AudioContextCtor: typeof AudioContext;
  AudioWorkletNodeCtor?: typeof AudioWorkletNode;
  mediaDevices: Pick<MediaDevices, "getUserMedia"> &
    Partial<Pick<MediaDevices, "addEventListener" | "removeEventListener">>;
  sampleRateHz?: number;
  workletModuleUrl?: string;
};

export class VivaAudioWorkletUnavailableError extends Error {
  constructor(message = "AudioWorklet capture is unavailable") {
    super(message);
    this.name = "VivaAudioWorkletUnavailableError";
  }
}

export function isVivaAudioWorkletUnavailableError(
  error: unknown,
): error is VivaAudioWorkletUnavailableError {
  return error instanceof VivaAudioWorkletUnavailableError;
}

export function float32ToPcm16LeBytes(samples: Float32Array | readonly number[]): Uint8Array {
  const pcm16 = new Uint8Array(samples.length * VIVA_PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampFiniteAudioSample(samples[index] ?? 0);
    const int16 = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    view.setInt16(index * VIVA_PCM16_BYTES_PER_SAMPLE, int16, true);
  }

  return pcm16;
}

export function resampleFloat32ToSampleRate(
  samples: Float32Array | readonly number[],
  sourceSampleRateHz: number,
  targetSampleRateHz = VIVA_AUDIO_SAMPLE_RATE_HZ,
): Float32Array {
  if (!Number.isFinite(sourceSampleRateHz) || sourceSampleRateHz <= 0) {
    throw new Error("sourceSampleRateHz must be a positive finite number");
  }
  if (!Number.isFinite(targetSampleRateHz) || targetSampleRateHz <= 0) {
    throw new Error("targetSampleRateHz must be a positive finite number");
  }
  if (sourceSampleRateHz === targetSampleRateHz) return Float32Array.from(samples);

  const outputLength = Math.max(
    1,
    Math.round((samples.length * targetSampleRateHz) / sourceSampleRateHz),
  );
  const output = new Float32Array(outputLength);
  const ratio = sourceSampleRateHz / targetSampleRateHz;
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceIndex = outputIndex * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
    const weight = sourceIndex - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;
    output[outputIndex] = left + (right - left) * weight;
  }
  return output;
}

export type StreamingFloat32Resampler = {
  push(input: Float32Array): Float32Array;
  reset(): void;
};

/**
 * One resampler instance per capture lifecycle (CRIT-AUDIO-01).
 *
 * `resampleFloat32ToSampleRate` restarts at source index 0 on every call, so
 * resampling each AudioWorklet callback independently resets phase at every block
 * boundary and rounds the emitted count per block — a 45-second turn then drifts
 * away from `45 * 24_000` samples. This instance instead tracks the generation's
 * total source samples and next target index as integers, derives each target
 * sample from the exact rational position `j * sourceRate / targetRate`, and
 * retains the single boundary source sample the next callback needs.
 *
 * After `N` source samples the emitted target count is exactly
 * `floor(N * targetRate / sourceRate)`, so cumulative duration error stays below
 * one 24 kHz sample. `reset()` is for a new capture generation or disposal only;
 * calling it between callbacks is the very bug this type exists to prevent.
 */
export function createStreamingFloat32Resampler(
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): StreamingFloat32Resampler {
  if (!Number.isFinite(sourceSampleRateHz) || sourceSampleRateHz <= 0) {
    throw new Error("sourceSampleRateHz must be a positive finite number");
  }
  if (!Number.isFinite(targetSampleRateHz) || targetSampleRateHz <= 0) {
    throw new Error("targetSampleRateHz must be a positive finite number");
  }

  // Absolute source index feeding target sample `targetIndex`. Both operands stay
  // exact integers well inside Number.MAX_SAFE_INTEGER for a 45-second turn
  // (1_080_000 * 48_000 = 5.184e10), so the floor is exact.
  const sourceIndexForTarget = (targetIndex: number) =>
    Math.floor((targetIndex * sourceSampleRateHz) / targetSampleRateHz);

  let retained = EMPTY_FLOAT32;
  let retainedStartIndex = 0;
  let sourceSampleCount = 0;
  let nextTargetIndex = 0;

  return {
    push(input: Float32Array): Float32Array {
      const nextSourceSampleCount = sourceSampleCount + input.length;
      const targetCount = Math.floor(
        (nextSourceSampleCount * targetSampleRateHz) / sourceSampleRateHz,
      );
      const window = retained.length === 0 ? input : joinFloat32(retained, input);
      const emitCount = targetCount - nextTargetIndex;
      const output = emitCount > 0 ? new Float32Array(emitCount) : EMPTY_FLOAT32;
      const lastWindowIndex = window.length - 1;

      for (let offset = 0; offset < emitCount; offset += 1) {
        const targetIndex = nextTargetIndex + offset;
        const numerator = targetIndex * sourceSampleRateHz;
        const sourceIndex = Math.floor(numerator / targetSampleRateHz);
        const remainder = numerator - sourceIndex * targetSampleRateHz;
        const leftIndex = sourceIndex - retainedStartIndex;
        const rightIndex = leftIndex < lastWindowIndex ? leftIndex + 1 : lastWindowIndex;
        const left = window[leftIndex] ?? 0;
        const right = window[rightIndex] ?? left;
        output[offset] =
          remainder === 0 ? left : left + ((right - left) * remainder) / targetSampleRateHz;
      }

      sourceSampleCount = nextSourceSampleCount;
      nextTargetIndex = targetCount;

      // Keep exactly the boundary samples the next target index interpolates over.
      // `slice` copies, so a caller reusing its AudioWorklet buffer cannot mutate
      // what this generation retained.
      const keepFromIndex = Math.min(sourceIndexForTarget(targetCount), nextSourceSampleCount);
      const keepFromWindowOffset = keepFromIndex - retainedStartIndex;
      retained =
        keepFromWindowOffset >= window.length ? EMPTY_FLOAT32 : window.slice(keepFromWindowOffset);
      retainedStartIndex = keepFromIndex;
      return output;
    },
    reset() {
      retained = EMPTY_FLOAT32;
      retainedStartIndex = 0;
      sourceSampleCount = 0;
      nextTargetIndex = 0;
    },
  };
}

/**
 * `WEBSESSION-CAPTURE-01` / WSC-M07 — the quality stage Plan 03's converter needs.
 *
 * Plan 03's rational-phase resampler is exact about POSITION, not about band
 * limiting: for 48 kHz -> 24 kHz every target index lands on an integer source
 * index, so the converter is a pure decimator and content above the 12 kHz output
 * Nyquist is not attenuated — it is folded down into the speech band as a phantom
 * tone. This stage removes that content BEFORE the converter sees it.
 *
 * It is a fixed odd-length linear-phase windowed-sinc: deterministic, allocation
 * free per tap, and adding no dependency. Its delay line persists across
 * AudioWorklet callbacks (resetting it per callback would re-introduce a boundary
 * artefact at every block, which is the same class of bug CRIT-AUDIO-01 fixed for
 * phase), and it is length-preserving, so the converter's exact
 * `floor(N * target / source)` output count is untouched.
 */
export const VIVA_AUDIO_ANTI_ALIAS_TAPS = 95;

/**
 * Cutoff as a fraction of the TARGET rate. 0.479 * 24 kHz = 11,496 Hz leaves the
 * whole speech band flat while placing the stopband edge below the 12 kHz output
 * Nyquist at both 44.1 and 48 kHz capture rates.
 */
export const VIVA_AUDIO_ANTI_ALIAS_CUTOFF_RATIO = 0.479;

export type StreamingFloat32Filter = {
  push(input: Float32Array): Float32Array;
  reset(): void;
};

/**
 * The low-pass stage for one capture lifecycle, or `null` when the capture is not
 * downsampling at all — a native 24 kHz microphone must stay byte-identical.
 */
export function createVivaAntiAliasLowPass(
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): StreamingFloat32Filter | null {
  if (!Number.isFinite(sourceSampleRateHz) || sourceSampleRateHz <= 0) {
    throw new Error("sourceSampleRateHz must be a positive finite number");
  }
  if (!Number.isFinite(targetSampleRateHz) || targetSampleRateHz <= 0) {
    throw new Error("targetSampleRateHz must be a positive finite number");
  }
  if (sourceSampleRateHz <= targetSampleRateHz) return null;

  const taps = blackmanLowPassTaps(
    VIVA_AUDIO_ANTI_ALIAS_TAPS,
    targetSampleRateHz * VIVA_AUDIO_ANTI_ALIAS_CUTOFF_RATIO,
    sourceSampleRateHz,
  );
  const order = taps.length - 1;
  const history = new Float32Array(order);

  return {
    push(input: Float32Array): Float32Array {
      if (input.length === 0) return EMPTY_FLOAT32;
      const window = new Float32Array(order + input.length);
      window.set(history);
      window.set(input, order);
      const output = new Float32Array(input.length);
      for (let index = 0; index < input.length; index += 1) {
        let accumulator = 0;
        const base = index + order;
        for (let tap = 0; tap <= order; tap += 1) {
          accumulator += (taps[tap] ?? 0) * (window[base - tap] ?? 0);
        }
        output[index] = accumulator;
      }
      history.set(window.subarray(window.length - order));
      return output;
    },
    reset() {
      history.fill(0);
    },
  };
}

/**
 * Plan 03's rational-phase converter with the WSC-M07 quality stage in front of
 * it. The converter itself is untouched and un-rewrapped when no downsampling is
 * happening, so the native path keeps its exact previous behaviour.
 */
export function createVivaAntiAliasedDownsampler(
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): StreamingFloat32Resampler {
  const resampler = createStreamingFloat32Resampler(sourceSampleRateHz, targetSampleRateHz);
  const antiAlias = createVivaAntiAliasLowPass(sourceSampleRateHz, targetSampleRateHz);
  if (!antiAlias) return resampler;
  return {
    push: (input: Float32Array) => resampler.push(antiAlias.push(input)),
    reset: () => {
      antiAlias.reset();
      resampler.reset();
    },
  };
}

/** A normalized, symmetric, Blackman-windowed sinc low-pass. */
function blackmanLowPassTaps(taps: number, cutoffHz: number, sampleRateHz: number): Float64Array {
  const coefficients = new Float64Array(taps);
  const middle = (taps - 1) / 2;
  const cutoff = cutoffHz / sampleRateHz;
  let sum = 0;
  for (let index = 0; index < taps; index += 1) {
    const offset = index - middle;
    const sinc =
      offset === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * index) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * index) / (taps - 1));
    coefficients[index] = sinc * window;
    sum += coefficients[index] ?? 0;
  }
  // Unity DC gain, so the learner's voice keeps its level exactly.
  for (let index = 0; index < taps; index += 1) {
    coefficients[index] = (coefficients[index] ?? 0) / sum;
  }
  return coefficients;
}

export function float32ToPcm16Base64FramesAtSampleRate(
  samples: Float32Array | readonly number[],
  sourceSampleRateHz: number,
  options: VivaPcm16ChunkOptions = {},
): string[] {
  return float32ToPcm16Base64Frames(
    resampleFloat32ToSampleRate(
      samples,
      sourceSampleRateHz,
      options.sampleRateHz ?? VIVA_AUDIO_SAMPLE_RATE_HZ,
    ),
    options,
  );
}

export function pcm16LeBytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      const chunk = bytes.subarray(offset, offset + 0x8000);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  const BufferCtor = (globalThis as { Buffer?: BufferConstructor }).Buffer;
  if (BufferCtor) return BufferCtor.from(bytes).toString("base64");
  throw new Error("No base64 encoder is available");
}

export function base64ToPcm16LeBytes(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  const BufferCtor = (globalThis as { Buffer?: BufferConstructor }).Buffer;
  if (BufferCtor) return Uint8Array.from(BufferCtor.from(base64, "base64"));
  throw new Error("No base64 decoder is available");
}

export function pcm16FrameByteLength(options: VivaPcm16ChunkOptions = {}): number {
  const sampleRateHz = options.sampleRateHz ?? VIVA_AUDIO_SAMPLE_RATE_HZ;
  const frameDurationMs = options.frameDurationMs ?? VIVA_AUDIO_DEFAULT_FRAME_DURATION_MS;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error("sampleRateHz must be a positive finite number");
  }
  if (!Number.isFinite(frameDurationMs) || frameDurationMs <= 0) {
    throw new Error("frameDurationMs must be a positive finite number");
  }

  const samplesPerFrame = (sampleRateHz * frameDurationMs) / 1000;
  if (!Number.isInteger(samplesPerFrame)) {
    throw new Error("frameDurationMs must produce a whole number of PCM16 samples");
  }
  return samplesPerFrame * VIVA_PCM16_BYTES_PER_SAMPLE;
}

export function chunkPcm16LeBytes(
  pcm16Bytes: Uint8Array,
  options: VivaPcm16ChunkOptions = {},
): VivaPcm16Chunk[] {
  if (pcm16Bytes.byteLength % VIVA_PCM16_BYTES_PER_SAMPLE !== 0) {
    throw new Error("PCM16 byte length must be even");
  }

  const frameByteLength = pcm16FrameByteLength(options);
  const includeFinalPartialFrame = options.includeFinalPartialFrame ?? true;
  const chunks: VivaPcm16Chunk[] = [];

  for (let byteOffset = 0; byteOffset < pcm16Bytes.byteLength; byteOffset += frameByteLength) {
    const byteLength = Math.min(frameByteLength, pcm16Bytes.byteLength - byteOffset);
    if (byteLength < frameByteLength && !includeFinalPartialFrame) break;
    chunks.push({
      bytes: pcm16Bytes.slice(byteOffset, byteOffset + byteLength),
      byteLength,
      byteOffset,
      sequence: chunks.length,
    });
  }

  return chunks;
}

export function pcm16LeBytesToBase64Frames(
  pcm16Bytes: Uint8Array,
  options: VivaPcm16ChunkOptions = {},
): string[] {
  return chunkPcm16LeBytes(pcm16Bytes, options).map((chunk) => pcm16LeBytesToBase64(chunk.bytes));
}

export function float32ToPcm16Base64Frames(
  samples: Float32Array | readonly number[],
  options: VivaPcm16ChunkOptions = {},
): string[] {
  return pcm16LeBytesToBase64Frames(float32ToPcm16LeBytes(samples), options);
}

export function startVivaPcm16StreamingCapture(
  options: VivaPcm16StreamingCaptureOptions,
): VivaPcm16StreamingCaptureController {
  const targetSampleRateHz = options.sampleRateHz ?? VIVA_AUDIO_SAMPLE_RATE_HZ;
  const frameByteLength = pcm16FrameByteLength({
    frameDurationMs: options.frameDurationMs,
    sampleRateHz: targetSampleRateHz,
  });
  let active = true;
  // A flushed tail frame reaches consumer code that may call `stop()`/`end()`
  // again from inside the callback; that nested request is already being served
  // by the finish in progress, so it must not restart the flush.
  let finishing = false;
  let pendingPcm16 = new Uint8Array(0);
  let sequence = 0;
  // Exactly one rate converter for this capture lifecycle — the anti-alias stage
  // and Plan 03's rational-phase resampler together. It is created on the first
  // callback (the worklet reports the real hardware rate there), replaced only
  // when the source itself changes rate, and dropped on stop/cancel/end/error.
  // Both halves keep their state across callbacks: resetting either one per
  // callback re-introduces a boundary artefact at every block.
  let resampler: StreamingFloat32Resampler | null = null;
  let resamplerSourceRateHz = 0;

  function resampleForLifecycle(samples: Float32Array, sourceSampleRateHz: number): Float32Array {
    if (!resampler || resamplerSourceRateHz !== sourceSampleRateHz) {
      resampler = createVivaAntiAliasedDownsampler(sourceSampleRateHz, targetSampleRateHz);
      resamplerSourceRateHz = sourceSampleRateHz;
    }
    return resampler.push(samples);
  }

  function releaseResampler() {
    resampler = null;
    resamplerSourceRateHz = 0;
  }

  // `onFrame` is consumer code that can synchronously re-enter this capture — the
  // 45-second turn cap stops capture from inside the callback, and stopping
  // flushes the tail straight back through `onFrame`. Every mutation below is
  // therefore published BEFORE the callback runs: the sequence counter advances
  // first, and the pending buffer always holds exactly the bytes that have not
  // been emitted yet. A re-entrant flush can then only see unsent bytes, and can
  // never replay a frame or reuse a sequence number.
  function emitFrame(bytes: Uint8Array) {
    const pcm16Bytes = bytes.slice();
    const frameSequence = sequence;
    sequence += 1;
    options.onFrame({
      byteLength: pcm16Bytes.byteLength,
      pcm16Base64: pcm16LeBytesToBase64(pcm16Bytes),
      pcm16Bytes,
      sequence: frameSequence,
    });
  }

  function pushPcm16(bytes: Uint8Array) {
    if (!active || bytes.byteLength === 0) return;
    const merged = new Uint8Array(pendingPcm16.byteLength + bytes.byteLength);
    merged.set(pendingPcm16);
    merged.set(bytes, pendingPcm16.byteLength);
    pendingPcm16 = merged;

    while (active && pendingPcm16.byteLength >= frameByteLength) {
      const frame = pendingPcm16.subarray(0, frameByteLength);
      pendingPcm16 = pendingPcm16.slice(frameByteLength);
      emitFrame(frame);
    }
  }

  function flushPendingFrame() {
    if (!active || pendingPcm16.byteLength === 0) return;
    const tail = pendingPcm16;
    pendingPcm16 = new Uint8Array(0);
    emitFrame(tail);
  }

  function stopSource() {
    try {
      void options.source.stop();
    } catch (error) {
      options.onError?.(error);
    }
  }

  try {
    void Promise.resolve(
      options.source.start(
        (samples, sourceSampleRateHz, frame) => {
          if (!active) return;
          options.onSampleFrame?.({
            rms: frame?.rms ?? Number.NaN,
            sampleRateHz: sourceSampleRateHz,
            samples,
          });
          pushPcm16(float32ToPcm16LeBytes(resampleForLifecycle(samples, sourceSampleRateHz)));
        },
        {
          onEnded: (reason) => {
            if (!active) return;
            active = false;
            pendingPcm16 = new Uint8Array(0);
            releaseResampler();
            options.onEnded?.(reason);
          },
        },
      ),
    ).catch((error) => {
      if (!active) return;
      active = false;
      pendingPcm16 = new Uint8Array(0);
      releaseResampler();
      options.onError?.(error);
      stopSource();
    });
  } catch (error) {
    active = false;
    releaseResampler();
    options.onError?.(error);
    stopSource();
  }

  function finish(flush: boolean) {
    if (!active || finishing) return;
    finishing = true;
    if (flush) flushPendingFrame();
    active = false;
    pendingPcm16 = new Uint8Array(0);
    releaseResampler();
    stopSource();
  }

  return {
    cancel: () => finish(false),
    end: () => finish(true),
    flush: () => flushPendingFrame(),
    isActive: () => active,
    stop: () => finish(true),
  };
}

/**
 * `WEBSESSION-CAPTURE-01` Steps 2-3 — construction inside ONE cleanup boundary.
 *
 * Browser capture builds five resources in sequence and then wires them together.
 * Every one of those steps can throw (a revoked permission, a context in a bad
 * state, a browser without `AudioWorkletNode`), and a throw between two of them
 * used to strand whatever had already been created: a live microphone track with
 * its recording indicator on, an `AudioContext` the browser counts against the
 * page's limit, and an object URL that is never revoked.
 *
 * So each resource registers its release the instant it exists, and the single
 * `releaseAll` runs those releases in REVERSE order, each isolated, exactly once.
 * Listener removal is registered last so it runs first — nothing may deliver a
 * frame into a graph that is being taken apart — and track stops are registered
 * before the context close so a rejecting `close()` cannot leave the microphone
 * open. The error a caller sees is the original typed one, unchanged.
 */
export async function createBrowserVivaAudioCaptureSource(
  options: VivaBrowserAudioCaptureOptions,
): Promise<VivaAudioCaptureSource> {
  const sampleRateHz = options.sampleRateHz ?? VIVA_AUDIO_SAMPLE_RATE_HZ;
  // `unknown` rather than `void | Promise<unknown>`: a release may be
  // synchronous or may hand back something awaitable, and only `releaseAll`
  // decides what to do with it. Naming the union put `void` inside it, which
  // reads as "this value is meaningless" on a value the caller then inspects.
  const releases: Array<() => unknown> = [];
  let released = false;

  /**
   * Reverse-order, run-once, isolated release.
   *
   * Run-once lives HERE rather than in each caller, so no caller has to remember
   * it. The synchronous half of every release runs before this function first
   * suspends, so a synchronous `stop()` has fully torn the graph down by the time
   * it returns.
   */
  function releaseAll(): Promise<void> {
    if (released) return Promise.resolve();
    released = true;
    const settling: Array<Promise<unknown>> = [];
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      try {
        const pending = releases[index]?.();
        // A rejected close must not become an unhandled rejection, and must not
        // suppress the releases that already ran or the ones still to run.
        if (pending) settling.push(Promise.resolve(pending).catch(() => undefined));
      } catch {
        // Isolated: one failing release cannot cancel the rest.
      }
    }
    return Promise.allSettled(settling).then(() => undefined);
  }

  const context = new options.AudioContextCtor({ sampleRate: sampleRateHz });
  releases.push(() => context.close());
  if (!context.audioWorklet) {
    await releaseAll();
    throw new VivaAudioWorkletUnavailableError();
  }

  let sampleHandler:
    | ((samples: Float32Array, sampleRateHz: number, frame?: VivaAudioCaptureSampleFrame) => void)
    | null = null;
  let endedHandler: ((reason: VivaAudioCaptureEndReason) => void) | null = null;
  let stopped = false;

  try {
    const module = createAudioCaptureWorkletModule(options.workletModuleUrl);
    let moduleRevoked = false;
    const revokeModuleUrl = () => {
      if (moduleRevoked) return;
      moduleRevoked = true;
      module.cleanup();
    };
    releases.push(revokeModuleUrl);
    await context.audioWorklet.addModule(module.url);
    // The URL has served its only purpose; revoking it here is what keeps the
    // success path from leaking one blob per capture.
    revokeModuleUrl();

    const stream = await options.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: sampleRateHz,
      },
    });
    if (!stream) throw new Error("Microphone stream was not opened");
    releases.push(() => {
      for (const track of stream.getTracks()) track.stop();
    });

    const streamSource = context.createMediaStreamSource(stream);
    releases.push(() => streamSource.disconnect());

    const AudioWorkletNodeCtor =
      options.AudioWorkletNodeCtor ??
      (typeof AudioWorkletNode === "function" ? AudioWorkletNode : undefined);
    if (!AudioWorkletNodeCtor) {
      throw new VivaAudioWorkletUnavailableError("AudioWorkletNode capture is unavailable");
    }
    const processor = new AudioWorkletNodeCtor(context, AUDIO_CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    releases.push(() => processor.disconnect());
    releases.push(() => {
      processor.port.onmessage = null;
      processor.onprocessorerror = null;
    });

    processor.port.onmessage = (event: MessageEvent<VivaAudioCaptureWorkletMessage>) => {
      if (stopped || !sampleHandler) return;
      const message = event.data;
      if (message?.type !== "samples" || !(message.samples instanceof Float32Array)) return;
      const sampleRate = validSampleRate(message.sampleRateHz)
        ? message.sampleRateHz
        : context.sampleRate;
      const rms = Number.isFinite(message.rms) && message.rms >= 0 ? message.rms : 0;
      sampleHandler(message.samples, sampleRate, {
        rms,
        sampleRateHz: sampleRate,
        samples: message.samples,
      });
    };
    processor.onprocessorerror = () => {
      stop("processor_error");
    };

    const onDeviceChange = () => {
      stop("devicechange");
    };
    options.mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    releases.push(() => options.mediaDevices.removeEventListener?.("devicechange", onDeviceChange));

    function stop(reason: VivaAudioCaptureEndReason = "stopped") {
      const alreadyStopped = stopped;
      stopped = true;
      sampleHandler = null;
      // Unconditional: `releaseAll` owns run-once, so a second `stop()` cannot
      // release anything twice and does not depend on this flag to be safe.
      void releaseAll();
      if (alreadyStopped) return;
      const notify = endedHandler;
      endedHandler = null;
      notify?.(reason);
    }

    return {
      sampleRateHz: context.sampleRate,
      start(onSamples, startOptions) {
        if (stopped) return;
        sampleHandler = onSamples;
        endedHandler = startOptions?.onEnded ?? null;
        try {
          streamSource.connect(processor);
          processor.connect(context.destination);
        } catch (error) {
          // A capture that could not be wired never started, so it reports no
          // `onEnded`; it runs the same idempotent release and rethrows.
          sampleHandler = null;
          endedHandler = null;
          stopped = true;
          void releaseAll();
          throw error;
        }
      },
      stop,
    };
  } catch (error) {
    await releaseAll();
    throw error;
  }
}

const EMPTY_FLOAT32 = new Float32Array(0);

function joinFloat32(head: Float32Array, tail: Float32Array): Float32Array {
  const merged = new Float32Array(head.length + tail.length);
  merged.set(head);
  merged.set(tail, head.length);
  return merged;
}

function clampFiniteAudioSample(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  if (sample < -1) return -1;
  if (sample > 1) return 1;
  return sample;
}

type BufferConstructor = {
  from(bytes: Uint8Array): { toString(encoding: "base64"): string };
  from(base64: string, encoding: "base64"): Uint8Array;
};

const AUDIO_CAPTURE_WORKLET_NAME = "viva-audio-capture";

type VivaAudioCaptureWorkletMessage = {
  type: "samples";
  samples: Float32Array;
  sampleRateHz: number;
  rms: number;
};

function createAudioCaptureWorkletModule(explicitUrl?: string): {
  url: string;
  cleanup: () => void;
} {
  if (explicitUrl) return { url: explicitUrl, cleanup: () => {} };
  if (typeof Blob !== "function" || !globalThis.URL?.createObjectURL) {
    throw new VivaAudioWorkletUnavailableError("AudioWorklet module URLs are unavailable");
  }
  const url = URL.createObjectURL(
    new Blob([AUDIO_CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }),
  );
  return {
    cleanup: () => URL.revokeObjectURL(url),
    url,
  };
}

function validSampleRate(sampleRateHz: number): boolean {
  return Number.isFinite(sampleRateHz) && sampleRateHz > 0;
}

const AUDIO_CAPTURE_WORKLET_SOURCE = `
class VivaAudioCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input) return true;
    if (output) output.fill(0);
    const samples = new Float32Array(input.length);
    let sumOfSquares = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = Number.isFinite(input[index]) ? input[index] : 0;
      samples[index] = sample;
      sumOfSquares += sample * sample;
    }
    const rms = input.length === 0 ? 0 : Math.sqrt(sumOfSquares / input.length);
    this.port.postMessage(
      { type: "samples", samples, sampleRateHz: sampleRate, rms },
      [samples.buffer],
    );
    return true;
  }
}

registerProcessor("${AUDIO_CAPTURE_WORKLET_NAME}", VivaAudioCaptureProcessor);
`;
