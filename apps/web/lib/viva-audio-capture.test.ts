import { describe, expect, test } from "bun:test";
import {
  base64ToPcm16LeBytes,
  chunkPcm16LeBytes,
  createBrowserVivaAudioCaptureSource,
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

class FakeAudioCaptureSource implements VivaAudioCaptureSource {
  readonly sampleRateHz: number;
  stopped = false;
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
