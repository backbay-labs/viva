import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resolveVivaEffectsPolicy,
  VIVA_EFFECTS_CHANGE_EVENT,
  VIVA_EFFECTS_PREFERENCE_STORAGE_KEY,
  type VivaEffectsPolicyInput,
} from "../../lib/viva-effects";
import { installVivaTestDom, resetVivaTestDom, uninstallVivaTestDom } from "../../test/setup-dom";
import type { ConceptNode } from "./session-data";
import {
  createVoiceTraceLabelPlanCache,
  planVoiceTraceConceptLabels,
  VoiceTraceCanvas,
  type VoiceTraceLabelPlanCacheInput,
  voiceTraceLabelPlanComputations,
} from "./VoiceTraceCanvas";

/**
 * `WEBSESSION-CANVAS-01`. Two obligations, proved through the component's public
 * surface rather than its source text:
 *
 *  1. Concept-label planning is a cached function of the *semantic* inputs
 *     (concept generation, canvas size, font scale) — never of the per-frame
 *     wobble — so a steady animation plans once and reuses one plan object.
 *  2. The frame/DPR budget is Plan 13A's shared `resolveVivaEffectsPolicy`
 *     result, published on `.voice-trace` so a policy change is observable and
 *     a second effects table can never drift from it.
 */

/**
 * `setup-dom`'s own module-scoped hooks attach to whichever mounted suite Bun
 * loads FIRST, so this suite installs and tears down its own DOM rather than
 * inheriting one that another file's `afterAll` may already have unregistered.
 * Both helpers are idempotent.
 */
beforeAll(() => {
  installVivaTestDom();
});

afterEach(() => {
  resetVivaTestDom();
});

afterAll(async () => {
  await uninstallVivaTestDom();
});

const conceptNodes: readonly ConceptNode[] = [
  { id: "c-1", label: "Enthalpy", status: "strong", emphasis: 1 },
  { id: "c-2", label: "Gibbs free energy", status: "review", emphasis: 0.6 },
  { id: "c-3", label: "Entropy of mixing", status: "shaky", emphasis: 0.4 },
  { id: "c-4", label: "Standard states", status: "missed", emphasis: 0.2 },
  { id: "c-5", label: "Hess's law", status: "review", emphasis: 0.3 },
  { id: "c-6", label: "Maxwell relations", status: "strong", emphasis: 0.5 },
  { id: "c-7", label: "Chemical potential", status: "shaky", emphasis: 0.7 },
];

/**
 * The same concepts with one character moved from the head of a label to the
 * tail of its id: a different concept set that concatenates to identical text.
 */
function boundaryShifted(): ConceptNode[] {
  return conceptNodes.map((node, index) =>
    index === 0
      ? { ...node, id: `${node.id}${node.label.slice(0, 1)}`, label: node.label.slice(1) }
      : { ...node },
  );
}

function planItems(offsetX = 0, offsetY = 0): VoiceTraceLabelPlanCacheInput["items"] {
  return conceptNodes.map((node, index) => ({
    emphasis: node.emphasis,
    label: node.label,
    point: { x: 60 + index * 90 + offsetX, y: 180 + (index % 3) * 12 + offsetY },
  }));
}

function cacheInput(
  overrides: Partial<VoiceTraceLabelPlanCacheInput> = {},
): VoiceTraceLabelPlanCacheInput {
  return {
    canvasHeight: 360,
    canvasWidth: 720,
    conceptGeneration: 1,
    fontScale: 1,
    items: planItems(),
    ...overrides,
  };
}

/**
 * A concept label is drawn either whole or elided with the planner's `...`
 * suffix, so a drawn string identifies its concept by being that concept's
 * prefix. Four characters keeps a one/two-glyph particle from ever matching.
 */
function isDrawOfLabel(drawn: string, label: string): boolean {
  const body = drawn.endsWith("...") ? drawn.slice(0, -3) : drawn;
  return body.length >= 4 && label.startsWith(body);
}

function countingPlanner() {
  let calls = 0;
  const planner: typeof planVoiceTraceConceptLabels = (input) => {
    calls += 1;
    return planVoiceTraceConceptLabels(input);
  };
  return {
    planner,
    get calls() {
      return calls;
    },
  };
}

