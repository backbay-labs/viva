"use client";

import { useState } from "react";
import { VivaApp } from "../viva/VivaApp";
import { LandingHero } from "./LandingHero";

/**
 * Entry boundary for "/". The muse hero is the front door; submitting the
 * command surface or tapping a suggestion crosses into the existing Viva app
 * (which opens on its upload screen). Nothing from the app is removed — the
 * hero simply becomes the way in.
 */
export function LandingEntry() {
  const [entered, setEntered] = useState(false);

  if (entered) {
    return <VivaApp />;
  }

  return <LandingHero onSubmit={() => setEntered(true)} onSuggestion={() => setEntered(true)} />;
}
