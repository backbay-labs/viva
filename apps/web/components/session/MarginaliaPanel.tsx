import type { ReviewScheduleItem, SessionRecap } from "@viva/core";
import { Icon, Spark } from "@viva/ui-web";
import { type FormEvent, useId, useState } from "react";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import type { RuntimeCopy, SourceFolioProjection } from "../../lib/viva-session-projection";
import { CorrectionMarginalia } from "./CorrectionMarginalia";
import { SessionActionButton } from "./SessionActionButton";
import { SourceFolio } from "./SourceFolio";
import type { Question, SessionState } from "./session-data";

export type TextAnswerState = {
  active: boolean;
  disabled: boolean;
  lastAnswer?: string;
  required: boolean;
};

/**
 * The intelligence surface — "ask in the centre, think in the margins". Its
 * content is generative: it adapts across listening, thinking, correction and
 * source. The header label and quill/source icon shift with the state.
 */
export function MarginaliaPanel({
  state,
  scene,
  runtime,
  question,
  sourceFolio,
  recap,
  reviewPlan = [],
  hintShown,
  textAnswer,
  onHint,
  onShowSource,
  onChallengeSource,
  onSubmitAnswer,
  onSubmitTextAnswer,
  onUseTextAnswer,
  onUseVoiceAnswer,
  onBackToQuestion,
  onTryAgain,
  onNextQuestion,
}: {
  state: SessionState;
  scene?: VivaSceneState;
  runtime: RuntimeCopy;
  question: Question;
  sourceFolio?: SourceFolioProjection;
  recap?: SessionRecap;
  reviewPlan?: ReviewScheduleItem[];
  hintShown: boolean;
  textAnswer?: TextAnswerState;
  onHint: () => void;
  onShowSource: () => void;
  onChallengeSource?: () => void;
  onSubmitAnswer: () => void;
  onSubmitTextAnswer?: (answer: string) => void;
  onUseTextAnswer?: () => void;
  onUseVoiceAnswer?: () => void;
  onBackToQuestion: () => void;
  onTryAgain: () => void;
  onNextQuestion: () => void;
}) {
  const isSource = state === "source";
  const isRecap = isSource && Boolean(recap);
  const studentHandAnswer = textAnswer?.lastAnswer;

  return (
    <aside
      className="marginalia"
      data-scene-emphasis={scene?.emphasis ?? "quiet"}
      data-scene-marginalia-count={scene?.marginalia.length ?? 0}
      data-scene-register={scene?.register ?? "examining"}
      data-state={state}
    >
      <div className="marginalia__head">
        <span className="marginalia__label">
          {isRecap ? "Recap" : isSource ? "Source" : "Marginalia"}
        </span>
        <Icon
          color="var(--viva-muted)"
          name={isSource ? "book" : "pen"}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <div className="marginalia__body" aria-live="polite">
        {state !== "listening" && !isSource && studentHandAnswer ? (
          <StudentHand answer={studentHandAnswer} />
        ) : null}
        {state === "listening" ? (
          <ListeningNote
            hintShown={hintShown}
            onHint={onHint}
            onShowSource={onShowSource}
            onSubmitAnswer={onSubmitAnswer}
            onSubmitTextAnswer={onSubmitTextAnswer}
            onUseTextAnswer={onUseTextAnswer}
            onUseVoiceAnswer={onUseVoiceAnswer}
            runtime={runtime}
            textAnswer={textAnswer}
          />
        ) : null}
        {state === "thinking" ? <ThinkingNote question={question} /> : null}
        {state === "correction" ? (
          <CorrectionMarginalia
            onNextQuestion={onNextQuestion}
            onShowSource={onShowSource}
            onTryAgain={onTryAgain}
            question={question}
          />
        ) : null}
        {isSource ? (
          recap ? (
            <RecapFold recap={recap} reviewPlan={reviewPlan} />
          ) : (
            <SourceFolio
              onBack={onBackToQuestion}
              onChallenge={onChallengeSource ?? onTryAgain}
              question={question}
              sourceFolio={sourceFolio}
            />
          )
        ) : null}
      </div>
    </aside>
  );
}