describe("createVoiceTraceLabelPlanCache", () => {
  test("plans once across 120 identical animation frames and returns one plan object", () => {
    const counting = countingPlanner();
    const cache = createVoiceTraceLabelPlanCache(counting.planner);

    const first = cache.plan(cacheInput());
    for (let frame = 1; frame < 120; frame++) {
      const next = cache.plan(cacheInput());
      expect(next).toBe(first);
    }

    expect(counting.calls).toBe(1);
    expect(first).toHaveLength(conceptNodes.length);
    expect(first.map((entry) => entry.label)).toEqual(conceptNodes.map((node) => node.label));
  });

  test("recomputes exactly once per width, height, font-scale, or generation change", () => {
    const counting = countingPlanner();
    const cache = createVoiceTraceLabelPlanCache(counting.planner);

    cache.plan(cacheInput());
    expect(counting.calls).toBe(1);

    cache.plan(cacheInput({ canvasWidth: 900 }));
    cache.plan(cacheInput({ canvasWidth: 900 }));
    expect(counting.calls).toBe(2);

    cache.plan(cacheInput({ canvasWidth: 900, canvasHeight: 420 }));
    cache.plan(cacheInput({ canvasWidth: 900, canvasHeight: 420 }));
    expect(counting.calls).toBe(3);

    cache.plan(cacheInput({ canvasWidth: 900, canvasHeight: 420, fontScale: 0.8 }));
    cache.plan(cacheInput({ canvasWidth: 900, canvasHeight: 420, fontScale: 0.8 }));
    expect(counting.calls).toBe(4);

    cache.plan(
      cacheInput({ canvasWidth: 900, canvasHeight: 420, conceptGeneration: 2, fontScale: 0.8 }),
    );
    cache.plan(
      cacheInput({ canvasWidth: 900, canvasHeight: 420, conceptGeneration: 2, fontScale: 0.8 }),
    );
    expect(counting.calls).toBe(5);
  });

  test("reset() forces exactly one recomputation", () => {
    const counting = countingPlanner();
    const cache = createVoiceTraceLabelPlanCache(counting.planner);

    cache.plan(cacheInput());
    cache.plan(cacheInput());
    expect(counting.calls).toBe(1);

    cache.reset();
    const afterReset = cache.plan(cacheInput());
    cache.plan(cacheInput());
    expect(counting.calls).toBe(2);
    expect(afterReset).toHaveLength(conceptNodes.length);
  });

  test("wobble offsets never reach the planner, so lanes and anchors stay put", () => {
    const counting = countingPlanner();
    const cache = createVoiceTraceLabelPlanCache(counting.planner);

    // Two different frame times produce two different wobble offsets. The cache
    // input carries only the STABLE points, so both frames share one plan.
    const frameOne = cache.plan(cacheInput({ items: planItems() }));
    const frameTwo = cache.plan(cacheInput({ items: planItems() }));
    expect(frameTwo).toBe(frameOne);
    expect(counting.calls).toBe(1);

    // Had the wobbled points been the cache input, the lane/row assignment would
    // have been replanned — and could have flipped — on every frame.
    const wobbled = cache.plan(cacheInput({ items: planItems(2.9, -2.1) }));
    expect(wobbled).toBe(frameOne);
    expect(counting.calls).toBe(1);
  });
});

/** A recording 2D context: every draw call the component makes, in order. */
type FakeContextCall = { op: string; args: unknown[] };

type FakeCanvasContext = {
  calls: FakeContextCall[];
  fillTexts: Array<{ text: string; x: number; y: number }>;
  moveTos: Array<{ x: number; y: number }>;
};

function createFakeContext(): { ctx: CanvasRenderingContext2D; record: FakeCanvasContext } {
  const record: FakeCanvasContext = { calls: [], fillTexts: [], moveTos: [] };
  const gradient = {
    addColorStop() {},
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, property) {
      if (property === "__record") return record;
      if (typeof property !== "string") return undefined;
      if (property === "canvas") return undefined;
      if (property in target) return target[property];
      const fn = (...args: unknown[]) => {
        record.calls.push({ args, op: property });
        if (property === "fillText") {
          record.fillTexts.push({
            text: String(args[0]),
            x: Number(args[1]),
            y: Number(args[2]),
          });
        }
        if (property === "moveTo") {
          record.moveTos.push({ x: Number(args[0]), y: Number(args[1]) });
        }
        if (property === "createRadialGradient" || property === "createLinearGradient") {
          return gradient;
        }
        return undefined;
      };
      target[property] = fn;
      return fn;
    },
    set(target, property, value) {
      if (typeof property === "string") target[property] = value;
      return true;
    },
  };
  return {
    ctx: new Proxy({} as Record<string, unknown>, handler) as unknown as CanvasRenderingContext2D,
    record,
  };
}

