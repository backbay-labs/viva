"use client";

import { useState } from "react";
import { CommandSurface } from "./CommandSurface";
import { ContextPill } from "./ContextPill";
import { HeroCopy } from "./HeroCopy";
import { MuseBackdrop } from "./MuseBackdrop";
import { MuseGlyphCanvas, type MuseGlyphState } from "./MuseGlyphCanvas";
import { SuggestionChip } from "./SuggestionChip";
import { VivaWordmark } from "./VivaWordmark";

const SUGGESTIONS = [
  { label: "Quiz Lecture 5", icon: "quiz" },
  { label: "Mock viva · 10 min", icon: "mic" },
  { label: "Review missed concepts", icon: "refresh" },
] as const;

/**
 * The Viva landing hero. Layered so the muse stays beautiful while her notes
 * come alive: parchment → static muse artwork → the animated MuseGlyphCanvas
 * (living manuscript) → a localized readability glow → the real UI. The hero
 * owns the command input value and a small visual state ("idle" | "focus") that
 * quickens the glyph field when the student engages the command surface.
 */
export function LandingHero({
  onSubmit,
  onSuggestion,
}: {
  onSubmit?: (query: string) => void;
  onSuggestion?: (suggestion: string) => void;
}) {
  const [query, setQuery] = useState("");
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
          <CommandSurface
            onActiveChange={(active) => setVisualState(active ? "focus" : "idle")}
            onChange={setQuery}
            onSubmit={(value) => onSubmit?.(value)}
            value={query}
          />
          <div className="viva-hero__chips">
            <span aria-hidden="true" className="viva-hero__try">
              Try
            </span>
            {SUGGESTIONS.map((suggestion) => (
              <SuggestionChip
                icon={suggestion.icon}
                key={suggestion.label}
                label={suggestion.label}
                onClick={() => onSuggestion?.(suggestion.label)}
              />
            ))}
          </div>
          <p className="viva-hero__tagline">Study by talking, not rereading.</p>
        </div>
      </div>
    </section>
  );
}
