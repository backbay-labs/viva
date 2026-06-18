import { VIVA_VOICE_SAMPLE_RATE_HZ } from "@viva/core";

export const VIVA_PCM16_BYTES_PER_SAMPLE = 2;
export const VIVA_AUDIO_SAMPLE_RATE_HZ = VIVA_VOICE_SAMPLE_RATE_HZ;
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

export type VivaAudioCaptureSource = {
  sampleRateHz: number;
  start: (onSamples: (samples: Float32Array, sampleRateHz: number) => void) => void | Promise<void>;
  stop: () => void | Promise<void>;
};

export type VivaAudioCaptureFrame = {
  pcm16Base64: string;
  sequence: number;
  byteLength: number;
};

export type VivaPcm16StreamingCaptureOptions = {
  source: VivaAudioCaptureSource;
  onFrame: (frame: VivaAudioCaptureFrame) => void;
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
  mediaDevices: Pick<MediaDevices, "getUserMedia">;
  sampleRateHz?: number;
};

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

  function emitFrame(bytes: Uint8Array) {
    options.onFrame({
      byteLength: bytes.byteLength,
      pcm16Base64: pcm16LeBytesToBase64(bytes),
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
      options.source.start((samples, sourceSampleRateHz) => {
        if (!active) return;
        pushPcm16(
          float32ToPcm16LeBytes(
            resampleFloat32ToSampleRate(samples, sourceSampleRateHz, targetSampleRateHz),
          ),
        );
      }),
    ).catch((error) => {
      if (!active) return;
      active = false;
      pendingPcm16 = new Uint8Array(0);
      options.onError?.(error);
      stopSource();
    });
  } catch (error) {
    active = false;
    options.onError?.(error);
    stopSource();
  }

  function finish(flush: boolean) {
    if (!active) return;
    if (flush) flushPendingFrame();
    active = false;
    pendingPcm16 = new Uint8Array(0);
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
  const stream = await options.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: sampleRateHz,
    },
  });
  const context = new options.AudioContextCtor({ sampleRate: sampleRateHz });
  const streamSource = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  let sampleHandler: ((samples: Float32Array, sampleRateHz: number) => void) | null = null;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped || !sampleHandler) return;
    sampleHandler(event.inputBuffer.getChannelData(0), context.sampleRate);
  };

  return {
    sampleRateHz: context.sampleRate,
    start(onSamples) {
      if (stopped) return;
      sampleHandler = onSamples;
      streamSource.connect(processor);
      processor.connect(context.destination);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      sampleHandler = null;
      processor.disconnect();
      streamSource.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
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