type MediaState = { reducedMotion: boolean; reducedTransparency: boolean };

type Harness = {
  backingStore(): { width: number; height: number };
  context: FakeCanvasContext;
  drainFrames(count: number, stepMs: number): void;
  drawCount(): number;
  effectsListenerCount(): number;
  mediaListenerCount(): number;
  mount(node: ReactElement): void;
  rerender(node: ReactElement): void;
  resizeTo(width: number, height: number): void;
  setMedia(next: Partial<MediaState>): void;
  trace(): HTMLElement;
  unmount(): void;
  visibilityListenerCount(): number;
  resizeObserverCount(): number;
  pendingFrameCount(): number;
  pendingTimeoutCount(): number;
};

type SavedProperty = { host: object; name: string; descriptor: PropertyDescriptor | undefined };

const savedProperties: SavedProperty[] = [];

function overrideGlobal(name: string, value: unknown, host: object = globalThis): void {
  savedProperties.push({ descriptor: Object.getOwnPropertyDescriptor(host, name), host, name });
  Object.defineProperty(host, name, { configurable: true, value, writable: true });
}

function createHarness(options?: {
  hardwareConcurrency?: number | null;
  media?: Partial<MediaState>;
  saveData?: boolean;
  size?: { width: number; height: number };
}): Harness {
  const media: MediaState = {
    reducedMotion: options?.media?.reducedMotion ?? false,
    reducedTransparency: options?.media?.reducedTransparency ?? false,
  };
  const size = { height: options?.size?.height ?? 360, width: options?.size?.width ?? 720 };
  const mediaListeners = new Map<string, Set<() => void>>();
  const { ctx, record } = createFakeContext();

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

  overrideGlobal("devicePixelRatio", 3, window);
  overrideGlobal("hardwareConcurrency", options?.hardwareConcurrency ?? 8, navigator);
  if (options?.saveData !== undefined) {
    overrideGlobal("connection", { saveData: options.saveData }, navigator);
  }

  overrideGlobal(
    "getBoundingClientRect",
    function boundingRect(this: Element) {
      if ((this as HTMLElement).classList?.contains("voice-trace")) {
        return {
          bottom: size.height,
          height: size.height,
          left: 0,
          right: size.width,
          top: 0,
          width: size.width,
          x: 0,
          y: 0,
        } as DOMRect;
      }
      return {
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
      } as DOMRect;
    },
    Element.prototype,
  );

  overrideGlobal(
    "getContext",
    function getContext(this: HTMLCanvasElement, kind: string) {
      return kind === "2d" ? ctx : null;
    },
    HTMLCanvasElement.prototype,
  );

  // Only `now` is faked: React's dev build calls `performance.mark`/`measure`
  // during rendering, so the rest of the real timing API must still be there.
  let now = 0;
  const realPerformance = globalThis.performance;
  overrideGlobal(
    "performance",
    new Proxy(realPerformance, {
      get(target, property) {
        if (property === "now") return () => now;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    globalThis,
  );

  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameHandle = 1;
  overrideGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => {
      const handle = nextFrameHandle++;
      frames.set(handle, callback);
      return handle;
    },
    globalThis,
  );
  overrideGlobal(
    "cancelAnimationFrame",
    (handle: number) => {
      frames.delete(handle);
    },
    globalThis,
  );

  const timeouts = new Map<number, () => void>();
  let nextTimeoutHandle = 1;
  overrideGlobal(
    "setTimeout",
    (callback: () => void) => {
      const handle = nextTimeoutHandle++;
      timeouts.set(handle, callback);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    globalThis,
  );
  overrideGlobal(
    "clearTimeout",
    (handle: number) => {
      timeouts.delete(handle);
    },
    globalThis,
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

  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = null;

  function flushTimeouts() {
    const pending = [...timeouts.entries()];
    timeouts.clear();
    for (const [, callback] of pending) callback();
  }

  return {
    backingStore() {
      const canvas = container.querySelector("canvas");
      if (!canvas) throw new Error("voice-trace canvas is not mounted");
      return {
        height: Number(canvas.getAttribute("height")),
        width: Number(canvas.getAttribute("width")),
      };
    },
    context: record,
    drainFrames(count: number, stepMs: number) {
      act(() => {
        for (let index = 0; index < count; index++) {
          now += stepMs;
          const pending = [...frames.entries()];
          frames.clear();
          for (const [, callback] of pending) callback(now);
        }
      });
    },
    drawCount() {
      return record.calls.filter((call) => call.op === "clearRect").length;
    },
    effectsListenerCount() {
      return windowListeners.get(VIVA_EFFECTS_CHANGE_EVENT)?.size ?? 0;
    },
    mediaListenerCount() {
      let total = 0;
      for (const listeners of mediaListeners.values()) total += listeners.size;
      return total;
    },
    mount(node) {
      act(() => {
        root = createRoot(container);
        root.render(node);
      });
      act(() => {
        flushTimeouts();
      });
    },
    pendingFrameCount() {
      return frames.size;
    },
    pendingTimeoutCount() {
      return timeouts.size;
    },
    rerender(node) {
      act(() => {
        root?.render(node);
      });
      act(() => {
        flushTimeouts();
      });
    },
    resizeObserverCount() {
      return resizeObservers.size;
    },
    resizeTo(width, height) {
      size.width = width;
      size.height = height;
      act(() => {
        for (const observer of resizeObservers) observer.callback();
      });
      act(() => {
        flushTimeouts();
      });
    },
    setMedia(next) {
      Object.assign(media, next);
      act(() => {
        for (const listeners of mediaListeners.values()) {
          for (const listener of listeners) listener();
        }
      });
      act(() => {
        flushTimeouts();
      });
    },
    trace() {
      const element = container.querySelector<HTMLElement>(".voice-trace");
      if (!element) throw new Error("voice-trace host is not mounted");
      return element;
    },
    unmount() {
      act(() => {
        root?.unmount();
        root = null;
      });
      container.remove();
    },
    visibilityListenerCount() {
      return documentListeners.get("visibilitychange")?.size ?? 0;
    },
  };
}

function restoreGlobals(): void {
  // Reverse order so a property overridden twice returns to its original value.
  for (let index = savedProperties.length - 1; index >= 0; index--) {
    const saved = savedProperties[index];
    if (saved.descriptor) Object.defineProperty(saved.host, saved.name, saved.descriptor);
    else Reflect.deleteProperty(saved.host, saved.name);
  }
  savedProperties.length = 0;
}

describe("VoiceTraceCanvas effects budget", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    restoreGlobals();
    window.localStorage.clear();
  });

  test("publishes the full-mode policy the shared resolver returns for voice_trace", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);

    const expected = resolveVivaEffectsPolicy({
      canvasRole: "voice_trace",
      devicePixelRatio: 3,
      explicitPreference: null,
      hardwareConcurrency: 8,
      prefersReducedMotion: false,
      prefersReducedTransparency: false,
      saveData: false,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    } satisfies VivaEffectsPolicyInput);

    expect(expected.mode).toBe("full");
    const trace = harness.trace();
    expect(trace.getAttribute("data-viva-effects")).toBe("full");
    expect(trace.getAttribute("data-render-mode")).toBe("animated");
    expect(trace.getAttribute("data-fps-budget")).toBe("32");
    expect(trace.getAttribute("data-dpr-cap")).toBe("2");
    // The published cap is the cap the backing store actually uses: this device
    // reports DPR 3, so a full-policy canvas is sized at the 2x ceiling.
    expect(harness.backingStore()).toEqual({ height: 720, width: 1440 });
  });

  test("publishes the reduced-mode policy for known low-end concurrency", () => {
    harness = createHarness({ hardwareConcurrency: 2 });
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);

    const trace = harness.trace();
    expect(trace.getAttribute("data-viva-effects")).toBe("reduced");
    expect(trace.getAttribute("data-render-mode")).toBe("animated");
    expect(trace.getAttribute("data-fps-budget")).toBe("24");
    expect(trace.getAttribute("data-dpr-cap")).toBe("1.5");
    expect(harness.backingStore()).toEqual({ height: 540, width: 1080 });
  });

  test("publishes the static policy under reduced motion and paints one readable frame", () => {
    harness = createHarness({ media: { reducedMotion: true } });
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);

    const trace = harness.trace();
    expect(trace.getAttribute("data-viva-effects")).toBe("static");
    expect(trace.getAttribute("data-render-mode")).toBe("static");
    expect(trace.getAttribute("data-fps-budget")).toBe("0");
    expect(trace.getAttribute("data-dpr-cap")).toBe("1.5");
    expect(harness.backingStore()).toEqual({ height: 540, width: 1080 });

    const afterMount = harness.drawCount();
    expect(afterMount).toBe(1);
    expect(harness.pendingFrameCount()).toBe(0);

    harness.drainFrames(16, 33);
    expect(harness.drawCount()).toBe(afterMount);

    harness.resizeTo(900, 420);
    expect(harness.drawCount()).toBe(afterMount + 1);
    expect(harness.pendingFrameCount()).toBe(0);
  });

  test("caps drawing at the full-mode 32 fps budget", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    const baseline = harness.drawCount();

    // 64 rAF callbacks spread across two seconds.
    harness.drainFrames(64, 2000 / 64);

    const drawn = harness.drawCount() - baseline;
    expect(drawn).toBeGreaterThanOrEqual(60);
    expect(drawn).toBeLessThanOrEqual(66);
  });

  test("caps drawing at the reduced-mode 24 fps budget", () => {
    harness = createHarness({ hardwareConcurrency: 2 });
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    const baseline = harness.drawCount();

    harness.drainFrames(64, 2000 / 64);

    const drawn = harness.drawCount() - baseline;
    expect(drawn).toBeGreaterThanOrEqual(44);
    expect(drawn).toBeLessThanOrEqual(50);
  });

  test("recomputes the policy once per imported effects-change event", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    expect(harness.trace().getAttribute("data-viva-effects")).toBe("full");
    expect(harness.effectsListenerCount()).toBe(1);

    window.localStorage.setItem(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY, "reduced");
    act(() => {
      window.dispatchEvent(new Event(VIVA_EFFECTS_CHANGE_EVENT));
    });

    const trace = harness.trace();
    expect(trace.getAttribute("data-viva-effects")).toBe("static");
    expect(trace.getAttribute("data-fps-budget")).toBe("0");
    expect(harness.pendingFrameCount()).toBe(0);
    expect(harness.effectsListenerCount()).toBe(1);
  });

  test("a media policy change rebuilds without starting a second animation loop", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    expect(harness.pendingFrameCount()).toBe(1);

    harness.setMedia({ reducedTransparency: true });
    expect(harness.trace().getAttribute("data-viva-effects")).toBe("static");
    expect(harness.pendingFrameCount()).toBe(0);

    harness.setMedia({ reducedTransparency: false });
    expect(harness.trace().getAttribute("data-viva-effects")).toBe("full");
    expect(harness.pendingFrameCount()).toBe(1);
  });

  test("unmount releases every listener, observer, frame, and timer", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    expect(harness.effectsListenerCount()).toBe(1);
    expect(harness.mediaListenerCount()).toBeGreaterThanOrEqual(1);
    expect(harness.visibilityListenerCount()).toBe(1);
    expect(harness.resizeObserverCount()).toBe(1);

    harness.unmount();

    expect(harness.effectsListenerCount()).toBe(0);
    expect(harness.mediaListenerCount()).toBe(0);
    expect(harness.visibilityListenerCount()).toBe(0);
    expect(harness.resizeObserverCount()).toBe(0);
    expect(harness.pendingFrameCount()).toBe(0);
    expect(harness.pendingTimeoutCount()).toBe(0);
    harness = null;
  });
});

