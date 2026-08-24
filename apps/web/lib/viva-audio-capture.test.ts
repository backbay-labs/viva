import { describe, expect, test } from "bun:test";
import {
  base64ToPcm16LeBytes,
  chunkPcm16LeBytes,
  createBrowserVivaAudioCaptureSource,
  createStreamingFloat32Resampler,
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

  test("streaming capture reuses one resampler across every worklet callback", () => {
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

    const expected = float32ToPcm16LeBytes(
      createStreamingFloat32Resampler(48_000, VIVA_AUDIO_SAMPLE_RATE_HZ).push(
        tone.subarray(0, offset),
      ),
    );

    expect(emitted.length).toBe(expected.length);
    expect(emitted).toEqual(Array.from(expected));
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
