"use client";

import type {
  AgentAnswerEvaluation,
  AgentEvaluationLabel,
  AgentSessionConfig,
  AgentStudyQuestion,
  AgentStudySessionRecap,
  AgentStudySetReadiness,
  AgentStudySourceReference,
  AgentTerminalSessionReason,
  AnswerEvaluation,
  ConceptStatus,
  CorrectionKind,
  EvaluationLabel,
  ManuscriptIntent,
  SessionQuestion,
  SessionRecap,
  SourceReference,
  StudyMode,
  StudySet,
} from "@viva/core";
import { agentStudySetReadiness } from "@viva/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createVivaAgentSessionController,
  initialVivaAgentSessionState,
  type VivaAgentAudioOutput,
  type VivaAgentClientOptions,
  type VivaAgentCloseDiagnostics,
  type VivaAgentGenerationReason,
  type VivaAgentSessionController,
  type VivaAgentSessionState,
} from "./viva-agent-client";

export type VivaAgentDerivedState = {
  phase: VivaAgentSessionState["phase"];
  generationId?: string;
  terminalReason?: AgentTerminalSessionReason;
  close?: VivaAgentCloseDiagnostics;
  question?: SessionQuestion;
  transcript: string;
  finalTranscript?: string;
  transcriptConfidence?: number;
  evaluation?: AnswerEvaluation;
  currentSource?: SourceReference;
  currentConceptStatus?: ConceptStatus;
  conceptStatuses: Record<string, ConceptStatus>;
  sources: SourceReference[];
  manuscriptIntents: ManuscriptIntent[];
  recap?: SessionRecap;
  errors: string[];
  canSubmitAnswer: boolean;
};

export type UseVivaAgentSessionOptions = VivaAgentClientOptions & {
  studySet: StudySet;
  mode: StudyMode;
  sessionId?: string;
  sessionToken?: string | null;
  trustedStudySetId?: string;
  userId?: string;
};

