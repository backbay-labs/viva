import { describe, expect, test } from "bun:test";
import type { AgentAnswerEvaluation, AnswerEvaluation } from "@viva/core";
import {
  correctionModelFromEvaluation,
  drainSessionPlayback,
  orbStateForSession,
  RECAP_PLAYBACK_MAX_WAIT_MS,
  retryAttemptResolution,
  shouldNavigateToRecap,
  stageCopyForConnection,
} from "@/agent/session-view-model";

const evaluation: AnswerEvaluation = {
  conciseFeedback:
    "You named ATP, but skipped the proton-gradient mechanism that drives ATP synthase.",
  confidenceScore: 0.55,
  conceptStatus: "shaky",
  correctionKind: "correct but imprecise",
  label: "partially correct",
  retryPrompt: "Now connect that electron flow to ATP synthase in one precise sentence.",
  source: {
    confidence: "high",
    documentId: "lec-5",
    excerpt:
      "NADH donates high-energy electrons to the electron transport chain. Electron flow pumps protons across the inner mitochondrial membrane, creating the gradient that drives ATP synthase.",
    label: "Lecture 5 · Slide 18",
    retrievalReason: "server fixture source for oxidative phosphorylation",
    sourceId: "src-lecture-5-slide-18",
    span: "slide:18",
  },
};

describe("orbStateForSession", () => {
  test("projects connection, learner, correction, and narration phases", () => {
    expect(orbStateForSession({ phase: "ready", speaking: false, status: "connecting" })).toBe(
      "thinking",
    );
    expect(orbStateForSession({ phase: "listening", speaking: false, status: "open" })).toBe(
      "listening",
    );
    expect(orbStateForSession({ phase: "thinking", speaking: false, status: "open" })).toBe(
      "thinking",
    );
    expect(orbStateForSession({ phase: "feedback", speaking: false, status: "open" })).toBe(
      "correcting",
    );
    expect(orbStateForSession({ phase: "recap", speaking: false, status: "open" })).toBe(
      "complete",
    );
    expect(orbStateForSession({ phase: "ready", speaking: true, status: "open" })).toBe(
      "correcting",
    );
  });
});

describe("correctionModelFromEvaluation", () => {
  test("projects the canonical fixture evaluation and transcript confidence honestly", () => {
    const model = correctionModelFromEvaluation(
      evaluation,
      "NADH gives electrons to the electron transport chain.",
      undefined,
      0.65,
    );

    expect(model.answer).toBe("NADH gives electrons to the electron transport chain.");
    expect(model.correction).toBe(evaluation.conciseFeedback);
    expect(model.retryPrompt).toBe(evaluation.retryPrompt);
    expect(model.sourceExcerpt).toBe(evaluation.source.excerpt);
    expect(model.sourceLabel).toBe("Lecture 5 · Slide 18");
    expect(model.title).toBe("Partially correct");
    expect(model.uncertainTranscript).toBe(true);
  });

  test("prefers an explicit typed answer and does not invent transcript uncertainty", () => {
    const model = correctionModelFromEvaluation(
      evaluation,
      "stale transcript",
      "  typed answer  ",
      undefined,
    );
    expect(model.answer).toBe("typed answer");
    expect(model.uncertainTranscript).toBe(false);
  });
});

describe("stageCopyForConnection", () => {
  test("never describes an unclean close as a finished session", () => {
    const model = stageCopyForConnection({
      close: { code: 1006, reason: "", wasClean: false },
      questionEverStarted: true,
      status: "closed",
    });
    expect(model.title).toBe("The connection was interrupted.");
    expect(model.canRetry).toBe(true);
    expect(model.terminal).toBe(false);
    expect(model.detail).toContain("transport disconnected");
  });

  test("uses ended copy only for a clean close or terminal reason", () => {
    expect(
      stageCopyForConnection({
        close: { code: 1000, reason: "client stop", wasClean: true },
        questionEverStarted: true,
        status: "closed",
      }),
    ).toMatchObject({ canRetry: false, terminal: true, title: "This session has ended." });
    expect(
      stageCopyForConnection({
        questionEverStarted: true,
        status: "closed",
        terminalReason: "session_cap",
      }),
    ).toMatchObject({ canRetry: false, terminal: true, title: "This session has ended." });
    expect(
      stageCopyForConnection({
        questionEverStarted: true,
        status: "open",
        terminalReason: "durability_degraded",
      }),
    ).toMatchObject({ canRetry: false, statusLabel: "ended", terminal: true });
    expect(
      stageCopyForConnection({
        questionEverStarted: true,
        status: "error",
        terminalReason: "provider_timeout",
      }),
    ).toMatchObject({ canRetry: false, statusLabel: "ended", terminal: true });
  });

  test("treats session_cap before any question as a retryable admission hold", () => {
    const model = stageCopyForConnection({
      close: { code: 1008, reason: "", wasClean: false },
      questionEverStarted: false,
      status: "closed",
      terminalReason: "session_cap",
    });
    expect(model.title).toBe("Your previous session is still closing.");
    expect(model.canRetry).toBe(true);
    expect(model.terminal).toBe(false);
    expect(model.statusLabel).toBe("previous session closing");
    expect(model.detail).toContain("one active session per study set");
  });

  test("distinguishes connecting, open preparation, and error", () => {
    expect(stageCopyForConnection({ questionEverStarted: false, status: "connecting" }).title).toBe(
      "Connecting to your examiner…",
    );
    expect(stageCopyForConnection({ questionEverStarted: false, status: "open" }).title).toBe(
      "Your examiner is preparing the first question…",
    );
    expect(stageCopyForConnection({ questionEverStarted: false, status: "error" }).canRetry).toBe(
      true,
    );
  });
});

