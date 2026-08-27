import { afterEach, describe, expect, test } from "bun:test";
import {
  base64ToPcm16LeBytes,
  chunkPcm16LeBytes,
  createBrowserVivaAudioCaptureSource,
  createStreamingFloat32Resampler,
  createVivaAntiAliasedDownsampler,
  createVivaAntiAliasLowPass,
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
  type VivaAudioCaptureEndReason,
  type VivaAudioCaptureSampleFrame,
  type VivaAudioCaptureSource,
  type VivaAudioCaptureStartOptions,
  VivaAudioWorkletUnavailableError,
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
    const sampleFrames: VivaAudioCaptureSampleFrame[] = [];
    const capture = startVivaPcm16StreamingCapture({
      onFrame: (frame) => frames.push(frame.pcm16Base64),
      onSampleFrame: (frame) => sampleFrames.push(frame),
      source,
    });

    source.push(new Float32Array(480).fill(0.25), { rms: 0.25 });
    source.push(new Float32Array(480).fill(-0.25));
    source.push(new Float32Array(480).fill(0.5));

    expect(frames).toHaveLength(3);
    expect(sampleFrames[0]?.rms).toBe(0.25);
    expect(capture.isActive()).toBe(true);
    expect(source.stopped).toBe(false);

    capture.stop();
    source.push(new Float32Array(480).fill(1));

    expect(frames).toHaveLength(3);
    expect(capture.isActive()).toBe(false);
    expect(source.stopped).toBe(true);
  });

  test("exposes emitted PCM16 bytes without changing the existing base64 frame format", () => {
    const source = new FakeAudioCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const frames: { base64: string; bytes: number[] }[] = [];
    startVivaPcm16StreamingCapture({
      frameDurationMs: 1 / 24,
      onFrame: (frame) =>
        frames.push({
          base64: frame.pcm16Base64,
          bytes: Array.from(frame.pcm16Bytes),
        }),
      source,
    });

    source.push(Float32Array.from([0, 1]));

    expect(frames).toEqual([
      { base64: "AAA=", bytes: [0, 0] },
      { base64: "/38=", bytes: [255, 127] },
    ]);
  });

  test("browser capture uses AudioWorklet frames and worklet-computed RMS", async () => {
    FakeAudioWorkletNode.instances = [];
    const mediaDevices = new FakeMediaDevices();
    const contextFactory = new FakeAudioContextFactory();
    const source = await createBrowserVivaAudioCaptureSource({
      AudioContextCtor: contextFactory.ctor,
      AudioWorkletNodeCtor: FakeAudioWorkletNode as unknown as typeof AudioWorkletNode,
      mediaDevices: mediaDevices as unknown as VivaBrowserMediaDevices,
      sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
      workletModuleUrl: "/viva-audio-capture-worklet.js",
    });
    const frames: VivaAudioCaptureSampleFrame[] = [];

    await source.start((_samples, _sampleRateHz, frame) => {
      if (frame) frames.push(frame);
    });
    FakeAudioWorkletNode.instances[0]?.emit(Float32Array.from([0, 0.5, -0.5]), 0.288675);

    expect(contextFactory.instances[0]?.scriptProcessorCalls).toBe(0);
    expect(contextFactory.instances[0]?.audioWorklet.modules).toEqual([
      "/viva-audio-capture-worklet.js",
    ]);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]?.samples ?? [])).toEqual([0, 0.5, -0.5]);
    expect(frames[0]?.sampleRateHz).toBe(VIVA_AUDIO_SAMPLE_RATE_HZ);
    expect(frames[0]?.rms).toBeCloseTo(0.288675, 6);
  });

  test("browser capture stops cleanly on device changes", async () => {
    FakeAudioWorkletNode.instances = [];
    const mediaDevices = new FakeMediaDevices();
    const contextFactory = new FakeAudioContextFactory();
    const source = await createBrowserVivaAudioCaptureSource({
      AudioContextCtor: contextFactory.ctor,
      AudioWorkletNodeCtor: FakeAudioWorkletNode as unknown as typeof AudioWorkletNode,
      mediaDevices: mediaDevices as unknown as VivaBrowserMediaDevices,
      sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
      workletModuleUrl: "/viva-audio-capture-worklet.js",
    });
    let endedReason: string | undefined;
    let samples = 0;

    await source.start(
      () => {
        samples += 1;
      },
      {
        onEnded: (reason) => {
          endedReason = reason;
        },
      },
    );
    mediaDevices.dispatchDeviceChange();
    FakeAudioWorkletNode.instances[0]?.emit(Float32Array.from([1]), 1);

    expect(endedReason).toBe("devicechange");
    expect(samples).toBe(0);
    expect(mediaDevices.removedDeviceChangeListeners).toBe(1);
    expect(mediaDevices.stream.track.stopped).toBe(true);
    expect(contextFactory.instances[0]?.closed).toBe(true);
    expect(FakeAudioWorkletNode.instances[0]?.disconnected).toBe(true);
  });

  test("browser capture stops cleanly on processor errors", async () => {
    FakeAudioWorkletNode.instances = [];
    const mediaDevices = new FakeMediaDevices();
    const contextFactory = new FakeAudioContextFactory();
    const source = await createBrowserVivaAudioCaptureSource({
      AudioContextCtor: contextFactory.ctor,
      AudioWorkletNodeCtor: FakeAudioWorkletNode as unknown as typeof AudioWorkletNode,
      mediaDevices: mediaDevices as unknown as VivaBrowserMediaDevices,
      sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
      workletModuleUrl: "/viva-audio-capture-worklet.js",
    });
    let endedReason: string | undefined;
    let samples = 0;

    await source.start(
      () => {
        samples += 1;
      },
      {
        onEnded: (reason) => {
          endedReason = reason;
        },
      },
    );
    FakeAudioWorkletNode.instances[0]?.onprocessorerror?.();
    FakeAudioWorkletNode.instances[0]?.emit(Float32Array.from([1]), 1);

    expect(endedReason).toBe("processor_error");
    expect(samples).toBe(0);
    expect(mediaDevices.removedDeviceChangeListeners).toBe(1);
    expect(mediaDevices.stream.track.stopped).toBe(true);
    expect(contextFactory.instances[0]?.closed).toBe(true);
    expect(FakeAudioWorkletNode.instances[0]?.disconnected).toBe(true);
  });

  test("browser capture closes the audio context when permission is denied", async () => {
    const mediaDevices = new FakeMediaDevices({ rejectGetUserMedia: true });
    const contextFactory = new FakeAudioContextFactory();

    let error: unknown;
    try {
      await createBrowserVivaAudioCaptureSource({
        AudioContextCtor: contextFactory.ctor,
        AudioWorkletNodeCtor: FakeAudioWorkletNode as unknown as typeof AudioWorkletNode,
        mediaDevices: mediaDevices as unknown as VivaBrowserMediaDevices,
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        workletModuleUrl: "/viva-audio-capture-worklet.js",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    expect(error instanceof Error ? error.message : String(error)).toContain("permission denied");
    expect(contextFactory.instances[0]?.closed).toBe(true);
  });

  test("browser capture reports unsupported when AudioWorklet is unavailable", async () => {
    const mediaDevices = new FakeMediaDevices();
    const contextFactory = new FakeAudioContextWithoutWorkletFactory();

    let error: unknown;
    try {
      await createBrowserVivaAudioCaptureSource({
        AudioContextCtor: contextFactory.ctor,
        mediaDevices: mediaDevices as unknown as VivaBrowserMediaDevices,
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        workletModuleUrl: "/viva-audio-capture-worklet.js",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof VivaAudioWorkletUnavailableError).toBe(true);
    expect(contextFactory.instances[0]?.closed).toBe(true);
  });
});

/**
 * CRIT-AUDIO-01: one resampler instance per capture lifecycle. The AudioWorklet
 * hands the page irregular block sizes; resampling each block from scratch resets
 * phase at every boundary and drifts the emitted 24 kHz sample count away from
 * `duration * 24_000`. These specs pin phase continuity and the exact counts at
 * both browser capture rates.
 */
describe("streaming Float32 resampler", () => {
  const TARGET_RATE_HZ = 24_000;
  const SOURCE_RATES_HZ = [44_100, 48_000] as const;
  const TURN_SECONDS = [2, 10, 45] as const;
  // Deliberately irregular AudioWorklet callback sizes: sub-sample, prime-ish,
  // power-of-two, and oversized blocks, so no block boundary lands on a whole
  // resampling period.
  const IRREGULAR_CALLBACK_BLOCKS = [1, 127, 128, 511, 7, 2048, 333] as const;

  const toneCache = new Map<string, Float32Array>();

  function toneSamples(sourceRateHz: number, seconds: number): Float32Array {
    const key = `${sourceRateHz}:${seconds}`;
    const cached = toneCache.get(key);
    if (cached) return cached;
    const total = Math.round(sourceRateHz * seconds);
    const samples = new Float32Array(total);
    for (let index = 0; index < total; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * 440 * index) / sourceRateHz);
    }
    toneCache.set(key, samples);
    return samples;
  }

  function concatFloat32(blocks: readonly Float32Array[]): Float32Array {
    let total = 0;
    for (const block of blocks) total += block.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const block of blocks) {
      merged.set(block, offset);
      offset += block.length;
    }
    return merged;
  }

  function firstMismatchIndex(left: Float32Array, right: Float32Array): number {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index += 1) {
      if (left[index] !== right[index]) return index;
    }
    return left.length === right.length ? -1 : shared;
  }

  function pushInOneBlock(sourceRateHz: number, seconds: number): Float32Array {
    return createStreamingFloat32Resampler(sourceRateHz, TARGET_RATE_HZ).push(
      toneSamples(sourceRateHz, seconds),
    );
  }

  function streamInIrregularBlocks(sourceRateHz: number, seconds: number): Float32Array {
    const source = toneSamples(sourceRateHz, seconds);
    const resampler = createStreamingFloat32Resampler(sourceRateHz, TARGET_RATE_HZ);
    const blocks: Float32Array[] = [];
    let offset = 0;
    let callback = 0;
    while (offset < source.length) {
      const requested = IRREGULAR_CALLBACK_BLOCKS[callback % IRREGULAR_CALLBACK_BLOCKS.length];
      const size = Math.min(requested, source.length - offset);
      blocks.push(resampler.push(source.subarray(offset, offset + size)));
      offset += size;
      callback += 1;
    }
    return concatFloat32(blocks);
  }

  test("emits exactly duration * 24_000 samples for 2/10/45 second turns at 44.1 and 48 kHz", () => {
    for (const sourceRate of SOURCE_RATES_HZ) {
      for (const seconds of TURN_SECONDS) {
        expect(streamInIrregularBlocks(sourceRate, seconds).length).toBe(seconds * 24_000);
        expect(pushInOneBlock(sourceRate, seconds).length).toBe(seconds * 24_000);
      }
    }
  });

  test("keeps irregular callback blocks phase-continuous with a single whole-turn push", () => {
    for (const sourceRate of SOURCE_RATES_HZ) {
      for (const seconds of TURN_SECONDS) {
        const streamed = streamInIrregularBlocks(sourceRate, seconds);
        const whole = pushInOneBlock(sourceRate, seconds);
        expect(streamed.length).toBe(whole.length);
        expect(firstMismatchIndex(streamed, whole)).toBe(-1);
      }
    }
  });

  test("reset restarts a capture generation and is never valid between callbacks", () => {
    const source = toneSamples(44_100, 2);
    const resampler = createStreamingFloat32Resampler(44_100, TARGET_RATE_HZ);

    const firstGeneration = resampler.push(source);
    resampler.reset();
    const secondGeneration = resampler.push(source);

    expect(secondGeneration.length).toBe(firstGeneration.length);
    expect(firstMismatchIndex(secondGeneration, firstGeneration)).toBe(-1);

    const perCallbackReset = createStreamingFloat32Resampler(44_100, TARGET_RATE_HZ);
    const blocks: Float32Array[] = [];
    for (let offset = 0; offset < source.length; offset += 1_000) {
      perCallbackReset.reset();
      blocks.push(
        perCallbackReset.push(source.subarray(offset, Math.min(offset + 1_000, source.length))),
      );
    }

    expect(concatFloat32(blocks).length).not.toBe(firstGeneration.length);
  });

  test("rejects non-positive sample rates before allocating", () => {
    expect(() => createStreamingFloat32Resampler(0, TARGET_RATE_HZ)).toThrow(
      "sourceSampleRateHz must be a positive finite number",
    );
    expect(() => createStreamingFloat32Resampler(48_000, Number.NaN)).toThrow(
      "targetSampleRateHz must be a positive finite number",
    );
  });

  test("streaming capture reuses one rate converter across every worklet callback", () => {
    const source = new FakeAudioCaptureSource(48_000);
    const emitted: number[] = [];
    const capture = startVivaPcm16StreamingCapture({
      frameDurationMs: 1 / 24,
      onFrame: (frame) => emitted.push(...frame.pcm16Bytes),
      source,
    });

    const tone = toneSamples(48_000, 0.01);
    let offset = 0;
    for (const size of [1, 127, 128, 224]) {
      source.push(tone.slice(offset, offset + size));
      offset += size;
    }
    capture.end();

    // The reference is the whole lifecycle converter — WSC-M07's anti-alias
    // stage AND Plan 03's rational-phase resampler — pushed ONCE. Streaming the
    // same audio through irregular callbacks must be byte-identical to it, which
    // is only true if BOTH halves keep their state across callbacks.
    const expected = float32ToPcm16LeBytes(
      createVivaAntiAliasedDownsampler(48_000, VIVA_AUDIO_SAMPLE_RATE_HZ).push(
        tone.subarray(0, offset),
      ),
    );

    expect(emitted.length).toBe(expected.length);
    expect(emitted).toEqual(Array.from(expected));
  });

  test("the anti-alias stage is length-preserving, stateful, and skipped when native", () => {
    // Length preservation is what keeps Plan 03's exact output count intact.
    const filter = createVivaAntiAliasLowPass(48_000, TARGET_RATE_HZ);
    if (!filter) throw new Error("expected an anti-alias stage for 48 kHz capture");
    for (const size of [1, 127, 128, 511, 7, 2048, 333]) {
      expect(filter.push(new Float32Array(size).fill(0.25)).length).toBe(size);
    }

    // A native-rate (or upsampling) capture has nothing to band-limit, so the
    // converter it gets is Plan 03's, unwrapped and byte-identical.
    expect(createVivaAntiAliasLowPass(TARGET_RATE_HZ, TARGET_RATE_HZ)).toBe(null);
    expect(createVivaAntiAliasLowPass(16_000, TARGET_RATE_HZ)).toBe(null);
    const nativeSamples = toneSamples(TARGET_RATE_HZ, 0.01);
    expect(
      Array.from(
        createVivaAntiAliasedDownsampler(TARGET_RATE_HZ, TARGET_RATE_HZ).push(nativeSamples),
      ),
    ).toEqual(Array.from(nativeSamples));

    // Resetting between callbacks re-introduces the boundary artefact the stage
    // exists to avoid, so per-block state must NOT match the continuous stream.
    const continuous = createVivaAntiAliasLowPass(48_000, TARGET_RATE_HZ);
    const perBlock = createVivaAntiAliasLowPass(48_000, TARGET_RATE_HZ);
    if (!continuous || !perBlock) throw new Error("expected an anti-alias stage");
    const tone = toneSamples(48_000, 0.02);
    const continuousBlocks: Float32Array[] = [];
    const perBlockBlocks: Float32Array[] = [];
    for (let offset = 0; offset < tone.length; offset += 128) {
      const block = tone.subarray(offset, Math.min(offset + 128, tone.length));
      continuousBlocks.push(continuous.push(block));
      perBlock.reset();
      perBlockBlocks.push(perBlock.push(block));
    }
    expect(
      firstMismatchIndex(concatFloat32(continuousBlocks), concatFloat32(perBlockBlocks)),
    ).not.toBe(-1);
  });
});

