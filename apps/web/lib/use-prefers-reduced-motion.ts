"use client";

import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Pure mapping from a media-query-list-like object to a boolean. Kept separate
 * from the hook so the gate's logic is unit-testable and SSR-safe.
 */
export function prefersReducedMotion(query: { matches: boolean } | null | undefined): boolean {
  return query?.matches ?? false;
}

/**
 * Shared JS reduced-motion gate. Every new JS-driven motion path (voice
 * amplitude, future WAAPI entrances) must consult this — the existing CSS
 * `@media (prefers-reduced-motion)` blocks and the canvases' own guards do NOT
 * cover JS-derived signals, so without this gate the amplitude bloom would
 * silently regress accessibility.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(prefersReducedMotion(query));
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}
