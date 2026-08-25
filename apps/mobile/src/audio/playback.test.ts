import { describe, expect, test } from "bun:test";
import type { VivaAgentAudioOutput } from "@/agent/shared-web";
import { pcm16LeBytesToBase64, VIVA_AUDIO_SAMPLE_RATE_HZ } from "@/agent/shared-web";
import { createMobilePlaybackSession } from "@/audio/playback";
import { createMobilePlaybackContextFactory } from "@/audio/playback-context";
import { fakeNativeContext } from "@/audio/test-support";

function audioOutput(responseId: string, firstSample: number): VivaAgentAudioOutput {
  const bytes = new Uint8Array([firstSample, 0]);
  return {
    frame: { pcm16_base64: pcm16LeBytesToBase64(bytes) },
    responseId,
  };
}

function createSession(
  fake: ReturnType<typeof fakeNativeContext>,
  onSpeakingChange?: (speaking: boolean) => void,
) {
  const contextFactory = createMobilePlaybackContextFactory(() => fake.context);
  return createMobilePlaybackSession({ contextFactory, onSpeakingChange });
}

describe("createMobilePlaybackSession", () => {
  test("cancels before enqueue, acknowledges exact frames, and follows native completion", async () => {
    const fake = fakeNativeContext({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ });
    const speakingChanges: boolean[] = [];
    const session = createSession(fake, (speaking) => speakingChanges.push(speaking));

    await session.unlock();
    expect(fake.calls.resume).toBe(1);

    const r1 = audioOutput("r1", 1);
    const r2 = audioOutput("r2", 2);
    const audio = [r1, r2] as const;
    let acknowledged: readonly VivaAgentAudioOutput[] | undefined;

    const handledCancel = session.drain({
      acknowledgeAudio: (consumed) => {
        acknowledged = consumed;
      },
      audio,
      cancellations: ["r1"],
      handledCancel: 0,
    });

    expect(handledCancel).toBe(1);
    expect(acknowledged).toBe(audio);
    expect(acknowledged?.[0]).toBe(r1);
    expect(acknowledged?.[1]).toBe(r2);
    expect(fake.calls.createBufferSource).toBe(1);
    expect(fake.sources).toHaveLength(1);
    expect(fake.calls.startArguments).toHaveLength(1);
    expect(speakingChanges.at(-1)).toBe(true);
    expect(session.isActive()).toBe(true);

    fake.analyser.samples.fill(0.1);
    expect(session.getOutputLevel()).toBeCloseTo((0.1 - 0.02) / (0.2 - 0.02), 5);
    expect(fake.calls.createAnalyser).toBe(1);
    expect(fake.analyserCalls.connectArguments).toEqual([fake.destination]);

    // Task 5's adapter maps the native member to the shared sink's onended.
    fake.sources[0]?.onEnded?.();
    expect(speakingChanges.at(-1)).toBe(false);
    expect(session.isActive()).toBe(false);

    await session.close();
    expect(fake.calls.close).toBe(1);
    expect(fake.analyserCalls.disconnect).toBe(1);
  });

  test("handles each cancellation once and resetForGeneration clears stale cancellation state", async () => {
    const fake = fakeNativeContext({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ });
    const session = createSession(fake);
    await session.unlock();

    const r1 = audioOutput("r1", 1);
    session.drain({
      acknowledgeAudio: () => {},
      audio: [r1],
      cancellations: [],
      handledCancel: 0,
    });
    expect(fake.calls.createBufferSource).toBe(1);

    const firstHandled = session.drain({
      acknowledgeAudio: () => {},
      audio: [],
      cancellations: ["r1"],
      handledCancel: 0,
    });
    expect(firstHandled).toBe(1);
    expect(fake.calls.stopCount).toBe(1);

    const repeatedHandled = session.drain({
      acknowledgeAudio: () => {},
      audio: [],
      cancellations: ["r1"],
      handledCancel: firstHandled,
    });
    expect(repeatedHandled).toBe(1);
    expect(fake.calls.stopCount).toBe(1);

    session.resetForGeneration();
    session.drain({
      acknowledgeAudio: () => {},
      audio: [r1],
      cancellations: [],
      handledCancel: 0,
    });
    expect(fake.calls.createBufferSource).toBe(2);
    expect(fake.sources[1]?.onEnded).not.toBe(null);

    await session.close();
  });
});
