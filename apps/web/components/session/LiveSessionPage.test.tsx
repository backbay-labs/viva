import { describe, expect, test } from "bun:test";
import type { SessionRecap } from "@viva/core";
import type { VivaAgentDerivedState } from "../../lib/use-viva-agent-session";
import type { VivaAgentAudioOutput } from "../../lib/viva-agent-client";
import { VivaAudioWorkletUnavailableError } from "../../lib/viva-audio-capture";
import { projectTrace } from "../../lib/viva-session-projection";
import {
  captureLevelForBloom,
  derivedStateWithProjectedRecap,
  drainAgentAudio,
  enterTextAnswerMode,
  isSessionOver,
  micStateForAudioCaptureError,
  micStateForCaptureEndReason,
  pcm16ChunksToBase64,
  shouldStopReadinessPolling,
  shouldUseLiveMicAudioTransport,
  spokenTurnFallbackAction,
  stopCaptureForRecap,
  textAnswerPayload,
} from "./LiveSessionPage";

describe("drainAgentAudio", () => {
  const out = (responseId: string): VivaAgentAudioOutput =>
    ({ responseId, frame: {} }) as unknown as VivaAgentAudioOutput;

  test("flushes new cancellations, enqueues pending audio, and acknowledges the exact frames", () => {
    const enqueued: string[] = [];
    const cancelled: string[] = [];
    let acked: readonly VivaAgentAudioOutput[] = [];
    const audio = [out("r1"), out("r1"), out("r2")];

    const next = drainAgentAudio({
      acknowledgeAudio: (consumed) => {
        acked = consumed;
      },
      audio,
      cancellations: ["rX"],
      handledCancel: 0,
      sink: {
        cancel: (id) => cancelled.push(id),
        enqueue: (o) => enqueued.push(o.responseId),
      },
    });

    // Cancellations flush before enqueue so barge-in stops a response in time.
    expect(cancelled).toEqual(["rX"]);
    expect(enqueued).toEqual(["r1", "r1", "r2"]);
    // The exact frame objects are acknowledged (by reference, not a count).
    expect(acked).toBe(audio);
    expect(next).toBe(1);
  });

  test("only flushes new cancellations and skips acknowledge when no audio is pending", () => {
    const cancelled: string[] = [];
    let ackCalls = 0;

    const next = drainAgentAudio({
      acknowledgeAudio: () => {
        ackCalls += 1;
      },
      audio: [],
      cancellations: ["rA", "rB"],
      handledCancel: 1,
      sink: {
        cancel: (id) => cancelled.push(id),
        enqueue: () => {},
      },
    });

    expect(cancelled).toEqual(["rB"]);
    expect(ackCalls).toBe(0);
    expect(next).toBe(2);
  });
});

describe("shouldStopReadinessPolling", () => {
  test("keeps polling while connecting or open-but-not-yet-ready", () => {
    expect(
      shouldStopReadinessPolling({ recap: undefined, status: "connecting", ready: false }),
    ).toBe(false);
    // Open socket but no ready frame yet — the probe is still the only readiness signal.
    expect(shouldStopReadinessPolling({ recap: undefined, status: "open", ready: false })).toBe(
      false,
    );
  });

  test("stops polling once the live ready frame proves the agent is reachable", () => {
    expect(shouldStopReadinessPolling({ recap: undefined, status: "open", ready: true })).toBe(
      true,
    );
  });

  test("stops polling once the session is over, regardless of ready", () => {
    expect(
      shouldStopReadinessPolling({ recap: { headline: "x" }, status: "open", ready: false }),
    ).toBe(true);
    expect(shouldStopReadinessPolling({ recap: undefined, status: "closed", ready: false })).toBe(
      true,
    );
  });
});

describe("isSessionOver", () => {
  test("a delivered recap freezes the session clock and stops the readiness probe", () => {
    expect(isSessionOver({ recap: { headline: "done" }, status: "open" })).toBe(true);
  });

  test("a terminal socket close freezes the clock even without a recap payload", () => {
    expect(isSessionOver({ recap: undefined, status: "closed" })).toBe(true);
  });

  test("an active, connected session keeps the clock running", () => {
    expect(isSessionOver({ recap: undefined, status: "open" })).toBe(false);
    expect(isSessionOver({ recap: undefined, status: "connecting" })).toBe(false);
  });
});

