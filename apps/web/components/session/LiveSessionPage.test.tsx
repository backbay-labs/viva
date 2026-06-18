import { describe, expect, test } from "bun:test";
import type { SessionRecap } from "@viva/core";
import type { VivaAgentDerivedState } from "../../lib/use-viva-agent-session";
import { projectTrace } from "../../lib/viva-session-projection";
import {
  derivedStateWithProjectedRecap,
  enterTextAnswerMode,
  stopCaptureForRecap,
  textAnswerPayload,
} from "./LiveSessionPage";

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

    stopCaptureForRecap(captureRef, captureStartedRef, levelRef);

    expect(stops).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.2, user: 0 });
  });

  test("stops microphone capture and leaves the bloom at floor in text answer mode", () => {
    let stops = 0;
    const captureRef = {
      current: {
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

    enterTextAnswerMode(captureRef, captureStartedRef, levelRef, meterRef);

    expect(stops).toBe(1);
    expect(resets).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.1, user: 0 });
  });

  test("normalizes written answers before sending them to the agent text frame", () => {
    expect(textAnswerPayload("  NADH donates electrons to the ETC.  ")).toBe(
      "NADH donates electrons to the ETC.",
    );
    expect(textAnswerPayload("   \n\t   ")).toBe(null);
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