describe("streaming capture turn lifecycle", () => {
  // 20 ms of mono PCM16 at 24 kHz — the production capture chunk.
  const FRAME_BYTES = 960;

  /** Distinct per-sample values, so a replayed byte range cannot hide in a fill. */
  function rampSamples(count: number, startIndex = 0): Float32Array {
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = (((startIndex + index) % 2_000) + 1) / 4_000;
    }
    return samples;
  }

  test("flushes a turn tail without ending the microphone lifecycle", () => {
    // `end()` terminates the whole capture generation: it stops the source — which
    // in the browser stops every MediaStream track and closes the AudioContext —
    // and, because `active` is already false by then, never reports `onEnded`. A
    // page that submitted an answer with it would keep a "capture started" flag
    // pointing at a dead controller and could never reopen the microphone, so a
    // turn boundary must flush instead of ending.
    const terminated = new FakeAudioCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const terminatedEndReasons: VivaAudioCaptureEndReason[] = [];
    const terminatedCapture = startVivaPcm16StreamingCapture({
      onEnded: (reason) => terminatedEndReasons.push(reason),
      onFrame: () => {},
      source: terminated,
    });

    terminatedCapture.end();

    expect(terminated.stopped).toBe(true);
    expect(terminatedCapture.isActive()).toBe(false);
    expect(terminatedEndReasons).toEqual([]);

    const source = new FakeAudioCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const frames: { sequence: number; byteLength: number }[] = [];
    const capture = startVivaPcm16StreamingCapture({
      onFrame: (frame) => frames.push({ byteLength: frame.byteLength, sequence: frame.sequence }),
      source,
    });

    source.push(rampSamples(700));

    expect(frames).toEqual([{ byteLength: FRAME_BYTES, sequence: 0 }]);

    capture.flush();

    // The buffered 220-sample tail becomes the turn's last chunk...
    expect(frames).toEqual([
      { byteLength: FRAME_BYTES, sequence: 0 },
      { byteLength: 440, sequence: 1 },
    ]);
    // ...and the microphone stays open for the next question.
    expect(capture.isActive()).toBe(true);
    expect(source.stopped).toBe(false);

    // A second flush with nothing buffered emits nothing, and capture continues.
    capture.flush();
    source.push(rampSamples(480, 700));

    expect(frames).toEqual([
      { byteLength: FRAME_BYTES, sequence: 0 },
      { byteLength: 440, sequence: 1 },
      { byteLength: FRAME_BYTES, sequence: 2 },
    ]);
    expect(capture.isActive()).toBe(true);
  });

  test("a consumer that stops capture from inside onFrame never replays buffered bytes", () => {
    const source = new FakeAudioCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const emitted: { sequence: number; bytes: number[] }[] = [];
    const capture = startVivaPcm16StreamingCapture({
      onFrame: (frame) => {
        emitted.push({ bytes: Array.from(frame.pcm16Bytes), sequence: frame.sequence });
        // The 45-second turn cap does exactly this: the consumer stops capture
        // from inside the frame callback, so the tail flush re-enters `onFrame`
        // while the emitting callback is still on the stack — and the re-entrant
        // callback asks to stop again.
        if (frame.sequence >= 1) capture.stop();
      },
      source,
    });

    const first = rampSamples(700);
    const second = rampSamples(700, 700);
    source.push(first);
    source.push(second);

    const expectedBytes = Array.from(
      float32ToPcm16LeBytes(Float32Array.from([...first, ...second])),
    );
    // Every captured byte is emitted exactly once, in order, under contiguous
    // sequence numbers: nothing is replayed and nothing is stranded in a buffer
    // that the stop already abandoned.
    expect(emitted.map((frame) => frame.sequence)).toEqual([0, 1, 2]);
    expect(emitted.flatMap((frame) => frame.bytes)).toEqual(expectedBytes);
    expect(capture.isActive()).toBe(false);
    expect(source.stopped).toBe(true);
    // The nested stop request is already being served, so the source (real
    // MediaStream tracks and AudioContext) is torn down exactly once.
    expect(source.stopCount).toBe(1);
  });
});

