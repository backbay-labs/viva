import { Icon, Spark } from "@viva/ui-web";
import { SessionActionButton } from "./SessionActionButton";
import { SourceChip } from "./SourceChip";
import { StatusChip } from "./StatusChip";
import type { Question } from "./session-data";

/**
 * The correction moment, written like a beautiful academic margin-note — never
 * an error state. A quiet "Almost.", what was missed, the source-grounded model
 * answer, the citation + spaced-repetition verdict, then the next actions.
 */
export function CorrectionMarginalia({
  question,
  onTryAgain,
  onShowSource,
  onNextQuestion,
}: {
  question: Question;
  onTryAgain: () => void;
  onShowSource: () => void;
  onNextQuestion: () => void;
}) {
  const family = question.correctionFamily ?? "reprompt";
  const emphasis = question.correctionEmphasis ?? 0;
  const title =
    family === "affirm"
      ? "Strong start."
      : family === "caveat"
        ? "I can’t confirm that from your notes."
        : "Almost.";
  const canRetry = Boolean(question.retryPrompt?.trim());

  return (
    <div className="correction" data-family={family}>
      <p className="correction__title">
        {title}
        <Spark color="var(--viva-gold)" size={15} />
      </p>
      <p className="correction__body">{question.correctionBody}</p>
      <p
        className="correction__explain"
        style={{
          opacity: 0.72 + 0.28 * emphasis,
          fontWeight: emphasis >= 0.66 ? 600 : emphasis >= 0.4 ? 550 : 500,
        }}
      >
        {question.explanation}
      </p>
      <div className="correction__meta">
        <SourceChip label={question.sourceRef} />
        <StatusChip label={question.status} />
      </div>
      {canRetry ? (
        <p className="correction__retry-cue">
          <span className="correction__retry-label">Try it this way</span>
          {question.retryPrompt}
        </p>
      ) : null}
      <div className="correction__actions">
        {canRetry ? (
          <SessionActionButton
            label="Try again"
            leading={<Icon color="var(--viva-paper)" name="refresh" size={15} strokeWidth={1.7} />}
            onClick={onTryAgain}
            variant="primary"
          />
        ) : null}
        <SessionActionButton
          label="Show source"
          leading={<Icon color="var(--viva-amethyst)" name="book" size={15} strokeWidth={1.6} />}
          onClick={onShowSource}
          trailing={<Icon color="var(--viva-muted)" name="chevron" size={14} strokeWidth={1.6} />}
        />
        <SessionActionButton
          label="Next question"
          leading={<Icon color="var(--viva-amethyst)" name="arrow" size={15} strokeWidth={1.6} />}
          onClick={onNextQuestion}
        />
      </div>
    </div>
  );
}