describe("terminal session lifecycle", () => {
  test("suppresses and acknowledges late audio after End", () => {
    const audio = [{ frame: { pcm16_base64: "AQID" }, responseId: "response-1" }];
    let acknowledged: readonly unknown[] | undefined;
    let drainCalls = 0;

    expect(
      drainSessionPlayback({
        acknowledgeAudio: (consumed) => {
          acknowledged = consumed;
        },
        audio,
        cancellations: ["response-1"],
        ending: true,
        handledCancel: 0,
        playback: {
          drain: () => {
            drainCalls += 1;
            return 99;
          },
        },
      }),
    ).toBe(1);
    expect(acknowledged).toBe(audio);
    expect(drainCalls).toBe(0);
  });

  test("waits for both pending frames and active playback before opening a real recap", () => {
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: true,
        hasRecap: true,
        playbackActive: false,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "open",
      }),
    ).toBe(false);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: true,
        playbackActive: true,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "closed",
        terminalReason: "turn_cap",
      }),
    ).toBe(false);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: true,
        playbackActive: false,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "open",
      }),
    ).toBe(true);
  });

  test("bounds a stuck recap playback wait after the two-minute safety window", () => {
    expect(RECAP_PLAYBACK_MAX_WAIT_MS).toBe(120_000);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: true,
        hasRecap: true,
        playbackActive: true,
        playbackWaitExpired: true,
        questionEverStarted: true,
        status: "open",
      }),
    ).toBe(true);
  });

  test("opens a terminal-only result immediately without waiting for socket close or playback", () => {
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: true,
        hasRecap: false,
        playbackActive: true,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "closed",
        terminalReason: "turn_cap",
      }),
    ).toBe(true);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: true,
        hasRecap: false,
        playbackActive: true,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "error",
        terminalReason: "provider_timeout",
      }),
    ).toBe(true);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: false,
        playbackActive: false,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "open",
        terminalReason: "turn_cap",
      }),
    ).toBe(true);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: false,
        playbackActive: false,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "closed",
      }),
    ).toBe(false);
  });

  test("holds on the session screen when session_cap rejects admission before any question", () => {
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: false,
        playbackActive: false,
        playbackWaitExpired: false,
        questionEverStarted: false,
        status: "closed",
        terminalReason: "session_cap",
      }),
    ).toBe(false);
    // A session_cap after a real session (question delivered) is still terminal.
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: false,
        playbackActive: false,
        playbackWaitExpired: false,
        questionEverStarted: true,
        status: "closed",
        terminalReason: "session_cap",
      }),
    ).toBe(true);
  });
});

describe("retry attempt lifecycle", () => {
  const baselineEvaluation: AgentAnswerEvaluation = {
    answer_text: "ATP is made by respiration.",
    concise_feedback: "Name the proton-gradient mechanism.",
    concept_status: "shaky",
    confidence_score: 0.55,
    label: "partially correct",
    question_id: "question-1",
    retry_prompt: "Connect electron flow to ATP synthase.",
    source: {
      confidence: "high",
      document_id: "lec-5",
      excerpt: "The proton gradient drives ATP synthase.",
      retrieval_reason: "Ground the correction in the selected study set.",
      source_id: "src-lecture-5-slide-18",
      span: "slide:18",
    },
  };
  const attempt = {
    baselineEvaluation,
    generationId: "generation-1",
    phase: "submitted" as const,
  };

  test("does not mistake a cleared pending flag or the baseline correction for a retry result", () => {
    expect(
      retryAttemptResolution({
        attempt,
        currentEvaluation: baselineEvaluation,
        generationId: "generation-1",
        status: "open",
      }),
    ).toBe("keep");
    expect(
      retryAttemptResolution({
        attempt,
        currentEvaluation: undefined,
        generationId: "generation-1",
        status: "open",
      }),
    ).toBe("keep");
  });

  test("completes only when a new evaluation identity arrives for the same generation", () => {
    expect(
      retryAttemptResolution({
        attempt,
        currentEvaluation: { ...baselineEvaluation },
        generationId: "generation-1",
        status: "open",
      }),
    ).toBe("complete");
  });

  test("clears retry state on connection failure or generation replacement", () => {
    expect(
      retryAttemptResolution({
        attempt,
        currentEvaluation: baselineEvaluation,
        generationId: "generation-2",
        status: "open",
      }),
    ).toBe("clear");
    expect(
      retryAttemptResolution({
        attempt,
        currentEvaluation: baselineEvaluation,
        generationId: "generation-1",
        status: "error",
      }),
    ).toBe("clear");
    expect(
      retryAttemptResolution({
        attempt,
        currentEvaluation: baselineEvaluation,
        generationId: "generation-1",
        status: "closed",
      }),
    ).toBe("clear");
  });

  test("keeps an editing retry until it is submitted or explicitly cleared", () => {
    expect(
      retryAttemptResolution({
        attempt: { ...attempt, phase: "editing" },
        currentEvaluation: { ...baselineEvaluation, answer_text: "A newer draft answer." },
        generationId: "generation-1",
        status: "open",
      }),
    ).toBe("keep");
  });
});
