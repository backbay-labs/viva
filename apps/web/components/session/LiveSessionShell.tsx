import type { ReviewScheduleItem, SessionRecap } from "@viva/core";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import type { RuntimeCopy, SourceFolioProjection } from "../../lib/viva-session-projection";
import { MuseBackdrop } from "../landing/MuseBackdrop";
import { MuseGlyphCanvas, type MuseGlyphState } from "../landing/MuseGlyphCanvas";
import type { TextAnswerState } from "./MarginaliaPanel";
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
  glyphState,
  highlightedTokens,
  conceptNodes,
  question,
  sourceFolio,
  recap,
  reviewPlan,
  transcript,
  contextLabel,
  clockLabel,
  elapsed,
  hintShown,
  textAnswer,
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
  glyphState: MuseGlyphState;
  highlightedTokens: string[];
  conceptNodes: ConceptNode[];
  question: Question;
  sourceFolio?: SourceFolioProjection;
  recap?: SessionRecap;
  reviewPlan?: ReviewScheduleItem[];
  transcript?: string;
  contextLabel: string;
  clockLabel?: string;
  elapsed: number;
  hintShown: boolean;
  textAnswer?: TextAnswerState;
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
  return (
    <section className="live-session">
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
            <SessionBottomControls
              onEndSession={onEndSession}
              onShowSources={onShowSource}
              transcript={transcript}
            />
          </div>

          <MarginaliaPanel
            hintShown={hintShown}
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
