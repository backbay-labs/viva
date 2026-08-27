"use client";

import type { ConceptStatus, SessionRecap, StudyMode, StudySetIngestionStatus } from "@viva/core";
import { useState } from "react";
import type { SessionReviewPlanItem } from "../../lib/viva-display";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import {
  projectTurnTakingState,
  type RuntimeCopy,
  type SourceFolioProjection,
  type VoiceTurnTakingState,
} from "../../lib/viva-session-projection";
import { MuseBackdrop } from "../landing/MuseBackdrop";
import { MuseGlyphCanvas, type MuseGlyphState } from "../landing/MuseGlyphCanvas";
import type { CheckingControl, TextAnswerState } from "./MarginaliaPanel";
import { MarginaliaPanel } from "./MarginaliaPanel";
import { QuestionStage } from "./QuestionStage";
import { SessionBottomControls } from "./SessionBottomControls";
import { SessionHeader } from "./SessionHeader";
import type { ConceptNode, Question, SessionState } from "./session-data";
import { VoiceTraceCanvas, type VoiceTraceLevelRef } from "./VoiceTraceCanvas";

/**
 * Pure layout for the live session — "ask in the centre, think in the margins".
 * Background: parchment → faint muse → toned-down glyph manuscript → a localised
 * veil behind the question plate → the UI. The question plate (with its quiet
 * control rail) and the adaptive marginalia sit side by side.
 */
