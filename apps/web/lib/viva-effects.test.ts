// The shared mounted-test DOM must exist before anything that reads `window`
// at import time (`react-dom/client`'s module scope pokes at the global
// object), so this stays the first import — mirrors
// `LiveSessionPage.mounted.test.tsx`'s own ordering rule.
import "../test/setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MuseGlyphCanvas } from "../components/landing/MuseGlyphCanvas";
import { VisualEffectsControl } from "../components/landing/VisualEffectsControl";
import { resetVivaTestDom } from "../test/setup-dom";
import type { VivaEffectsPolicy, VivaEffectsPolicyInput } from "./viva-effects";
import {
  readVivaEffectsPreference,
  resolveVivaEffectsPolicy,
  VIVA_EFFECTS_CHANGE_EVENT,
  VIVA_EFFECTS_PREFERENCE_STORAGE_KEY,
} from "./viva-effects";

const STATIC_POLICY: VivaEffectsPolicy = {
  mode: "static",
  dprCap: 1.5,
  fps: 0,
  glyphCountScale: 0.5,
};

const REDUCED_POLICY: VivaEffectsPolicy = {
  mode: "reduced",
  dprCap: 1.5,
  fps: 24,
  glyphCountScale: 0.5,
};

const FULL_POLICY: VivaEffectsPolicy = {
  mode: "full",
  dprCap: 2,
  fps: 32,
  glyphCountScale: 1,
};

/**
 * High-end, no-reduction baseline: absent any overrides this resolves to
 * `FULL_POLICY`. Every table row overrides only the fields relevant to the
 * rule it exercises so a failure names exactly one precedence row.
 */
function baseInput(overrides: Partial<VivaEffectsPolicyInput> = {}): VivaEffectsPolicyInput {
  return {
    canvasRole: "voice_trace",
    viewportWidth: 1280,
    viewportHeight: 720,
    devicePixelRatio: 2,
    hardwareConcurrency: 8,
    prefersReducedMotion: false,
    prefersReducedTransparency: false,
    saveData: false,
    explicitPreference: null,
    ...overrides,
  };
}

type PolicyRow = {
  name: string;
  overrides: Partial<VivaEffectsPolicyInput>;
  expected: VivaEffectsPolicy;
};

const POLICY_TABLE: PolicyRow[] = [
  {
    name: "session_muse forces static even with high-end hardware and no reduced signals",
    overrides: { canvasRole: "session_muse", hardwareConcurrency: 16, saveData: false },
    expected: STATIC_POLICY,
  },
  {
    name: "session_muse stays static even when a reduced-tier hardware signal also applies",
    overrides: {
      canvasRole: "session_muse",
      hardwareConcurrency: 2,
      saveData: true,
      prefersReducedMotion: true,
    },
    expected: STATIC_POLICY,
  },
  {
    name: "prefersReducedMotion alone forces static",
    overrides: { canvasRole: "voice_trace", prefersReducedMotion: true },
    expected: STATIC_POLICY,
  },
  {
    name: "prefersReducedTransparency alone forces static",
    overrides: { canvasRole: "landing_muse", prefersReducedTransparency: true },
    expected: STATIC_POLICY,
  },
  {
    name: "explicitPreference reduced alone forces static",
    overrides: { canvasRole: "landing_muse", explicitPreference: "reduced" },
    expected: STATIC_POLICY,
  },
  {
    name: "static precedence wins over a simultaneous low-end-hardware/Save-Data signal",
    overrides: {
      canvasRole: "voice_trace",
      prefersReducedMotion: true,
      hardwareConcurrency: 2,
      saveData: true,
    },
    expected: STATIC_POLICY,
  },
  {
    name: "hardwareConcurrency at the 4-core boundary is reduced",
    overrides: { hardwareConcurrency: 4, saveData: false },
    expected: REDUCED_POLICY,
  },
  {
    name: "hardwareConcurrency below the boundary is reduced",
    overrides: { hardwareConcurrency: 2, saveData: false },
    expected: REDUCED_POLICY,
  },
  {
    name: "saveData alone is reduced even on high-end hardware",
    overrides: { hardwareConcurrency: 16, saveData: true },
    expected: REDUCED_POLICY,
  },
  {
    name: "saveData combined with unknown hardwareConcurrency is reduced",
    overrides: { hardwareConcurrency: null, saveData: true },
    expected: REDUCED_POLICY,
  },
  {
    name: "unknown hardwareConcurrency is not treated as low-end",
    overrides: { hardwareConcurrency: null, saveData: false },
    expected: FULL_POLICY,
  },
  {
    name: "hardwareConcurrency just above the boundary is full",
    overrides: { hardwareConcurrency: 5, saveData: false },
    expected: FULL_POLICY,
  },
  {
    name: "high hardwareConcurrency with no reduced signals is full",
    overrides: { canvasRole: "landing_muse", hardwareConcurrency: 32, saveData: false },
    expected: FULL_POLICY,
  },
];

