"use client";

import { Icon } from "@viva/ui-web";
import { useRouter } from "next/navigation";

/**
 * A quiet control rail along the bottom of the question plate. Low visual
 * weight — no alarming red "End". End session returns to the front door; the
 * other two are placeholders for the wired session.
 */
export function SessionBottomControls() {
  const router = useRouter();

  return (
    <div className="session-controls">
      <button className="session-controls__btn" onClick={() => router.push("/")} type="button">
        <Icon color="var(--viva-muted)" name="x" size={15} strokeWidth={1.6} />
        End session
      </button>
      <span aria-hidden="true" className="session-controls__sep" />
      <button className="session-controls__btn" type="button">
        <Icon color="var(--viva-muted)" name="doc" size={15} strokeWidth={1.6} />
        Transcript
      </button>
      <span aria-hidden="true" className="session-controls__sep" />
      <button className="session-controls__btn" type="button">
        <Icon color="var(--viva-muted)" name="layers" size={15} strokeWidth={1.6} />
        Sources
      </button>
    </div>
  );
}
