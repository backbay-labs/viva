import { describe, expect, test } from "bun:test";
import type { AnswerEvaluation } from "@viva/core";
import {
  correctionModelFromEvaluation,
  drainSessionPlayback,
  orbStateForSession,
  RECAP_PLAYBACK_MAX_WAIT_MS,
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
        status: "closed",
      }),
    ).toMatchObject({ canRetry: false, terminal: true, title: "This session has ended." });
    expect(
      stageCopyForConnection({ status: "closed", terminalReason: "session_cap" }),
    ).toMatchObject({ canRetry: false, terminal: true, title: "This session has ended." });
    expect(
      stageCopyForConnection({ status: "open", terminalReason: "durability_degraded" }),
    ).toMatchObject({ canRetry: false, statusLabel: "ended", terminal: true });
    expect(
      stageCopyForConnection({ status: "error", terminalReason: "provider_timeout" }),
    ).toMatchObject({ canRetry: false, statusLabel: "ended", terminal: true });
  });

  test("distinguishes connecting, open preparation, and error", () => {
    expect(stageCopyForConnection({ status: "connecting" }).title).toBe(
      "Connecting to your examiner…",
    );
    expect(stageCopyForConnection({ status: "open" }).title).toBe(
      "Your examiner is preparing the first question…",
    );
    expect(stageCopyForConnection({ status: "error" }).canRetry).toBe(true);
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
        status: "open",
      }),
    ).toBe(false);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: true,
        playbackActive: true,
        playbackWaitExpired: false,
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
        status: "open",
      }),
    ).toBe(true);
  });

  test("opens a closed terminal-only result immediately without waiting for playback", () => {
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: true,
        hasRecap: false,
        playbackActive: true,
        playbackWaitExpired: false,
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
        status: "open",
        terminalReason: "turn_cap",
      }),
    ).toBe(false);
    expect(
      shouldNavigateToRecap({
        hasPendingAudio: false,
        hasRecap: false,
        playbackActive: false,
        playbackWaitExpired: false,
        status: "closed",
      }),
    ).toBe(false);
  });
});
