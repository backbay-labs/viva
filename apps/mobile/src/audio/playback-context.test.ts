import { describe, expect, test } from "bun:test";
import { VIVA_AUDIO_SAMPLE_RATE_HZ } from "@/agent/shared-web";
import { createMobilePlaybackContextFactory } from "@/audio/playback-context";
import { fakeNativeContext } from "@/audio/test-support";

describe("createMobilePlaybackContextFactory", () => {
  test("constructs lazily at 24 kHz and preserves the sink context surface", async () => {
    let fake: ReturnType<typeof fakeNativeContext> | undefined;
    const factory = createMobilePlaybackContextFactory((options) => {
      fake = fakeNativeContext(options);
      return fake.context;
    });

    expect(fake).toBeUndefined();

    const context = factory();
    expect(fake?.context.sampleRate).toBe(VIVA_AUDIO_SAMPLE_RATE_HZ);
    expect(context.sampleRate).toBe(VIVA_AUDIO_SAMPLE_RATE_HZ);
    expect(context.currentTime).toBe(fake?.context.currentTime);
    expect(context.destination).toBe(fake?.destination);

    for (const member of [
      "close",
      "createAnalyser",
      "createBuffer",
      "createBufferSource",
      "currentTime",
      "destination",
      "resume",
      "sampleRate",
    ]) {
      expect(member in context).toBe(true);
    }

    const createdBuffer = context.createBuffer(1, 4, VIVA_AUDIO_SAMPLE_RATE_HZ);
    expect(createdBuffer).toBe(fake?.buffer);
    expect(fake?.calls.createBufferArguments).toEqual([1, 4, VIVA_AUDIO_SAMPLE_RATE_HZ]);
    expect(context.createAnalyser?.()).toBe(fake?.analyser);
    await context.resume?.();
    await context.close?.();
    expect(fake?.calls.createAnalyser).toBe(1);
    expect(fake?.calls.resume).toBe(1);
    expect(fake?.calls.close).toBe(1);
  });

  test("adapts source delegation and maps onended to native onEnded", () => {
    const fake = fakeNativeContext({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ });
    const context = createMobilePlaybackContextFactory(() => fake.context)();
    const source = context.createBufferSource();
    const buffer = context.createBuffer(1, 4, VIVA_AUDIO_SAMPLE_RATE_HZ);

    expect("onended" in fake.source).toBe(false);
    expect(fake.calls.createBufferSource).toBe(1);

    source.buffer = buffer;
    expect(fake.source.buffer).toBe(buffer);
    expect(source.buffer).toBe(buffer);

    expect(source.connect(fake.destination)).toBe(fake.connectResult);
    source.start(1, 2, 3);
    source.stop(4);
    expect(fake.calls.connectArguments).toEqual([fake.destination]);
    expect(fake.calls.startArguments).toEqual([1, 2, 3]);
    expect(fake.calls.stopArguments).toEqual([4]);

    let endedCalls = 0;
    const onended = () => {
      endedCalls += 1;
    };
    source.onended = onended;
    expect(source.onended).toBe(onended);
    expect(fake.source.onEnded).not.toBe(onended);
    fake.source.onEnded?.();
    expect(endedCalls).toBe(1);

    source.onended = null;
    expect(source.onended).toBe(null);
    expect(fake.source.onEnded).toBe(null);
  });
});
