"use client";

import type { VivaLibrarySnapshot } from "../../lib/viva-library";
import { landingSessionTarget } from "../../lib/viva-session-entry";
import { LandingHero } from "./LandingHero";
import { LibraryStatusPanel } from "./LibraryStatusPanel";

/**
 * Entry boundary for "/". The muse hero is the front door; the one honest
 * "Begin oral exam" action crosses into the single event-driven manuscript
 * route (D-03 Branch B: Viva makes no unsigned mode/goal promise).
 */
export function LandingEntry({
  initialLibrarySnapshot,
  onEnter = enterSession,
}: {
  initialLibrarySnapshot?: VivaLibrarySnapshot | null;
  onEnter?: () => void;
}) {
  return (
    <main className="viva-landing">
      <LandingHero onBegin={onEnter} />
      <LibraryStatusPanel snapshot={initialLibrarySnapshot} />
    </main>
  );
}

export function landingEntryTarget(search = currentSearch(), hash = currentHash()): string {
  return landingSessionTarget(search, hash);
}

function enterSession() {
  window.location.assign(landingEntryTarget());
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}
