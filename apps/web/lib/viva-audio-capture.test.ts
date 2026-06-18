import { describe, expect, test } from "bun:test";
import {
  base64ToPcm16LeBytes,
  chunkPcm16LeBytes,
  float32ToPcm16Base64Frames,
  float32ToPcm16Base64FramesAtSampleRate,
  float32ToPcm16LeBytes,
  pcm16FrameByteLength,
  pcm16LeBytesToBase64,
  pcm16LeBytesToBase64Frames,
  resampleFloat32ToSampleRate,
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_DEFAULT_FRAME_DURATION_MS,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaAudioCaptureSource,
} from "./viva-audio-capture";

describe("Viva audio capture helpers", () => {
  test("converts Float32 samples to clamped PCM16 little-endian bytes", () => {
    const pcm16 = float32ToPcm16LeBytes(
      new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]),
    );

    expect(Array.from(pcm16)).toEqual([
      0x00, 0x80, 0x00, 0x80, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x40, 0xff, 0x7f, 0xff, 0x7f, 0x00,
      0x00, 0x00, 0x00,
    ]);
  });

  test("round-trips PCM16 bytes through base64", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const base64 = pcm16LeBytesToBase64(bytes);

    expect(base64).toBe("AQIDBA==");
    expect(Array.from(base64ToPcm16LeBytes(base64))).toEqual([1, 2, 3, 4]);
  });

  test("computes default 24 kHz PCM16 frame size", () => {
    expect(VIVA_AUDIO_SAMPLE_RATE_HZ).toBe(24_000);
    expect(VIVA_AUDIO_DEFAULT_FRAME_DURATION_MS).toBe(20);
    expect(pcm16FrameByteLength()).toBe(960);
  });

  test("chunks PCM16 bytes deterministically and copies frame data", () => {
    const bytes = new Uint8Array(960 * 2 + 10);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    const chunks = chunkPcm16LeBytes(bytes);
    bytes[0] = 255;

    expect(
      chunks.map((chunk) => ({
        byteLength: chunk.byteLength,
        byteOffset: chunk.byteOffset,
        firstByte: chunk.bytes[0],
        sequence: chunk.sequence,
      })),
    ).toEqual([
      { byteLength: 960, byteOffset: 0, firstByte: 0, sequence: 0 },
      { byteLength: 960, byteOffset: 960, firstByte: 207, sequence: 1 },
      { byteLength: 10, byteOffset: 1920, firstByte: 163, sequence: 2 },
    ]);
  });

  test("can drop the final partial PCM16 frame", () => {
    const bytes = new Uint8Array(960 + 2);

    expect(chunkPcm16LeBytes(bytes, { includeFinalPartialFrame: false })).toHaveLength(1);
  });

  test("encodes chunked PCM16 frames as base64", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);

    expect(pcm16LeBytesToBase64Frames(bytes, { frameDurationMs: 1 / 24 })).toEqual([
      "AQI=",
      "AwQ=",
      "BQY=",
    ]);
  });

  test("converts Float32 samples directly to base64 PCM16 frames", () => {
    const frames = float32ToPcm16Base64Frames([0, 1], { frameDurationMs: 1 / 24 });

    expect(frames).toEqual(["AAA=", "/38="]);
  });

  test("resamples browser audio before PCM16 framing", () => {
    const resampled = resampleFloat32ToSampleRate([0, 1, 0, -1], 48_000, 24_000);

    expect(Array.from(resampled)).toEqual([0, 0]);
    expect(
      float32ToPcm16Base64FramesAtSampleRate([0, 1, 0, -1], 48_000, {
        frameDurationMs: 1 / 24,
      }),
    ).toEqual(["AAA=", "AAA="]);
  });

  test("rejects malformed PCM16 chunk boundaries", () => {
    expect(() => chunkPcm16LeBytes(new Uint8Array([1]))).toThrow("PCM16 byte length must be even");
    expect(() => pcm16FrameByteLength({ frameDurationMs: 1 / 48 })).toThrow(
      "frameDurationMs must produce a whole number of PCM16 samples",
    );
  });

  test("streams multiple PCM16 frames from a fake source until explicit stop", () => {
    const source = new FakeAudioCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const frames: string[] = [];
    const capture = startVivaPcm16StreamingCapture({
      onFrame: (frame) => frames.push(frame.pcm16Base64),
      source,
    });

    source.push(new Float32Array(480).fill(0.25));
    source.push(new Float32Array(480).fill(-0.25));
    source.push(new Float32Array(480).fill(0.5));

    expect(frames).toHaveLength(3);
    expect(capture.isActive()).toBe(true);
    expect(source.stopped).toBe(false);

    capture.stop();
    source.push(new Float32Array(480).fill(1));

    expect(frames).toHaveLength(3);
    expect(capture.isActive()).toBe(false);
    expect(source.stopped).toBe(true);
  });
});

class FakeAudioCaptureSource implements VivaAudioCaptureSource {
  readonly sampleRateHz: number;
  stopped = false;
  #onSamples: ((samples: Float32Array, sampleRateHz: number) => void) | null = null;

  constructor(sampleRateHz: number) {
    this.sampleRateHz = sampleRateHz;
  }

  start(onSamples: (samples: Float32Array, sampleRateHz: number) => void) {
    this.#onSamples = onSamples;
  }

  stop() {
    this.stopped = true;
    this.#onSamples = null;
  }

  push(samples: Float32Array) {
    this.#onSamples?.(samples, this.sampleRateHz);
  }
}
