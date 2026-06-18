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
  glyphState,
  highlightedTokens,
  conceptNodes,
  question,
  elapsed,
  hintShown,
  levelRef,
  onHint,
  onShowSource,
  onSubmitAnswer,
  onBackToQuestion,
  onTryAgain,
  onNextQuestion,
}: {
  state: SessionState;
  glyphState: MuseGlyphState;
  highlightedTokens: string[];
  conceptNodes: ConceptNode[];
  question: Question;
  elapsed: number;
  hintShown: boolean;
  levelRef?: VoiceTraceLevelRef;
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

      <SessionHeader elapsed={elapsed} />

      <div className="live-session__stage-wrap">
        <div className="live-session__stage">
          <div className="session-plate" data-state={state}>
            <QuestionStage question={question} state={state} />
            <VoiceTraceCanvas
              conceptNodes={conceptNodes}
              highlightedTokens={highlightedTokens}
              levelRef={levelRef}
              state={state}
            />
            <SessionBottomControls />
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
            state={state}
          />
        </div>
      </div>
    </section>
  );
}
