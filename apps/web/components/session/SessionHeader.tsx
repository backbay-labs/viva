import { VivaWordmark } from "../landing/VivaWordmark";
import { formatClock } from "./session-data";

/** Top-left wordmark, top-centre context capsule with the (mocked) session clock. */
export function SessionHeader({ elapsed }: { elapsed: number }) {
  return (
    <header className="session-header">
      <VivaWordmark />
      <div className="session-capsule">
        <span className="session-capsule__primary">Biology Midterm</span>
        <span className="session-capsule__dot">·</span>
        <span>Mock viva</span>
        <span className="session-capsule__dot">·</span>
        <span className="session-capsule__time">{formatClock(elapsed)}</span>
      </div>
    </header>
  );
}
