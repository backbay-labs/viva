"use client";

import { Icon } from "@viva/ui-web";

/**
 * `WEBSESSION-A11Y-01`: the transcript disclosure's accessible contract.
 *
 * The control is a real button with an explicit expanded state and an explicit
 * relationship to the ONE region it reveals, and its open/closed state is owned
 * by the caller — so a recap, a route change, or an unmount can close it
 * deterministically instead of leaving a stale `<details>` open over a session
 * that has ended.
 */
export type TranscriptDisclosureProps = {
  transcriptId: string;
  transcriptOpen: boolean;
  onTranscriptOpenChange(open: boolean): void;
};

export type SessionBottomControlsProps = TranscriptDisclosureProps & {
  onEndSession: () => void;
  onShowSources?: () => void;
  transcript?: string;
};

/**
 * A quiet control rail along the bottom of the question plate. Low visual
 * weight — no alarming red "End". End session asks the Conductor to close the
 * turn so the manuscript can render the terminal recap. Transcript discloses the
 * server-finalized transcript record in place; Sources opens the source folio.
 */
export function SessionBottomControls({
  onEndSession,
  onShowSources,
  onTranscriptOpenChange,
  transcript,
  transcriptId,
  transcriptOpen,
}: SessionBottomControlsProps) {
  const hasTranscript = Boolean(transcript?.trim());
  // With nothing to reveal there is nothing to disclose: an enabled control that
  // opens an empty region announces a state change that did not happen.
  const open = transcriptOpen && hasTranscript;

  return (
    <div className="session-controls">
      <button className="session-controls__btn" onClick={onEndSession} type="button">
        <Icon color="var(--viva-muted)" name="x" size={15} strokeWidth={1.6} />
        End session
      </button>
      <span aria-hidden="true" className="session-controls__sep" />
      <button
        aria-controls={transcriptId}
        aria-expanded={open}
        className="session-controls__btn"
        disabled={!hasTranscript}
        onClick={() => onTranscriptOpenChange(!open)}
        type="button"
      >
        <Icon color="var(--viva-muted)" name="doc" size={15} strokeWidth={1.6} />
        {open ? "Hide transcript" : "Show transcript"}
      </button>
      <section
        aria-label="Session transcript"
        className="session-controls__panel"
        hidden={!open}
        id={transcriptId}
      >
        {hasTranscript ? (
          <p className="session-controls__transcript-text">{transcript}</p>
        ) : (
          <p className="session-controls__empty">
            No transcript yet — your spoken answers appear here as the Conductor transcribes them.
          </p>
        )}
      </section>
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
