import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionStage } from "./QuestionStage";
import type { Question, SessionState } from "./session-data";

function makeQuestion(prompt: string, pending = false): Question {
  return {
    prompt,
    checklist: [],
    correctionBody: "",
    explanation: "",
    sourceRef: "",
    sourceSubtitle: "",
    excerpt: "",
    sourceFooter: "",
    status: "",
    highlights: [],
    pending,
  };
}

test("renders a calm warming-up state for a pending connecting placeholder", () => {
  const markup = renderToStaticMarkup(
    <QuestionStage
      highlightedTokens={[]}
      question={makeQuestion("Connecting to your examiner…", true)}
      state="listening"
    />,
  );
  // The plate flags itself as a loading region rather than a real question.
  expect(markup).toContain('data-pending="true"');
  expect(markup).toContain('aria-busy="true"');
});

test("a real question is not flagged pending or busy", () => {
  const markup = renderToStaticMarkup(
    <QuestionStage
      highlightedTokens={[]}
      question={makeQuestion("Explain NADH.")}
      state="listening"
    />,
  );
  expect(markup).not.toContain('data-pending="true"');
  expect(markup).not.toContain('aria-busy="true"');
});

function render(prompt: string, state: SessionState, highlightedTokens: string[]): string {
  return renderToStaticMarkup(
    <QuestionStage
      highlightedTokens={highlightedTokens}
      question={makeQuestion(prompt)}
      state={state}
    />,
  );
}

test("announces the question via a dedicated live region, not the heading itself", () => {
  const markup = render("Explain the role of NADH.", "listening", []);
  // A separate visually-hidden polite region speaks the plain prompt, so a new
  // question is read aloud in a voice-first product.
  expect(markup).toContain('class="sr-only"');
  expect(/<p[^>]*aria-live="polite"[^>]*>/.test(markup)).toBe(true);
  expect(markup).toContain("Explain the role of NADH.");
  // The heading itself is NOT a live region — the post-answer source-term reveal
  // must never re-announce the whole question.
  expect(/<h1[^>]*aria-live/.test(markup)).toBe(false);
});

test("reveals a source term inside the prompt once the answer is being reviewed", () => {
  const markup = render("Describe how the proton gradient drives ATP synthase.", "correction", [
    "ATP synthase",
  ]);
  // The matched term is marked and the trailing punctuation stays outside the mark.
  expect(markup).toContain('class="question-stage__reveal">ATP synthase</mark>.');
  // The surrounding prompt text is preserved verbatim before the mark.
  expect(markup).toContain("Describe how the proton gradient drives ");
});

test("keeps the prompt unmarked while still listening, so it never telegraphs the answer", () => {
  const markup = render("Describe how the proton gradient drives ATP synthase.", "listening", [
    "ATP synthase",
  ]);
  expect(markup).not.toContain("question-stage__reveal");
  expect(markup).toContain("ATP synthase");
});

test("matches source terms case-insensitively but renders the prompt's own casing", () => {
  const markup = render("The Proton Gradient powers the cell.", "source", ["proton gradient"]);
  expect(markup).toContain('class="question-stage__reveal">Proton Gradient</mark>');
});

test("only marks terms the Conductor actually surfaced and that appear in the prompt", () => {
  // "ATP synthase" is highlighted but absent from this prompt -> nothing to reveal.
  const markup = render("Explain the role of NADH.", "correction", ["ATP synthase"]);
  expect(markup).not.toContain("question-stage__reveal");
  expect(markup).toContain("Explain the role of NADH.");
});

test("prefers the longest matching term when tokens overlap", () => {
  const markup = render("Trace ATP synthase activity.", "correction", ["ATP", "ATP synthase"]);
  expect(markup).toContain('class="question-stage__reveal">ATP synthase</mark>');
  // The standalone "ATP" token must not also wrap the inner substring.
  expect((markup.match(/question-stage__reveal/g) ?? []).length).toBe(1);
});

test("preserves the inscribed line break across a multi-line prompt", () => {
  const markup = render("Describe how the proton gradient\ndrives ATP synthase.", "correction", [
    "proton gradient",
    "ATP synthase",
  ]);
  expect(markup).toContain("<br/>");
  expect((markup.match(/question-stage__reveal/g) ?? []).length).toBe(2);
});