class FakeAudioCaptureSource implements VivaAudioCaptureSource {
  readonly sampleRateHz: number;
  stopped = false;
  stopCount = 0;
  #onSamples:
    | ((samples: Float32Array, sampleRateHz: number, frame?: VivaAudioCaptureSampleFrame) => void)
    | null = null;
  #onEnded: ((reason: VivaAudioCaptureEndReason) => void) | null = null;

  constructor(sampleRateHz: number) {
    this.sampleRateHz = sampleRateHz;
  }

  start(
    onSamples: (
      samples: Float32Array,
      sampleRateHz: number,
      frame?: VivaAudioCaptureSampleFrame,
    ) => void,
    options?: VivaAudioCaptureStartOptions,
  ) {
    this.#onSamples = onSamples;
    this.#onEnded = options?.onEnded ?? null;
  }

  stop() {
    this.stopped = true;
    this.stopCount += 1;
    this.#onSamples = null;
    this.#onEnded?.("stopped");
  }

  push(samples: Float32Array, frame?: { rms: number }) {
    this.#onSamples?.(samples, this.sampleRateHz, {
      rms: frame?.rms ?? 0,
      sampleRateHz: this.sampleRateHz,
      samples,
    });
  }
}

type VivaBrowserMediaDevices = Parameters<
  typeof createBrowserVivaAudioCaptureSource
