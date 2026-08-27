"use client";

import { useCallback, useEffect, useState } from "react";
import {
  readVivaEffectsPreference,
  VIVA_EFFECTS_CHANGE_EVENT,
  VIVA_EFFECTS_PREFERENCE_STORAGE_KEY,
} from "../../lib/viva-effects";

const REDUCE_LABEL = "Reduce visual effects";
const RESTORE_LABEL = "Use system visual effects";

function readPreferenceSafely(): "reduced" | null {
  try {
    return readVivaEffectsPreference(window.localStorage);
  } catch {
    return null;
  }
}

/**
 * `FRONTEND-008`: the one user-facing control for the explicit
 * reduced-effects preference. It never renders during a server/static
 * render — its state depends on `window.localStorage`, so it stays absent
 * until its own mount effect runs, which is also what keeps
 * `LandingHero.test.tsx`'s "exactly one real button" claim about `Begin
 * oral exam` true for a `renderToStaticMarkup` snapshot.
 *
 * It only ever writes `VIVA_EFFECTS_PREFERENCE_STORAGE_KEY`'s exact
 * `"reduced"` value or removes it — never study/session data — and never
 * duplicates the Task 0 module's storage key or precedence table. Every
 * owned canvas (`MuseGlyphCanvas` here; Plan 10's `VoiceTraceCanvas`)
 * independently re-reads that same key after `VIVA_EFFECTS_CHANGE_EVENT`
 * and mirrors the preference onto `document.documentElement.dataset
 * .vivaEffects` for `landing.css`/`session.css`'s reduced-transparency
 * rules; this control never reaches into a canvas or the document itself.
 */
export function VisualEffectsControl() {
  const [mounted, setMounted] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const sync = () => setReduced(readPreferenceSafely() === "reduced");
    sync();
    setMounted(true);
    window.addEventListener("storage", sync);
    window.addEventListener(VIVA_EFFECTS_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(VIVA_EFFECTS_CHANGE_EVENT, sync);
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !reduced;
    try {
      if (next) {
        window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
      } else {
        window.localStorage.removeItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY);
      }
    } catch {
      // Private-browsing/disabled storage: the in-memory toggle below still
      // applies for this tab; only cross-reload persistence is lost, which
      // matches `readVivaEffectsPreference`'s own fail-closed-to-null
      // contract rather than fighting it with a second storage strategy.
    }
    setReduced(next);
    window.dispatchEvent(new Event(VIVA_EFFECTS_CHANGE_EVENT));
  }, [reduced]);

  if (!mounted) return null;

  return (
    <button aria-pressed={reduced} className="viva-effects-toggle" onClick={toggle} type="button">
      {reduced ? RESTORE_LABEL : REDUCE_LABEL}
    </button>
  );
}
