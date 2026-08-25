/**
 * Canvas effects policy: the single place that names the reduced-effects
 * storage key/change event and chooses mode/DPR/FPS/glyph-density values for
 * every Muse and voice-trace canvas. Pure and DOM-free by design — this
 * module never reads `window`, media queries, `navigator`, React state, or
 * the DOM itself. Each owning canvas gathers its own browser/media inputs in
 * its own lifecycle, reads the explicit stored preference only after mount
 * via `readVivaEffectsPreference`, and calls `resolveVivaEffectsPolicy` with
 * the assembled input. No other module may duplicate the storage key/event
 * name or the mode/DPR/FPS/scale table.
 */

export type VivaEffectsPolicy = {
  mode: "full" | "reduced" | "static";
  dprCap: number;
  fps: number;
  glyphCountScale: number;
};

export type VivaEffectsPolicyInput = {
  canvasRole: "landing_muse" | "session_muse" | "voice_trace";
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  prefersReducedMotion: boolean;
  prefersReducedTransparency: boolean;
  saveData: boolean;
  explicitPreference: "reduced" | null;
};

export const VIVA_EFFECTS_PREFERENCE_STORAGE_KEY = "viva.effects.preference.v1" as const;
export const VIVA_EFFECTS_CHANGE_EVENT = "viva-effects-change" as const;

/** Concurrency at or below this is treated as low-end. `null` is unknown, not low-end. */
const LOW_END_HARDWARE_CONCURRENCY_MAX = 4;

function staticPolicy(): VivaEffectsPolicy {
  return { mode: "static", dprCap: 1.5, fps: 0, glyphCountScale: 0.5 };
}

function reducedPolicy(): VivaEffectsPolicy {
  return { mode: "reduced", dprCap: 1.5, fps: 24, glyphCountScale: 0.5 };
}

function fullPolicy(): VivaEffectsPolicy {
  return { mode: "full", dprCap: 2, fps: 32, glyphCountScale: 1 };
}

/**
 * Reads the explicit reduced-effects preference from the given storage.
 * Reads only `VIVA_EFFECTS_PREFERENCE_STORAGE_KEY` and returns `"reduced"`
 * only for that exact stored string; a missing key, any other stored value,
 * or storage access that throws (private browsing, disabled storage) all
 * fail closed to the system default, `null`.
 */
export function readVivaEffectsPreference(storage: Pick<Storage, "getItem">): "reduced" | null {
  try {
    return storage.getItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY) === "reduced" ? "reduced" : null;
  } catch {
    return null;
  }
}

/**
 * Pure precedence resolver over an already-gathered input snapshot. Ignores
 * `viewportWidth`/`viewportHeight`/`devicePixelRatio` for the decision
 * itself — `dprCap` is a policy ceiling, and consumers combine it with the
 * device's actual ratio via `Math.min(input.devicePixelRatio, policy.dprCap)`.
 *
 * Precedence, highest first:
 *  1. `canvasRole === "session_muse"` is unconditionally static.
 *  2. Any reduced-motion, reduced-transparency, or explicit-reduced signal is
 *     static.
 *  3. Otherwise, known low-end concurrency (`hardwareConcurrency !== null &&
 *     hardwareConcurrency <= 4`) or Save-Data is reduced.
 *  4. Otherwise, full.
 */
export function resolveVivaEffectsPolicy(input: VivaEffectsPolicyInput): VivaEffectsPolicy {
  const forcedStatic =
    input.canvasRole === "session_muse" ||
    input.prefersReducedMotion ||
    input.prefersReducedTransparency ||
    input.explicitPreference === "reduced";

  if (forcedStatic) {
    return staticPolicy();
  }

  const isLowEndConcurrency =
    input.hardwareConcurrency !== null &&
    input.hardwareConcurrency <= LOW_END_HARDWARE_CONCURRENCY_MAX;

  if (isLowEndConcurrency || input.saveData) {
    return reducedPolicy();
  }

  return fullPolicy();
}