>[0]["mediaDevices"];

class FakeMediaDevices {
  readonly stream = new FakeMediaStream();
  removedDeviceChangeListeners = 0;
  #deviceChangeListener: (() => void) | null = null;
  #rejectGetUserMedia: boolean;

  constructor(options: { rejectGetUserMedia?: boolean } = {}) {
    this.#rejectGetUserMedia = options.rejectGetUserMedia ?? false;
  }

  async getUserMedia() {
    if (this.#rejectGetUserMedia) throw new Error("permission denied");
    return this.stream;
  }

  addEventListener(event: "devicechange", listener: () => void) {
    if (event === "devicechange") this.#deviceChangeListener = listener;
  }

  removeEventListener(event: "devicechange", listener: () => void) {
    if (event === "devicechange" && this.#deviceChangeListener === listener) {
      this.#deviceChangeListener = null;
      this.removedDeviceChangeListeners += 1;
    }
  }

  dispatchDeviceChange() {
    this.#deviceChangeListener?.();
  }
}

class FakeMediaStream {
  readonly track = { stopped: false, stop: () => (this.track.stopped = true) };
  getTracks() {
    return [this.track];
  }
}

class FakeAudioContextFactory {
  readonly instances: FakeAudioContext[] = [];
  readonly ctor: typeof AudioContext;

