import { describe, expect, test } from "bun:test";
import {
  pcm16FrameByteLength,
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  VIVA_PCM16_BYTES_PER_SAMPLE,
  type VivaAudioCaptureEndReason,
  type VivaAudioCaptureSampleFrame,
} from "@/agent/shared-web";
import {
  type AudioApiResult,
  type AudioManagerLike,
  type AudioRecorderLike,
  createMobileVivaAudioCaptureSource,
  MobileAudioPermissionError,
  type PermissionStatus,
} from "@/audio/capture-source";

const FRAME_BYTE_LENGTH = pcm16FrameByteLength({ sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ });
const FRAME_SAMPLE_LENGTH = FRAME_BYTE_LENGTH / VIVA_PCM16_BYTES_PER_SAMPLE;
const SUCCESS: AudioApiResult = { status: "success" };

type FakeRecorderOptions = {
  onAudioReadyResult?: AudioApiResult;
  startResult?: Promise<AudioApiResult>;
  stopResult?: Promise<AudioApiResult>;
};

class FakeRecorder implements AudioRecorderLike {
  readonly calls = {
    clearOnAudioReady: 0,
    clearOnError: 0,
    onAudioReady: 0,
    onError: 0,
    start: 0,
    stop: 0,
  };
  registeredOptions: { bufferLength: number; channelCount: number; sampleRate: number } | undefined;
  private audioCallback:
    | ((event: { buffer: { getChannelData: () => Float32Array; sampleRate: number } }) => void)
    | null = null;
  private errorCallback: ((error: unknown) => void) | null = null;

  constructor(private readonly options: FakeRecorderOptions = {}) {}

  clearOnAudioReady(): void {
    this.calls.clearOnAudioReady += 1;
    this.audioCallback = null;
  }

  clearOnError(): void {
    this.calls.clearOnError += 1;
    this.errorCallback = null;
  }

  onAudioReady(
    options: { bufferLength: number; channelCount: number; sampleRate: number },
    callback: (event: {
      buffer: { getChannelData: () => Float32Array; sampleRate: number };
    }) => void,
  ): AudioApiResult {
    this.calls.onAudioReady += 1;
    this.registeredOptions = options;
    if (this.options.onAudioReadyResult) return this.options.onAudioReadyResult;
    this.audioCallback = callback;
    return SUCCESS;
  }

  onError(callback: (error: unknown) => void): void {
    this.calls.onError += 1;
    this.errorCallback = callback;
  }

  start(): Promise<AudioApiResult> {
    this.calls.start += 1;
    return this.options.startResult ?? Promise.resolve(SUCCESS);
  }

  stop(): Promise<AudioApiResult> {
    this.calls.stop += 1;
    return this.options.stopResult ?? Promise.resolve(SUCCESS);
  }

  emit(samples: Float32Array, sampleRate: number): void {
    this.audioCallback?.({ buffer: { getChannelData: () => samples, sampleRate } });
  }

  emitError(error: unknown): void {
    this.errorCallback?.(error);
  }
}

class FakeAudioManager implements AudioManagerLike {
  readonly options: { iosCategory: "playAndRecord"; iosOptions: ["defaultToSpeaker"] }[] = [];
  readonly activity: boolean[] = [];
  readonly permissionCalls: number[] = [];

  constructor(readonly permission: PermissionStatus = "Granted") {}

  requestRecordingPermissions(): Promise<PermissionStatus> {
    this.permissionCalls.push(1);
    return Promise.resolve(this.permission);
  }

  async setAudioSessionActivity(enabled: boolean): Promise<void> {
    this.activity.push(enabled);
  }

  setAudioSessionOptions(options: {
    iosCategory: "playAndRecord";
    iosOptions: ["defaultToSpeaker"];
  }): void {
    this.options.push(options);
  }
}

