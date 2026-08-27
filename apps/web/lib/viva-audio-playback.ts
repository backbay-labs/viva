import type { AgentAudioFrame } from "@viva/core";
import { base64ToPcm16LeBytes, VIVA_AUDIO_SAMPLE_RATE_HZ } from "./viva-audio-capture";
import { computeRms, voiceLevelFromRms } from "./viva-voice-level";

export type VivaAudioPlaybackFrameInput = {
  responseId: string;
  frame: AgentAudioFrame;
};

export type VivaAudioPlaybackQueuedFrame = {
  responseId: string;
  pcm16Bytes: Uint8Array;
  byteLength: number;
  sequence: number;
};

export type VivaAudioPlaybackState = {
  userGestureUnlocked: boolean;
  queue: VivaAudioPlaybackQueuedFrame[];
  cancelledResponseIds: string[];
  nextSequence: number;
  speaking: boolean;
  responding: boolean;
  scheduledFrameCount: number;
};

export type VivaAudioPlaybackDrainResult = {
  state: VivaAudioPlaybackState;
  frame?: VivaAudioPlaybackQueuedFrame;
};

export type VivaAudioContextLike = {
  currentTime: number;
  sampleRate: number;
  destination: AudioNode;
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer;
  createBufferSource: () => AudioBufferSourceNode;
  createAnalyser?: () => AnalyserNode;
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
};

export type VivaAudioPlaybackSinkOptions = {
  contextFactory: () => VivaAudioContextLike;
  outputSampleRateHz?: number;
  onStateChange?: (state: VivaAudioPlaybackState) => void;
};

/**
 * `WEBSESSION-PLAYBACK-01`: one scheduled frame, with the interval it occupies.
 *
 * `buffer` is retained alongside the node because an `AudioBufferSourceNode` is
 * ONE-SHOT: a survivor that has to move earlier cannot be rescheduled, it has to
 * be recreated from the same decoded audio. `startTime`/`endTime` are what make
 * "has this already begun?" and "where does the next frame go?" answerable from
 * the frames that actually survived rather than from a running total that
 * cancellation silently invalidated.
 */
type ScheduledPlaybackFrame = Readonly<{
  responseId: string;
  source: AudioBufferSourceNode;
  buffer: AudioBuffer;
  sequence: number;
  startTime: number;
  endTime: number;
}>;

export function initialVivaAudioPlaybackState(): VivaAudioPlaybackState {
  return {
    cancelledResponseIds: [],
    nextSequence: 0,
    queue: [],
    responding: false,
    scheduledFrameCount: 0,
    speaking: false,
    userGestureUnlocked: false,
  };
}

export function unlockVivaAudioPlayback(state: VivaAudioPlaybackState): VivaAudioPlaybackState {
  if (state.userGestureUnlocked) return state;
  return { ...state, userGestureUnlocked: true };
}

export function enqueueVivaAudioPlaybackFrame(
  state: VivaAudioPlaybackState,
  input: VivaAudioPlaybackFrameInput,
): VivaAudioPlaybackState {
  if (!input.responseId) throw new Error("responseId is required for playback audio");
  if (state.cancelledResponseIds.includes(input.responseId)) return state;

  const pcm16Bytes = base64ToPcm16LeBytes(input.frame.pcm16_base64);
  if (pcm16Bytes.byteLength % 2 !== 0) {
    throw new Error("Playback PCM16 byte length must be even");
  }

  return {
    ...state,
    nextSequence: state.nextSequence + 1,
    responding: true,
    queue: [
      ...state.queue,
      {
        byteLength: pcm16Bytes.byteLength,
        pcm16Bytes,
        responseId: input.responseId,
        sequence: state.nextSequence,
      },
    ],
  };
}

export function dequeueVivaAudioPlaybackFrame(
  state: VivaAudioPlaybackState,
): VivaAudioPlaybackDrainResult {
  if (!state.userGestureUnlocked) return { state };
  const [frame, ...queue] = state.queue;
  if (!frame) return { state };
  return { frame, state: { ...state, queue } };
}

export function drainVivaAudioPlaybackFrames(
  state: VivaAudioPlaybackState,
  maxFrames = Number.POSITIVE_INFINITY,
): { state: VivaAudioPlaybackState; frames: VivaAudioPlaybackQueuedFrame[] } {
  if (!state.userGestureUnlocked || maxFrames <= 0) return { frames: [], state };

  const frames = state.queue.slice(0, maxFrames);
  const queue = state.queue.slice(frames.length);
  return {
    frames,
    state: { ...state, queue, responding: queue.length > 0 || state.scheduledFrameCount > 0 },
  };
}

export function cancelVivaAudioPlaybackResponse(
  state: VivaAudioPlaybackState,
  responseId?: string | null,
): VivaAudioPlaybackState {
  if (!responseId) {
    return { ...state, queue: [], responding: state.scheduledFrameCount > 0 };
  }
  const cancelledResponseIds = state.cancelledResponseIds.includes(responseId)
    ? state.cancelledResponseIds
    : [...state.cancelledResponseIds, responseId];
  const queue = state.queue.filter((frame) => frame.responseId !== responseId);
  return {
    ...state,
    cancelledResponseIds,
    queue,
    responding: queue.length > 0 || state.scheduledFrameCount > 0,
  };
}