function ListeningNote({
  hintShown,
  runtime,
  textAnswer,
  onHint,
  onShowSource,
  onSubmitAnswer,
  onSubmitTextAnswer,
  onUseTextAnswer,
  onUseVoiceAnswer,
}: {
  hintShown: boolean;
  runtime: RuntimeCopy;
  textAnswer?: TextAnswerState;
  onHint: () => void;
  onShowSource: () => void;
  onSubmitAnswer: () => void;
  onSubmitTextAnswer?: (answer: string) => void;
  onUseTextAnswer?: () => void;
  onUseVoiceAnswer?: () => void;
}) {
  const [writtenAnswer, setWrittenAnswer] = useState("");
  const answerId = useId();
  const helpId = useId();
  const submitWrittenAnswer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = writtenAnswer.trim();
    if (!trimmed || textAnswer?.disabled) return;
    onSubmitTextAnswer?.(trimmed);
    setWrittenAnswer("");
  };

  return (
    <div
      className="margin-note margin-note--center"
      data-text-answer={textAnswer?.active ? "active" : "inactive"}
    >
      <span aria-hidden="true" className="margin-note__glyph">
        <EarMark />
      </span>
      <p className="margin-note__title">{runtime.marginaliaTitle}</p>
      <p className="margin-note__text">{runtime.marginaliaText}</p>
      {textAnswer?.lastAnswer ? <StudentHand answer={textAnswer.lastAnswer} /> : null}
      <ul className="readiness-ladder" aria-label="Connected session readiness">
        {runtime.readinessNotes.map((note) => (
          <li className="readiness-ladder__item" data-state={note.state} key={note.label}>
            <span className="readiness-ladder__dot" />
            <span className="readiness-ladder__label">{note.label}</span>
            <span className="readiness-ladder__text">{note.text}</span>
          </li>
        ))}
      </ul>
      <p className="margin-note__next">Next action: {runtime.nextActionLabel}</p>
      {hintShown ? (
        <p className="margin-note__hint">
          Use your own words first; the Conductor will reveal source terms after you answer.
        </p>
      ) : null}
      {textAnswer?.active ? (
        <form aria-label="Written answer" className="written-answer" onSubmit={submitWrittenAnswer}>
          <label className="written-answer__label" htmlFor={answerId}>
            Write in the margin
          </label>
          <textarea
            aria-describedby={helpId}
            aria-label="Student written answer"
            className="written-answer__input"
            disabled={textAnswer.disabled}
            id={answerId}
            onChange={(event) => setWrittenAnswer(event.currentTarget.value)}
            rows={4}
            value={writtenAnswer}
          />
          <p className="written-answer__note" id={helpId}>
            {textAnswer.required
              ? "Mic unavailable; this answer goes to the Conductor."
              : "This answer goes to the Conductor."}
          </p>
          <button
            className="session-action session-action--primary written-answer__submit"
            disabled={textAnswer.disabled || writtenAnswer.trim().length === 0}
            type="submit"
          >
            <span className="session-action__icon">
              <Icon color="var(--viva-paper)" name="pen" size={15} strokeWidth={1.7} />
            </span>
            <span className="session-action__label">Submit written answer</span>
          </button>
        </form>
      ) : null}
      <div className="margin-note__actions">
        {textAnswer?.active ? (
          !textAnswer.required && onUseVoiceAnswer ? (
            <SessionActionButton
              label="Use mic"
              leading={<Icon color="var(--viva-amethyst)" name="mic" size={15} strokeWidth={1.6} />}
              onClick={onUseVoiceAnswer}
            />
          ) : null
        ) : (
          <SessionActionButton
            disabled={runtime.primaryActionDisabled}
            label={runtime.primaryActionLabel}
            leading={<Icon color="var(--viva-paper)" name="mic" size={15} strokeWidth={1.7} />}
            onClick={onSubmitAnswer}
            variant="primary"
          />
        )}
        {!textAnswer?.active && textAnswer && onUseTextAnswer ? (
          <SessionActionButton
            label="Write answer"
            leading={<Icon color="var(--viva-amethyst)" name="pen" size={15} strokeWidth={1.6} />}
            onClick={onUseTextAnswer}
          />
        ) : null}
        <SessionActionButton
          label="Hint"
          leading={<Icon color="var(--viva-amethyst)" name="bulb" size={15} strokeWidth={1.6} />}
          onClick={onHint}
        />
        <SessionActionButton
          label="Show source"
          leading={<Icon color="var(--viva-amethyst)" name="book" size={15} strokeWidth={1.6} />}
          onClick={onShowSource}
          trailing={<Icon color="var(--viva-muted)" name="chevron" size={14} strokeWidth={1.6} />}
        />
      </div>
    </div>
  );
}

