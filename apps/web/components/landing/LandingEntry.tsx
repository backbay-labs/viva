"use client";

import type { VivaLibrarySnapshot } from "../../lib/viva-library";
import { landingSessionTarget } from "../../lib/viva-session-entry";
import { LandingHero } from "./LandingHero";
import { LibraryStatusPanel } from "./LibraryStatusPanel";

/**
 * Entry boundary for "/". The muse hero is the front door; submitting the command surface or
 * tapping a suggestion crosses into the single event-driven manuscript route.
 */
export function LandingEntry({
  initialLibrarySnapshot,
  onEnter = enterSession,
}: {
  initialLibrarySnapshot?: VivaLibrarySnapshot | null;
  onEnter?: (intent: string) => void;
}) {
  return (
    <main className="viva-landing">
      <LandingHero onSubmit={onEnter} onSuggestion={onEnter} />
      <LibraryStatusPanel snapshot={initialLibrarySnapshot} />
    </main>
  );
}

export function landingEntryTarget(search = currentSearch()): string {
  return landingSessionTarget(search);
}

function enterSession() {
  window.location.assign(landingEntryTarget());
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}