  constructor() {
    const factory = this;
    this.ctor = function FakeAudioContextCtor(options: { sampleRate: number }) {
      const context = new FakeAudioContext(options.sampleRate);
      factory.instances.push(context);
      return context;
    } as unknown as typeof AudioContext;
  }
}

class FakeAudioContextWithoutWorkletFactory {
  readonly instances: FakeAudioContextWithoutWorklet[] = [];
  readonly ctor: typeof AudioContext;

  constructor() {
    const factory = this;
    this.ctor = function FakeAudioContextCtor(options: { sampleRate: number }) {
      const context = new FakeAudioContextWithoutWorklet(options.sampleRate);
      factory.instances.push(context);
      return context;
    } as unknown as typeof AudioContext;
  }
}

class FakeAudioContext {
  readonly audioWorklet = {
    modules: [] as string[],
    addModule: async (url: string) => {
      this.audioWorklet.modules.push(url);
    },
  };
  readonly destination = {};
  readonly sampleRate: number;
  closed = false;
  scriptProcessorCalls = 0;
  readonly source = new FakeMediaStreamAudioSourceNode();

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  createMediaStreamSource() {
    return this.source;
  }

  createScriptProcessor() {
    this.scriptProcessorCalls += 1;
    throw new Error("ScriptProcessorNode must not be used");
  }

  async close() {
    this.closed = true;
  }
}

class FakeAudioContextWithoutWorklet {
  readonly sampleRate: number;
  closed = false;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  async close() {
    this.closed = true;
  }
}

class FakeMediaStreamAudioSourceNode {
  connectedTo: unknown;
  disconnected = false;

