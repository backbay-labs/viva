"use client";

import { landingSessionTarget } from "../../lib/viva-session-entry";
import { LandingHero } from "./LandingHero";

/**
 * Entry boundary for "/". The muse hero is the front door; submitting the command surface or
 * tapping a suggestion crosses into the single event-driven manuscript route.
 */
export function LandingEntry({ onEnter = enterSession }: { onEnter?: (intent: string) => void }) {
  return <LandingHero onSubmit={onEnter} onSuggestion={onEnter} />;
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
