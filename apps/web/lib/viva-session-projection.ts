import {
  type Concept,
  type ConceptStatus,
  type EvaluationLabel,
  reviewIntervalForStatus,
} from "@viva/core";
import type {
  ChecklistItem,
  ConceptNode,
  CorrectionFamily,
  Question,
  SessionState,
} from "../components/session/session-data";
import type { VivaAgentDerivedState } from "./use-viva-agent-session";
import type { VivaAgentConnectionStatus } from "./viva-agent-client";

/**
 * The Conductor — a pure projection from the real agent event stream
 * (VivaAgentDerivedState, folded by the existing reducer) onto the inputs the
 * gorgeous "Listening Manuscript" already consumes: a four-state SessionState,
 * the per-prompt Question the marginalia renders, and the tokens that glow on
 * the trace.
 *
 * This is what replaces LiveSessionPage's hardcoded 4-state timer + biology
 * fixtures: the manuscript now moves because of what the examiner actually did,
 * not a clock. It is deliberately pure so it can be unit-tested and so every
 * later backend swap (real evaluator, retrieval, mastery) flows through it
 * unchanged.
 *
 * Reveal-timing rule (anti-spoiler, learning-science): the question's
 * expected_terms are server-only fuel during listening and are revealed to the
 * page only once Viva is thinking — never as a pre-answer answer key.
 */

export type TraceProjection = {
  state: SessionState;
  question: Question;
  highlightedTokens: string[];
  hasAgentQuestion: boolean;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function projectSessionState(
  phase: VivaAgentDerivedState["phase"],
  _hasQuestion: boolean,
): SessionState {
  switch (phase) {
    case "thinking":
      return "thinking";
    case "feedback":
    case "correction":
      return "correction";
    case "recap":
      return "source";
    default:
      return "listening";
  }
}

export function expectedTermsRevealed(state: SessionState): boolean {
  return state !== "listening";
}

export function projectHighlightedTokens(
  state: SessionState,
  derived: VivaAgentDerivedState,
): string[] {
  if (!expectedTermsRevealed(state)) return [];
  return derived.question?.expectedTerms ?? [];
}

/** The Concept Mastery Field palette: each status reads as a distinct ink tone. */
export function conceptStatusColor(status: ConceptStatus): { r: number; g: number; b: number } {
  switch (status) {
    case "strong":
      return { r: 127, g: 146, b: 119 }; // sage
    case "review":
      return { r: 195, g: 178, b: 221 }; // lavender
    case "shaky":
      return { r: 193, g: 134, b: 74 }; // amber
    case "missed":
      return { r: 176, g: 98, b: 52 }; // deep ochre
  }
}

/**
 * Build the live concept pathway: the study set's own concepts, each carrying
 * its current mastery. Live concept_status events (from the agent, keyed by
 * concept_id) overlay the baseline, and a concept touched this session is
 * emphasised so it warms into its new colour on the trace.
 */
export function projectConceptNodes(
  concepts: Concept[],
  liveStatuses: Record<string, ConceptStatus>,
): ConceptNode[] {
  return concepts.map((concept) => {
    const live = liveStatuses[concept.id];
    return {
      id: concept.id,
      label: concept.label,
      status: live ?? concept.status,
      emphasis: live !== undefined ? 1 : 0.5,
    };
  });
}

function statusLabel(status: ConceptStatus): string {
  switch (status) {
    case "strong":
      return "Strong";
    case "shaky":
      return "Shaky";
    case "missed":
      return "Missed";
    case "review":
      return "Review";
  }
}

export function conceptStatusVerdict(status: ConceptStatus, now: Date): string {
  return `${statusLabel(status)} · review ${reviewIntervalForStatus(status, now)}`;
}

/** The three marking families the margin uses (collapsing the 7 eval labels). */
export function correctionFamily(label: EvaluationLabel): CorrectionFamily {
  switch (label) {
    case "strong":
    case "mostly correct":
      return "affirm";
    case "insufficient evidence":
      return "caveat";
    default:
      return "reprompt";
  }
}

function labelWrongness(label: EvaluationLabel): number {
  switch (label) {
    case "wrong":
    case "off-topic":
      return 1;
    case "vague":
    case "partially correct":
      return 0.7;
    case "insufficient evidence":
      return 0.5;
    case "mostly correct":
      return 0.3;
    case "strong":
      return 0.15;
  }
}

/**
 * Hypercorrection: a confident-and-wrong answer earns the heaviest ink, a
 * hesitant or already-correct one stays light. Returns a 0..1 ink-weight.
 */
export function correctionEmphasis(confidence: number, label: EvaluationLabel): number {
  return clamp01(labelWrongness(label) * (0.4 + 0.6 * clamp01(confidence)));
}

export function checklistFromExpectedTerms(
  expectedTerms: string[],
  transcript: string,
): ChecklistItem[] {
  const haystack = transcript.toLowerCase();
  return expectedTerms.map((term) => ({
    label: term,
    status: haystack.includes(term.toLowerCase()) ? "done" : "missing",
  }));
}

function connectionPlaceholderPrompt(status: VivaAgentConnectionStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting to your examiner…";
    case "error":
      return "The connection was interrupted.";
    case "closed":
      return "This session has ended.";
    default:
      return "Your examiner is preparing the first question…";
  }
}

const EMPTY_QUESTION: Omit<Question, "prompt" | "status"> = {
  checklist: [],
  correctionBody: "",
  explanation: "",
  sourceRef: "",
  sourceSubtitle: "",
  excerpt: "",
  sourceFooter: "",
  highlights: [],
};

export function projectSessionQuestion(
  derived: VivaAgentDerivedState,
  status: VivaAgentConnectionStatus,
  now: Date,
): Question {
  const agentQuestion = derived.question;
  if (!agentQuestion) {
    return { ...EMPTY_QUESTION, prompt: connectionPlaceholderPrompt(status), status: "" };
  }

  const evaluation = derived.evaluation;
  const source = evaluation?.source ?? agentQuestion.source;
  const transcript = derived.finalTranscript ?? derived.transcript;

  return {
    prompt: agentQuestion.prompt,
    checklist: checklistFromExpectedTerms(agentQuestion.expectedTerms, transcript),
    correctionBody: evaluation?.conciseFeedback ?? "",
    explanation: evaluation ? source.excerpt : agentQuestion.source.excerpt,
    sourceRef: source.label,
    sourceSubtitle: source.retrievalReason ?? "",
    excerpt: source.excerpt,
    sourceFooter: source.label,
    status: evaluation ? conceptStatusVerdict(evaluation.conceptStatus, now) : "",
    highlights: agentQuestion.expectedTerms,
    correctionFamily: evaluation ? correctionFamily(evaluation.label) : undefined,
    correctionEmphasis: evaluation
      ? correctionEmphasis(evaluation.confidenceScore, evaluation.label)
      : undefined,
  };
}

export function projectTrace(
  derived: VivaAgentDerivedState,
  status: VivaAgentConnectionStatus,
  now: Date,
): TraceProjection {
  const hasAgentQuestion = Boolean(derived.question);
  const state = projectSessionState(derived.phase, hasAgentQuestion);
  return {
    state,
    question: projectSessionQuestion(derived, status, now),
    highlightedTokens: projectHighlightedTokens(state, derived),
    hasAgentQuestion,
  };
}
