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
  let pendingPcm16 = new Uint8Array(0);
  let sequence = 0;
  // Exactly one resampler for this capture lifecycle. It is created on the first
  // callback (the worklet reports the real hardware rate there), replaced only
  // when the source itself changes rate, and dropped on stop/cancel/end/error.
  let resampler: StreamingFloat32Resampler | null = null;
  let resamplerSourceRateHz = 0;

  function resampleForLifecycle(samples: Float32Array, sourceSampleRateHz: number): Float32Array {
    if (!resampler || resamplerSourceRateHz !== sourceSampleRateHz) {
      resampler = createStreamingFloat32Resampler(sourceSampleRateHz, targetSampleRateHz);
      resamplerSourceRateHz = sourceSampleRateHz;
    }
    return resampler.push(samples);
  }

  function releaseResampler() {
    resampler = null;
    resamplerSourceRateHz = 0;
  }

  function emitFrame(bytes: Uint8Array) {
    const pcm16Bytes = bytes.slice();
    options.onFrame({
      byteLength: bytes.byteLength,
      pcm16Base64: pcm16LeBytesToBase64(pcm16Bytes),
      pcm16Bytes,
      sequence,
    });
    sequence += 1;
  }

  function pushPcm16(bytes: Uint8Array) {
    if (!active || bytes.byteLength === 0) return;
    const merged = new Uint8Array(pendingPcm16.byteLength + bytes.byteLength);
    merged.set(pendingPcm16);
    merged.set(bytes, pendingPcm16.byteLength);

    let offset = 0;
    while (merged.byteLength - offset >= frameByteLength) {
      emitFrame(merged.slice(offset, offset + frameByteLength));
      offset += frameByteLength;
    }
    pendingPcm16 = merged.slice(offset);
  }

  function flushPendingFrame() {
    if (active && pendingPcm16.byteLength > 0) {
      emitFrame(pendingPcm16);
      pendingPcm16 = new Uint8Array(0);
    }
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
    if (!active) return;
    if (flush) flushPendingFrame();
    active = false;
    pendingPcm16 = new Uint8Array(0);
    releaseResampler();
    stopSource();
  }

  return {
    cancel: () => finish(false),
    end: () => finish(true),
    isActive: () => active,
    stop: () => finish(true),
  };
}

export async function createBrowserVivaAudioCaptureSource(
  options: VivaBrowserAudioCaptureOptions,
): Promise<VivaAudioCaptureSource> {
  const sampleRateHz = options.sampleRateHz ?? VIVA_AUDIO_SAMPLE_RATE_HZ;
  const context = new options.AudioContextCtor({ sampleRate: sampleRateHz });
  if (!context.audioWorklet) {
    await context.close();
    throw new VivaAudioWorkletUnavailableError();
  }
  let moduleUrlCleanup: (() => void) | undefined;
  let stream: MediaStream | undefined;
  try {
    const module = createAudioCaptureWorkletModule(options.workletModuleUrl);
    moduleUrlCleanup = module.cleanup;
    await context.audioWorklet.addModule(module.url);
    stream = await options.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: sampleRateHz,
      },
    });
  } catch (error) {
    moduleUrlCleanup?.();
    for (const track of stream?.getTracks() ?? []) track.stop();
    await context.close();
    throw error;
  } finally {
    moduleUrlCleanup?.();
  }
  if (!stream) {
    await context.close();
    throw new Error("Microphone stream was not opened");
  }
  const activeStream = stream;

  const streamSource = context.createMediaStreamSource(activeStream);
  const AudioWorkletNodeCtor =
    options.AudioWorkletNodeCtor ??
    (typeof AudioWorkletNode === "function" ? AudioWorkletNode : undefined);
  if (!AudioWorkletNodeCtor) {
    for (const track of activeStream.getTracks()) track.stop();
    await context.close();
    throw new VivaAudioWorkletUnavailableError("AudioWorkletNode capture is unavailable");
  }
  const processor = new AudioWorkletNodeCtor(context, AUDIO_CAPTURE_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  let sampleHandler:
    | ((samples: Float32Array, sampleRateHz: number, frame?: VivaAudioCaptureSampleFrame) => void)
    | null = null;
  let endedHandler: ((reason: VivaAudioCaptureEndReason) => void) | null = null;
  let stopped = false;

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

  function stop(reason: VivaAudioCaptureEndReason = "stopped") {
    if (stopped) return;
    stopped = true;
    sampleHandler = null;
    options.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    processor.port.onmessage = null;
    processor.onprocessorerror = null;
    processor.disconnect();
    streamSource.disconnect();
    for (const track of activeStream.getTracks()) track.stop();
    void context.close();
    endedHandler?.(reason);
    endedHandler = null;
  }

  return {
    sampleRateHz: context.sampleRate,
    start(onSamples, startOptions) {
      if (stopped) return;
      sampleHandler = onSamples;
      endedHandler = startOptions?.onEnded ?? null;
      streamSource.connect(processor);
      processor.connect(context.destination);
    },
    stop,
  };
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