export function LiveSessionShell({
  state,
  scene,
  runtime,
  challengeDisabled,
  consentDisclosure,
  glyphState,
  highlightedTokens,
  conceptNodes,
  question,
  sourceFolio,
  recap,
  reviewPlan,
  studyContext,
  turnTaking,
  transcript,
  contextLabel,
  clockLabel,
  generationId,
  elapsed,
  hintShown,
  textAnswer,
  checkingControl,
  levelRef,
  transcriptId = "live-session-transcript",
  transcriptOpen = false,
  onTranscriptOpenChange = () => {},
  onEndSession,
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
  challengeDisabled?: boolean;
  consentDisclosure?: {
    /**
     * The selected D-08 branch. Restated structurally rather than imported from
     * the page, so the shell carries no page dependency.
     */
    scope?: "all_live_provider_content" | "microphone_audio_only";
    acknowledged: boolean;
    onAcknowledge: () => void;
  };
  glyphState: MuseGlyphState;
  highlightedTokens: string[];
  conceptNodes: ConceptNode[];
  question: Question;
  sourceFolio?: SourceFolioProjection;
  recap?: SessionRecap;
  reviewPlan?: SessionReviewPlanItem[];
  studyContext?: StudyContextSummary;
  turnTaking?: VoiceTurnTakingState;
  transcript?: string;
  contextLabel: string;
  clockLabel?: string;
  generationId?: string;
  elapsed: number;
  hintShown: boolean;
  textAnswer?: TextAnswerState;
  checkingControl?: CheckingControl;
  levelRef?: VoiceTraceLevelRef;
  /**
   * `WEBSESSION-A11Y-01`: the transcript disclosure's state is the OWNER's.
   * The defaults keep a static render coherent (closed, inert) without
   * introducing a second, differently-named control.
   */
  transcriptId?: string;
  transcriptOpen?: boolean;
  onTranscriptOpenChange?: (open: boolean) => void;
  onEndSession: () => void;
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
  const voiceTurn =
    turnTaking ??
    projectTurnTakingState({
      question,
      runtime,
      state,
    });

  return (
    <main className="live-session" data-generation-id={generationId} id="live-session-main">
      <SkipToTurnLink />
      <MuseBackdrop />
      <MuseGlyphCanvas highlightedTokens={highlightedTokens} state={glyphState} />
      <div className="live-session__veil" />

      <SessionHeader
        clockLabel={clockLabel}
        contextLabel={contextLabel}
        elapsed={elapsed}
        runtime={runtime}
      />

      {studyContext ? <StudyContextBar studyContext={studyContext} /> : null}

      <div className="live-session__stage-wrap">
        {consentDisclosure && !consentDisclosure.acknowledged ? (
          <section aria-label="Recording disclosure" className="session-consent">
            <div>
              <p className="session-consent__label">Recording disclosure</p>
              <p className="session-consent__copy">
                {(consentDisclosure.scope ?? "all_live_provider_content") ===
                "microphone_audio_only"
                  ? "Before Viva uses the microphone, acknowledge that this study session may collect microphone audio, derived transcripts, source-linked study events, answer-attempt envelopes, nonces, and session metadata. Live mode sends that audio to Cartesia Ink/Sonic and Google Gemini; synthetic mode stays within the configured agent."
                  : "Before Viva sends anything to the live provider, acknowledge that this study session may collect microphone audio, typed answers, citation challenges, derived transcripts, source-linked study events, answer-attempt envelopes, nonces, and session metadata. Live mode sends spoken and typed content to Cartesia Ink/Sonic and Google Gemini; synthetic mode stays within the configured agent."}
              </p>
            </div>
            <button onClick={consentDisclosure.onAcknowledge} type="button">
              Acknowledge
            </button>
          </section>
        ) : null}
        <div className="live-session__stage" id="live-session-turn" tabIndex={-1}>
          <div className="session-plate" data-state={state}>
            <QuestionStage
              highlightedTokens={highlightedTokens}
              question={question}
              state={state}
            />
            <VoiceTraceCanvas
              conceptNodes={conceptNodes}
              highlightedTokens={highlightedTokens}
              levelRef={levelRef}
              scene={scene}
              state={state}
              textMode={Boolean(textAnswer?.active)}
            />
            <TurnTakingPanel turnTaking={voiceTurn} />
            <SessionBottomControls
              onEndSession={onEndSession}
              onShowSources={onShowSource}
              onTranscriptOpenChange={onTranscriptOpenChange}
              transcript={transcript}
              transcriptId={transcriptId}
              transcriptOpen={transcriptOpen}
            />
          </div>

          <MarginaliaPanel
            hintShown={hintShown}
            checkingControl={checkingControl}
            onBackToQuestion={onBackToQuestion}
            onHint={onHint}
            challengeDisabled={challengeDisabled}
            onChallengeSource={onChallengeSource}
            onNextQuestion={onNextQuestion}
            onShowSource={onShowSource}
            onSubmitAnswer={onSubmitAnswer}
            onSubmitTextAnswer={onSubmitTextAnswer}
            onTryAgain={onTryAgain}
            onUseTextAnswer={onUseTextAnswer}
            onUseVoiceAnswer={onUseVoiceAnswer}
            question={question}
            recap={recap}
            reviewPlan={reviewPlan}
            runtime={runtime}
            scene={scene}
            sourceFolio={sourceFolio}
            state={state}
            textAnswer={textAnswer}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * `WEBSESSION-A11Y-02`: the keyboard entrance to the turn stage.
 *
 * It is the first focusable child of the session landmark, so a keyboard learner
 * reaches the question they are being examined on in one Tab instead of walking
 * past two backdrop canvases, the header, and the study-context bar. It is
 * visually hidden until focused — the class swap is what makes it appear, so the
 * behaviour lives with the component and no stylesheet is touched — and it moves
 * focus explicitly rather than relying on a fragment navigation whose focus
 * behaviour differs between browsers.
 */
function SkipToTurnLink() {
  const [focused, setFocused] = useState(false);
  return (
    // biome-ignore lint/a11y/useValidAnchor: a skip link IS in-page navigation — it must stay an anchor with a real fragment href so assistive technology announces it as a link. The click handler only hardens the focus move that some engines skip for a `tabindex="-1"` target; it is not a button masquerading as a link.
    <a
      className={focused ? "session-skip-link" : "session-skip-link sr-only"}
      href="#live-session-turn"
      onBlur={() => setFocused(false)}
      onClick={(event) => {
        event.preventDefault();
        const target = document.getElementById("live-session-turn");
        target?.focus();
      }}
      onFocus={() => setFocused(true)}
    >
      Skip to current question and answer
    </a>
  );
}

/**
 * The study facts the AUTHENTICATED projection states, rendered as it states
 * them. `examLabel` is the server's own label; the browser never derives an exam
 * date from prose, and progress is the server's counter, never a local tally.
 */
export type StudyContextSummary = Readonly<{
  title: string;
  course: string | null;
  examLabel: string | null;
  ingestionStatus: StudySetIngestionStatus;
  progress: { completed: number; total: number };
  sessionMode: StudyMode;
  sessionGoal: string | null;
  activeQuestionPrompt: string | null;
  concepts: ReadonlyArray<{ id: string; label: string; status: ConceptStatus }>;
}>;

function StudyContextBar({ studyContext }: { studyContext: StudyContextSummary }) {
  return (
    <section aria-label="Study set" className="session-study-context">
      <p className="session-study-context__title">{studyContext.title}</p>
      <dl className="session-study-context__facts">
        <div>
          <dt>Course</dt>
          <dd>{studyContext.course ?? "No course recorded"}</dd>
        </div>
        <div>
          <dt>Exam</dt>
          <dd>{studyContext.examLabel ?? "No exam recorded"}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{studyContext.sessionMode}</dd>
        </div>
        <div>
          <dt>Goal</dt>
          <dd>{studyContext.sessionGoal ?? "No goal recorded"}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>
            {studyContext.progress.completed} of {studyContext.progress.total} questions
          </dd>
        </div>
        <div>
          <dt>Ingestion</dt>
          <dd>{studyContext.ingestionStatus}</dd>
        </div>
      </dl>
      <p className="session-study-context__question">
        {studyContext.activeQuestionPrompt ?? "No active question"}
      </p>
      {studyContext.concepts.length > 0 ? (
        <ul aria-label="Study set concepts" className="session-study-context__concepts">
          {studyContext.concepts.map((concept) => (
            <li data-status={concept.status} key={concept.id}>
              <span>{concept.label}</span>
              <span>{concept.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TurnTakingPanel({ turnTaking }: { turnTaking: VoiceTurnTakingState }) {
  return (
    <section aria-label="Voice turn state" className="turn-taking" data-phase={turnTaking.phase}>
      <div className="turn-taking__status">
        <span className="turn-taking__label">{turnTaking.label}</span>
        <strong className="turn-taking__headline">{turnTaking.headline}</strong>
        <span className="turn-taking__detail">{turnTaking.detail}</span>
      </div>
      {turnTaking.nudge ? (
        <p className="turn-taking__nudge">
          <span>{turnTaking.nudge.label}</span>
          {turnTaking.nudge.text}
        </p>
      ) : null}
      {turnTaking.captions.length > 0 ? (
        <section aria-label="Spoken captions" className="turn-captions">
          {turnTaking.captions.map((caption) => (
            <p className="turn-captions__line" data-kind={caption.kind} key={caption.label}>
              <span>{caption.label}</span>
              {caption.text}
            </p>
          ))}
        </section>
      ) : null}
      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {turnTaking.ariaStatus}
      </p>
    </section>
  );
}
