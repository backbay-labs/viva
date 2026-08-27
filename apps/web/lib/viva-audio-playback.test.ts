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

  test("sink generation reset clears cancelled response ids without relocking playback", async () => {
    const context = new FakeAudioContext();
    const sink = createVivaAudioPlaybackSink({ contextFactory: () => context });

    await sink.unlock();
    sink.enqueue({
      frame: { pcm16_base64: pcm16LeBytesToBase64(new Uint8Array([0, 0])) },
      responseId: "response-1",
    });
    sink.cancel("response-1");

    expect(sink.getState().cancelledResponseIds).toEqual(["response-1"]);

    sink.resetForGeneration();
    sink.enqueue({
      frame: { pcm16_base64: pcm16LeBytesToBase64(new Uint8Array([1, 0])) },
      responseId: "response-1",
    });
    context.sources[0]?.finish();

    expect(sink.getState().cancelledResponseIds).toEqual([]);
    expect(sink.getState().scheduledFrameCount).toBe(1);
    expect(sink.getState().userGestureUnlocked).toBe(true);
    expect(context.sources.at(-1)?.stopped).toBe(false);
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

    // Both response-1 nodes are released. The response-2 frame was scheduled
    // BEHIND them, so it is recreated from its retained buffer at the
    // cancellation instant rather than left waiting out audio that will never
    // play — its original one-shot node is released with the cancelled ones.
    expect(context.sources.map((source) => source.stopped)).toEqual([true, true, true, false]);
    expect(context.sources.at(-1)?.startTime).toBe(4);
    expect(sink.getState()).toMatchObject({
      cancelledResponseIds: ["response-1"],
      scheduledFrameCount: 1,
      speaking: true,
    });

    context.sources.at(-1)?.finish();

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
  disconnectCount = 0;

  connect(_destination: AudioNode) {
    return _destination;
  }

  disconnect() {
    this.disconnectCount += 1;
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

/**
 * `WEBSESSION-PLAYBACK-01` — cancellation leaves no phantom gap.
 *
 * Each scheduled frame is a one-shot `AudioBufferSourceNode` placed at an
 * absolute context time. Cancelling one response used to stop its nodes and leave
 * `nextStartTime` pointing past the audio that no longer exists, so every
 * SURVIVING future frame kept its old slot and the next response was queued
 * behind silence the learner sits through. The schedule must instead be
 * recomputed from the frames that actually survived.
 */
describe("playback schedule after cancellation (WEBSESSION-PLAYBACK-01)", () => {
  const SAMPLE_RATE_HZ = 24_000;

  /** A frame whose decoded buffer is exactly `seconds` long at 24 kHz. */
  function frameOfSeconds(seconds: number) {
    return { pcm16_base64: pcm16LeBytesToBase64(new Uint8Array(seconds * SAMPLE_RATE_HZ * 2)) };
  }

  function scheduleOf(context: TimelineAudioContext) {
    return context.sources
      .filter((source) => source.startTime !== undefined)
      .map((source) => ({
        duration: source.buffer?.duration ?? 0,
        disconnects: source.disconnectCount,
        startTime: source.startTime ?? 0,
        stopped: source.stopped,
      }));
  }

  test("a cancelled response's survivors are re-laid contiguously from now", async () => {
    const context = new TimelineAudioContext(10);
    const states: Array<{ scheduledFrameCount: number; speaking: boolean }> = [];
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => context,
      onStateChange: (state) => states.push(state),
    });
    await sink.unlock();

    sink.enqueue({ frame: frameOfSeconds(2), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(3), responseId: "B" });
    expect(scheduleOf(context).map((entry) => entry.startTime)).toEqual([10, 12]);

    // Half a second into A, the learner barges in on A alone. B is still in the
    // future and must move UP, not keep waiting for audio that will never play.
    context.currentTime = 10.5;
    sink.cancel("A");

    const rescheduled = context.sources.filter((source) => source.startTime !== undefined);
    // A's node and B's original node are both released exactly once.
    expect(rescheduled[0]?.stopped).toBe(true);
    expect(rescheduled[0]?.stopCount).toBe(1);
    expect(rescheduled[0]?.disconnectCount).toBe(1);
    expect(rescheduled[1]?.stopped).toBe(true);
    expect(rescheduled[1]?.stopCount).toBe(1);
    expect(rescheduled[1]?.disconnectCount).toBe(1);
    // B is recreated from its RETAINED buffer at the cancellation instant.
    expect(rescheduled[2]?.startTime).toBe(10.5);
    expect(rescheduled[2]?.buffer?.duration).toBe(3);
    expect(rescheduled[2]?.stopped).toBe(false);
    expect(sink.getState().scheduledFrameCount).toBe(1);
    expect(states.at(-1)).toMatchObject({ scheduledFrameCount: 1, speaking: true });

    // The next response starts at B's NEW end, not at its abandoned 15.
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "C" });
    expect(context.sources.at(-1)?.startTime).toBe(13.5);
  });

  test("an already-started survivor keeps its interval and is never restarted", async () => {
    const context = new TimelineAudioContext(10);
    const sink = createVivaAudioPlaybackSink({ contextFactory: () => context });
    await sink.unlock();

    sink.enqueue({ frame: frameOfSeconds(2), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(3), responseId: "B" });

    // Now cancel the FUTURE response while the active one plays on.
    context.currentTime = 10.5;
    sink.cancel("B");

    const nodeA = context.sources[0];
    expect(nodeA?.startTime).toBe(10);
    expect(nodeA?.startCount).toBe(1);
    expect(nodeA?.stopped).toBe(false);
    expect(nodeA?.disconnectCount).toBe(0);
    expect(context.sources[1]?.stopped).toBe(true);
    expect(context.sources[1]?.disconnectCount).toBe(1);
    expect(sink.getState().scheduledFrameCount).toBe(1);

    // C waits for A to finish and not one sample longer.
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "C" });
    expect(context.sources.at(-1)?.startTime).toBe(12);
  });

  test("cancelling the only response starts the next frame at the current time", async () => {
    const context = new TimelineAudioContext(10);
    const sink = createVivaAudioPlaybackSink({ contextFactory: () => context });
    await sink.unlock();

    sink.enqueue({ frame: frameOfSeconds(2), responseId: "A" });
    context.currentTime = 10.5;
    sink.cancel("A");

    expect(sink.getState().scheduledFrameCount).toBe(0);
    expect(sink.getState().speaking).toBe(false);

    sink.enqueue({ frame: frameOfSeconds(1), responseId: "B" });
    expect(context.sources.at(-1)?.startTime).toBe(10.5);
  });

  test("multiple future survivors stay contiguous and in sequence order", async () => {
    const context = new TimelineAudioContext(10);
    const sink = createVivaAudioPlaybackSink({ contextFactory: () => context });
    await sink.unlock();

    sink.enqueue({ frame: frameOfSeconds(2), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "B" });
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(2), responseId: "B" });
    expect(scheduleOf(context).map((entry) => entry.startTime)).toEqual([10, 12, 13, 14]);

    context.currentTime = 10.5;
    sink.cancel("A");

    const live = context.sources.filter(
      (source) => source.startTime !== undefined && !source.stopped,
    );
    expect(live.map((source) => [source.startTime, source.buffer?.duration])).toEqual([
      [10.5, 1],
      [11.5, 2],
    ]);
    expect(sink.getState().scheduledFrameCount).toBe(2);

    sink.enqueue({ frame: frameOfSeconds(1), responseId: "C" });
    expect(context.sources.at(-1)?.startTime).toBe(13.5);
  });

  test("a global cancellation empties the schedule and rebases on the current time", async () => {
    const context = new TimelineAudioContext(10);
    const sink = createVivaAudioPlaybackSink({ contextFactory: () => context });
    await sink.unlock();

    sink.enqueue({ frame: frameOfSeconds(2), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(3), responseId: "B" });
    context.currentTime = 11;
    sink.cancel(null);

    expect(context.sources.every((source) => source.stopped)).toBe(true);
    expect(sink.getState()).toMatchObject({
      responding: false,
      scheduledFrameCount: 0,
      speaking: false,
    });

    sink.enqueue({ frame: frameOfSeconds(1), responseId: "C" });
    expect(context.sources.at(-1)?.startTime).toBe(11);
  });

  test("cancellation publishes exactly one coherent state, even when stops fire onended", async () => {
    const context = new TimelineAudioContext(10, { endsOnStop: true });
    const published: Array<{ scheduledFrameCount: number; speaking: boolean }> = [];
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => context,
      onStateChange: (state) => published.push(state),
    });
    await sink.unlock();

    sink.enqueue({ frame: frameOfSeconds(2), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(3), responseId: "B" });
    context.currentTime = 10.5;
    published.length = 0;

    sink.cancel("A");

    // Every released node's `onended` was cleared BEFORE it was stopped, so no
    // discarded node can delete a live frame's slot or emit a half-torn-down
    // state on its way out.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ scheduledFrameCount: 1, speaking: true });
    expect(sink.getState().scheduledFrameCount).toBe(1);
    expect(context.sources.at(-1)?.startTime).toBe(10.5);

    sink.enqueue({ frame: frameOfSeconds(1), responseId: "C" });
    expect(context.sources.at(-1)?.startTime).toBe(13.5);
  });

  /**
   * WSC-M08 characterization: the scheduler drains the WHOLE queue every time it
   * runs — there is no partially-scheduled remainder for a "remaining queue"
   * variable to hold.
   */
  test("every unlocked enqueue drains the queue completely into the schedule", async () => {
    const context = new TimelineAudioContext(10);
    const sink = createVivaAudioPlaybackSink({ contextFactory: () => context });

    sink.enqueue({ frame: frameOfSeconds(1), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "A" });
    // Locked: nothing is scheduled and everything is still queued.
    expect(sink.getState().queue).toHaveLength(2);
    expect(context.sources).toHaveLength(0);

    await sink.unlock();

    expect(sink.getState().queue).toEqual([]);
    expect(sink.getState().scheduledFrameCount).toBe(2);

    // A frame for an already-cancelled response is dropped, not left queued.
    sink.cancel("A");
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "A" });
    sink.enqueue({ frame: frameOfSeconds(1), responseId: "B" });
    expect(sink.getState().queue).toEqual([]);
    expect(sink.getState().scheduledFrameCount).toBe(1);
  });
});

