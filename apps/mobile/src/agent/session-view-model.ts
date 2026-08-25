import {
  type AgentAnswerEvaluation,
  type AgentTerminalSessionReason,
  type AnswerEvaluation,
  learnerRecoveryCopyForState,
  type SessionPhase,
} from "@viva/core";

import type {
  VivaAgentAudioOutput,
  VivaAgentCloseDiagnostics,
  VivaAgentSessionState,
} from "@/agent/shared-web";
import type { MobilePlaybackSession } from "@/audio/playback";
import type { OrbState } from "@/components/voice-orb";

export type SessionCorrectionModel = {
  answer: string;
  correction: string;
  retryPrompt: string;
  sourceExcerpt: string;
  sourceLabel: string;
  title: string;
  uncertainTranscript: boolean;
};

export type SessionStageCopy = {
  canRetry: boolean;
  detail: string;
  statusLabel: string;
  terminal: boolean;
  title: string;
};

export type RetryAttemptState = {
  baselineEvaluation?: AgentAnswerEvaluation;
  generationId?: string;
  phase: "editing" | "submitted";
};

export type RetryAttemptResolution = "clear" | "complete" | "keep";

// The agent's submitted-turn contract is capped at 45 seconds and the examiner
// is instructed to speak concisely. Two minutes after recap_ready leaves ample
// room for normal queued playback while bounding a failed unlock or missing
// native completion callback so the learner cannot be stranded on the session.
export const RECAP_PLAYBACK_MAX_WAIT_MS = 2 * 60_000;

export function drainSessionPlayback(input: {
  acknowledgeAudio: (audio: readonly VivaAgentAudioOutput[]) => void;
  audio: readonly VivaAgentAudioOutput[];
  cancellations: readonly string[];
  ending: boolean;
  handledCancel: number;
  playback: Pick<MobilePlaybackSession, "drain">;
}): number {
  if (input.ending) {
    if (input.audio.length > 0) input.acknowledgeAudio(input.audio);
    return input.cancellations.length;
  }
  return input.playback.drain({
    acknowledgeAudio: input.acknowledgeAudio,
    audio: input.audio,
    cancellations: input.cancellations,
    handledCancel: input.handledCancel,
  });
}

/**
 * A `session_cap` terminal on a generation that never delivered a question is
 * the server's duplicate-session admission guard, not a finished session: the
 * agent allows one active session per learner and study set, and a lease from
 * an uncleanly dropped connection frees only when the server's 45-second idle
 * timer reaps it. That state is a retryable hold.
 */
export function isSessionAdmissionRejection(input: {
  questionEverStarted: boolean;
  terminalReason?: AgentTerminalSessionReason;
}): boolean {
  return input.terminalReason === "session_cap" && !input.questionEverStarted;
}

export function shouldNavigateToRecap(input: {
  hasRecap: boolean;
  hasPendingAudio: boolean;
  playbackActive: boolean;
  playbackWaitExpired: boolean;
  questionEverStarted: boolean;
  status: VivaAgentSessionState["status"];
  terminalReason?: AgentTerminalSessionReason;
}): boolean {
  if (!input.hasRecap) {
    if (isSessionAdmissionRejection(input)) return false;
    return input.terminalReason !== undefined;
  }

  return input.playbackWaitExpired || (!input.hasPendingAudio && !input.playbackActive);
}

/**
 * Resolve one learner-initiated retry without depending on the controller's
 * transient pending flag. `question_started` intentionally clears both that
 * flag and the current evaluation. The captured baseline identity therefore
 * remains authoritative until `answer_evaluated` supplies a distinct result.
 */
export function retryAttemptResolution(input: {
  attempt: RetryAttemptState;
  currentEvaluation?: AgentAnswerEvaluation;
  generationId?: string;
  status: VivaAgentSessionState["status"];
}): RetryAttemptResolution {
  if (input.status === "closed" || input.status === "error") return "clear";
  if (input.generationId !== input.attempt.generationId) return "clear";
  if (
    input.attempt.phase === "submitted" &&
    input.currentEvaluation !== undefined &&
    input.currentEvaluation !== input.attempt.baselineEvaluation
  ) {
    return "complete";
  }
  return "keep";
}

export function orbStateForSession(input: {
  phase: SessionPhase;
  speaking: boolean;
  status: VivaAgentSessionState["status"];
}): OrbState {
  if (input.speaking) return "correcting";
  if (input.status === "connecting" || input.status === "idle") return "thinking";
  switch (input.phase) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "feedback":
    case "correction":
      return "correcting";
    case "recap":
      return "complete";
    default:
      return "ready";
  }
}

export function correctionModelFromEvaluation(
  evaluation: AnswerEvaluation,
  finalTranscript: string | undefined,
  submittedText: string | undefined,
  transcriptConfidence?: number,
): SessionCorrectionModel {
  const typedAnswer = submittedText?.trim();
  return {
    answer: typedAnswer || finalTranscript?.trim() || "No answer was captured.",
    correction: evaluation.conciseFeedback,
    retryPrompt: evaluation.retryPrompt,
    sourceExcerpt: evaluation.source.excerpt,
    sourceLabel: evaluation.source.label,
    title: sentenceCase(evaluation.label),
    uncertainTranscript: typeof transcriptConfidence === "number" && transcriptConfidence < 0.7,
  };
}

export function stageCopyForConnection(input: {
  close?: VivaAgentCloseDiagnostics;
  questionEverStarted: boolean;
  status: VivaAgentSessionState["status"];
  terminalReason?: AgentTerminalSessionReason;
}): SessionStageCopy {
  if (isSessionAdmissionRejection(input)) {
    return {
      canRetry: true,
      detail:
        "The server allows one active session per study set, and an interrupted connection's slot frees within about a minute. Wait a moment, then retry.",
      statusLabel: "previous session closing",
      terminal: false,
      title: "Your previous session is still closing.",
    };
  }

  const terminal = input.terminalReason !== undefined || input.close?.wasClean === true;
  if (terminal) {
    const reason = input.terminalReason?.replace(/_/g, " ");
    return {
      canRetry: false,
      detail: reason ? `The agent ended this session: ${reason}.` : "The agent closed cleanly.",
      statusLabel: "ended",
      terminal: true,
      title: "This session has ended.",
    };
  }

  if (input.status === "connecting" || input.status === "idle") {
    return {
      canRetry: false,
      detail: "Waiting for provider readiness from the local agent.",
      statusLabel: "connecting",
      terminal: false,
      title: "Connecting to your examiner…",
    };
  }

  if (input.status === "open") {
    return {
      canRetry: false,
      detail: "The connection is open; the first grounded question has not arrived yet.",
      statusLabel: "preparing",
      terminal: false,
      title: "Your examiner is preparing the first question…",
    };
  }

  const recovery = learnerRecoveryCopyForState("network_disconnect");
  return {
    canRetry: true,
    detail:
      recovery?.learner.marginalia_text ??
      "The provider transport disconnected before the session reached a terminal phase.",
    statusLabel: recovery?.learner.status_label ?? "connection interrupted",
    terminal: false,
    title: "The connection was interrupted.",
  };
}

function sentenceCase(value: string): string {
  return value ? value[0]?.toUpperCase() + value.slice(1) : value;
}
