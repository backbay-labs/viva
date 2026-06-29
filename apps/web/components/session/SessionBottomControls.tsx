"use client";

import { Icon } from "@viva/ui-web";

/**
 * A quiet control rail along the bottom of the question plate. Low visual
 * weight — no alarming red "End". End session asks the Conductor to close the
 * turn so the manuscript can render the terminal recap. Sources opens the source
 * folio; turn capture status stays ephemeral in the voice turn panel.
 */
export function SessionBottomControls({
  onEndSession,
  onShowSources,
}: {
  onEndSession: () => void;
  onShowSources?: () => void;
}) {
  return (
    <div className="session-controls">
      <button className="session-controls__btn" onClick={onEndSession} type="button">
        <Icon color="var(--viva-muted)" name="x" size={15} strokeWidth={1.6} />
        End session
      </button>
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
