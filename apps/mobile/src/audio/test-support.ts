export function fakeNativeContext(options: { sampleRate: number }) {
  const calls = {
    close: 0,
    connectArguments: [] as unknown[],
    createAnalyser: 0,
    createBufferArguments: [] as unknown[],
    createBufferSource: 0,
    resume: 0,
    startArguments: [] as unknown[],
    stopArguments: [] as unknown[],
    stopCount: 0,
  };
  const destination = {} as AudioNode;
  const buffer = new FakeAudioBuffer(0, options.sampleRate);
  let firstBufferReturned = false;
  const buffers: AudioBuffer[] = [];
  const analyserSamples = new Float32Array(256);
  const analyser = {
    connect: (...arguments_: unknown[]) => {
      analyserCalls.connectArguments = arguments_;
      return destination;
    },
    disconnect: () => {
      analyserCalls.disconnect += 1;
    },
    fftSize: 0,
    getFloatTimeDomainData: (target: Float32Array) => {
      target.set(analyserSamples.subarray(0, target.length));
    },
    smoothingTimeConstant: 0,
    samples: analyserSamples,
  } as unknown as FakeAnalyser;
  const analyserCalls = {
    connectArguments: [] as unknown[],
    disconnect: 0,
  };
  const connectResult = {} as AudioNode;
  const sources: FakeNativeSource[] = [];
  const source = createFakeNativeSource(calls, connectResult);
  sources.push(source);
  const context = {
    close: async () => {
      calls.close += 1;
    },
    createAnalyser: () => {
      calls.createAnalyser += 1;
      return analyser;
    },
    createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => {
      const arguments_ = [numberOfChannels, length, sampleRate];
      calls.createBufferArguments = arguments_;
      let nextBuffer: FakeAudioBuffer;
      if (firstBufferReturned) {
        nextBuffer = new FakeAudioBuffer(length, sampleRate);
      } else {
        firstBufferReturned = true;
        nextBuffer = buffer;
      }
      nextBuffer.resize(length, sampleRate);
      buffers.push(nextBuffer as unknown as AudioBuffer);
      return nextBuffer as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      calls.createBufferSource += 1;
      if (calls.createBufferSource === 1) return source;
      const nextSource = createFakeNativeSource(calls, connectResult);
      sources.push(nextSource);
      return nextSource;
    },
    currentTime: 12.5,
    destination,
    resume: async () => {
      calls.resume += 1;
    },
    sampleRate: options.sampleRate,
  };

  return {
    analyser,
    analyserCalls,
    buffer: buffer as unknown as AudioBuffer,
    buffers,
    calls,
    connectResult,
    context,
    destination,
    source,
    sources,
  };
}

type FakeAnalyser = AnalyserNode & {
  samples: Float32Array;
};

class FakeAudioBuffer {
  duration: number;
  private channelData: Float32Array;

  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    if (channel !== 0) throw new Error("Unexpected fake channel");
    return this.channelData;
  }

  resize(length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }
}

type FakeNativeSource = {
  buffer: AudioBuffer | null;
  connect: (...arguments_: unknown[]) => AudioNode;
  onEnded: (() => void) | null;
  start: (...arguments_: unknown[]) => void;
  stop: (...arguments_: unknown[]) => void;
};

function createFakeNativeSource(
  calls: {
    connectArguments: unknown[];
    startArguments: unknown[];
    stopArguments: unknown[];
    stopCount: number;
  },
  connectResult: AudioNode,
): FakeNativeSource {
  return {
    buffer: null,
    connect: (...arguments_: unknown[]) => {
      calls.connectArguments = arguments_;
      return connectResult;
    },
    onEnded: null,
    start: (...arguments_: unknown[]) => {
      calls.startArguments = arguments_;
    },
    stop: (...arguments_: unknown[]) => {
      calls.stopArguments = arguments_;
      calls.stopCount += 1;
    },
  };
}
