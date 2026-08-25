"use client";

import { useState } from "react";
import { ContextPill } from "./ContextPill";
import { HeroCopy } from "./HeroCopy";
import { MuseBackdrop } from "./MuseBackdrop";
import { MuseGlyphCanvas, type MuseGlyphState } from "./MuseGlyphCanvas";
import { VivaWordmark } from "./VivaWordmark";

/**
 * The Viva landing hero. Layered so the muse stays beautiful while her notes
 * come alive: parchment → static muse artwork → the animated MuseGlyphCanvas
 * (living manuscript) → a localized readability glow → the real UI.
 *
 * D-03 Branch B (`FRONTEND-003`): Viva has no signed mode/goal contract, so
 * the hero makes no promise it cannot keep. There is exactly one honest,
 * 44 px primary action — "Begin oral exam" — and no command input, ornamental
 * mic, or mode/goal suggestion chips. Hovering/focusing that action quickens
 * the glyph field, the same "engaged" feel the removed command surface used
 * to drive.
 */
export function LandingHero({ onBegin }: { onBegin?: () => void }) {
  const [visualState, setVisualState] = useState<MuseGlyphState>("idle");

  return (
    <section className="viva-hero">
      <div className="viva-hero__paper" />
      <MuseBackdrop />
      <MuseGlyphCanvas state={visualState} />
      <div className="viva-hero__readability" />

      <div className="viva-hero__chrome">
        <header className="viva-hero__top">
          <VivaWordmark />
        </header>

        <div className="viva-hero__center">
          <ContextPill />
          <HeroCopy />
          <button
            className="viva-hero__begin"
            onBlur={() => setVisualState("idle")}
            onClick={() => onBegin?.()}
            onFocus={() => setVisualState("focus")}
            onMouseEnter={() => setVisualState("focus")}
            onMouseLeave={() => setVisualState("idle")}
            type="button"
          >
            Begin oral exam
          </button>
          <p className="viva-hero__tagline">Study by talking, not rereading.</p>
        </div>
      </div>
    </section>
  );
}