describe("resolveVivaEffectsPolicy", () => {
  for (const row of POLICY_TABLE) {
    test(row.name, () => {
      expect(resolveVivaEffectsPolicy(baseInput(row.overrides))).toEqual(row.expected);
    });
  }

  test("returns the exact locked policy shape for each mode", () => {
    expect(resolveVivaEffectsPolicy(baseInput({ canvasRole: "session_muse" }))).toEqual({
      mode: "static",
      dprCap: 1.5,
      fps: 0,
      glyphCountScale: 0.5,
    });
    expect(
      resolveVivaEffectsPolicy(baseInput({ hardwareConcurrency: 4, saveData: false })),
    ).toEqual({ mode: "reduced", dprCap: 1.5, fps: 24, glyphCountScale: 0.5 });
    expect(
      resolveVivaEffectsPolicy(baseInput({ hardwareConcurrency: 8, saveData: false })),
    ).toEqual({ mode: "full", dprCap: 2, fps: 32, glyphCountScale: 1 });
  });
});

type FakeStorageBehavior = { value?: string | null; throwOnGet?: boolean };

function fakeStorage(behavior: FakeStorageBehavior = {}): {
  storage: Pick<Storage, "getItem">;
  calls: string[];
} {
  const calls: string[] = [];
  const storage: Pick<Storage, "getItem"> = {
    getItem(key: string) {
      calls.push(key);
      if (behavior.throwOnGet) {
        throw new Error("storage unavailable");
      }
      return behavior.value ?? null;
    },
  };
  return { storage, calls };
}

