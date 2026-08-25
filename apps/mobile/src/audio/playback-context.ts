import { VIVA_AUDIO_SAMPLE_RATE_HZ, type VivaAudioContextLike } from "@/agent/shared-web";

type VivaAudioBufferSourceNode = ReturnType<VivaAudioContextLike["createBufferSource"]>;
type VivaOnEndedCallback = NonNullable<VivaAudioBufferSourceNode["onended"]>;

type NativeBufferSourceNode = {
  buffer: VivaAudioBufferSourceNode["buffer"];
  connect: (
    ...arguments_: Parameters<VivaAudioBufferSourceNode["connect"]>
  ) => ReturnType<VivaAudioBufferSourceNode["connect"]>;
  onEnded: ((...arguments_: unknown[]) => void) | null | undefined;
  start: (
    ...arguments_: Parameters<VivaAudioBufferSourceNode["start"]>
  ) => ReturnType<VivaAudioBufferSourceNode["start"]>;
  stop: (
    ...arguments_: Parameters<VivaAudioBufferSourceNode["stop"]>
  ) => ReturnType<VivaAudioBufferSourceNode["stop"]>;
};

type NativePlaybackContext = {
  close?: NonNullable<VivaAudioContextLike["close"]>;
  createAnalyser?: NonNullable<VivaAudioContextLike["createAnalyser"]>;
  createBuffer: VivaAudioContextLike["createBuffer"];
  createBufferSource: () => NativeBufferSourceNode;
  currentTime: VivaAudioContextLike["currentTime"];
  destination: VivaAudioContextLike["destination"];
  resume?: NonNullable<VivaAudioContextLike["resume"]>;
  sampleRate: VivaAudioContextLike["sampleRate"];
};

type NativeContextFactory = (options: { sampleRate: number }) => unknown;

function defaultNativeContextFactory(options: { sampleRate: number }): unknown {
  // Keep the native JSI module out of Bun's process. It is loaded only when the
  // returned factory is invoked by a real mobile playback session.
  const audioApi = require("react-native-audio-api") as {
    AudioContext: new (options: { sampleRate: number }) => unknown;
  };
  return new audioApi.AudioContext(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNativePlaybackContext(value: unknown): value is NativePlaybackContext {
  if (!isRecord(value)) return false;
  return (
    typeof value.currentTime === "number" &&
    typeof value.sampleRate === "number" &&
    "destination" in value &&
    typeof value.createBuffer === "function" &&
    typeof value.createBufferSource === "function"
  );
}

function requireNativePlaybackContext(value: unknown): NativePlaybackContext {
  if (!isNativePlaybackContext(value)) {
    throw new Error("react-native-audio-api returned an invalid AudioContext");
  }
  return value;
}

class MobilePlaybackSourceNode {
  #onended: VivaAudioBufferSourceNode["onended"] = null;

  constructor(private readonly native: NativeBufferSourceNode) {}

  get buffer(): VivaAudioBufferSourceNode["buffer"] {
    return this.native.buffer;
  }

  set buffer(value: VivaAudioBufferSourceNode["buffer"]) {
    this.native.buffer = value;
  }

  connect(
    ...arguments_: Parameters<VivaAudioBufferSourceNode["connect"]>
  ): ReturnType<VivaAudioBufferSourceNode["connect"]> {
    return this.native.connect(...arguments_);
  }

  get onended(): VivaAudioBufferSourceNode["onended"] {
    return this.#onended;
  }

  set onended(callback: VivaAudioBufferSourceNode["onended"]) {
    this.#onended = callback;
    this.native.onEnded = callback
      ? (...arguments_: unknown[]) => {
          Reflect.apply(callback, this, arguments_ as Parameters<VivaOnEndedCallback>);
        }
      : null;
  }

  start(
    ...arguments_: Parameters<VivaAudioBufferSourceNode["start"]>
  ): ReturnType<VivaAudioBufferSourceNode["start"]> {
    return this.native.start(...arguments_);
  }

  stop(
    ...arguments_: Parameters<VivaAudioBufferSourceNode["stop"]>
  ): ReturnType<VivaAudioBufferSourceNode["stop"]> {
    return this.native.stop(...arguments_);
  }
}

function adaptNativeSourceNode(native: NativeBufferSourceNode): VivaAudioBufferSourceNode {
  // The native class and Web Audio's AudioBufferSourceNode have different
  // event-member names and otherwise expose a much larger class surface. This
  // adapter intentionally implements the exact subset consumed by the shared
  // playback sink before crossing that structural type boundary.
  return new MobilePlaybackSourceNode(native) as unknown as VivaAudioBufferSourceNode;
}

function adaptNativeContext(native: NativePlaybackContext): VivaAudioContextLike {
  const context: VivaAudioContextLike = {
    get currentTime() {
      return native.currentTime;
    },
    get destination() {
      return native.destination;
    },
    get sampleRate() {
      return native.sampleRate;
    },
    createBuffer: (...arguments_) => native.createBuffer(...arguments_),
    createBufferSource: () => adaptNativeSourceNode(native.createBufferSource()),
  };

  const createAnalyser = native.createAnalyser;
  if (createAnalyser) {
    context.createAnalyser = () => createAnalyser.call(native);
  }
  const resume = native.resume;
  if (resume) {
    context.resume = () => resume.call(native);
  }
  const close = native.close;
  if (close) {
    context.close = () => close.call(native);
  }

  return context;
}

export function createMobilePlaybackContextFactory(
  createContext: NativeContextFactory = defaultNativeContextFactory,
): () => VivaAudioContextLike {
  return () =>
    adaptNativeContext(
      requireNativePlaybackContext(
        createContext({
          sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ,
        }),
      ),
    );
}
