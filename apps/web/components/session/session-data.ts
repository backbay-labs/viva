import type { ConceptStatus } from "@viva/core";
import type { MuseGlyphState } from "../landing/MuseGlyphCanvas";

/**
 * "The Listening Manuscript" — shared types and mock data for the live oral-exam
 * session. Backend voice/agent integration is intentionally absent; everything
 * here is shaped so it can later be fed by real session events (each Question is
 * the kind of payload an adaptive examiner would emit per prompt).
 */
export type SessionState = "listening" | "thinking" | "correction" | "source" | "recap";

export type ChecklistStatus = "done" | "partial" | "missing";

export type ChecklistItem = { label: string; status: ChecklistStatus };

/** How the examiner marks an answer: affirm + nuance, Socratic re-prompt, or a source caveat. */
export type CorrectionFamily = "affirm" | "reprompt" | "caveat";

/** A concept on the live manuscript pathway, coloured by its current mastery (the Concept Mastery Field). */
export type ConceptNode = { id: string; label: string; status: ConceptStatus; emphasis: number };

export type Question = {
  /** May contain a single "\n" to control the inscribed line break. */
  prompt: string;
  /** Marks Viva makes while cross-referencing — shown in the Thinking margin. */
  checklist: ChecklistItem[];
  /** One-line "what you missed". */
  correctionBody: string;
  /** Source-grounded model answer (gets the subtle plum emphasis). */
  explanation: string;
  sourceRef: string;
  sourceSubtitle: string;
  excerpt: string;
  sourceFooter: string;
  /** Spaced-repetition style verdict (muted ochre). */
  status: string;
  /** Concept terms to glow across the trace/manuscript for this prompt. */
  highlights: string[];
  /** True while the examiner is connecting/preparing — the plate renders a calm
   * warming-up state instead of dressing the placeholder up as a real question. */
  pending?: boolean;
  /** True once the connection has closed or errored without a live question —
   * the plate shows calm terminal copy and suppresses the live status line, so a
   * closed/unreachable session never reads as "Listening…". */
  terminal?: boolean;
  /** Which marking family the correction belongs to (set once evaluated). */
  correctionFamily?: CorrectionFamily;
  /** Hypercorrection ink weight 0..1 — heavier when the student was confident and wrong. */
  correctionEmphasis?: number;
  /** The agent's Socratic re-prompt — actionable guidance for the next attempt. */
  retryPrompt?: string;
};

/** Source terms that drift through the voice trace and manuscript. */
export const TRACE_TOKENS = [
  "NADH",
  "electron donor",
  "electron transport chain",
  "proton gradient",
  "ATP synthase",
  "ADP + Pi",
  "H⁺",
  "ATP",
  "chemiosmosis",
  "inner mitochondrial membrane",
] as const;

/** Terms the trace gathers around while Viva is thinking. */
export const THINKING_HIGHLIGHTS = ["NADH", "electron transport chain", "proton gradient"];

export const QUESTIONS: Question[] = [
  {
    prompt: "Explain the role of\nNADH in oxidative phosphorylation.",
    checklist: [
      { label: "NADH identified", status: "done" },
      { label: "Mechanism partial", status: "partial" },
      { label: "Proton gradient not explained", status: "missing" },
      { label: "Link to ATP synthase missing", status: "missing" },
    ],
    correctionBody: "You named ATP, but skipped the mechanism.",
    explanation:
      "NADH donates electrons to the electron transport chain, helping create the proton gradient that drives ATP synthase.",
    sourceRef: "Lecture 5 · Slide 18",
    sourceSubtitle: "Oxidative Phosphorylation",
    excerpt:
      "NADH donates electrons to the electron transport chain. The energy released pumps protons across the inner mitochondrial membrane, creating a proton gradient. As H⁺ flows back through ATP synthase, ADP + Pi are converted to ATP.",
    sourceFooter: "Your lecture notes · Slide 18",
    status: "Shaky · bring back tomorrow",
    highlights: ["proton gradient", "ATP synthase"],
  },
  {
    prompt: "Describe how the proton gradient\ndrives ATP synthase.",
    checklist: [
      { label: "Gradient identified", status: "done" },
      { label: "Coupling partial", status: "partial" },
      { label: "Rotation not named", status: "missing" },
      { label: "ATP yield missing", status: "missing" },
    ],
    correctionBody: "Close — you described the gradient, but not the turbine.",
    explanation:
      "Protons flow back through ATP synthase down their gradient; that flux rotates the enzyme and phosphorylates ADP into ATP.",
    sourceRef: "Lecture 5 · Slide 21",
    sourceSubtitle: "Chemiosmosis",
    excerpt:
      "The proton-motive force stored across the inner membrane drives H⁺ back through ATP synthase. This rotational flux couples the gradient to phosphorylation, converting ADP + Pi into ATP.",
    sourceFooter: "Your lecture notes · Slide 21",
    status: "Strengthening · review in 3 days",
    highlights: ["ATP synthase", "H⁺"],
  },
  {
    prompt: "Trace one electron from NADH\nto its final acceptor.",
    checklist: [
      { label: "NADH entry identified", status: "done" },
      { label: "Chain partial", status: "partial" },
      { label: "Complex IV not named", status: "missing" },
      { label: "Final acceptor missing", status: "missing" },
    ],
    correctionBody: "Good start — now name where the electron ends.",
    explanation:
      "From NADH the electron passes along the electron transport chain to Complex IV, where oxygen is the final acceptor and is reduced to water.",
    sourceRef: "Lecture 5 · Slide 24",
    sourceSubtitle: "The Electron Transport Chain",
    excerpt:
      "Electrons from NADH move through Complexes I, III and IV. At Complex IV they reduce O₂ to water — oxygen is the terminal electron acceptor of the chain.",
    sourceFooter: "Your lecture notes · Slide 24",
    status: "Shaky · bring back tomorrow",
    highlights: ["electron transport chain", "electron donor"],
  },
];

export const STATUS_LINE: Record<Exclude<SessionState, "thinking">, string> = {
  listening: "Listening…",
  correction: "Reviewing your answer…",
  source: "Use this to answer again.",
  recap: "The manuscript is folded for review.",
};

export const CHECKING_PROGRESS_STEPS = [
  {
    label: "Saved",
    status: "Answer saved",
    detail: "Your attempt is saved.",
  },
  {
    label: "Checking",
    status: "Checking sources",
    detail: "Viva is matching it against your source spans.",
  },
  {
    label: "Feedback",
    status: "Preparing feedback",
    detail: "Feedback or a retry prompt is next.",
  },
] as const;

/** Map a session state onto the landing glyph layer's energy states. */
export function glyphStateFor(state: SessionState): MuseGlyphState {
  switch (state) {
    case "thinking":
      return "thinking";
    case "correction":
      return "correcting";
    case "source":
    case "recap":
      return "idle";
    default:
      return "listening";
  }
}

export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