export function canDrainVivaAudioPlayback(state: VivaAudioPlaybackState): boolean {
  return state.userGestureUnlocked && state.queue.length > 0;
}

export class VivaAudioPlaybackSink {
  readonly #contextFactory: () => VivaAudioContextLike;
  readonly #outputSampleRateHz: number;
  readonly #onStateChange?: (state: VivaAudioPlaybackState) => void;
  #context: VivaAudioContextLike | null = null;
  #state = initialVivaAudioPlaybackState();
  #scheduled = new Map<number, ScheduledPlaybackFrame>();
  #nextStartTime = 0;
  #analyser: AnalyserNode | null = null;
  #analyserBuffer: Float32Array<ArrayBuffer> | null = null;

  /**
   * Examiner-voice amplitude (0..1) for the listening bloom's "breathe back in
   * gold" — RMS off an AnalyserNode tapping the playback output. Client-only and
   * cheap (one reused buffer). Returns 0 when the context cannot create an
   * analyser (mocks/tests) or no audio has played yet.
   */
  getOutputLevel(): number {
    if (!this.#analyser || !this.#analyserBuffer) return 0;
    this.#analyser.getFloatTimeDomainData(this.#analyserBuffer);
    return voiceLevelFromRms(computeRms(this.#analyserBuffer));
  }

  #outputTarget(context: VivaAudioContextLike): AudioNode {
    if (!context.createAnalyser) return context.destination;
    if (!this.#analyser) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      analyser.connect(context.destination);
      this.#analyser = analyser;
      this.#analyserBuffer = new Float32Array(analyser.fftSize);
    }
    return this.#analyser;
  }

  constructor(options: VivaAudioPlaybackSinkOptions) {
    this.#contextFactory = options.contextFactory;
    this.#outputSampleRateHz = options.outputSampleRateHz ?? VIVA_AUDIO_SAMPLE_RATE_HZ;
    this.#onStateChange = options.onStateChange;
  }

  getState(): VivaAudioPlaybackState {
    return clonePlaybackState(this.#state);
  }

  async unlock(): Promise<VivaAudioPlaybackState> {
    if (!this.#context) {
      this.#context = this.#contextFactory();
      this.#nextStartTime = this.#context.currentTime;
    }
    if (this.#context.resume) await this.#context.resume();
    this.#state = unlockVivaAudioPlayback(this.#state);
    this.#scheduleQueuedFrames();
    this.#publishState();
    return this.getState();
  }

  enqueue(input: VivaAudioPlaybackFrameInput): VivaAudioPlaybackState {
    this.#state = enqueueVivaAudioPlaybackFrame(this.#state, input);
    this.#scheduleQueuedFrames();
    this.#publishState();
    return this.getState();
  }

  cancel(responseId?: string | null): VivaAudioPlaybackState {
    if (!responseId) {
      for (const frame of this.#scheduled.values()) releasePlaybackFrame(frame);
      this.#scheduled.clear();
      this.#state = {
        ...cancelVivaAudioPlaybackResponse(this.#state, null),
        responding: false,
        scheduledFrameCount: 0,
        speaking: false,
      };
      this.#rebaseOnSurvivingFrames();
      this.#publishState();
      return this.getState();
    }

    for (const frame of this.#scheduled.values()) {
      if (frame.responseId === responseId) {
        releasePlaybackFrame(frame);
        this.#scheduled.delete(frame.sequence);
      }
    }
    // The gap the cancelled frames left is closed BEFORE any state is published,
    // so a listener never sees a schedule that still counts abandoned time.
    this.#rebaseOnSurvivingFrames();
    this.#state = {
      ...cancelVivaAudioPlaybackResponse(this.#state, responseId),
      scheduledFrameCount: this.#scheduled.size,
      speaking: this.#scheduled.size > 0,
      responding:
        this.#state.queue.some((frame) => frame.responseId !== responseId) ||
        this.#scheduled.size > 0,
    };
    this.#publishState();
    return this.getState();
  }

  resetForGeneration(): VivaAudioPlaybackState {
    const nextSequence = this.#state.nextSequence;
    for (const frame of this.#scheduled.values()) releasePlaybackFrame(frame);
    this.#scheduled.clear();
    this.#state = {
      ...initialVivaAudioPlaybackState(),
      nextSequence,
      userGestureUnlocked: this.#state.userGestureUnlocked,
    };
    this.#rebaseOnSurvivingFrames();
    this.#publishState();
    return this.getState();
  }

  async close(): Promise<void> {
    this.cancel(null);
    this.#analyser?.disconnect();
    this.#analyser = null;
    this.#analyserBuffer = null;
    await this.#context?.close?.();
    this.#context = null;
    this.#nextStartTime = 0;
  }

  #scheduleQueuedFrames() {
    if (!this.#state.userGestureUnlocked || !this.#context || this.#state.queue.length === 0) {
      return;
    }

    const context = this.#context;
    for (const frame of this.#state.queue) {
      if (this.#state.cancelledResponseIds.includes(frame.responseId)) continue;
      const buffer = pcm16LeBytesToAudioBuffer(frame.pcm16Bytes, context, this.#outputSampleRateHz);
      const startTime = Math.max(context.currentTime, this.#nextStartTime);
      this.#startScheduledFrame({
        buffer,
        context,
        responseId: frame.responseId,
        sequence: frame.sequence,
        startTime,
      });
      this.#nextStartTime = startTime + buffer.duration;
    }

    // WSC-M08: this loop drains the WHOLE queue on every run — a frame is either
    // scheduled or dropped as cancelled, never carried over — so there is no
    // remainder to keep.
    this.#state = {
      ...this.#state,
      queue: [],
      responding: this.#scheduled.size > 0,
      scheduledFrameCount: this.#scheduled.size,
      speaking: this.#scheduled.size > 0,
    };
  }

  /** Creates, wires, and starts ONE node for a frame, recording its interval. */
  #startScheduledFrame(input: {
    buffer: AudioBuffer;
    context: VivaAudioContextLike;
    responseId: string;
    sequence: number;
    startTime: number;
  }) {
    const source = input.context.createBufferSource();
    source.buffer = input.buffer;
    source.connect(this.#outputTarget(input.context));
    source.onended = () => {
      this.#scheduled.delete(input.sequence);
      this.#state = {
        ...this.#state,
        responding: this.#state.queue.length > 0 || this.#scheduled.size > 0,
        scheduledFrameCount: this.#scheduled.size,
        speaking: this.#scheduled.size > 0,
      };
      this.#publishState();
    };
    this.#scheduled.set(input.sequence, {
      buffer: input.buffer,
      endTime: input.startTime + input.buffer.duration,
      responseId: input.responseId,
      sequence: input.sequence,
      source,
      startTime: input.startTime,
    });
    source.start(input.startTime);
  }