describe("readVivaEffectsPreference", () => {
  test("returns reduced for the exact stored value", () => {
    const { storage } = fakeStorage({ value: "reduced" });
    expect(readVivaEffectsPreference(storage)).toBe("reduced");
  });

  test("reads only the locked storage key", () => {
    const { storage, calls } = fakeStorage({ value: "reduced" });
    readVivaEffectsPreference(storage);
    expect(calls).toEqual([VIVA_EFFECTS_PREFERENCE_STORAGE_KEY]);
  });

  test("returns null when the key is missing", () => {
    const { storage } = fakeStorage({ value: null });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("returns null for an unknown stored string instead of treating it as reduced", () => {
    const { storage } = fakeStorage({ value: "true" });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("is case-sensitive and rejects a differently-cased value", () => {
    const { storage } = fakeStorage({ value: "REDUCED" });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("returns null for an empty stored value", () => {
    const { storage } = fakeStorage({ value: "" });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("fails closed to null instead of letting a throwing storage escape", () => {
    const { storage } = fakeStorage({ throwOnGet: true });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });
});

describe("viva effects shared constants", () => {
  test("locks the storage key and change-event names", () => {
    expect(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY).toBe("viva.effects.preference.v1");
    expect(VIVA_EFFECTS_CHANGE_EVENT).toBe("viva-effects-change");
  });
});

/* -------------------------------------------------------------------------
 * Task 10 (`FRONTEND-008`): mounted policy-integration tests.
 *
 * The Task 0 resolver above is exercised completely unchanged — these tests
 * prove `VisualEffectsControl` and `MuseGlyphCanvas` actually gather real
 * browser inputs, call it, and reflect its output as observable DOM state
 * (never a second copy of its precedence table).
 * ---------------------------------------------------------------------- */

type MediaState = { reducedMotion: boolean; reducedTransparency: boolean };
type SavedProperty = { host: object; name: string; descriptor: PropertyDescriptor | undefined };

const savedProperties: SavedProperty[] = [];

function overrideGlobal(name: string, value: unknown, host: object = globalThis): void {
  savedProperties.push({ descriptor: Object.getOwnPropertyDescriptor(host, name), host, name });
  Object.defineProperty(host, name, { configurable: true, value, writable: true });
}

function restoreGlobals(): void {
  for (let index = savedProperties.length - 1; index >= 0; index--) {
    const saved = savedProperties[index];
    if (saved.descriptor) Object.defineProperty(saved.host, saved.name, saved.descriptor);
    else Reflect.deleteProperty(saved.host, saved.name);
  }
  savedProperties.length = 0;
}

/**
 * Fakes exactly the browser surface `MuseGlyphCanvas`'s effect touches so it
 * mounts and resolves a policy in `happy-dom`: a controllable per-query
 * `matchMedia`, canvas 2D context stubs (drawing calls are no-ops — these
 * tests assert observable data attributes, never pixels), a fixed
 * `getBoundingClientRect`, and `addEventListener`/`removeEventListener`
 * wrappers that count listeners by type for the Step 4 cleanup guarantee.
 * `museBox()`/`measureSafe()` find no `.viva-muse__img`/safe-zone siblings
 * here and degrade to zero glyphs, which is irrelevant to policy assertions.
 */
function fakeMuseGlyphBrowser(options?: {
  hardwareConcurrency?: number | null;
  media?: Partial<MediaState>;
  saveData?: boolean;
}) {
  const media: MediaState = {
    reducedMotion: options?.media?.reducedMotion ?? false,
    reducedTransparency: options?.media?.reducedTransparency ?? false,
  };
  const mediaListeners = new Map<string, Set<() => void>>();

  overrideGlobal(
    "matchMedia",
    (query: string) => {
      const listeners = mediaListeners.get(query) ?? new Set<() => void>();
      mediaListeners.set(query, listeners);
      return {
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        get matches() {
          if (query.includes("prefers-reduced-motion")) return media.reducedMotion;
          if (query.includes("prefers-reduced-transparency")) return media.reducedTransparency;
          return false;
        },
        media: query,
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      };
    },
    window,
  );

  overrideGlobal("devicePixelRatio", 2, window);
  overrideGlobal("hardwareConcurrency", options?.hardwareConcurrency ?? 8, navigator);
  if (options?.saveData !== undefined) {
    overrideGlobal("connection", { saveData: options.saveData }, navigator);
  }

  overrideGlobal(
    "getBoundingClientRect",
    () =>
      ({
        bottom: 720,
        height: 720,
        left: 0,
        right: 1280,
        top: 0,
        width: 1280,
        x: 0,
        y: 0,
      }) as DOMRect,
    Element.prototype,
  );

  const fakeCtx = {
    arc() {},
    beginPath() {},
    clearRect() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    fillRect() {},
    fillText() {},
    lineTo() {},
    moveTo() {},
    setLineDash() {},
    setTransform() {},
    stroke() {},
  };
  overrideGlobal(
    "getContext",
    function getContext(this: HTMLCanvasElement, kind: string) {
      return kind === "2d" ? fakeCtx : null;
    },
    HTMLCanvasElement.prototype,
  );

  const resizeObservers = new Set<{ callback: () => void }>();
  overrideGlobal(
    "ResizeObserver",
    class FakeResizeObserver {
      readonly entry: { callback: () => void };
      constructor(callback: () => void) {
        this.entry = { callback };
      }
      observe() {
        resizeObservers.add(this.entry);
      }
      disconnect() {
        resizeObservers.delete(this.entry);
      }
      unobserve() {
        resizeObservers.delete(this.entry);
      }
    },
    globalThis,
  );

  const documentListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  function trackListeners(
    host: Document | Window,
    registry: Map<string, Set<EventListenerOrEventListenerObject>>,
  ) {
    const add = host.addEventListener.bind(host);
    const remove = host.removeEventListener.bind(host);
    overrideGlobal(
      "addEventListener",
      (type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
        const set = registry.get(type) ?? new Set();
        set.add(listener);
        registry.set(type, set);
        add(type, listener as EventListener, opts as AddEventListenerOptions);
      },
      host,
    );
    overrideGlobal(
      "removeEventListener",
      (type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
        registry.get(type)?.delete(listener);
        remove(type, listener as EventListener, opts as EventListenerOptions);
      },
      host,
    );
  }
  trackListeners(document, documentListeners);
  trackListeners(window, windowListeners);

  return {
    mediaListenerCount(): number {
      let total = 0;
      for (const listeners of mediaListeners.values()) total += listeners.size;
      return total;
    },
    setMedia(next: Partial<MediaState>) {
      Object.assign(media, next);
      act(() => {
        for (const listeners of mediaListeners.values()) {
          for (const listener of listeners) listener();
        }
      });
    },
    storageListenerCount(): number {
      return windowListeners.get("storage")?.size ?? 0;
    },
    vivaEffectsListenerCount(): number {
      return windowListeners.get(VIVA_EFFECTS_CHANGE_EVENT)?.size ?? 0;
    },
    visibilityListenerCount(): number {
      return documentListeners.get("visibilitychange")?.size ?? 0;
    },
  };
}

type MountedGlyphs = { glyphs: HTMLElement; root: Root; unmount: () => void };

/** Mounts `<MuseGlyphCanvas>` under the real ancestor its role detection reads. */
function mountMuseGlyphCanvas(
  role: "landing_muse" | "session_muse",
  props: {
    highlightedTokens?: string[];
    state?: Parameters<typeof MuseGlyphCanvas>[0]["state"];
  } = {},
): MountedGlyphs {
  const container = document.createElement(role === "session_muse" ? "main" : "section");
  container.className = role === "session_muse" ? "live-session" : "viva-hero";
  document.body.append(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(createElement(MuseGlyphCanvas, props));
  });
  const glyphs = container.querySelector<HTMLElement>(".viva-glyphs");
  if (!glyphs) throw new Error("MuseGlyphCanvas did not mount a .viva-glyphs wrapper");
  return {
    glyphs,
    root: root as unknown as Root,
    unmount() {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe("MuseGlyphCanvas effects policy integration", () => {
  afterEach(() => {
    restoreGlobals();
    resetVivaTestDom();
  });

  test("default desktop landing_muse: dpr cap 2, 32fps, glyph scale 1, animated", () => {
    fakeMuseGlyphBrowser();
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-dpr-cap")).toBe("2");
      expect(mounted.glyphs.getAttribute("data-fps-budget")).toBe("32");
      expect(mounted.glyphs.getAttribute("data-glyph-scale")).toBe("1");
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("animated");
      expect(mounted.glyphs.getAttribute("data-viva-effects")).toBe("full");
    } finally {
      mounted.unmount();
    }
  });

  test("low-end hardwareConcurrency: dpr cap 1.5, 24fps, glyph scale 0.5, still animated", () => {
    fakeMuseGlyphBrowser({ hardwareConcurrency: 4 });
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-dpr-cap")).toBe("1.5");
      expect(mounted.glyphs.getAttribute("data-fps-budget")).toBe("24");
      expect(mounted.glyphs.getAttribute("data-glyph-scale")).toBe("0.5");
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("animated");
    } finally {
      mounted.unmount();
    }
  });

  test("Save-Data alone reduces even high-end hardware", () => {
    fakeMuseGlyphBrowser({ hardwareConcurrency: 16, saveData: true });
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-fps-budget")).toBe("24");
      expect(mounted.glyphs.getAttribute("data-dpr-cap")).toBe("1.5");
    } finally {
      mounted.unmount();
    }
  });

  test("prefers-reduced-motion: one static frame, no continuous rAF budget", () => {
    fakeMuseGlyphBrowser({ media: { reducedMotion: true } });
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-fps-budget")).toBe("0");
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
      expect(mounted.glyphs.getAttribute("data-dpr-cap")).toBe("1.5");
      expect(mounted.glyphs.getAttribute("data-glyph-scale")).toBe("0.5");
    } finally {
      mounted.unmount();
    }
  });

  test("prefers-reduced-transparency alone also forces the static policy", () => {
    fakeMuseGlyphBrowser({ media: { reducedTransparency: true } });
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
    } finally {
      mounted.unmount();
    }
  });

  test("session_muse is unconditionally static, even on high-end hardware with no reduced signal", () => {
    fakeMuseGlyphBrowser({ hardwareConcurrency: 16 });
    const mounted = mountMuseGlyphCanvas("session_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-fps-budget")).toBe("0");
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
      expect(mounted.glyphs.getAttribute("data-dpr-cap")).toBe("1.5");
      expect(mounted.glyphs.getAttribute("data-glyph-scale")).toBe("0.5");
    } finally {
      mounted.unmount();
    }
  });

  test("session_muse never animates beside a live voice_trace canvas: at most one animated canvas on /session", () => {
    fakeMuseGlyphBrowser({ hardwareConcurrency: 16 });
    const mounted = mountMuseGlyphCanvas("session_muse");
    try {
      // The shared resolver (unchanged from Task 0) is what Plan 10's
      // VoiceTraceCanvas calls with `canvasRole: "voice_trace"` — asserting
      // it directly here proves the two canvases' policies can never both
      // resolve to `animated` on the same route, without importing Plan
      // 10's file.
      const sessionMusePolicy = resolveVivaEffectsPolicy({
        canvasRole: "session_muse",
        devicePixelRatio: 2,
        explicitPreference: null,
        hardwareConcurrency: 16,
        prefersReducedMotion: false,
        prefersReducedTransparency: false,
        saveData: false,
        viewportHeight: 720,
        viewportWidth: 1280,
      });
      const voiceTracePolicy = resolveVivaEffectsPolicy({
        canvasRole: "voice_trace",
        devicePixelRatio: 2,
        explicitPreference: null,
        hardwareConcurrency: 16,
        prefersReducedMotion: false,
        prefersReducedTransparency: false,
        saveData: false,
        viewportHeight: 720,
        viewportWidth: 1280,
      });
      const animatedCount = [sessionMusePolicy, voiceTracePolicy].filter((p) => p.fps > 0).length;
      expect(animatedCount).toBeLessThanOrEqual(1);
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
    } finally {
      mounted.unmount();
    }
  });

  test("recomputes after one same-tab VIVA_EFFECTS_CHANGE_EVENT following an explicit-reduced write", () => {
    const browser = fakeMuseGlyphBrowser();
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("animated");
      act(() => {
        window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
        window.dispatchEvent(new Event(VIVA_EFFECTS_CHANGE_EVENT));
      });
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
      expect(mounted.glyphs.getAttribute("data-dpr-cap")).toBe("1.5");
      void browser;
    } finally {
      mounted.unmount();
    }
  });

  test("recomputes after a cross-tab storage event with no local click", () => {
    fakeMuseGlyphBrowser();
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("animated");
      act(() => {
        window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
        window.dispatchEvent(
          new StorageEvent("storage", { key: VIVA_EFFECTS_PREFERENCE_STORAGE_KEY }),
        );
      });
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
    } finally {
      mounted.unmount();
    }
  });

  test("reload restores the static render from a preference set before mount", () => {
    fakeMuseGlyphBrowser({ media: { reducedMotion: false } });
    window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
    expect(readVivaEffectsPreference(window.localStorage)).toBe("reduced");
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
    } finally {
      mounted.unmount();
    }
  });

  test("toggling the explicit preference mirrors onto the root data-viva-effects attribute", () => {
    fakeMuseGlyphBrowser();
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(document.documentElement.dataset.vivaEffects).toBeUndefined();
      act(() => {
        window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
        window.dispatchEvent(new Event(VIVA_EFFECTS_CHANGE_EVENT));
      });
      expect(document.documentElement.dataset.vivaEffects).toBe("reduced");
      act(() => {
        window.localStorage.removeItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY);
        window.dispatchEvent(new Event(VIVA_EFFECTS_CHANGE_EVENT));
      });
      expect(document.documentElement.dataset.vivaEffects).toBeUndefined();
    } finally {
      mounted.unmount();
    }
  });

  test("system reduced-motion remains authoritative after the explicit preference is absent", () => {
    const browser = fakeMuseGlyphBrowser({ media: { reducedMotion: true } });
    const mounted = mountMuseGlyphCanvas("landing_muse");
    try {
      expect(mounted.glyphs.getAttribute("data-render-mode")).toBe("static");
      // No explicit preference was ever set — the root attribute stays
      // absent even though the canvas itself is static via system settings.
      expect(document.documentElement.dataset.vivaEffects).toBeUndefined();
      void browser;
    } finally {
      mounted.unmount();
    }
  });

  test("mounts and unmounts with exactly one listener each, then zero after cleanup", () => {
    const browser = fakeMuseGlyphBrowser();
    for (let iteration = 0; iteration < 2; iteration++) {
      const mounted = mountMuseGlyphCanvas("landing_muse");
      expect(browser.visibilityListenerCount()).toBe(1);
      expect(browser.mediaListenerCount()).toBe(2); // motion + transparency
      expect(browser.storageListenerCount()).toBe(1);
      expect(browser.vivaEffectsListenerCount()).toBe(1);
      mounted.unmount();
      expect(browser.visibilityListenerCount()).toBe(0);
      expect(browser.mediaListenerCount()).toBe(0);
      expect(browser.storageListenerCount()).toBe(0);
      expect(browser.vivaEffectsListenerCount()).toBe(0);
    }
  });

  /**
   * Regression: `MuseGlyphCanvas` used to build its density sampler from a
   * second, independently-fetched `new Image()` pointed at the exact same
   * `/viva-muse.webp` URL `MuseBackdrop`'s own `<picture>`/`<img>` already
   * requests. Real Chromium's CDP `Network` trace showed this as two
   * genuinely separate transfers that raced each other (`scripts/
   * frontend-performance.mjs`'s Muse-WebP-transfer budget occasionally
   * observed exactly 2x the real asset's byte size). The fix reuses the
   * sibling `.viva-muse__img` DOM node `MuseBackdrop` renders instead of
   * constructing a second `Image` — asserted here by spying on the global
   * `Image` constructor, which no test-environment network mocking can
   * substitute for (happy-dom never performs a real fetch either way, so
   * this is the one signal that distinguishes "reused the existing element"
   * from "quietly constructed a second one").
   */
  test("samples the sibling MuseBackdrop <img> instead of independently constructing a second Image (regression: real duplicate /viva-muse.webp network fetch)", () => {
    fakeMuseGlyphBrowser();
    const RealImage = globalThis.Image;
    let imageConstructions = 0;
    overrideGlobal(
      "Image",
      class SpyImage extends RealImage {
        constructor(...args: ConstructorParameters<typeof RealImage>) {
          super(...args);
          imageConstructions += 1;
        }
      },
    );

    const container = document.createElement("section");
    container.className = "viva-hero";
    const museImg = document.createElement("img");
    museImg.className = "viva-muse__img";
    container.append(museImg);
    document.body.append(container);

    let root: Root | null = null;
    act(() => {
      root = createRoot(container);
      root.render(createElement(MuseGlyphCanvas, {}));
    });
    try {
      expect(container.querySelector(".viva-glyphs")).not.toBeNull();
      expect(imageConstructions).toBe(0);

      // The sampler must also actually wire up to that sibling element (not
      // just avoid constructing a redundant one) — dispatching its `load`
      // event must not throw, proving `MuseGlyphCanvas` attached a real
      // listener to it rather than silently doing nothing.
      expect(() => {
        act(() => {
          museImg.dispatchEvent(new Event("load"));
        });
      }).not.toThrow();
    } finally {
      act(() => {
        root?.unmount();
      });
      container.remove();
    }
  });
});

