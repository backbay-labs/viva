import { describe, expect, test } from "bun:test";
import type { AnswerEvaluation, Concept, SessionQuestion, SourceReference } from "@viva/core";
import type { VivaAgentDerivedState } from "./use-viva-agent-session";
import {
  checklistFromExpectedTerms,
  conceptStatusColor,
  conceptStatusVerdict,
  correctionEmphasis,
  correctionFamily,
  expectedTermsRevealed,
  projectConceptNodes,
  projectHighlightedTokens,
  projectSessionQuestion,
  projectSessionState,
  projectTrace,
} from "./viva-session-projection";

const NOW = new Date("2026-06-17T12:00:00.000Z");

const source: SourceReference = {
  label: "Lecture 5 · Slide 18",
  excerpt: "NADH donates electrons to the electron transport chain.",
  confidence: "high",
  span: "slide:18",
  documentId: "lec-5",
  retrievalReason: "server fixture source for oxidative phosphorylation",
};

const question: SessionQuestion = {
  id: "q1",
  prompt: "Explain the role of NADH in oxidative phosphorylation.",
  expectedTerms: ["electron donor", "electron transport chain", "proton gradient", "ATP synthase"],
  followUp: "Now connect that to ATP synthase.",
  source,
};

function evaluation(overrides: Partial<AnswerEvaluation> = {}): AnswerEvaluation {
  return {
    label: "mostly correct",
    correctionKind: "correct but incomplete",
    conciseFeedback: "Good mechanism. Connect the proton gradient to ATP synthase.",
    retryPrompt: "Try again naming the gradient.",
    source,
    conceptStatus: "strong",
    confidenceScore: 0.84,
    ...overrides,
  };
}

function derived(overrides: Partial<VivaAgentDerivedState> = {}): VivaAgentDerivedState {
  return {
    phase: "listening",
    transcript: "",
    sources: [],
    manuscriptIntents: [],
    errors: [],
    canSubmitAnswer: true,
    ...overrides,
  };
}

describe("projectSessionState", () => {
  test("maps agent phases onto the four trace states", () => {
    expect(projectSessionState("listening", true)).toBe("listening");
    expect(projectSessionState("thinking", true)).toBe("thinking");
    expect(projectSessionState("feedback", true)).toBe("correction");
    expect(projectSessionState("correction", true)).toBe("correction");
    expect(projectSessionState("recap", true)).toBe("source");
  });

  test("stays calm (listening) before a question arrives", () => {
    expect(projectSessionState("ready", false)).toBe("listening");
    expect(projectSessionState("ready", true)).toBe("listening");
  });
});

describe("expectedTermsRevealed", () => {
  test("hides expected terms during listening and reveals them only after thinking", () => {
    expect(expectedTermsRevealed("listening")).toBe(false);
    expect(expectedTermsRevealed("thinking")).toBe(true);
    expect(expectedTermsRevealed("correction")).toBe(true);
    expect(expectedTermsRevealed("source")).toBe(true);
  });
});

describe("projectHighlightedTokens", () => {
  test("never leaks the answer key while the student is still speaking", () => {
    expect(projectHighlightedTokens("listening", derived({ question }))).toEqual([]);
  });

  test("highlights the question's expected terms once Viva is thinking", () => {
    expect(projectHighlightedTokens("thinking", derived({ phase: "thinking", question }))).toEqual(
      question.expectedTerms,
    );
  });

  test("is empty when there is no agent question", () => {
    expect(projectHighlightedTokens("thinking", derived({ phase: "thinking" }))).toEqual([]);
  });
});

describe("checklistFromExpectedTerms", () => {
  test("marks terms present in the transcript as done and the rest as missing", () => {
    expect(
      checklistFromExpectedTerms(["NADH", "proton gradient"], "nadh donates electrons, that's it"),
    ).toEqual([
      { label: "NADH", status: "done" },
      { label: "proton gradient", status: "missing" },
    ]);
  });

  test("is empty when there are no expected terms", () => {
    expect(checklistFromExpectedTerms([], "anything")).toEqual([]);
  });
});

describe("conceptStatusVerdict", () => {
  test("pairs the status label with a real FSRS review interval", () => {
    const strong = conceptStatusVerdict("strong", NOW);
    expect(strong).toContain("Strong");
    expect(/today|tomorrow|day/.test(strong)).toBe(true);
    expect(conceptStatusVerdict("shaky", NOW)).toContain("Shaky");
    expect(conceptStatusVerdict("missed", NOW)).toContain("Missed");
    expect(conceptStatusVerdict("review", NOW)).toContain("Review");
  });
});

describe("correctionFamily", () => {
  test("affirms strong answers, re-prompts partial ones, caveats non-answers", () => {
    expect(correctionFamily("strong")).toBe("affirm");
    expect(correctionFamily("mostly correct")).toBe("affirm");
    expect(correctionFamily("partially correct")).toBe("reprompt");
    expect(correctionFamily("vague")).toBe("reprompt");
    expect(correctionFamily("wrong")).toBe("reprompt");
    expect(correctionFamily("off-topic")).toBe("reprompt");
    expect(correctionFamily("insufficient evidence")).toBe("caveat");
  });
});

