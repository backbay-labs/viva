import { Spark } from "@viva/ui-web";
import { Fragment } from "react";
import { type Question, type SessionState, STATUS_LINE } from "./session-data";

/**
 * The hero of the screen: the examiner's question, set large and calm in the
 * high-contrast serif, with a quiet live status line beneath it.
 */
export function QuestionStage({ question, state }: { question: Question; state: SessionState }) {
  const lines = question.prompt.split("\n");

  return (
    <div className="question-stage">
      <h1 className="question-stage__text">
        {lines.map((line, index) => (
          <Fragment key={line}>
            {index > 0 ? <br /> : null}
            {line}
          </Fragment>
        ))}
      </h1>
      <p className="question-stage__status" aria-live="polite">
        <Spark className="question-stage__spark" color="var(--viva-gold)" size={13} />
        <span>{STATUS_LINE[state]}</span>
      </p>
    </div>
  );
}
