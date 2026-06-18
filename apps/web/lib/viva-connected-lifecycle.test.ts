import { describe, expect, test } from "bun:test";
import { initialVivaAgentSessionState, type VivaAgentSessionState } from "./viva-agent-client";
import {
  connectedLifecycleStatusLabel,
  deriveVivaConnectedLifecycle,
  type VivaConnectedLifecycleState,
} from "./viva-connected-lifecycle";

describe("Viva connected lifecycle state machine", () => {
  test("waits for the server prompt after the socket opens", () => {
    expect(lifecycle({ status: "open" })).toBe("waiting_prompt");
  });

  test("distinguishes reconnecting from disconnected", () => {
    expect(lifecycle({ status: "connecting" })).toBe("reconnecting");
    expect(lifecycle({ status: "closed" })).toBe("disconnected");
  });

  test("tracks answering, feedback wait, correction, and recap states", () => {
    expect(lifecycle({ phase: "listening", question: question() })).toBe("answering");
    expect(lifecycle({ phase: "thinking", question: question() })).toBe("waiting_feedback");
    expect(lifecycle({ phase: "feedback", question: question() })).toBe("waiting_feedback");
    expect(lifecycle({ phase: "correction", question: question() })).toBe("correction");
    expect(lifecycle({ phase: "recap", question: question() })).toBe("recap");
  });

  test("keeps stop-pending separate from close-without-recap", () => {
    expect(lifecycle({ question: question() }, true)).toBe("stopping");
    expect(lifecycle({ question: question(), status: "closed" }, true)).toBe("ended_without_recap");
  });

  test("does not treat local mode as connected success", () => {
    expect(
      deriveVivaConnectedLifecycle({
        connectedRuntime: false,
        state: { ...initialVivaAgentSessionState(), recap: recap() },
        stopRequested: false,
      }),
    ).toBe("disconnected");
  });

  test("status labels are stable for UI assertions", () => {
    const states: VivaConnectedLifecycleState[] = [
      "waiting_prompt",
      "answering",
      "waiting_feedback",
      "correction",
      "stopping",
      "recap",
      "ended_without_recap",
      "disconnected",
      "reconnecting",
    ];

    expect(states.map(connectedLifecycleStatusLabel)).toEqual([
      "waiting for prompt",
      "answering",
      "waiting for feedback",
      "correction",
      "stopping",
      "recap",
      "ended without recap",
      "disconnected",
      "reconnecting",
    ]);
  });
});

function lifecycle(
  state: Partial<VivaAgentSessionState>,
  stopRequested = false,
): VivaConnectedLifecycleState {
  return deriveVivaConnectedLifecycle({
    connectedRuntime: true,
    state: { ...initialVivaAgentSessionState(), status: "open", ...state },
    stopRequested,
  });
}

function question(): NonNullable<VivaAgentSessionState["question"]> {
  return {
    expected_terms: [],
    follow_up: "follow up",
    prompt: "Prompt",
    question_id: "question-1",
    source: {
      confidence: "high",
      document_id: "doc-1",
      excerpt: "excerpt",
      retrieval_reason: "test",
      source_id: "source-1",
      span: "span",
    },
  };
}

function recap(): NonNullable<VivaAgentSessionState["recap"]> {
  return {
    headline: "Done",
    missed_concepts: [],
    next_action: "Review",
    review_later: [],
    shaky_concepts: [],
    source_moments: [],
    strong_concepts: [],
    summary: "Summary",
    voice_session_id: "voice-session-1",
  };
}