describe("correctionEmphasis (hypercorrection)", () => {
  test("a confident wrong answer earns heavier ink than a hesitant one", () => {
    expect(correctionEmphasis(0.9, "wrong")).toBeGreaterThan(correctionEmphasis(0.3, "wrong"));
  });

  test("a confident correct answer stays light", () => {
    expect(correctionEmphasis(0.9, "strong")).toBeLessThan(0.3);
  });

  test("is always within 0..1", () => {
    expect(correctionEmphasis(1, "wrong")).toBeLessThanOrEqual(1);
    expect(correctionEmphasis(0, "strong")).toBeGreaterThanOrEqual(0);
  });
});

describe("projectSessionQuestion", () => {
  test("returns a calm placeholder while connecting, never mock biology data", () => {
    const projected = projectSessionQuestion(derived({ phase: "ready" }), "connecting", NOW);
    expect(projected.prompt).toContain("Connecting");
    expect(projected.checklist).toEqual([]);
    expect(projected.correctionBody).toBe("");
    expect(projected.status).toBe("");
    expect(projected.correctionFamily).toBeUndefined();
  });

  test("projects the live agent question with no verdict before evaluation", () => {
    const projected = projectSessionQuestion(
      derived({ phase: "listening", question, finalTranscript: "NADH gives electrons" }),
      "open",
      NOW,
    );
    expect(projected.prompt).toBe(question.prompt);
    expect(projected.sourceRef).toBe("Lecture 5 · Slide 18");
    expect(projected.highlights).toEqual(question.expectedTerms);
    expect(projected.status).toBe("");
    expect(projected.correctionFamily).toBeUndefined();
  });

  test("projects the evaluation into family, emphasis, verdict and correction copy", () => {
    const projected = projectSessionQuestion(
      derived({
        phase: "correction",
        question,
        evaluation: evaluation({ label: "wrong", conceptStatus: "missed", confidenceScore: 0.9 }),
        finalTranscript: "NADH",
      }),
      "open",
      NOW,
    );
    expect(projected.correctionBody).toBe(
      "Good mechanism. Connect the proton gradient to ATP synthase.",
    );
    expect(projected.explanation).toBe(source.excerpt);
    expect(projected.status).toContain("Missed");
    expect(projected.correctionFamily).toBe("reprompt");
    expect(projected.correctionEmphasis ?? 0).toBeGreaterThan(0.6);
  });
});

describe("projectTrace", () => {
  test("composes a live thinking projection from real agent state", () => {
    const projection = projectTrace(derived({ phase: "thinking", question }), "open", NOW);
    expect(projection.state).toBe("thinking");
    expect(projection.highlightedTokens).toEqual(question.expectedTerms);
    expect(projection.hasAgentQuestion).toBe(true);
    expect(projection.question.prompt).toBe(question.prompt);
  });

  test("stays calm and spoiler-free during listening", () => {
    const projection = projectTrace(derived({ phase: "listening", question }), "open", NOW);
    expect(projection.state).toBe("listening");
    expect(projection.highlightedTokens).toEqual([]);
  });
});

function concept(id: string, label: string, status: Concept["status"]): Concept {
  return {
    id,
    label,
    status,
    misses: 0,
    centrality: 50,
    source: { label: "src", excerpt: "", confidence: "high" },
  };
}

describe("conceptStatusColor", () => {
  test("gives strong the sage tone and every status a distinct colour", () => {
    expect(conceptStatusColor("strong")).toEqual({ r: 127, g: 146, b: 119 });
    const distinct = new Set(
      (["strong", "shaky", "missed", "review"] as const).map((s) =>
        JSON.stringify(conceptStatusColor(s)),
      ),
    );
    expect(distinct.size).toBe(4);
  });
});

describe("projectConceptNodes", () => {
  test("overlays live concept statuses onto the study set, preserving order", () => {
    const nodes = projectConceptNodes(
      [concept("nadh", "NADH", "review"), concept("op", "Oxidative phosphorylation", "shaky")],
      { nadh: "strong" },
    );
    expect(nodes.map((n) => n.id)).toEqual(["nadh", "op"]);
    expect(nodes[0]).toMatchObject({ id: "nadh", label: "NADH", status: "strong" });
    expect(nodes[1].status).toBe("shaky");
  });

  test("emphasises concepts touched this session over untouched ones", () => {
    const nodes = projectConceptNodes([concept("a", "A", "shaky"), concept("b", "B", "strong")], {
      a: "missed",
    });
    expect(nodes[0].emphasis).toBeGreaterThan(nodes[1].emphasis);
  });

  test("is empty when there are no concepts", () => {
    expect(projectConceptNodes([], {})).toEqual([]);
  });
});
