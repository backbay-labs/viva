import { Spark } from "@viva/ui-web";
import { Fragment, type ReactNode } from "react";
import { type Question, type SessionState, STATUS_LINE } from "./session-data";

/** States in which the answer has been given, so revealing source terms can't telegraph it. */
const REVEALING_STATES: ReadonlySet<SessionState> = new Set(["correction", "source", "recap"]);

/**
 * The hero of the screen: the examiner's question, set large and calm in the
 * high-contrast serif, with a quiet live status line beneath it. Once the
 * student has answered, the Conductor's surfaced source terms are revealed in
 * place — a soft gold ink-wash under the words the question turns on — tying the
 * spoken question to the source vocabulary it marks in the margins.
 */
export function QuestionStage({
  question,
  state,
  highlightedTokens = [],
}: {
  question: Question;
  state: SessionState;
  highlightedTokens?: string[];
}) {
  const lines = question.prompt.split("\n");
  const pending = Boolean(question.pending);
  // The live examiner status ("Listening…", "Checking…") belongs to a real
  // exchange only. While connecting (pending) or after a close/error (terminal)
  // there is nothing to listen to — showing it contradicts the headline.
  const showStatus = !pending && !question.terminal;
  const reveal = !pending && REVEALING_STATES.has(state) && highlightedTokens.length > 0;
  const matcher = reveal ? buildTokenMatcher(highlightedTokens) : null;

  return (
    <div
      className="question-stage"
      data-pending={pending ? "true" : undefined}
      aria-busy={pending ? "true" : undefined}
    >
      <h1 className="question-stage__text">
        {lines.map((line, index) => (
          <Fragment key={line}>
            {index > 0 ? <br /> : null}
            {matcher ? revealLine(line, matcher) : line}
          </Fragment>
        ))}
      </h1>
      {/* The heading stays a clean heading; a dedicated live region speaks the
          plain prompt so assistive tech hears a new question without the
          source-term reveal re-announcing the whole line. */}
      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {question.prompt}
      </p>
      {showStatus ? (
        <p aria-hidden="true" className="question-stage__status">
          <Spark className="question-stage__spark" color="var(--viva-gold)" size={13} />
          <span>{STATUS_LINE[state]}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Build a global, case-insensitive matcher for the surfaced tokens. Longer
 * phrases are listed first so an overlapping standalone token (e.g. "ATP")
 * never steals a match from the phrase that contains it ("ATP synthase").
 */
function buildTokenMatcher(tokens: string[]): RegExp | null {
  const ordered = [...new Set(tokens.filter((token) => token.trim().length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (ordered.length === 0) return null;
  const alternation = ordered.map(escapeRegExp).join("|");
  return new RegExp(`(${alternation})`, "gi");
}

function revealLine(line: string, matcher: RegExp): ReactNode[] {
  // String.split with a capturing group keeps the matched terms at odd indices.
  return line.split(matcher).map((segment, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a static line
      <mark className="question-stage__reveal" key={index}>
        {segment}
      </mark>
    ) : (
      segment
    ),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