function StudentHand({ answer }: { answer: string }) {
  return (
    <figure className="student-hand" aria-label="Student hand answer">
      <figcaption>Student's hand</figcaption>
      <p>{answer}</p>
    </figure>
  );
}

function RecapFold({
  recap,
  reviewPlan,
}: {
  recap: SessionRecap;
  reviewPlan: ReviewScheduleItem[];
}) {
  return (
    <div className="folio recap-fold">
      <p className="folio__subtitle">Recap ready</p>
      <p className="folio__ref">{recap.headline}</p>
      <p className="folio__excerpt">{recap.summary}</p>
      <ul className="recap-fold__list" aria-label="Conductor recap">
        <li>
          <span>Strong</span>
          <span>{joinRecapItems(recap.strongConcepts)}</span>
        </li>
        <li>
          <span>Shaky</span>
          <span>{joinRecapItems(recap.shakyConcepts)}</span>
        </li>
        <li>
          <span>Missed</span>
          <span>{joinRecapItems(recap.missedConcepts)}</span>
        </li>
        <li>
          <span>Review later</span>
          <span>{joinRecapItems(recap.reviewLater)}</span>
        </li>
      </ul>
      {reviewPlan.length > 0 ? (
        <div className="recap-fold__next">
          <p>Next session</p>
          <ul>
            {reviewPlan.slice(0, 3).map((item) => (
              <li key={item.conceptId}>
                <span>{item.label}</span>
                <span>
                  {item.intervalLabel} · core FSRS · {item.explanation[0]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recap.sourceMoments[0] ? (
        <p className="folio__footer">
          {recap.sourceMoments[0].source.label}: {recap.sourceMoments[0].text}
        </p>
      ) : null}
      <p className="folio__footer">Conductor next action: {recap.nextAction}</p>
    </div>
  );
}

function joinRecapItems(items: string[]) {
  return items.length > 0 ? items.join(", ") : "none yet";
}

function ThinkingNote({ question }: { question: Question }) {
  return (
    <div className="margin-note">
      <p className="margin-note__title">Thinking…</p>
      <p className="margin-note__text">Cross-referencing your answer with your sources.</p>
      <ul className="checklist">
        {question.checklist.map((item) => (
          <li className={`checklist__item checklist__item--${item.status}`} key={item.label}>
            {item.status === "done" ? (
              <Icon color="var(--viva-sage)" name="check" size={14} strokeWidth={2} />
            ) : (
              <span className={`checklist__ring checklist__ring--${item.status}`} />
            )}
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
      <p className="margin-note__hold">
        <Spark color="var(--viva-gold)" size={12} />
        Hold tight…
      </p>
      <span aria-hidden="true" className="margin-note__hourglass">
        <HourglassMark />
      </span>
    </div>
  );
}

function EarMark() {
  return (
    <svg
      fill="none"
      height="30"
      stroke="var(--viva-amethyst-deep)"
      strokeLinecap="round"
      strokeWidth="1.3"
      viewBox="0 0 24 24"
      width="30"
    >
      <title>Listening</title>
      <path d="M8 9a4 4 0 1 1 8 0c0 2-1.5 3-2.4 4.2-.7.9-1 1.6-1.1 2.8a2 2 0 1 1-3.4-1.2" />
      <path d="M11 9.2a1.6 1.6 0 0 1 2.6 1.3c0 1.1-1.2 1.3-1.4 2.4" />
    </svg>
  );
}

function HourglassMark() {
  return (
    <svg
      fill="none"
      height="26"
      stroke="var(--viva-gold)"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.2"
      viewBox="0 0 24 24"
      width="26"
    >
      <title>Working</title>
      <path d="M7 3h10M7 21h10M8 3c0 4 8 5 8 9s-8 5-8 9M16 3c0 4-8 5-8 9s8 5 8 9" />
    </svg>
  );
}
