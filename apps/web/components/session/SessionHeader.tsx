import type { RuntimeCopy } from "../../lib/viva-session-projection";
import { VivaWordmark } from "../landing/VivaWordmark";
import { formatClock } from "./session-data";

/** Top-left wordmark, top-centre context capsule with an explicit local clock. */
export function SessionHeader({
  clockLabel = "Local clock",
  contextLabel,
  elapsed,
  runtime,
}: {
  clockLabel?: string;
  contextLabel: string;
  elapsed: number;
  runtime: RuntimeCopy;
}) {
  return (
    <header className="session-header">
      <VivaWordmark />
      <div className="session-capsule">
        <span className="session-capsule__primary">{contextLabel}</span>
        <span className="session-capsule__dot">·</span>
        <span>{runtime.capsuleLabel}</span>
        <span className="session-capsule__dot">·</span>
        <span className="session-capsule__time">
          {clockLabel} {formatClock(elapsed)}
        </span>
      </div>
    </header>
  );
}