  /**
   * Recomputes the schedule from the frames that SURVIVED a cancellation.
   *
   * A survivor that has already begun keeps its interval — restarting audio the
   * learner is mid-way through hearing would be worse than the gap. Every
   * survivor still in the future is released and recreated from its retained
   * buffer, in sequence order, contiguously from the later of "now" and the end
   * of whatever is still playing. `nextStartTime` then follows from those
   * intervals, and collapses to `currentTime` when nothing survived at all.
   */
  #rebaseOnSurvivingFrames() {
    const context = this.#context;
    if (!context) return;
    const now = context.currentTime;
    const survivors = [...this.#scheduled.values()].sort((a, b) => a.sequence - b.sequence);
    let cursor = now;
    for (const frame of survivors) {
      if (frame.startTime <= now) cursor = Math.max(cursor, frame.endTime);
    }
    for (const frame of survivors) {
      if (frame.startTime <= now) continue;
      releasePlaybackFrame(frame);
      this.#startScheduledFrame({
        buffer: frame.buffer,
        context,
        responseId: frame.responseId,
        sequence: frame.sequence,
        startTime: cursor,
      });
      cursor += frame.buffer.duration;
    }
    this.#nextStartTime = cursor;
  }

  #publishState() {
    this.#onStateChange?.(this.getState());
  }
}

export function createVivaAudioPlaybackSink(
  options: VivaAudioPlaybackSinkOptions,
): VivaAudioPlaybackSink {
  return new VivaAudioPlaybackSink(options);
}

export function pcm16LeBytesToAudioBuffer(
  pcm16Bytes: Uint8Array,
  context: Pick<VivaAudioContextLike, "createBuffer">,
  sampleRateHz = VIVA_AUDIO_SAMPLE_RATE_HZ,
): AudioBuffer {
  if (pcm16Bytes.byteLength % 2 !== 0) {
    throw new Error("Playback PCM16 byte length must be even");
  }
  const sampleCount = pcm16Bytes.byteLength / 2;
  const buffer = context.createBuffer(1, sampleCount, sampleRateHz);
  const output = buffer.getChannelData(0);
  const view = new DataView(pcm16Bytes.buffer, pcm16Bytes.byteOffset, pcm16Bytes.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return buffer;
}

function clonePlaybackState(state: VivaAudioPlaybackState): VivaAudioPlaybackState {
  return {
    ...state,
    cancelledResponseIds: [...state.cancelledResponseIds],
    queue: state.queue.map((frame) => ({
      ...frame,
      pcm16Bytes: frame.pcm16Bytes.slice(),
    })),
  };
}

/**
 * Releases one scheduled node exactly once: its `onended` is cleared FIRST so a
 * stop cannot re-enter the scheduler's bookkeeping, then it is stopped and
 * disconnected so the discarded node holds no graph edge.
 */
function releasePlaybackFrame(frame: ScheduledPlaybackFrame) {
  frame.source.onended = null;
  stopPlaybackNode(frame.source);
  try {
    frame.source.disconnect();
  } catch {
    // A node that was never connected (or already torn down) is already released.
  }
}

function stopPlaybackNode(node: AudioBufferSourceNode) {
  try {
    node.stop();
  } catch {
    // Already-ended source nodes throw in some browser engines.
  }
}