describe("VoiceTraceCanvas label planning inside the frame budget", () => {
  let harness: Harness | null = null;

  afterEach(() => {
    harness?.unmount();
    harness = null;
    restoreGlobals();
    window.localStorage.clear();
  });

  test("120 steady frames draw every concept label from one cached plan", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    const plannedAtMount = voiceTraceLabelPlanComputations();

    harness.drainFrames(120, 1000 / 32);

    // The whole point of `WEBSESSION-CANVAS-01`: 120 animation frames solve the
    // label layout ZERO extra times.
    expect(voiceTraceLabelPlanComputations() - plannedAtMount).toBe(0);

    // Concept labels only: the drifting particle glyphs are one- and two-glyph
    // strings drawn from the same `fillText` surface and are not label draws.
    const conceptDraws = harness.context.fillTexts.filter((entry) =>
      conceptNodes.some((node) => isDrawOfLabel(entry.text, node.label)),
    );
    for (const node of conceptNodes) {
      expect(
        `${node.label}:${conceptDraws.some((entry) => isDrawOfLabel(entry.text, node.label))}`,
      ).toBe(`${node.label}:true`);
    }

    // Every drawn frame re-uses the same lane assignment: a label's y positions
    // across frames vary only by the small per-frame wobble (|dy| <= 2.4), never
    // by a lane flip, which moves a label by a whole row.
    const byLabel = new Map<string, number[]>();
    for (const entry of conceptDraws) {
      const bucket = byLabel.get(entry.text) ?? [];
      bucket.push(entry.y);
      byLabel.set(entry.text, bucket);
    }
    expect(byLabel.size).toBe(conceptNodes.length);
    for (const [text, ys] of byLabel) {
      expect(ys.length).toBeGreaterThan(100);
      const spread = Math.max(...ys) - Math.min(...ys);
      expect(`${text}:${spread <= 6}`).toBe(`${text}:true`);
    }
  });

  test("a new concept-node array with the same concepts does not replan", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    harness.drainFrames(8, 1000 / 32);
    const drawsBefore = harness.drawCount();
    const plannedBefore = voiceTraceLabelPlanComputations();

    harness.rerender(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    harness.drainFrames(8, 1000 / 32);

    // A pure identity change is not a semantic change: no extra synchronous
    // repaint, and no extra layout solve.
    expect(harness.drawCount()).toBeGreaterThan(drawsBefore);
    expect(voiceTraceLabelPlanComputations() - plannedBefore).toBe(0);
  });

  test("a resize replans exactly once", () => {
    harness = createHarness();
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    harness.drainFrames(8, 1000 / 32);
    const plannedBefore = voiceTraceLabelPlanComputations();

    harness.resizeTo(900, 420);
    harness.drainFrames(8, 1000 / 32);

    expect(voiceTraceLabelPlanComputations() - plannedBefore).toBe(1);
  });

  test("a semantic concept change repaints and replans once, even in static mode", () => {
    harness = createHarness({ media: { reducedMotion: true } });
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    const drawsBefore = harness.drawCount();
    const plannedBefore = voiceTraceLabelPlanComputations();

    harness.rerender(
      <VoiceTraceCanvas
        conceptNodes={[
          ...conceptNodes,
          { id: "c-8", label: "Fugacity", status: "review", emphasis: 0.5 },
        ]}
        state="listening"
      />,
    );

    expect(harness.drawCount()).toBe(drawsBefore + 1);
    expect(voiceTraceLabelPlanComputations() - plannedBefore).toBe(1);
    const drawn = harness.context.fillTexts.map((entry) => entry.text);
    expect(drawn.some((text) => isDrawOfLabel(text, "Fugacity"))).toBe(true);
  });

  test("a concept change that only moves the id/label boundary still replans", () => {
    harness = createHarness({ media: { reducedMotion: true } });
    harness.mount(<VoiceTraceCanvas conceptNodes={[...conceptNodes]} state="listening" />);
    const drawsBefore = harness.drawCount();
    const plannedBefore = voiceTraceLabelPlanComputations();
    const textsBefore = harness.context.fillTexts.length;

    // `c-1` + `Enthalpy` and `c-1E` + `nthalpy` are DIFFERENT concept sets whose
    // parts run together into the same characters. A set identity that just
    // concatenates the parts cannot tell them apart, so the generation never
    // bumps, the label plan is never invalidated, and the canvas keeps drawing
    // the previous set's lanes and label text.
    harness.rerender(<VoiceTraceCanvas conceptNodes={boundaryShifted()} state="listening" />);

    expect(harness.drawCount()).toBe(drawsBefore + 1);
    expect(voiceTraceLabelPlanComputations() - plannedBefore).toBe(1);
    const repainted = harness.context.fillTexts.slice(textsBefore).map((entry) => entry.text);
    expect(repainted.some((text) => isDrawOfLabel(text, "nthalpy"))).toBe(true);
    expect(repainted.some((text) => isDrawOfLabel(text, "Enthalpy"))).toBe(false);
  });
});
