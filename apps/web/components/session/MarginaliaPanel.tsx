import type { ReviewScheduleItem, SessionRecap } from "@viva/core";
import { Icon, MasteryRing, Spark, TimelineItem } from "@viva/ui-web";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import type { RuntimeCopy, SourceFolioProjection } from "../../lib/viva-session-projection";
import { CorrectionMarginalia } from "./CorrectionMarginalia";
import { SessionActionButton } from "./SessionActionButton";
import { SourceChip } from "./SourceChip";
import { SourceFolio } from "./SourceFolio";
import { StatusChip } from "./StatusChip";
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
  const isRecap = state === "recap" && recap !== undefined;
  const showsRuntimeNote = state === "listening" || (state === "recap" && !isRecap);
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
          {isRecap ? "Closing fold" : isSource ? "Source" : "Marginalia"}
        </span>
        <Icon
          color="var(--viva-muted)"
          name={isSource || isRecap ? "book" : "pen"}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <p className="marginalia__announcer" aria-live="polite">
        {marginaliaAnnouncement(state, recap)}
      </p>
      <div className="marginalia__body">
        {state !== "listening" && !isSource && !isRecap && studentHandAnswer ? (
          <StudentHand answer={studentHandAnswer} />
        ) : null}
        {showsRuntimeNote ? (
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
        {isRecap ? <RecapFold recap={recap} reviewPlan={reviewPlan} /> : null}
        {isSource ? (
          <SourceFolio
            onBack={onBackToQuestion}
            onChallenge={onChallengeSource ?? onTryAgain}
            question={question}
            sourceFolio={sourceFolio}
          />
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    const active = Boolean(textAnswer?.active);
    if (active && !textAnswer?.disabled && !wasActiveRef.current) {
      textareaRef.current?.focus();
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
    wasActiveRef.current = active;
  }, [textAnswer?.active, textAnswer?.disabled]);

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
            ref={textareaRef}
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
  const masteryTiers = recapMasteryTiers(recap);

  return (
    <div className="folio recap-fold">
      <p className="folio__subtitle">Closing fold / Recap ready</p>
      <p className="folio__ref">{recap.headline}</p>
      <p className="folio__excerpt">{recap.summary}</p>
      {masteryTiers ? (
        <ul className="recap-fold__rings" aria-label="Mastery at a glance">
          {masteryTiers.map((tier) => (
            <li className="recap-stat" key={tier.label}>
              <MasteryRing color={tier.color} pct={tier.pct} size={62} stroke={6} />
              <span className="recap-stat__label" style={{ color: tier.color }}>
                {tier.label}
              </span>
              <span className="recap-stat__count">
                {tier.count} concept{tier.count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
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
      {recap.plan.length > 0 ? (
        <div className="recap-fold__plan">
          <p className="recap-fold__section-title">Study plan</p>
          <div className="recap-fold__timeline">
            {recap.plan.map((item, index) => (
              <TimelineItem
                day={item.day}
                key={`${item.day}-${item.topics}-${item.meta}`}
                last={index === recap.plan.length - 1}
                meta={item.meta}
                status={item.status}
                topics={item.topics}
              />
            ))}
          </div>
        </div>
      ) : null}
      {reviewPlan.length > 0 ? (
        <div className="recap-fold__next">
          <p>Next session</p>
          <ul>
            {reviewPlan.slice(0, 3).map((item) => (
              <li key={item.conceptId}>
                <span>{item.label}</span>
                <span>
                  {item.intervalLabel} · core FSRS · {formatRecapDueDate(item.dueAt)} ·{" "}
                  {item.explanation[0]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recap.sourceMoments.length > 0 ? (
        <div className="recap-fold__sources">
          <p className="recap-fold__section-title">Source moments</p>
          <ul>
            {recap.sourceMoments.map((moment) => (
              <li className="recap-fold__source" key={`${moment.source.label}-${moment.text}`}>
                <div className="source-folio__chips">
                  <SourceChip label={moment.source.label} />
                  <StatusChip label={recapSourceStatusLabel(moment.status)} />
                </div>
                <dl className="source-folio__facts">
                  <div>
                    <dt>Confidence</dt>
                    <dd>{recapSourceConfidenceLabel(moment.source.confidence)}</dd>
                  </div>
                  <div>
                    <dt>Span</dt>
                    <dd>{recapSourceSpanLabel(moment.source)}</dd>
                  </div>
                </dl>
                <div className="source-folio__excerpt">
                  <p>{moment.source.excerpt || moment.text}</p>
                </div>
                <p className="source-folio__caveat">{moment.text}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="folio__footer">Conductor next action: {recap.nextAction}</p>
    </div>
  );
}

function joinRecapItems(items: string[]) {
  return items.length > 0 ? items.join(", ") : "none yet";
}

/**
 * A concise, stable per-state line for the visually-hidden live region — so a
 * screen reader hears what changed (listening, correction ready, recap) without
 * the panel re-reading the readiness ladder, the answer textarea, or the rings,
 * and without churning on the 5s readiness probe (the copy is state-derived, not
 * runtime-derived).
 */
function marginaliaAnnouncement(state: SessionState, recap?: SessionRecap): string {
  switch (state) {
    case "listening":
      return "Listening for your answer.";
    case "thinking":
      return "Checking your answer against your sources.";
    case "correction":
      return "A correction is ready in the margin.";
    case "source":
      return "The source folio is open.";
    case "recap":
      return recap ? `Session recap ready. ${recap.headline}` : "The session has closed.";
  }
}

type RecapMasteryTier = { label: string; count: number; pct: number; color: string };

/**
 * Reduce the four graded concept buckets into the three-ring emotional summary
 * the manuscript closes on: Strong (held), Shaky (missed + unsure, needs another
 * pass), and Review (scheduled for spaced recall). Percentages are each tier's
 * honest share of the graded concepts, so the rings always read against the same
 * whole. Returns null when nothing was graded, so the rings stay silent rather
 * than drawing three empty zeros.
 */
function recapMasteryTiers(recap: SessionRecap): RecapMasteryTier[] | null {
  const strong = recap.strongConcepts.length;
  const shaky = recap.shakyConcepts.length + recap.missedConcepts.length;
  const review = recap.reviewLater.length;
  const total = strong + shaky + review;
  if (total === 0) return null;
  const share = (count: number) => Math.round((count / total) * 100);
  return [
    { color: "var(--sage)", count: strong, label: "Strong", pct: share(strong) },
    { color: "var(--amber)", count: shaky, label: "Shaky", pct: share(shaky) },
    { color: "var(--plum)", count: review, label: "Review", pct: share(review) },
  ];
}

function recapSourceConfidenceLabel(
  confidence: SessionRecap["sourceMoments"][number]["source"]["confidence"],
) {
  switch (confidence) {
    case "high":
      return "High confidence";
    case "medium":
      return "Medium confidence";
    case "low":
      return "Low confidence";
  }
}

function recapSourceSpanLabel(source: SessionRecap["sourceMoments"][number]["source"]): string {
  if (source.documentId && source.span) return `${source.documentId} · ${source.span}`;
  return source.span ?? source.documentId ?? "bounded span unavailable";
}

function recapSourceStatusLabel(status: SessionRecap["sourceMoments"][number]["status"]): string {
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

const DUE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatRecapDueDate(dueAt: Date) {
  return `Due ${DUE_MONTHS[dueAt.getUTCMonth()]} ${dueAt.getUTCDate()}, ${dueAt.getUTCFullYear()}`;
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