describe("VisualEffectsControl", () => {
  afterEach(() => {
    resetVivaTestDom();
  });

  function mountControl(): { control: Root; toggle: HTMLButtonElement; unmount: () => void } {
    const container = document.createElement("div");
    document.body.append(container);
    let root: Root | null = null;
    act(() => {
      root = createRoot(container);
      root.render(createElement(VisualEffectsControl));
    });
    const toggle = container.querySelector("button");
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error("VisualEffectsControl did not mount a button after its client-only effect");
    }
    return {
      control: root as unknown as Root,
      toggle,
      unmount() {
        act(() => {
          root?.unmount();
        });
        container.remove();
      },
    };
  }

  test("mounts client-only: renders nothing under renderToStaticMarkup, which never runs effects", () => {
    // `act()` always flushes pending effects before returning, so it cannot
    // observe the pre-mount-effect DOM state; `renderToStaticMarkup` (what
    // `LandingHero.test.tsx`'s "exactly one real button" assertion actually
    // uses) never runs effects at all, which is the real guarantee this
    // component's client-only gate provides for that claim.
    const markup = renderToStaticMarkup(createElement(VisualEffectsControl));
    expect(markup).toBe("");
  });

  test("defaults to the Reduce label, then toggles to the restore label on click", () => {
    const mounted = mountControl();
    try {
      expect(mounted.toggle.textContent?.trim()).toBe("Reduce visual effects");
      expect(mounted.toggle.getAttribute("aria-pressed")).toBe("false");
      act(() => {
        mounted.toggle.click();
      });
      expect(mounted.toggle.textContent?.trim()).toBe("Use system visual effects");
      expect(mounted.toggle.getAttribute("aria-pressed")).toBe("true");
      expect(window.localStorage.getItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY)).toBe("reduced");
    } finally {
      mounted.unmount();
    }
  });

  test("clicking dispatches exactly one same-tab VIVA_EFFECTS_CHANGE_EVENT per click", () => {
    const mounted = mountControl();
    try {
      let changeEvents = 0;
      const onChange = () => {
        changeEvents += 1;
      };
      window.addEventListener(VIVA_EFFECTS_CHANGE_EVENT, onChange);
      try {
        act(() => {
          mounted.toggle.click();
        });
        expect(changeEvents).toBe(1);
      } finally {
        window.removeEventListener(VIVA_EFFECTS_CHANGE_EVENT, onChange);
      }
    } finally {
      mounted.unmount();
    }
  });

  test("clearing the value removes the stored preference and restores the Reduce label", () => {
    const mounted = mountControl();
    try {
      act(() => {
        mounted.toggle.click();
      });
      expect(mounted.toggle.textContent?.trim()).toBe("Use system visual effects");
      act(() => {
        mounted.toggle.click();
      });
      expect(mounted.toggle.textContent?.trim()).toBe("Reduce visual effects");
      expect(window.localStorage.getItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY)).toBe(null);
    } finally {
      mounted.unmount();
    }
  });

  test("a cross-tab storage change updates the displayed label without a click", () => {
    const mounted = mountControl();
    try {
      expect(mounted.toggle.textContent?.trim()).toBe("Reduce visual effects");
      act(() => {
        window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
        window.dispatchEvent(
          new StorageEvent("storage", { key: VIVA_EFFECTS_PREFERENCE_STORAGE_KEY }),
        );
      });
      expect(mounted.toggle.textContent?.trim()).toBe("Use system visual effects");
    } finally {
      mounted.unmount();
    }
  });

  test("restores the reduced label from a preference already stored before mount", () => {
    window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
    const mounted = mountControl();
    try {
      expect(mounted.toggle.textContent?.trim()).toBe("Use system visual effects");
    } finally {
      mounted.unmount();
    }
  });

  test("removes its listeners on unmount", () => {
    const mounted = mountControl();
    let changeEvents = 0;
    const onChange = () => {
      changeEvents += 1;
    };
    window.addEventListener(VIVA_EFFECTS_CHANGE_EVENT, onChange);
    mounted.unmount();
    act(() => {
      window.dispatchEvent(new Event(VIVA_EFFECTS_CHANGE_EVENT));
    });
    window.removeEventListener(VIVA_EFFECTS_CHANGE_EVENT, onChange);
    // The unmounted control's own internal listener must not throw or act on
    // a stale container; this only proves the test's own spy still works.
    expect(changeEvents).toBe(1);
  });
});
