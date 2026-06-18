import { describe, expect, test } from "bun:test";
import { pcm16LeBytesToBase64 } from "./viva-audio-capture";
import {
  cancelVivaAudioPlaybackResponse,
  canDrainVivaAudioPlayback,
  createVivaAudioPlaybackSink,
  dequeueVivaAudioPlaybackFrame,
  drainVivaAudioPlaybackFrames,
  enqueueVivaAudioPlaybackFrame,
  initialVivaAudioPlaybackState,
  unlockVivaAudioPlayback,
  type VivaAudioContextLike,
} from "./viva-audio-playback";

describe("Viva audio playback queue", () => {
  test("stores response-bound PCM16 frames decoded from base64", () => {
    const state = enqueueVivaAudioPlaybackFrame(initialVivaAudioPlaybackState(), {
      frame: { pcm16_base64: "AQIDBA==" },
      responseId: "response-1",
    });

    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.responseId).toBe("response-1");
    expect(state.queue[0]?.sequence).toBe(0);
    expect(state.queue[0]?.byteLength).toBe(4);
    expect(Array.from(state.queue[0]?.pcm16Bytes ?? [])).toEqual([1, 2, 3, 4]);
  });

  test("does not drain before the user gesture gate is unlocked", () => {
    let state = initialVivaAudioPlaybackState();
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AQI=" },
      responseId: "response-1",
    });

    const result = dequeueVivaAudioPlaybackFrame(state);

    expect(canDrainVivaAudioPlayback(state)).toBe(false);
    expect(result.frame).toBeUndefined();
    expect(result.state.queue).toHaveLength(1);
  });

  test("drains queued frames in insertion order after a user gesture", () => {
    let state = unlockVivaAudioPlayback(initialVivaAudioPlaybackState());
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AQI=" },
      responseId: "response-1",
    });
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AwQ=" },
      responseId: "response-2",
    });
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "BQY=" },
      responseId: "response-1",
    });

    const result = drainVivaAudioPlaybackFrames(state);

    expect(result.frames.map((frame) => [frame.sequence, frame.responseId])).toEqual([
      [0, "response-1"],
      [1, "response-2"],
      [2, "response-1"],
    ]);
    expect(result.frames.map((frame) => Array.from(frame.pcm16Bytes))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(result.state.queue).toEqual([]);
  });

  test("can drain a bounded number of frames without dropping the rest", () => {
    let state = unlockVivaAudioPlayback(initialVivaAudioPlaybackState());
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AQI=" },
      responseId: "response-1",
    });
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AwQ=" },
      responseId: "response-1",
    });

    const result = drainVivaAudioPlaybackFrames(state, 1);

    expect(result.frames.map((frame) => frame.sequence)).toEqual([0]);
    expect(result.state.queue.map((frame) => frame.sequence)).toEqual([1]);
  });

  test("clears queued frames for cancelled response IDs and suppresses later stale frames", () => {
    let state = unlockVivaAudioPlayback(initialVivaAudioPlaybackState());
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AQI=" },
      responseId: "response-1",
    });
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AwQ=" },
      responseId: "response-2",
    });
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "BQY=" },
      responseId: "response-1",
    });

    state = cancelVivaAudioPlaybackResponse(state, "response-1");
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "Bwg=" },
      responseId: "response-1",
    });

    expect(state.cancelledResponseIds).toEqual(["response-1"]);
    expect(state.queue.map((frame) => frame.responseId)).toEqual(["response-2"]);
    expect(state.queue.map((frame) => Array.from(frame.pcm16Bytes))).toEqual([[3, 4]]);
  });

  test("clears all queued playback for global cancellation without blocking future responses", () => {
    let state = unlockVivaAudioPlayback(initialVivaAudioPlaybackState());
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AQI=" },
      responseId: "response-1",
    });

    state = cancelVivaAudioPlaybackResponse(state, null);
    state = enqueueVivaAudioPlaybackFrame(state, {
      frame: { pcm16_base64: "AwQ=" },
      responseId: "response-2",
    });

    expect(state.cancelledResponseIds).toEqual([]);
    expect(state.queue.map((frame) => frame.responseId)).toEqual(["response-2"]);
  });

  test("rejects unbound or malformed playback frames", () => {
    expect(() =>
      enqueueVivaAudioPlaybackFrame(initialVivaAudioPlaybackState(), {
        frame: { pcm16_base64: "AQI=" },
        responseId: "",
      }),
    ).toThrow("responseId is required for playback audio");
    expect(() =>
      enqueueVivaAudioPlaybackFrame(initialVivaAudioPlaybackState(), {
        frame: { pcm16_base64: "AQID" },
        responseId: "response-1",
      }),
    ).toThrow("Playback PCM16 byte length must be even");
  });

  test("sink gates playback until unlock, schedules buffers, and cancels scheduled response frames", async () => {
    const context = new FakeAudioContext();
    const states: ReturnType<ReturnType<typeof createVivaAudioPlaybackSink>["getState"]>[] = [];
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => context,
      onStateChange: (state) => states.push(state),
    });

    sink.enqueue({
      frame: { pcm16_base64: pcm16LeBytesToBase64(new Uint8Array([0, 0, 255, 127])) },
      responseId: "response-1",
    });

    expect(context.sources).toHaveLength(0);
    expect(sink.getState().queue).toHaveLength(1);

    await sink.unlock();
    sink.enqueue({
      frame: { pcm16_base64: pcm16LeBytesToBase64(new Uint8Array([0, 32, 0, 224])) },
      responseId: "response-1",
    });
    sink.enqueue({
      frame: { pcm16_base64: pcm16LeBytesToBase64(new Uint8Array([1, 2, 3, 4])) },
      responseId: "response-2",
    });

    expect(context.sources).toHaveLength(3);
    expect(context.sources.map((source) => source.startTime)).toEqual([
      4,
      4 + 2 / 24_000,
      4 + 4 / 24_000,
    ]);
    expect(context.buffers[0]?.channelData).toEqual(new Float32Array([0, 32_767 / 32_768]));
    expect(sink.getState()).toMatchObject({
      queue: [],
      responding: true,
      scheduledFrameCount: 3,
      speaking: true,
      userGestureUnlocked: true,
    });

    sink.cancel("response-1");

    expect(context.sources.map((source) => source.stopped)).toEqual([true, true, false]);
    expect(sink.getState()).toMatchObject({
      cancelledResponseIds: ["response-1"],
      scheduledFrameCount: 1,
      speaking: true,
    });

    context.sources[2]?.finish();

    expect(sink.getState()).toMatchObject({
      responding: false,
      scheduledFrameCount: 0,
      speaking: false,
    });
    expect(states.at(-1)?.speaking).toBe(false);
  });
});

class FakeAudioContext implements VivaAudioContextLike {
  currentTime = 4;
  destination = {} as AudioNode;
  sampleRate = 24_000;
  buffers: FakeAudioBuffer[] = [];
  sources: FakeAudioBufferSourceNode[] = [];

  createBuffer(_numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    const buffer = new FakeAudioBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeAudioBufferSourceNode();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  async resume() {}
}

class FakeAudioBuffer {
  readonly channelData: Float32Array;
  readonly duration: number;

  constructor(length: number, sampleRate: number) {
    this.channelData = new Float32Array(length);
    this.duration = length / sampleRate;
  }

  getChannelData(channel: number) {
    if (channel !== 0) throw new Error("Unexpected fake channel");
    return this.channelData;
  }
}

class FakeAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startTime: number | undefined;
  stopped = false;

  connect(_destination: AudioNode) {
    return _destination;
  }

  start(when = 0) {
    this.startTime = when;
  }

  stop() {
    this.stopped = true;
  }

  finish() {
    this.onended?.();
  }
}