describe("LiveSessionPage recap cleanup", () => {
  test("stops microphone capture when a terminal recap appears", () => {
    let stops = 0;
    const captureRef = {
      current: {
        stop: () => {
          stops += 1;
        },
      },
    };
    const captureStartedRef = { current: true };
    const levelRef = { current: { agent: 0.2, user: 0.8 } };
    const capturedTurnPcm16Ref = { current: [new Uint8Array([1, 2])] };

    stopCaptureForRecap(captureRef, captureStartedRef, levelRef, capturedTurnPcm16Ref);

    expect(stops).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.2, user: 0 });
    expect(capturedTurnPcm16Ref.current).toEqual([]);
  });

  test("stops microphone capture and leaves the bloom at floor in text answer mode", () => {
    let stops = 0;
    let cancels = 0;
    const captureRef = {
      current: {
        cancel: () => {
          cancels += 1;
        },
        stop: () => {
          stops += 1;
        },
      },
    };
    const captureStartedRef = { current: true };
    const levelRef = { current: { agent: 0.1, user: 0.9 } };
    let resets = 0;
    const meterRef = {
      current: {
        reset: () => {
          resets += 1;
        },
      },
    };
    const capturedTurnPcm16Ref = { current: [new Uint8Array([3, 4])] };

    enterTextAnswerMode(captureRef, captureStartedRef, levelRef, meterRef, capturedTurnPcm16Ref);

    expect(cancels).toBe(1);
    expect(stops).toBe(0);
    expect(resets).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.1, user: 0 });
    expect(capturedTurnPcm16Ref.current).toEqual([]);
  });

  test("classifies Worklet support failures separately from mic permission denial", () => {
    expect(micStateForAudioCaptureError(new VivaAudioWorkletUnavailableError())).toBe(
      "unsupported",
    );
    expect(micStateForAudioCaptureError(new Error("permission denied"))).toBe("denied");
    expect(micStateForCaptureEndReason("processor_error", "available")).toBe("unsupported");
    expect(micStateForCaptureEndReason("devicechange", "available")).toBe("unknown");
    expect(micStateForCaptureEndReason("stopped", "available")).toBe("available");
  });

  test("normalizes written answers before sending them to the agent text frame", () => {
    expect(textAnswerPayload("  NADH donates electrons to the ETC.  ")).toBe(
      "NADH donates electrons to the ETC.",
    );
    expect(textAnswerPayload("   \n\t   ")).toBe(null);
  });

  test("only streams buffered mic PCM to selectable live runtimes", () => {
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: true, selectable: true } },
        status: "open",
        textAnswerMode: false,
      }),
    ).toBe(true);
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: false, selectable: true } },
        status: "open",
        textAnswerMode: false,
      }),
    ).toBe(false);
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: true, selectable: true } },
        status: "closed",
        textAnswerMode: false,
      }),
    ).toBe(false);
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: true, selectable: true } },
        status: "open",
        textAnswerMode: true,
      }),
    ).toBe(false);
  });

  test("merges buffered worklet PCM chunks into one live audio turn", () => {
    expect(pcm16ChunksToBase64([])).toBe(null);
    expect(pcm16ChunksToBase64([new Uint8Array([1, 2]), new Uint8Array([3, 4])])).toBe("AQIDBA==");
  });

  test("opens typed answer mode instead of synthesizing a spoken-answer placeholder", () => {
    expect(spokenTurnFallbackAction({ websocketReady: true })).toBe("open_text_answer");
    expect(spokenTurnFallbackAction({ websocketReady: false })).toBe("ignore");
  });

  test("uses worklet-computed RMS for the user bloom while reduced motion keeps it at floor", () => {
    const calls: string[] = [];
    const meter = {
      push: () => {
        calls.push("samples");
        return 0.4;
      },
      pushRms: (rms: number) => {
        calls.push(`rms:${rms}`);
        return 0.7;
      },
    };

    expect(
      captureLevelForBloom({
        frame: { rms: 0.12, sampleRateHz: 24_000, samples: Float32Array.from([0.5]) },
        meter,
        reducedMotion: false,
        samples: Float32Array.from([0.5]),
        textAnswerMode: false,
      }),
    ).toBe(0.7);
    expect(calls).toEqual(["rms:0.12"]);
    expect(
      captureLevelForBloom({
        frame: { rms: 0.12, sampleRateHz: 24_000, samples: Float32Array.from([0.5]) },
        meter,
        reducedMotion: true,
        samples: Float32Array.from([0.5]),
        textAnswerMode: false,
      }),
    ).toBe(0);
    expect(calls).toEqual(["rms:0.12"]);
  });

  test("uses projected recap buckets for center trace highlights", () => {
    const staleRawRecap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Good session, Ananya.",
      missedConcepts: ["Fixture stale id"],
      nextAction: "Fixture action",
      plan: [],
      reviewLater: ["Fixture stale id"],
      shakyConcepts: [],
      sourceMoments: [],
      strongConcepts: [],
      summary: "Server recap summary.",
    };
    const projectedRecap: SessionRecap = {
      ...staleRawRecap,
      missedConcepts: ["ATP synthase"],
      nextAction: "Rebuild ATP synthase from the source.",
      reviewLater: ["ATP synthase"],
      strongConcepts: ["NADH"],
    };
    const derived: VivaAgentDerivedState = {
      canSubmitAnswer: true,
      conceptStatuses: {},
      errors: [],
      manuscriptIntents: [],
      phase: "recap",
      recap: staleRawRecap,
      sources: [],
      transcript: "",
    };

    const projection = projectTrace(
      derivedStateWithProjectedRecap(derived, projectedRecap),
      "open",
      new Date("2026-06-17T12:00:00.000Z"),
    );

    expect(projection.question.highlights).toEqual(["NADH", "ATP synthase"]);
    expect(projection.question.highlights).not.toContain("Fixture stale id");
  });
});
