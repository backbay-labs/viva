import {
  type AgentStudySetReadiness,
  type Concept,
  type ConceptStatus,
  type EvaluationLabel,
  reviewIntervalForStatus,
  type VivaReadyFrame,
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

export type RuntimeCopyCause =
  | "agent_offline"
  | "auth_failed"
  | "fake_provider"
  | "ingestion_failed"
  | "ingestion_pending"
  | "live_provider_gated"
  | "live_runtime"
  | "mic_denied"
  | "store_unavailable"
  | "synthetic";

export type RuntimeCopy = {
  capsuleLabel: string;
  marginaliaTitle: string;
  marginaliaText: string;
  statusLabel: string;
  cause: RuntimeCopyCause;
};

export type RuntimeMicState = "available" | "denied" | "unsupported" | "unknown";

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

export function projectRuntimeCopy({
  readiness,
  ready,
  status,
  errors = [],
  mic = "unknown",
}: {
  readiness: AgentStudySetReadiness;
  ready?: VivaReadyFrame;
  status: VivaAgentConnectionStatus;
  errors?: string[];
  mic?: RuntimeMicState;
}): RuntimeCopy {
  const newestError = errors.at(-1) ?? "";
  const authFailed = /auth|token|claim|unauthori[sz]ed/i.test(newestError);
  if (authFailed) {
    return {
      capsuleLabel: "Auth failed",
      marginaliaTitle: "Agent unavailable: auth failed.",
      marginaliaText:
        "The Conductor auth failed for this session identity; refresh the signed session before the manuscript opens another question.",
      statusLabel: "Auth failed",
      cause: "auth_failed",
    };
  }

  if (!readiness.canConnect) {
    const ingestionFailed = readiness.reason === "failed_ingestion";
    return {
      capsuleLabel: ingestionFailed ? "Ingestion failed" : "Ingestion pending",
      marginaliaTitle: ingestionFailed
        ? "Agent unavailable: ingestion failed."
        : "Agent unavailable: ingestion pending.",
      marginaliaText: readiness.message,
      statusLabel: readiness.reason.replace(/_/g, " "),
      cause: ingestionFailed ? "ingestion_failed" : "ingestion_pending",
    };
  }

  if (!ready) {
    const connecting = status === "connecting" || status === "idle";
    return {
      capsuleLabel: connecting ? "Agent connecting" : "Agent offline",
      marginaliaTitle: connecting
        ? "Waiting for the Conductor."
        : "Agent unavailable: service offline.",
      marginaliaText: connecting
        ? "The manuscript has not received provider readiness from the Conductor yet."
        : newestError ||
          "The `/ws` stream closed before provider readiness reached the manuscript.",
      statusLabel: connecting ? "connecting" : "agent offline",
      cause: "agent_offline",
    };
  }

  if (newestError && (status === "error" || status === "closed")) {
    return {
      capsuleLabel: "Agent unavailable",
      marginaliaTitle: "Agent unavailable: session rejected.",
      marginaliaText: newestError,
      statusLabel: "session rejected",
      cause: "agent_offline",
    };
  }

  if (!ready.store.available) {
    const backend = ready.store.backend.replace(/_/g, " ");
    return {
      capsuleLabel: "Store unavailable",
      marginaliaTitle: "Agent unavailable: store unavailable.",
      marginaliaText: `The ${backend} store is unavailable, so Viva will not ask or mark questions for this session.`,
      statusLabel: `${backend} store unavailable`,
      cause: "store_unavailable",
    };
  }

  if (mic === "denied" || mic === "unsupported") {
    const denied = mic === "denied";
    return {
      capsuleLabel: denied ? "Mic denied" : "Mic unavailable",
      marginaliaTitle: denied
        ? "Agent unavailable: mic denied."
        : "Agent unavailable: mic unavailable.",
      marginaliaText: denied
        ? "Browser microphone capture was denied. Use the keyboard turn control or allow mic access before treating this as a spoken session."
        : "Browser microphone capture is unavailable in this browser context. Use the keyboard turn control or switch to a browser with audio capture.",
      statusLabel: denied ? "mic denied" : "mic unavailable",
      cause: "mic_denied",
    };
  }

  if (ready.brain.selectable && ready.brain.live_runtime) {
    if (ready.brain.provider === "cartesia_gemini") {
      return {
        capsuleLabel: "Live Cartesia/Gemini tutor",
        marginaliaTitle: "Live Cartesia/Gemini tutor is listening.",
        marginaliaText:
          "The live Cartesia/Gemini runtime is selected; spoken turns are handled by the Act 3 provider path.",
        statusLabel: "live runtime",
        cause: "live_runtime",
      };
    }
    return {
      capsuleLabel: "Live tutor",
      marginaliaTitle: "Live tutor is listening.",
      marginaliaText:
        "The live provider runtime is selected; spoken turns are handled by the Act 3 provider path.",
      statusLabel: "live runtime",
      cause: "live_runtime",
    };
  }

  if (ready.brain.provider === "synthetic") {
    return {
      capsuleLabel: "Synthetic examiner",
      marginaliaTitle: "Synthetic examiner is listening.",
      marginaliaText:
        "Default no-key synthetic brain: a verified Act 1 event stream with source-grounded questions and no provider keys.",
      statusLabel: "synthetic",
      cause: "synthetic",
    };
  }

  if (ready.brain.provider === "fake_cartesia_gemini") {
    return {
      capsuleLabel: "Non-live provider test",
      marginaliaTitle: "Non-live provider test is listening.",
      marginaliaText:
        "The Cartesia/Gemini-shaped path is running through no-key test transports; it is not a live tutor.",
      statusLabel: "fake provider",
      cause: "fake_provider",
    };
  }

  if (
    ready.brain.provider === "cartesia_gemini" ||
    !ready.brain.configured ||
    !ready.brain.selectable
  ) {
    return {
      capsuleLabel: "Live provider gated",
      marginaliaTitle: "Agent unavailable: live provider gated.",
      marginaliaText:
        "Cartesia/Gemini is reserved for Act 3 until provider keys and the live runtime are selectable.",
      statusLabel: "live provider gated",
      cause: "live_provider_gated",
    };
  }

  return {
    capsuleLabel: "Non-live provider test",
    marginaliaTitle: "Non-live provider test is listening.",
    marginaliaText: `${ready.brain.provider} is running through a no-key provider path; it is not a live tutor.`,
    statusLabel: "non-live provider",
    cause: "fake_provider",
  };
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
