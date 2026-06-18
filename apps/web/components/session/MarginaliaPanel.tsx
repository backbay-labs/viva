import { Icon, Spark } from "@viva/ui-web";
import { CorrectionMarginalia } from "./CorrectionMarginalia";
import { SessionActionButton } from "./SessionActionButton";
import { SourceFolio } from "./SourceFolio";
import type { Question, SessionState } from "./session-data";

/**
 * The intelligence surface — "ask in the centre, think in the margins". Its
 * content is generative: it adapts across listening, thinking, correction and
 * source. The header label and quill/source icon shift with the state.
 */
export function MarginaliaPanel({
  state,
  question,
  hintShown,
  onHint,
  onShowSource,
  onSubmitAnswer,
  onBackToQuestion,
  onTryAgain,
  onNextQuestion,
}: {
  state: SessionState;
  question: Question;
  hintShown: boolean;
  onHint: () => void;
  onShowSource: () => void;
  onSubmitAnswer: () => void;
  onBackToQuestion: () => void;
  onTryAgain: () => void;
  onNextQuestion: () => void;
}) {
  const isSource = state === "source";

  return (
    <aside className="marginalia" data-state={state}>
      <div className="marginalia__head">
        <span className="marginalia__label">{isSource ? "Source" : "Marginalia"}</span>
        <Icon
          color="var(--viva-muted)"
          name={isSource ? "book" : "pen"}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <div className="marginalia__body" aria-live="polite">
        {state === "listening" ? (
          <ListeningNote
            hintShown={hintShown}
            onHint={onHint}
            onShowSource={onShowSource}
            onSubmitAnswer={onSubmitAnswer}
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
        {isSource ? <SourceFolio onBack={onBackToQuestion} question={question} /> : null}
      </div>
    </aside>
  );
}

function ListeningNote({
  hintShown,
  onHint,
  onShowSource,
  onSubmitAnswer,
}: {
  hintShown: boolean;
  onHint: () => void;
  onShowSource: () => void;
  onSubmitAnswer: () => void;
}) {
  return (
    <div className="margin-note margin-note--center">
      <span aria-hidden="true" className="margin-note__glyph">
        <EarMark />
      </span>
      <p className="margin-note__title">Viva is listening.</p>
      <p className="margin-note__text">
        Answer aloud from memory. I&rsquo;ll wait for your whole answer, then mark it in the margin.
      </p>
      {hintShown ? (
        <p className="margin-note__hint">
          Start with NADH&rsquo;s electrons — where do they go first?
        </p>
      ) : null}
      <div className="margin-note__actions">
        <SessionActionButton
          label="I&rsquo;m ready — check it"
          leading={<Icon color="var(--viva-paper)" name="mic" size={15} strokeWidth={1.7} />}
          onClick={onSubmitAnswer}
          variant="primary"
        />
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