  connect(node: unknown) {
    this.connectedTo = node;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  connectedTo: unknown;
  disconnected = false;
  onprocessorerror: (() => void) | null = null;

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(destination: unknown) {
    this.connectedTo = destination;
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(samples: Float32Array, rms: number) {
    this.port.onmessage?.({
      data: { rms, sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ, samples, type: "samples" },
    } as MessageEvent);
  }
}

/**
 * `WEBSESSION-CAPTURE-01` Steps 2-3 — partial construction is a complete release.
 *
 * Browser capture builds five resources in sequence (context, worklet module URL,
 * microphone stream, media-stream source node, worklet node) and then connects
 * them. A throw at ANY of those points must leave the machine in the same state
 * as a never-started capture: the microphone light off, the context closed, the
 * object URL revoked once, and no listener able to deliver a later frame.
 */
describe("browser capture construction cleanup (WEBSESSION-CAPTURE-01)", () => {
  type ReleaseLog = string[];

  class TrackedMediaStream {
    readonly tracks: Array<{ stop: () => void; stopCount: number }>;
    constructor(private readonly log: ReleaseLog) {
      this.tracks = [0, 1].map((index) => {
        const track = {
          stop: () => {
            track.stopCount += 1;
            this.log.push(`track-${index}.stop`);
          },
          stopCount: 0,
        };
        return track;
      });
    }
    getTracks() {
      return this.tracks;
    }
  }

  class TrackedMediaDevices {
    readonly stream: TrackedMediaStream;
    added = 0;
    removed = 0;
    #listener: (() => void) | null = null;
    constructor(private readonly log: ReleaseLog) {
      this.stream = new TrackedMediaStream(log);
    }
    async getUserMedia() {
      return this.stream;
    }
    addEventListener(event: string, listener: () => void) {
      if (event !== "devicechange") return;
      this.added += 1;
      this.#listener = listener;
    }
    removeEventListener(event: string, listener: () => void) {
      if (event !== "devicechange" || this.#listener !== listener) return;
      this.removed += 1;
      this.#listener = null;
      this.log.push("devicechange.remove");
    }
    dispatchDeviceChange() {
      this.#listener?.();
    }
    listenerAttached() {
      return this.#listener !== null;
    }
  }

  class TrackedSourceNode {
    disconnectCount = 0;
    connectCount = 0;
    constructor(
      private readonly log: ReleaseLog,
      private readonly failConnect: boolean,
      private readonly failDisconnect: boolean,
    ) {}
    connect() {
      this.connectCount += 1;
      if (this.failConnect) throw new Error("source connect failed");
    }
    disconnect() {
      this.disconnectCount += 1;
      this.log.push("source.disconnect");
      if (this.failDisconnect) throw new Error("source disconnect failed");
    }
  }

  class TrackedContext {
    readonly audioWorklet = {
      modules: [] as string[],
      addModule: async (url: string) => {
        this.audioWorklet.modules.push(url);
      },
    };
    readonly destination = {};
    closeCount = 0;
    readonly source: TrackedSourceNode;
    constructor(
      readonly sampleRate: number,
      private readonly log: ReleaseLog,
      private readonly failures: CaptureFailures,
    ) {
      this.source = new TrackedSourceNode(
        log,
        failures.sourceConnect === true,
        failures.sourceDisconnect === true,
      );
    }
    createMediaStreamSource() {
      if (this.failures.createMediaStreamSource) throw new Error("createMediaStreamSource failed");
      return this.source;
    }
    async close() {
      this.closeCount += 1;
      this.log.push("context.close");
      if (this.failures.contextClose) throw new Error("context close failed");
    }
  }

  type CaptureFailures = {
    contextClose?: boolean;
    createMediaStreamSource?: boolean;
    processorConnect?: boolean;
    sourceConnect?: boolean;
    sourceDisconnect?: boolean;
    workletNodeCtor?: boolean;
  };

  class TrackedWorkletNode {
    static instances: TrackedWorkletNode[] = [];
    readonly port = { onmessage: null as ((event: MessageEvent) => void) | null };
    onprocessorerror: (() => void) | null = null;
    disconnectCount = 0;
    constructor(
      private readonly log: ReleaseLog,
      private readonly failConnect: boolean,
    ) {
      TrackedWorkletNode.instances.push(this);
    }
    connect() {
      if (this.failConnect) throw new Error("worklet connect failed");
    }
    disconnect() {
      this.disconnectCount += 1;
      this.log.push("worklet.disconnect");
    }
  }

  type Harness = {
    log: ReleaseLog;
    context: () => TrackedContext;
    mediaDevices: TrackedMediaDevices;
    revokes: () => number;
    creates: () => number;
    build: () => Promise<VivaAudioCaptureSource>;
  };

  function harness(failures: CaptureFailures = {}): Harness {
    const log: ReleaseLog = [];
    const contexts: TrackedContext[] = [];
    const mediaDevices = new TrackedMediaDevices(log);
    TrackedWorkletNode.instances = [];
    const created: string[] = [];
    const revoked: string[] = [];

    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      const url = `blob:viva-capture-${created.length}`;
      created.push(url);
      void blob;
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
      log.push("module.revoke");
    }) as typeof URL.revokeObjectURL;
    restoreObjectUrl = () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    };

    const AudioContextCtor = function TrackedContextCtor(options: { sampleRate: number }) {
      const context = new TrackedContext(options.sampleRate, log, failures);
      contexts.push(context);
      return context;
    } as unknown as typeof AudioContext;

    const AudioWorkletNodeCtor = function TrackedWorkletNodeCtor() {
      const node = new TrackedWorkletNode(log, failures.processorConnect === true);
      if (failures.workletNodeCtor) throw new Error("AudioWorkletNode construction failed");
      return node;
    } as unknown as typeof AudioWorkletNode;

    return {
      build: () =>
        createBrowserVivaAudioCaptureSource({
          AudioContextCtor,
          AudioWorkletNodeCtor,
          mediaDevices: mediaDevices as unknown as VivaBrowserMediaDevices,
          sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        }),
      context: () => {
        const context = contexts[0];
        if (!context) throw new Error("no AudioContext was constructed");
        return context;
      },
      creates: () => created.length,
      log,
      mediaDevices,
      revokes: () => revoked.length,
    };
  }

  let restoreObjectUrl: (() => void) | null = null;

  afterEach(() => {
    restoreObjectUrl?.();
    restoreObjectUrl = null;
  });

  async function expectThrows(build: () => Promise<unknown>): Promise<unknown> {
    try {
      await build();
    } catch (error) {
      return error;
    }
    throw new Error("expected construction to throw");
  }

  function expectFullyReleased(h: Harness) {
    for (const track of h.mediaDevices.stream.tracks) expect(track.stopCount).toBe(1);
    expect(h.context().closeCount).toBe(1);
    // The object URL is revoked exactly once — never twice, and never left alive.
    expect(h.creates()).toBe(1);
    expect(h.revokes()).toBe(1);
    // Nothing is left that could deliver a later frame.
    expect(h.mediaDevices.listenerAttached()).toBe(false);
    for (const node of TrackedWorkletNode.instances) {
      expect(node.port.onmessage).toBe(null);
      expect(node.onprocessorerror).toBe(null);
    }
  }

  test("a failing createMediaStreamSource releases the stream, the context, and the module URL once", async () => {
    const h = harness({ createMediaStreamSource: true });
    const error = await expectThrows(h.build);

    expect(error instanceof Error).toBe(true);
    expectFullyReleased(h);
  });

  test("a failing AudioWorkletNode construction disconnects the source and releases everything once", async () => {
    const h = harness({ workletNodeCtor: true });
    const error = await expectThrows(h.build);

    expect(error instanceof Error).toBe(true);
    expect(h.context().source.disconnectCount).toBe(1);
    expectFullyReleased(h);
  });

  test("a failing source connect releases everything and never leaves a half-wired graph", async () => {
    const h = harness({ sourceConnect: true });
    const source = await h.build();

    expect(() => source.start(() => {})).toThrow("source connect failed");
    expect(h.context().source.disconnectCount).toBe(1);
    expect(TrackedWorkletNode.instances[0]?.disconnectCount).toBe(1);
    expectFullyReleased(h);
    // A later stop is a no-op, not a second release.
    source.stop();
    expectFullyReleased(h);
  });

  test("a failing worklet connect releases everything exactly once", async () => {
    const h = harness({ processorConnect: true });
    const source = await h.build();

    expect(() => source.start(() => {})).toThrow("worklet connect failed");
    expectFullyReleased(h);
  });

  test("stop() twice after a successful construction releases each resource once", async () => {
    const h = harness();
    const source = await h.build();
    source.start(() => {});

    source.stop();
    source.stop();
    source.stop();

    expectFullyReleased(h);
    expect(h.context().source.disconnectCount).toBe(1);
    expect(TrackedWorkletNode.instances[0]?.disconnectCount).toBe(1);
    expect(h.mediaDevices.removed).toBe(1);
  });

  test("listeners are removed before anything is disconnected or closed", async () => {
    const h = harness();
    const source = await h.build();
    source.start(() => {});
    source.stop();

    const order = h.log.filter((entry) => entry !== "module.revoke");
    expect(order.indexOf("devicechange.remove")).toBeLessThan(order.indexOf("worklet.disconnect"));
    expect(order.indexOf("worklet.disconnect")).toBeLessThan(order.indexOf("source.disconnect"));
    expect(order.indexOf("source.disconnect")).toBeLessThan(order.indexOf("track-0.stop"));
    expect(order.indexOf("track-0.stop")).toBeLessThan(order.indexOf("context.close"));
  });

  test("a rejecting context close still stops every track and clears every listener", async () => {
    const h = harness({ contextClose: true });
    const source = await h.build();
    source.start(() => {});
    let ended: string | undefined;
    source.stop();
    void ended;

    expectFullyReleased(h);
    // The rejection is swallowed as a release failure, never rethrown into the
    // caller and never left as an unhandled rejection.
    await Promise.resolve();
  });

  test("a release that throws synchronously never suppresses the releases after it", async () => {
    const h = harness({ sourceDisconnect: true });
    const source = await h.build();
    source.start(() => {});

    // The throw is contained: the caller sees an ordinary stop, and every
    // release registered BEFORE the failing one still ran.
    expect(() => source.stop()).not.toThrow();
    expectFullyReleased(h);
    expect(h.context().source.disconnectCount).toBe(1);
  });

  test("run-once lives in the release boundary, not in the caller's stop flag", async () => {
    const h = harness();
    const source = await h.build();
    let endedCount = 0;
    source.start(() => {}, { onEnded: () => (endedCount += 1) });

    // Every one of these reaches the release boundary; only the boundary's own
    // run-once keeps each resource from being released more than once.
    source.stop();
    source.stop();
    source.stop();

    expect(endedCount).toBe(1);
    expectFullyReleased(h);
    expect(h.context().source.disconnectCount).toBe(1);
    expect(TrackedWorkletNode.instances[0]?.disconnectCount).toBe(1);
  });

  test("a frame delivered after teardown reaches no consumer", async () => {
    const h = harness();
    const source = await h.build();
    const frames: Float32Array[] = [];
    source.start((samples) => frames.push(samples));
    const node = TrackedWorkletNode.instances[0];
    const deliver = node?.port.onmessage;

    source.stop();
    deliver?.({
      data: {
        rms: 1,
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        samples: Float32Array.from([1]),
        type: "samples",
      },
    } as MessageEvent);

    expect(frames).toHaveLength(0);
    expect(node?.port.onmessage).toBe(null);
  });
});

/**
 * `WEBSESSION-CAPTURE-01` Step 4 (WSC-M07) — downsampling is band-limited.
 *
 * Decimating 48 kHz to 24 kHz without a low-pass stage lands every target sample
 * exactly on a source sample: content above the 12 kHz output Nyquist is not
 * attenuated at all, it is FOLDED down into the speech band as a phantom tone the
 * examiner then hears as part of the answer. These specs pin the passband the
 * learner's voice lives in and the rejection above Nyquist, at both browser
 * capture rates and across irregular AudioWorklet block boundaries.
 */
describe("capture anti-alias quality (WSC-M07)", () => {
  const IRREGULAR_BLOCKS = [1, 127, 128, 511, 7, 2048, 333] as const;
  const AMPLITUDE = 0.5;

  function tone(sourceRateHz: number, toneHz: number, seconds: number): Float32Array {
    const total = Math.round(sourceRateHz * seconds);
    const samples = new Float32Array(total);
    for (let index = 0; index < total; index += 1) {
      samples[index] = AMPLITUDE * Math.sin((2 * Math.PI * toneHz * index) / sourceRateHz);
    }
    return samples;
  }

  /** Drives the REAL capture pipeline and returns its emitted 24 kHz PCM16. */
  function capturePcm16(sourceRateHz: number, toneHz: number, seconds: number): Int16Array {
    const source = new FakeAudioCaptureSource(sourceRateHz);
    const chunks: Uint8Array[] = [];
    const capture = startVivaPcm16StreamingCapture({
      onFrame: (frame) => chunks.push(frame.pcm16Bytes),
      source,
    });
    const samples = tone(sourceRateHz, toneHz, seconds);
    let offset = 0;
    let callback = 0;
    while (offset < samples.length) {
      const requested = IRREGULAR_BLOCKS[callback % IRREGULAR_BLOCKS.length] ?? 128;
      const size = Math.min(requested, samples.length - offset);
      source.push(samples.subarray(offset, offset + size));
      offset += size;
      callback += 1;
    }
    capture.end();

    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const merged = new Uint8Array(total);
    let byteOffset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, byteOffset);
      byteOffset += chunk.byteLength;
    }
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    const pcm = new Int16Array(merged.byteLength / 2);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = view.getInt16(index * 2, true);
    }
    return pcm;
  }

  /** RMS over the steady state, skipping the filter's start-up transient. */
  function steadyStateRms(pcm: Int16Array, skip = 4_000): number {
    let sumOfSquares = 0;
    let count = 0;
    for (let index = skip; index < pcm.length; index += 1) {
      const sample = pcm[index] ?? 0;
      sumOfSquares += sample * sample;
      count += 1;
    }
    return count === 0 ? 0 : Math.sqrt(sumOfSquares / count);
  }

  function hasNoNanOrClip(pcm: Int16Array): boolean {
    for (const sample of pcm) {
      if (!Number.isFinite(sample)) return false;
      if (sample >= 32_767 || sample <= -32_768) return false;
    }
    return true;
  }

  const nativeReference = steadyStateRms(capturePcm16(24_000, 1_000, 1));

  test("the native 24 kHz path is the reference and carries a full-amplitude tone", () => {
    expect(nativeReference).toBeGreaterThan(0.5 * AMPLITUDE * 32_767);
  });

  test("48 kHz capture keeps the speech passband intact", () => {
    const oneKilohertz = capturePcm16(48_000, 1_000, 1);
    const tenKilohertz = capturePcm16(48_000, 10_000, 1);

    expect(hasNoNanOrClip(oneKilohertz)).toBe(true);
    expect(hasNoNanOrClip(tenKilohertz)).toBe(true);
    expect(Math.abs(steadyStateRms(oneKilohertz) - nativeReference) / nativeReference).toBeLessThan(
      0.05,
    );
    expect(Math.abs(steadyStateRms(tenKilohertz) - nativeReference) / nativeReference).toBeLessThan(
      0.1,
    );
  });

  test("48 kHz capture rejects every tone above the 12 kHz output Nyquist by 20 dB", () => {
    for (const toneHz of [14_000, 18_000, 22_000]) {
      const pcm = capturePcm16(48_000, toneHz, 1);
      const rejectionDb = 20 * Math.log10(Math.max(steadyStateRms(pcm), 1e-9) / nativeReference);

      expect(hasNoNanOrClip(pcm)).toBe(true);
      expect(rejectionDb).toBeLessThanOrEqual(-20);
    }
  });

  test("44.1 kHz capture rejects a 16 kHz tone and still emits Plan 03's exact sample count", () => {
    const pcm = capturePcm16(44_100, 16_000, 45);
    const rejectionDb = 20 * Math.log10(Math.max(steadyStateRms(pcm), 1e-9) / nativeReference);

    expect(rejectionDb).toBeLessThanOrEqual(-20);
    expect(hasNoNanOrClip(pcm)).toBe(true);
    // The quality stage is length-preserving: a 45-second turn is still exactly
    // 45 * 24_000 samples, so Plan 03's ledger accounting is untouched.
    expect(pcm.length).toBe(45 * 24_000);
  });

  test("the 24 kHz native path is bypassed byte-for-byte", () => {
    const native = capturePcm16(24_000, 10_000, 0.5);
    const expected = float32ToPcm16LeBytes(tone(24_000, 10_000, 0.5));
    const view = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);

    expect(native.length).toBe(expected.byteLength / 2);
    for (let index = 0; index < native.length; index += 1) {
      expect(native[index]).toBe(view.getInt16(index * 2, true));
    }
  });
});