function makeSource(
  recorder: FakeRecorder,
  manager = new FakeAudioManager(),
  onError?: (error: unknown) => void,
) {
  return {
    manager,
    source: createMobileVivaAudioCaptureSource({
      audioManager: manager,
      onError,
      recorderFactory: () => recorder,
    }),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("createMobileVivaAudioCaptureSource", () => {
  test("requests recording permission at start before configuring the audio session", async () => {
    const recorder = new FakeRecorder();
    const { manager, source } = makeSource(recorder);

    await source.start(() => {});

    expect(manager.permissionCalls).toEqual([1]);
    expect(manager.options).toEqual([
      { iosCategory: "playAndRecord", iosOptions: ["defaultToSpeaker"] },
    ]);
    await source.stop();
  });

  test("rejects denied and non-granted permission without starting the recorder", async () => {
    for (const permission of ["Denied", "Undetermined"] as const) {
      const recorder = new FakeRecorder();
      const manager = new FakeAudioManager(permission);
      const source = createMobileVivaAudioCaptureSource({
        audioManager: manager,
        recorderFactory: () => recorder,
      });

      let failure: unknown;
      try {
        await source.start(() => {});
      } catch (error) {
        failure = error;
      }

      expect(failure instanceof MobileAudioPermissionError).toBe(true);
      expect((failure as MobileAudioPermissionError).status).toBe(permission);
      expect(String(failure)).toContain(permission);
      expect(manager.permissionCalls).toEqual([1]);
      expect(manager.options).toEqual([]);
      expect(manager.activity).toEqual([]);
      expect(recorder.calls.start).toBe(0);
    }
  });

  test("registers the shared frame size and streams two 24 kHz buffers with finite RMS", async () => {
    const recorder = new FakeRecorder();
    const { manager, source } = makeSource(recorder);
    const frames: { byteLength: number; sequence: number }[] = [];
    const sampleFrames: VivaAudioCaptureSampleFrame[] = [];
    const controller = startVivaPcm16StreamingCapture({
      onFrame: (frame) => frames.push({ byteLength: frame.byteLength, sequence: frame.sequence }),
      onSampleFrame: (frame) => sampleFrames.push(frame),
      source,
    });
    await flush();

    expect(recorder.registeredOptions).toEqual({
      bufferLength: FRAME_SAMPLE_LENGTH,
      channelCount: 1,
      sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ,
    });
    expect(manager.options).toEqual([
      { iosCategory: "playAndRecord", iosOptions: ["defaultToSpeaker"] },
    ]);
    expect(manager.activity).toEqual([true]);

    const samples = Float32Array.from({ length: FRAME_SAMPLE_LENGTH }, () => 0.25);
    samples[0] = Number.NaN;
    samples[1] = Number.POSITIVE_INFINITY;
    recorder.emit(samples, VIVA_AUDIO_SAMPLE_RATE_HZ);
    recorder.emit(samples, VIVA_AUDIO_SAMPLE_RATE_HZ);

    expect(frames).toEqual([
      { byteLength: FRAME_BYTE_LENGTH, sequence: 0 },
      { byteLength: FRAME_BYTE_LENGTH, sequence: 1 },
    ]);
    expect(sampleFrames).toHaveLength(2);
    expect(sampleFrames.every((frame) => Number.isFinite(frame.rms))).toBe(true);
    expect(sampleFrames.every((frame) => frame.sampleRateHz === VIVA_AUDIO_SAMPLE_RATE_HZ)).toBe(
      true,
    );
    expect(sampleFrames.every((frame) => frame.samples === samples)).toBe(true);

    controller.stop();
    await source.stop();
    expect(manager.activity).toEqual([true, false]);
  });

  test("passes the actual 48 kHz callback rate to the shared resampler", async () => {
    const recorder = new FakeRecorder();
    const { source } = makeSource(recorder);
    const frames: { sequence: number; byteLength: number }[] = [];
    const sampleFrames: VivaAudioCaptureSampleFrame[] = [];
    const controller = startVivaPcm16StreamingCapture({
      onFrame: (frame) => frames.push({ byteLength: frame.byteLength, sequence: frame.sequence }),
      onSampleFrame: (frame) => sampleFrames.push(frame),
      source,
    });
    await flush();

    const deviceSampleRate = VIVA_AUDIO_SAMPLE_RATE_HZ * 2;
    const samples = new Float32Array(FRAME_SAMPLE_LENGTH * 2).fill(0.5);
    recorder.emit(samples, deviceSampleRate);
    recorder.emit(samples, deviceSampleRate);

    expect(frames).toEqual([
      { byteLength: FRAME_BYTE_LENGTH, sequence: 0 },
      { byteLength: FRAME_BYTE_LENGTH, sequence: 1 },
    ]);
    expect(sampleFrames.map((frame) => frame.sampleRateHz)).toEqual([
      deviceSampleRate,
      deviceSampleRate,
    ]);
    expect(sampleFrames.every((frame) => Number.isFinite(frame.rms))).toBe(true);
    controller.stop();
    await source.stop();
  });

  test("accumulates irregular 44.1 kHz callbacks without losing frame boundaries", async () => {
    const recorder = new FakeRecorder();
    const { source } = makeSource(recorder);
    const frames: { byteLength: number; sequence: number }[] = [];
    const sampleRates: number[] = [];
    const controller = startVivaPcm16StreamingCapture({
      onFrame: (frame) => frames.push({ byteLength: frame.byteLength, sequence: frame.sequence }),
      onSampleFrame: (frame) => sampleRates.push(frame.sampleRateHz),
      source,
    });
    await flush();

    const deviceSampleRate = 44_100;
    for (const length of [257, 313, 619, 263, 441, 527]) {
      recorder.emit(new Float32Array(length).fill(0.125), deviceSampleRate);
    }

    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((frame) => frame.byteLength === FRAME_BYTE_LENGTH)).toBe(true);
    expect(frames.map((frame) => frame.sequence)).toEqual(frames.map((_frame, index) => index));
    expect(sampleRates.every((sampleRate) => sampleRate === deviceSampleRate)).toBe(true);
    controller.cancel();
    await source.stop();
  });

  test("propagates registration and async start Result failures through the shared controller", async () => {
    for (const recorderOptions of [
      { onAudioReadyResult: { status: "error", message: "register denied" } as AudioApiResult },
      {
        startResult: Promise.resolve({
          status: "error",
          message: "start denied",
        }) as Promise<AudioApiResult>,
      },
    ]) {
      const recorder = new FakeRecorder(recorderOptions);
      const errors: unknown[] = [];
      const { source } = makeSource(recorder);
      const controller = startVivaPcm16StreamingCapture({
        onError: (error) => errors.push(error),
        onFrame: () => {},
        source,
      });

      await flush();
      expect(controller.isActive()).toBe(false);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain(
        recorderOptions.onAudioReadyResult ? "register denied" : "start denied",
      );
      await source.stop();
    }
  });

  test("maps recorder errors to processor_error and tears down callbacks", async () => {
    const recorder = new FakeRecorder();
    const errors: unknown[] = [];
    const ended: VivaAudioCaptureEndReason[] = [];
    const { source } = makeSource(recorder, new FakeAudioManager(), (error) => errors.push(error));
    await source.start(() => {}, {
      onEnded: (reason) => ended.push(reason),
    });

    const recorderError = { message: "input device failed" };
    recorder.emitError(recorderError);
    await source.stop();

    expect(errors).toEqual([recorderError]);
    expect(ended).toEqual(["processor_error"]);
    expect(recorder.calls.clearOnAudioReady).toBe(1);
    expect(recorder.calls.clearOnError).toBe(1);
    expect(recorder.calls.stop).toBe(1);
  });

  test("routes stop Result failures to the injected error callback without rejecting", async () => {
    const recorder = new FakeRecorder({
      stopResult: Promise.resolve({ status: "error", message: "stop denied" }),
    });
    const errors: unknown[] = [];
    const { source } = makeSource(recorder, new FakeAudioManager(), (error) => errors.push(error));
    await source.start(() => {});

    await source.stop();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("stop denied");
  });

  test("makes teardown idempotent across repeated stop calls", async () => {
    const recorder = new FakeRecorder();
    const { manager, source } = makeSource(recorder);
    await source.start(() => {});

    await Promise.all([source.stop(), source.stop(), source.stop()]);

    expect(recorder.calls.stop).toBe(1);
    expect(recorder.calls.clearOnAudioReady).toBe(1);
    expect(recorder.calls.clearOnError).toBe(1);
    expect(manager.activity).toEqual([true, false]);
  });
});