export function useVivaAgentSession(options: UseVivaAgentSessionOptions) {
  const session = useMemo(
    () =>
      studySetToAgentSessionConfig(options.studySet, {
        mode: options.mode,
        sessionId: options.sessionId,
        userId: options.userId,
      }),
    [options.studySet, options.mode, options.sessionId, options.userId],
  );
  const controllerRef = useRef<VivaAgentSessionController | null>(null);
  const [agentState, setAgentState] = useState<VivaAgentSessionState>(initialVivaAgentSessionState);

  useEffect(() => {
    controllerRef.current?.close();
    const controller = createVivaAgentSessionController({
      WebSocketImpl: options.WebSocketImpl,
      session,
      sessionToken: options.sessionToken ?? options.studySet.sessionToken,
      token: options.token,
      url: options.url,
    });
    controllerRef.current = controller;
    setAgentState(controller.getState());
    const unsubscribe = controller.subscribe(setAgentState);
    return () => {
      unsubscribe();
      controller.close();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [
    options.WebSocketImpl,
    options.sessionToken,
    options.studySet.sessionToken,
    options.token,
    options.url,
    session,
  ]);

  const derived = useMemo(() => deriveVivaAgentUiState(agentState), [agentState]);
  const readiness: AgentStudySetReadiness = useMemo(
    () => agentStudySetReadiness(options.studySet, options.trustedStudySetId),
    [options.studySet, options.trustedStudySetId],
  );

  return {
    acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) =>
      controllerRef.current?.acknowledgeAudio(consumed),
    agentState,
    cancel: () => controllerRef.current?.cancel(),
    close: () => controllerRef.current?.close(),
    connect: (reason?: VivaAgentGenerationReason) => controllerRef.current?.connect(reason),
    derived,
    readiness,
    refreshSession: (input?: { sessionToken?: string | null }) =>
      controllerRef.current?.refreshSession(input),
    reset: () => controllerRef.current?.reset(),
    sendAudio: (pcm16Base64: string) => controllerRef.current?.sendAudio(pcm16Base64) ?? false,
    sendText: (text: string) => controllerRef.current?.sendText(text) ?? false,
    status: agentState.status,
    stop: () => controllerRef.current?.stop(),
  };
}

export function studySetToAgentSessionConfig(
  studySet: StudySet,
  options: { mode: StudyMode; sessionId?: string; userId?: string },
): AgentSessionConfig {
  return {
    active_concepts: studySet.concepts.map((concept) => concept.id),
    initial_goal: studySet.recommendedSession,
    mode: options.mode,
    session_id: studySet.sessionId ?? options.sessionId ?? "voice-session-1",
    source_context: [],
    study_set_id: studySet.id,
    user_id: studySet.userId ?? options.userId ?? "user-1",
  };
}

export function deriveVivaAgentUiState(state: VivaAgentSessionState): VivaAgentDerivedState {
  const question = state.question ? agentQuestionToSessionQuestion(state.question) : undefined;
  return {
    canSubmitAnswer: state.status === "open" && !state.pendingSubmission,
    close: state.close,
    errors: state.errors,
    evaluation: state.evaluation
      ? agentAnswerEvaluationToUiEvaluation(state.evaluation)
      : undefined,
    currentSource: state.currentSource ? agentSourceToUiSource(state.currentSource) : undefined,
    currentConceptStatus: state.currentConceptStatus,
    conceptStatuses: state.conceptStatuses,
    finalTranscript: state.finalTranscript,
    generationId: state.generation?.id,
    transcriptConfidence: state.transcriptConfidence,
    manuscriptIntents: state.manuscriptIntents.map((event) => event.intent),
    phase: state.question && state.phase === "ready" ? "listening" : state.phase,
    question,
    recap: state.recap ? agentRecapToSessionRecap(state.recap) : undefined,
    sources: state.sources.map(agentSourceToUiSource),
    terminalReason: state.terminalReason,
    transcript: state.finalTranscript ?? state.transcript,
  };
}

export function agentQuestionToSessionQuestion(question: AgentStudyQuestion): SessionQuestion {
  return {
    expectedTerms: question.expected_terms,
    followUp: question.follow_up,
    id: question.question_id,
    prompt: question.prompt,
    source: agentSourceToUiSource(question.source),
  };
}

export function agentAnswerEvaluationToUiEvaluation(
  evaluation: AgentAnswerEvaluation,
): AnswerEvaluation {
  const label = toEvaluationLabel(evaluation.label);
  return {
    conciseFeedback: evaluation.concise_feedback,
    confidenceScore: evaluation.confidence_score,
    conceptStatus: evaluation.concept_status,
    correctionKind: correctionKindForLabel(label),
    label,
    retryPrompt: evaluation.retry_prompt,
    source: agentSourceToUiSource(evaluation.source),
  };
}

export function agentRecapToSessionRecap(recap: AgentStudySessionRecap): SessionRecap {
  return {
    durationLabel: "Agent session",
    headline: recap.headline,
    missedConcepts: recap.missed_concepts,
    nextAction: recap.next_action,
    plan: [
      { day: "Now", meta: "completed", status: "done", topics: recap.strong_concepts.join(", ") },
      {
        day: "Tomorrow",
        meta: "scheduled",
        status: "today",
        topics: recap.review_later.join(", ") || "Source-backed recall",
      },
      { day: "Next", meta: "upcoming", status: "upcoming", topics: recap.next_action },
    ],
    reviewLater: recap.review_later,
    shakyConcepts: recap.shaky_concepts,
    sourceMoments: recap.source_moments.map((moment) => ({
      source: agentSourceToUiSource(moment.source),
      status: moment.status,
      text: moment.text,
    })),
    strongConcepts: recap.strong_concepts,
    summary: recap.summary,
  };
}

export function agentSourceToUiSource(source: AgentStudySourceReference): SourceReference {
  return {
    confidence: source.confidence,
    documentId: source.document_id,
    excerpt: source.excerpt,
    label: formatAgentSourceLabel(source),
    retrievalReason: source.retrieval_reason,
    sourceId: source.source_id,
    span: source.span,
  };
}

function formatAgentSourceLabel(source: AgentStudySourceReference): string {
  const document = source.document_id.replace(/^lec-(\d+)$/i, "Lecture $1").replace(/-/g, " ");
  const span = source.span
    .replace(/^slide:(\d+)$/i, "Slide $1")
    .replace(/:/g, " ")
    .replace(/-/g, " ");
  return `${titleCase(document)} · ${titleCase(span)}`;
}

function toEvaluationLabel(label: AgentEvaluationLabel): EvaluationLabel {
  return label;
}

function correctionKindForLabel(label: EvaluationLabel): CorrectionKind {
  if (label === "strong") return "correct but incomplete";
  if (label === "mostly correct") return "correct but incomplete";
  if (label === "partially correct" || label === "vague") return "correct but imprecise";
  if (label === "insufficient evidence") return "course-specific discrepancy";
  return "wrong";
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
