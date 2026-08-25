import {
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

export function shouldNavigateToRecap(input: {
  hasRecap: boolean;
  status: VivaAgentSessionState["status"];
  terminalReason?: AgentTerminalSessionReason;
}): boolean {
  return (
    input.hasRecap ||
    (input.terminalReason !== undefined && (input.status === "closed" || input.status === "error"))
  );
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
  status: VivaAgentSessionState["status"];
  terminalReason?: AgentTerminalSessionReason;
}): SessionStageCopy {
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