/**
 * A fake context whose `currentTime` the test advances by hand.
 *
 * `endsOnStop` models the real Web Audio contract that stopping a started
 * `AudioBufferSourceNode` fires its `onended`, which is exactly how a released
 * node can reach back into the scheduler it no longer belongs to.
 */
class TimelineAudioContext implements VivaAudioContextLike {
  currentTime: number;
  destination = {} as AudioNode;
  sampleRate = 24_000;
  buffers: FakeAudioBuffer[] = [];
  sources: TimelineBufferSourceNode[] = [];
  readonly #endsOnStop: boolean;

  constructor(startTime: number, options: { endsOnStop?: boolean } = {}) {
    this.currentTime = startTime;
    this.#endsOnStop = options.endsOnStop ?? false;
  }

  createBuffer(_numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    const buffer = new FakeAudioBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new TimelineBufferSourceNode(this.#endsOnStop);
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  async resume() {}
}

class TimelineBufferSourceNode {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startTime: number | undefined;
  startCount = 0;
  stopped = false;
  stopCount = 0;
  disconnectCount = 0;
  readonly #endsOnStop: boolean;

  constructor(endsOnStop = false) {
    this.#endsOnStop = endsOnStop;
  }

  connect(destination: AudioNode) {
    return destination;
  }

  disconnect() {
    this.disconnectCount += 1;
  }

  start(when = 0) {
    this.startCount += 1;
    this.startTime = when;
  }

  stop() {
    this.stopped = true;
    this.stopCount += 1;
    if (this.#endsOnStop) this.onended?.();
  }

  finish() {
    this.onended?.();
  }
}
