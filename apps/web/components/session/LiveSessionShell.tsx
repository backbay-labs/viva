import type { ReviewScheduleItem, SessionRecap } from "@viva/core";
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
  consentDisclosure,
  glyphState,
  highlightedTokens,
  conceptNodes,
  question,
  sourceFolio,
  recap,
  reviewPlan,
  turnTaking,
  contextLabel,
  clockLabel,
  generationId,
  elapsed,
  hintShown,
  textAnswer,
  checkingControl,
  levelRef,
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
  consentDisclosure?: {
    acknowledged: boolean;
    onAcknowledge: () => void;
  };
  glyphState: MuseGlyphState;
  highlightedTokens: string[];
  conceptNodes: ConceptNode[];
  question: Question;
  sourceFolio?: SourceFolioProjection;
  recap?: SessionRecap;
  reviewPlan?: ReviewScheduleItem[];
  turnTaking?: VoiceTurnTakingState;
  contextLabel: string;
  clockLabel?: string;
  generationId?: string;
  elapsed: number;
  hintShown: boolean;
  textAnswer?: TextAnswerState;
  checkingControl?: CheckingControl;
  levelRef?: VoiceTraceLevelRef;
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
    <section className="live-session" data-generation-id={generationId}>
      <MuseBackdrop />
      <MuseGlyphCanvas highlightedTokens={highlightedTokens} state={glyphState} />
      <div className="live-session__veil" />

      <SessionHeader
        clockLabel={clockLabel}
        contextLabel={contextLabel}
        elapsed={elapsed}
        runtime={runtime}
      />

      <div className="live-session__stage-wrap">
        {consentDisclosure && !consentDisclosure.acknowledged ? (
          <section aria-label="Recording disclosure" className="session-consent">
            <div>
              <p className="session-consent__label">Recording disclosure</p>
              <p className="session-consent__copy">
                Before Viva uses the microphone, acknowledge that this study session may collect
                microphone audio, derived transcripts, answers, source-linked study events,
                answer-attempt envelopes, nonces, and session metadata. Live mode sends audio and
                answers to Cartesia Ink/Sonic and Google Gemini; synthetic mode stays within the
                configured agent.
              </p>
            </div>
            <button onClick={consentDisclosure.onAcknowledge} type="button">
              Acknowledge
            </button>
          </section>
        ) : null}
        <div className="live-session__stage">
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
            />
          </div>

          <MarginaliaPanel
            hintShown={hintShown}
            checkingControl={checkingControl}
            onBackToQuestion={onBackToQuestion}
            onHint={onHint}
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
      {turnTaking.capture ? (
        <section
          aria-label="Voice capture trust"
          className="capture-trust"
          data-state={turnTaking.capture.state}
        >
          <p className="capture-trust__status">
            <span>{turnTaking.capture.label}</span>
            {turnTaking.capture.text}
          </p>
          {turnTaking.capture.ephemeralText ? (
            <p className="capture-trust__heard">{turnTaking.capture.ephemeralText}</p>
          ) : null}
          {turnTaking.capture.repair ? (
            <p className="capture-trust__repair">
              <span>{turnTaking.capture.repair.label}</span>
              {turnTaking.capture.repair.text}
            </p>
          ) : null}
        </section>
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
