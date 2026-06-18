import type { SessionRecap } from "@viva/core";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import type { RuntimeCopy } from "../../lib/viva-session-projection";
import { MuseBackdrop } from "../landing/MuseBackdrop";
import { MuseGlyphCanvas, type MuseGlyphState } from "../landing/MuseGlyphCanvas";
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
  recap,
  contextLabel,
  clockLabel,
  elapsed,
  hintShown,
  levelRef,
  onEndSession,
  onHint,
  onShowSource,
  onSubmitAnswer,
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
  recap?: SessionRecap;
  contextLabel: string;
  clockLabel?: string;
  elapsed: number;
  hintShown: boolean;
  levelRef?: VoiceTraceLevelRef;
  onEndSession: () => void;
  onHint: () => void;
  onShowSource: () => void;
  onSubmitAnswer: () => void;
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
            <QuestionStage question={question} state={state} />
            <VoiceTraceCanvas
              conceptNodes={conceptNodes}
              highlightedTokens={highlightedTokens}
              levelRef={levelRef}
              scene={scene}
              state={state}
            />
            <SessionBottomControls onEndSession={onEndSession} />
          </div>

          <MarginaliaPanel
            hintShown={hintShown}
            onBackToQuestion={onBackToQuestion}
            onHint={onHint}
            onNextQuestion={onNextQuestion}
            onShowSource={onShowSource}
            onSubmitAnswer={onSubmitAnswer}
            onTryAgain={onTryAgain}
            question={question}
            recap={recap}
            runtime={runtime}
            scene={scene}
            state={state}
          />
        </div>
      </div>
    </section>
  );
}
