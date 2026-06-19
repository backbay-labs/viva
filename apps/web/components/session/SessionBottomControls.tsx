"use client";

import { Icon } from "@viva/ui-web";

/**
 * A quiet control rail along the bottom of the question plate. Low visual
 * weight — no alarming red "End". End session asks the Conductor to close the
 * turn so the manuscript can render the terminal recap. Transcript discloses the
 * server-finalized transcript record in place; Sources opens the source folio.
 */
export function SessionBottomControls({
  onEndSession,
  onShowSources,
  transcript,
}: {
  onEndSession: () => void;
  onShowSources?: () => void;
  transcript?: string;
}) {
  const hasTranscript = Boolean(transcript?.trim());

  return (
    <div className="session-controls">
      <button className="session-controls__btn" onClick={onEndSession} type="button">
        <Icon color="var(--viva-muted)" name="x" size={15} strokeWidth={1.6} />
        End session
      </button>
      <span aria-hidden="true" className="session-controls__sep" />
      <details className="session-controls__transcript">
        <summary className="session-controls__btn">
          <Icon color="var(--viva-muted)" name="doc" size={15} strokeWidth={1.6} />
          Transcript
        </summary>
        <section aria-label="Session transcript" className="session-controls__panel">
          {hasTranscript ? (
            <p className="session-controls__transcript-text">{transcript}</p>
          ) : (
            <p className="session-controls__empty">
              No transcript captured yet — your spoken answers appear here once the Conductor
              finalizes them.
            </p>
          )}
        </section>
      </details>
      <span aria-hidden="true" className="session-controls__sep" />
      <button
        className="session-controls__btn"
        disabled={!onShowSources}
        onClick={onShowSources}
        type="button"
      >
        <Icon color="var(--viva-muted)" name="layers" size={15} strokeWidth={1.6} />
        Sources
      </button>
    </div>
  );
}
