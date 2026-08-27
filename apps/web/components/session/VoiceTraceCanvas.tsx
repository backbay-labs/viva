"use client";

import { useEffect, useRef, useState } from "react";
import {
  readVivaEffectsPreference,
  resolveVivaEffectsPolicy,
  VIVA_EFFECTS_CHANGE_EVENT,
  type VivaEffectsPolicy,
} from "../../lib/viva-effects";
import type { VivaSceneState } from "../../lib/viva-scene-reducer";
import { conceptStatusColor } from "../../lib/viva-session-projection";
import type { ConceptNode, SessionState } from "./session-data";

/**
 * The living manuscript trace — Viva's signature session instrument. It reads as
 * a biochemical pathway, a voice waveform, and a page of source notes coming
 * alive, all at once: concept nodes laid out left→right (NADH → electron
 * transport chain → proton gradient → ATP synthase), elegant curved manuscript
 * lines threaded through them, tiny glyph particles drifting along the lines, a
 * scatter of source fragments, and a soft central listening bloom.
 *
 * It choreographs the four session states by easing a set of params toward
 * per-state targets so transitions feel generative, not switched:
 *   listening   — lines ripple, particles drift, the bloom pulses
 *   thinking    — particles slow, the key concept nodes gather and brighten
 *   correction  — the missing concepts (proton gradient, ATP synthase) glow ochre
 *                 and a gold pathway lights ETC → proton gradient → synthase, with
 *                 a faint connector reaching toward the right margin
 *   source      — motion calms and "Lecture 5 · Slide 18" anchors and glows
 *
 * Canvas (not SVG) for precise particle-along-path motion + lerped state easing.
 * DPR-aware, ~32fps, paints one frame synchronously (visible before the first
 * rAF / while backgrounded), pauses when hidden, draws a single static frame
 * under prefers-reduced-motion, and cleans up on unmount.
 */
type RGB = { r: number; g: number; b: number };
type Vec = { x: number; y: number };

const INK: RGB = { r: 36, g: 24, b: 47 };
const LAV: RGB = { r: 129, g: 84, b: 189 };
const PALE_LAV: RGB = { r: 181, g: 150, b: 218 };
const GOLD: RGB = { r: 214, g: 168, b: 95 };
const OCHRE: RGB = { r: 200, g: 139, b: 72 };
const GRAY: RGB = { r: 90, g: 78, b: 98 };

// Curved manuscript lines (normalised). Endpoints run off-canvas for flow.
// Concept nodes are no longer hardcoded — they are the session's real concepts,
// placed along the main line and coloured by live mastery (see draw()).
const MAIN_SEQ: Vec[] = [
  { x: -0.06, y: 0.5 },
  { x: 0.12, y: 0.42 },
  { x: 0.26, y: 0.28 },
  { x: 0.47, y: 0.55 },
  { x: 0.65, y: 0.39 },
  { x: 0.83, y: 0.55 },
  { x: 0.96, y: 0.62 },
  { x: 1.06, y: 0.66 },
];
const GOLD_SEQ: Vec[] = MAIN_SEQ.map((p) => ({ x: p.x, y: p.y + 0.07 }));
const SOURCE_SEQ: Vec[] = [
  { x: -0.06, y: 0.74 },
  { x: 0.22, y: 0.8 },
  { x: 0.46, y: 0.71 },
  { x: 0.7, y: 0.82 },
  { x: 0.95, y: 0.73 },
  { x: 1.06, y: 0.78 },
];
const BG_SEQ: Vec[] = [
  { x: -0.06, y: 0.5 },
  { x: 0.25, y: 0.46 },
  { x: 0.5, y: 0.53 },
  { x: 0.75, y: 0.47 },
  { x: 1.06, y: 0.51 },
];
const PARTICLE_GLYPHS = ["+", "·", "→", "e⁻", "·", "·", "H⁺"];

type Params = {
  flow: number;
  gather: number;
  warm: number;
  source: number;
  calm: number;
  marker: number;
  highlight: number;
  connector: number;
};

const TARGETS: Record<SessionState, Params> = {
  listening: {
    flow: 1,
    gather: 0.25,
    warm: 0,
    source: 0.25,
    calm: 0,
    marker: 1,
    highlight: 0,
    connector: 0,
  },
  thinking: {
    flow: 0.6,
    gather: 1,
    warm: 0,
    source: 0.35,
    calm: 0.12,
    marker: 0.7,
    highlight: 0,
    connector: 0,
  },
  correction: {
    flow: 0.42,
    gather: 0.9,
    warm: 1,
    source: 0.45,
    calm: 0.22,
    marker: 0.45,
    highlight: 1,
    connector: 1,
  },
  source: {
    flow: 0.22,
    gather: 0.6,
    warm: 0.5,
    source: 1,
    calm: 0.55,
    marker: 0.3,
    highlight: 0.4,
    connector: 0.2,
  },
  recap: {
    flow: 0.14,
    gather: 0.72,
    warm: 0.34,
    source: 0.86,
    calm: 0.72,
    marker: 0.22,
    highlight: 0.64,
    connector: 0.12,
  },
};

type Particle = {
  poly: Vec[];
  t: number;
  speed: number;
  size: number;
  glyph: string | null;
  warm: boolean;
};

function rgba(c: RGB, a: number) {
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function mix(a: RGB, b: RGB, m: number): RGB {
  return { r: a.r + (b.r - a.r) * m, g: a.g + (b.g - a.g) * m, b: a.b + (b.b - a.b) * m };
}

function catmull(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function buildPoly(pts: Vec[], perSegment: number): Vec[] {
  const out: Vec[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    for (let j = 0; j < perSegment; j++) out.push(catmull(p0, p1, p2, p3, j / perSegment));
  }
  out.push(pts[n - 1]);
  return out;
}

function polyAt(poly: Vec[], t: number): Vec {
  const f = (t - Math.floor(t)) * (poly.length - 1);
  const i = Math.floor(f);
  const frac = f - i;
  const a = poly[i];
  const b = poly[Math.min(poly.length - 1, i + 1)];
  return { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac };
}

/** Live voice amplitude (0..1) the bloom breathes to — student vs examiner. */
export type VoiceTraceLevel = { user: number; agent: number };
/** A stable ref the parent mutates ~50×/s; read in the rAF loop, never via React state. */
export type VoiceTraceLevelRef = { current: VoiceTraceLevel | null };

const TEXT_MODE_BLOOM_FLOOR = 0.34;

export function voiceTraceBloomPulse({
  textMode,
  time,
  voice,
}: {
  textMode: boolean;
  time: number;
  voice: number;
}): number {
  return textMode
    ? TEXT_MODE_BLOOM_FLOOR
    : Math.max(TEXT_MODE_BLOOM_FLOOR + 0.1 * Math.sin(time * 1.7), voice);
}

type LabelBox = { left: number; right: number; top: number; bottom: number };

export type VoiceTraceConceptLabelPlan = {
  box: LabelBox;
  fontSize: number;
  hidden: false;
  label: string;
  leaderLine: { from: Vec; to: Vec } | null;
  maxWidth: number;
  text: string;
  textAlign: CanvasTextAlign;
  x: number;
  y: number;
};

export function voiceTraceConceptDensity(conceptCount: number): "sparse" | "roomy" | "dense" {
  if (conceptCount >= 7) return "dense";
  if (conceptCount >= 5) return "roomy";
  return "sparse";
}

let labelPlanComputations = 0;

/**
 * How many concept-label layouts this module has solved since it was loaded.
 *
 * `WEBSESSION-CANVAS-01` makes label planning a cost paid per *data* change, not
 * per animation frame — a claim about work done, which no assertion about the
 * painted output can see. This monotonic counter is that claim's observable, so
 * the guarantee is provable from outside the module instead of by reading its
 * source. It is the only reason the counter exists; nothing branches on it.
 */
export function voiceTraceLabelPlanComputations(): number {
  return labelPlanComputations;
}

export function planVoiceTraceConceptLabels({
  canvasHeight,
  canvasWidth,
  fontScale = 1,
  items,
}: {
  canvasHeight: number;
  canvasWidth: number;
  fontScale?: number;
  items: Array<{ emphasis: number; label: string; point: Vec }>;
}): VoiceTraceConceptLabelPlan[] {
  labelPlanComputations += 1;
  if (canvasWidth <= 0 || canvasHeight <= 0) return [];

  const padding = canvasWidth < 520 ? 8 : 12;
  const maxWidth = Math.max(
    54,
    Math.min(canvasWidth < 520 ? 94 : canvasWidth < 760 ? 112 : 142, canvasWidth - padding * 2),
  );
  const laneOffsets = conceptLabelLaneOffsets(canvasWidth);
  const placed: LabelBox[] = [];

  return items.map((item, index) => {
    const fontSize = Math.round((14 + (item.emphasis >= 1 ? 2.5 : 0)) * fontScale);
    const labelHeight = Math.max(15, fontSize * 1.35);
    const text = compactConceptLabel(item.label, maxWidth, fontSize);
    const textWidth = Math.min(maxWidth, estimateConceptLabelWidth(text, fontSize));
    const rowCandidates = orderedUniqueNumbers(
      [
        ...laneOffsets.map((_, laneIndex) => {
          const offset = laneOffsets[(laneIndex + index) % laneOffsets.length];
          return item.point.y + offset;
        }),
        ...conceptLabelRowCandidates(canvasHeight, labelHeight, padding),
      ].map((y) => clamp(y, padding + labelHeight / 2, canvasHeight - padding - labelHeight / 2)),
    );
    const xCandidates = orderedUniqueNumbers(
      conceptLabelXCandidates(item.point.x, textWidth, canvasWidth, padding),
    );

    let best: { box: LabelBox; overlap: number; offset: number; x: number; y: number } | null =
      null;
    for (const y of rowCandidates) {
      for (const x of xCandidates) {
        const box = labelBox(x, y, textWidth, labelHeight);
        const overlap = placed.reduce(
          (total, other) => total + overlapArea(inflate(box, 2), other),
          0,
        );
        const offset = Math.abs(y - item.point.y) + Math.abs(x - item.point.x) * 0.55;
        const score = overlap * 1000 + offset;
        if (!best || score < best.overlap * 1000 + best.offset) {
          best = { box, overlap, offset, x, y };
        }
        if (overlap === 0) break;
      }
      if (best?.overlap === 0) break;
    }

    const label = best ?? {
      box: labelBox(item.point.x, item.point.y, textWidth, labelHeight),
      overlap: 0,
      offset: 0,
      x: item.point.x,
      y: item.point.y,
    };
    placed.push(label.box);
    const lineTargetY = label.y < item.point.y ? label.box.bottom + 1.5 : label.box.top - 1.5;

    return {
      box: label.box,
      fontSize,
      hidden: false,
      label: item.label,
      leaderLine:
        Math.abs(label.y - item.point.y) > labelHeight * 0.72
          ? {
              from: item.point,
              to: { x: label.x, y: lineTargetY },
            }
          : null,
      maxWidth,
      text,
      textAlign: "center",
      x: label.x,
      y: label.y,
    };
  });
}

/**
 * The cache key of one concept-label layout: the *semantic* inputs only.
 *
 * `items` carries the STABLE node anchors — `nodePos * canvas size` — and is
 * deliberately absent from the key. Per-frame wobble is a drawing offset, not a
 * layout input; feeding it back into the planner is what made lanes re-solve
 * (and occasionally flip) 32 times a second. `conceptGeneration` is the caller's
 * promise that the concept set itself changed.
 */
export type VoiceTraceLabelPlanCacheInput = Readonly<{
  conceptGeneration: number;
  canvasHeight: number;
  canvasWidth: number;
  fontScale: number;
  items: Parameters<typeof planVoiceTraceConceptLabels>[0]["items"];
}>;

export type VoiceTraceLabelPlanCache = Readonly<{
  plan(input: VoiceTraceLabelPlanCacheInput): ReturnType<typeof planVoiceTraceConceptLabels>;
  reset(): void;
}>;

/**
 * Memoizes `planVoiceTraceConceptLabels` on generation/size/font-scale. A hit
 * returns the *same* plan array, so a steady animation neither recomputes the
 * lane solve nor allocates a new plan per frame. The planner is injectable so a
 * test can count calls without reading this module's source.
 */
export function createVoiceTraceLabelPlanCache(
  planner: typeof planVoiceTraceConceptLabels = planVoiceTraceConceptLabels,
): VoiceTraceLabelPlanCache {
  let key: string | null = null;
  let plan: VoiceTraceConceptLabelPlan[] = [];
  return {
    plan(input) {
      const nextKey = `${input.conceptGeneration}|${input.canvasWidth}|${input.canvasHeight}|${input.fontScale}`;
      if (key === nextKey) return plan;
      plan = planner({
        canvasHeight: input.canvasHeight,
        canvasWidth: input.canvasWidth,
        fontScale: input.fontScale,
        items: input.items,
      });
      key = nextKey;
      return plan;
    },
    reset() {
      key = null;
      plan = [];
    },
  };
}

function conceptLabelLaneOffsets(canvasWidth: number): number[] {
  if (canvasWidth < 520) return [-62, 42, -38, 66, 18, -82];
  if (canvasWidth < 760) return [-54, 40, -32, 62, 20, -78];
  return [-42, 42, -68, 68, 18, -88];
}

function conceptLabelRowCandidates(
  canvasHeight: number,
  labelHeight: number,
  padding: number,
): number[] {
  const min = padding + labelHeight / 2;
  const max = canvasHeight - padding - labelHeight / 2;
  if (max <= min) return [min];
  const step = Math.max(labelHeight + 3, 16);
  const rows: number[] = [];
  for (let y = min; y <= max; y += step) rows.push(y);
  if (rows[rows.length - 1] !== max) rows.push(max);
  return rows;
}

function conceptLabelXCandidates(
  anchorX: number,
  textWidth: number,
  canvasWidth: number,
  padding: number,
): number[] {
  const min = padding + textWidth / 2;
  const max = canvasWidth - padding - textWidth / 2;
  const shifts = [0, -textWidth * 0.5, textWidth * 0.5, -textWidth, textWidth];
  return shifts.map((shift) => clamp(anchorX + shift, min, max));
}

function orderedUniqueNumbers(values: number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (!out.some((existing) => Math.abs(existing - value) < 0.5)) out.push(value);
  }
  return out;
}

function estimateConceptLabelWidth(label: string, fontSize: number): number {
  let units = 0;
  for (const char of label) {
    if (char === " ") units += 0.28;
    else if (/[A-Z0-9]/.test(char)) units += 0.7;
    else if (/[+\-/·]/.test(char)) units += 0.46;
    else units += 0.5;
  }
  return Math.max(12, units * fontSize);
}

function compactConceptLabel(label: string, maxWidth: number, fontSize: number): string {
  const maxChars = Math.max(4, Math.floor(maxWidth / Math.max(1, fontSize * 0.5)));
  if (label.length <= maxChars) return label;
  return `${label.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function labelBox(x: number, y: number, width: number, height: number): LabelBox {
  return {
    bottom: y + height / 2,
    left: x - width / 2,
    right: x + width / 2,
    top: y - height / 2,
  };
}

function inflate(box: LabelBox, amount: number): LabelBox {
  return {
    bottom: box.bottom + amount,
    left: box.left - amount,
    right: box.right + amount,
    top: box.top - amount,
  };
}

function overlapArea(a: LabelBox, b: LabelBox): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/** `navigator.connection` is not in the DOM lib; only `saveData` is read. */
type SaveDataNavigator = Navigator & { connection?: { saveData?: boolean } };

function readSaveDataPreference(): boolean {
  return (navigator as SaveDataNavigator).connection?.saveData === true;
}

/**
 * Plan 13A owns the storage key and the fail-closed parse; this only guards the
 * `window.localStorage` *access*, which itself throws in some privacy modes.
 */
function readEffectsPreference(): "reduced" | null {
  try {
    return readVivaEffectsPreference(window.localStorage);
  } catch {
    return null;
  }
}

/**
 * Identity of the concept set as the label planner sees it: which concepts, in
 * what order, with what label, status, and emphasis tier (the planner's only
 * use of `emphasis` is its `>= 1` size bump).
 *
 * The parts are JSON-encoded rather than joined on a separator character, so
 * the encoding is INJECTIVE and visibly so: quoting and escaping keep id `a` +
 * label `bc` distinct from id `ab` + label `c` for every possible id and label,
 * including ones that themselves contain whatever character a hand-rolled join
 * would have picked. A collision would suppress the generation bump, leave the
 * label plan un-invalidated, and keep the canvas drawing the previous concept
 * set's lanes and label text.
 */
function conceptSetSignature(nodes: ConceptNode[] | undefined): string {
  return JSON.stringify(
    (nodes ?? []).map((node) => [node.id, node.label, node.status, node.emphasis >= 1 ? 1 : 0]),
  );
}

export function VoiceTraceCanvas({
  state,
  scene,
  highlightedTokens,
  conceptNodes,
  levelRef,
  textMode = false,
}: {
  state: SessionState;
  scene?: VivaSceneState;
  highlightedTokens?: string[];
  conceptNodes?: ConceptNode[];
  levelRef?: VoiceTraceLevelRef;
  textMode?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<SessionState>(state);
  const sceneRef = useRef<VivaSceneState | undefined>(scene);
  const textModeRef = useRef(textMode);
  const highlightRef = useRef<Set<string>>(new Set());
  const conceptNodesRef = useRef<ConceptNode[]>(conceptNodes ?? []);
  const conceptGenerationRef = useRef(0);
  const conceptSignatureRef = useRef<string | null>(null);
  const rebuildRef = useRef<(() => void) | null>(null);
  const levelRefHolder = useRef<VoiceTraceLevelRef | null>(levelRef ?? null);
  const [effectsPolicy, setEffectsPolicy] = useState<VivaEffectsPolicy | null>(null);
  levelRefHolder.current = levelRef ?? null;
  stateRef.current = state;
  sceneRef.current = scene;
  textModeRef.current = textMode;

  useEffect(() => {
    highlightRef.current = new Set(highlightedTokens ?? []);
  }, [highlightedTokens]);

  // Only a change to the *semantic* concept set invalidates a label plan: a new
  // array holding the same concepts is a React identity change, not a layout
  // change, and must not force a replan or a repaint.
  useEffect(() => {
    conceptNodesRef.current = conceptNodes ?? [];
    const signature = conceptSetSignature(conceptNodes);
    if (conceptSignatureRef.current === signature) return;
    conceptSignatureRef.current = signature;
    conceptGenerationRef.current += 1;
    rebuildRef.current?.();
  }, [conceptNodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cv = canvas;

    let cssW = 0;
    let cssH = 0;
    let raf = 0;
    let last = 0;
    let lastDrawAt = 0;
    let animating = false;
    let particles: Particle[] = [];
    const cur: Params = { ...TARGETS.listening };
    const labelCache = createVoiceTraceLabelPlanCache();
    const reduceMotionMQ = window.matchMedia(REDUCED_MOTION_QUERY);
    const reduceTransparencyMQ = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);

    /**
     * Plan 13A owns the effects table; this canvas only gathers its browser
     * inputs and consumes `mode`/`dprCap`/`fps`. There is deliberately no local
     * DPR or fps literal left to drift from it (`glyphCountScale` is not
     * consumed here — particle density stays a width decision).
     */
    function resolvePolicy(): VivaEffectsPolicy {
      return resolveVivaEffectsPolicy({
        canvasRole: "voice_trace",
        devicePixelRatio: window.devicePixelRatio || 1,
        explicitPreference: readEffectsPreference(),
        hardwareConcurrency:
          typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null,
        prefersReducedMotion: reduceMotionMQ.matches,
        prefersReducedTransparency: reduceTransparencyMQ.matches,
        saveData: readSaveDataPreference(),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      });
    }

    let policy = resolvePolicy();
    setEffectsPolicy(policy);

    const mainPoly = buildPoly(MAIN_SEQ, 26);
    const goldPoly = buildPoly(GOLD_SEQ, 26);
    const sourcePoly = buildPoly(SOURCE_SEQ, 24);
    const bgPoly = buildPoly(BG_SEQ, 24);

    function makeParticles() {
      const count = cssW < 520 ? 40 : 64;
      particles = [];
      for (let i = 0; i < count; i++) {
        const r = Math.random();
        const poly = r < 0.5 ? mainPoly : r < 0.78 ? goldPoly : sourcePoly;
        particles.push({
          poly,
          t: Math.random(),
          speed: 0.012 + Math.random() * 0.03,
          size: 0.8 + Math.random() * 1.5,
          glyph:
            Math.random() < 0.32
              ? PARTICLE_GLYPHS[(Math.random() * PARTICLE_GLYPHS.length) | 0]
              : null,
          warm: poly === goldPoly,
        });
      }
    }

    function resize() {
      const rect = host?.getBoundingClientRect();
      if (!rect) return;
      cssW = rect.width;
      cssH = rect.height;
      const dpr = Math.min(policy.dprCap, window.devicePixelRatio || 1);
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
      cv.style.width = `${cssW}px`;
      cv.style.height = `${cssH}px`;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function strokePoly(poly: Vec[], color: string, width: number, dash: number[], offset: number) {
      if (!ctx) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash(dash);
      ctx.lineDashOffset = offset;
      ctx.beginPath();
      ctx.moveTo(poly[0].x * cssW, poly[0].y * cssH);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * cssW, poly[i].y * cssH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function fontScale() {
      return Math.max(0.72, Math.min(1.2, cssW / 720));
    }

    function draw(t: number, dt: number) {
      if (!ctx) return;
      const target = TARGETS[stateRef.current] ?? TARGETS.listening;
      const k = Math.min(1, dt * 2.6);
      cur.flow += (target.flow - cur.flow) * k;
      cur.gather += (target.gather - cur.gather) * k;
      cur.warm += (target.warm - cur.warm) * k;
      cur.source += (target.source - cur.source) * k;
      cur.calm += (target.calm - cur.calm) * k;
      cur.marker += (target.marker - cur.marker) * k;
      cur.highlight += (target.highlight - cur.highlight) * k;
      cur.connector += (target.connector - cur.connector) * k;

      const hl = highlightRef.current;
      const sceneState = sceneRef.current;
      const sceneEntityWeights = new Map(
        (sceneState?.entities ?? []).map((entity) => [entity.id, entity.emphasisWeight]),
      );
      const sceneWeight = sceneState?.emphasisWeight ?? 0.25;
      const calm = 1 - cur.calm * 0.55;
      const fs = fontScale();
      const levels = levelRefHolder.current?.current;
      const textModeActive = textModeRef.current;
      const userLevel = textModeActive ? 0 : clamp01(levels?.user ?? 0);
      const agentLevel = textModeActive ? 0 : clamp01(levels?.agent ?? 0);
      const voice = textModeActive ? 0 : Math.max(userLevel, agentLevel);
      ctx.clearRect(0, 0, cssW, cssH);

      // concept pathway: the session's real concepts, placed along the main line
      const nodes = conceptNodesRef.current;
      const nodeCount = nodes.length;
      const nodePos = nodes.map((_node, i) => {
        const tt = nodeCount <= 1 ? 0.5 : 0.12 + 0.76 * (i / (nodeCount - 1));
        return polyAt(mainPoly, tt);
      });
      let focal = -1;
      let focalEmph = 0;
      for (let i = 0; i < nodeCount; i++) {
        if (nodes[i].emphasis > focalEmph) {
          focalEmph = nodes[i].emphasis;
          focal = i;
        }
      }

      // 1 — faint baseline + manuscript lines
      strokePoly(bgPoly, rgba(GRAY, 0.14 * calm), 1, [], 0);
      strokePoly(
        mainPoly,
        rgba(LAV, (0.2 + cur.gather * 0.12) * calm),
        1.4,
        [1, 7],
        -t * 16 * cur.flow,
      );
      strokePoly(goldPoly, rgba(GOLD, 0.18 * calm), 1.1, [1, 9], t * 12 * cur.flow);
      strokePoly(sourcePoly, rgba(PALE_LAV, 0.16 * calm), 1, [2, 8], -t * 9 * cur.flow);

      // correction — a faint connector from the focal concept toward the margin
      if (cur.connector > 0.02 && focal >= 0) {
        const fp = nodePos[focal];
        ctx.strokeStyle = rgba(OCHRE, 0.22 * cur.connector);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(fp.x * cssW, fp.y * cssH);
        ctx.lineTo(cssW, 0.42 * cssH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 2 — particles drifting along the lines
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const p of particles) {
        p.t = (p.t + p.speed * dt * cur.flow * (0.8 + 0.7 * voice)) % 1;
        const pos = polyAt(p.poly, p.t);
        const x = pos.x * cssW;
        const y = pos.y * cssH;
        if (x < -6 || x > cssW + 6) continue;
        const a = (p.glyph ? 0.3 : 0.42) * (0.6 + 0.4 * Math.sin(t * 1.4 + p.t * 9)) * calm;
        if (a < 0.03) continue;
        const color = mix(p.warm ? GOLD : LAV, OCHRE, p.warm ? cur.warm * 0.6 : 0);
        ctx.globalAlpha = a;
        if (p.glyph) {
          ctx.fillStyle = rgba(color, 1);
          ctx.font = `${Math.round(11 * fs)}px "Cormorant", Georgia, serif`;
          ctx.fillText(p.glyph, x, y);
        } else {
          ctx.fillStyle = rgba(color, 1);
          ctx.fillRect(x - p.size, y - p.size, p.size * 2, p.size * 2);
        }
      }
      ctx.globalAlpha = 1;

      // 3 — the Concept Mastery Field: the session's real concepts, each a dot on
      // the pathway coloured by its live mastery (sage strong / lavender review /
      // amber shaky / deep-ochre missed); dense labels use bounded lanes and
      // leader lines, never hidden concepts.
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // The planner sees the STABLE anchors only. Wobble is added to the plan's
      // output below, so a node, its leader line, and its label all drift by the
      // same delta while the lane solve stays put.
      const anchors = nodes.map((_node, i) => ({
        x: nodePos[i].x * cssW,
        y: nodePos[i].y * cssH,
      }));
      const nodeDrawState = nodes.map((node, i) => ({
        node,
        phase: i * 1.3,
        wobble: {
          x: Math.sin(t * 0.3 + i * 1.3) * 3,
          y: Math.cos(t * 0.24 + i * 1.3) * 2.4,
        },
      }));
      const labelPlans = currentLabelPlan(fs, anchors);
      for (let i = 0; i < nodeCount; i++) {
        const { node, phase, wobble } = nodeDrawState[i];
        const x = anchors[i].x + wobble.x;
        const y = anchors[i].y + wobble.y;
        const color = conceptStatusColor(node.status);
        const highlighted = hl.has(node.label);
        const sceneBoost = sceneEntityWeights.get(node.id) ?? 0;
        const emph = Math.min(
          1.2,
          node.emphasis * (0.55 + cur.gather * 0.45) + sceneBoost * 0.22 + (highlighted ? 0.3 : 0),
        );

        // status glow
        const glowR = 36 * fs;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        grad.addColorStop(0, rgba(color, 0.22 * Math.min(1, emph) * calm));
        grad.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2);
        ctx.fill();

        // node marker dot + breathing ring, sitting on the pathway
        ctx.globalAlpha = (0.55 + emph * 0.4) * calm;
        ctx.fillStyle = rgba(color, 1);
        ctx.beginPath();
        ctx.arc(x, y, 2.8 * fs, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = (0.26 + emph * 0.3) * calm;
        ctx.strokeStyle = rgba(color, 1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, (6 + Math.sin(t * 1.2 + phase) * 1.3) * fs, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // label — status-tinted ink, lane-planned to keep 7+ active concepts legible
        const labelPlan = labelPlans[i];
        const labelColor = mix(INK, color, 0.45 + node.emphasis * 0.3);
        const alpha = Math.min(0.88, (0.5 + emph * 0.34) * calm);
        if (labelPlan?.leaderLine) {
          ctx.strokeStyle = rgba(labelColor, 0.18 * alpha);
          ctx.lineWidth = 1;
          ctx.setLineDash([1.5, 4]);
          ctx.beginPath();
          ctx.moveTo(
            labelPlan.leaderLine.from.x + wobble.x,
            labelPlan.leaderLine.from.y + wobble.y,
          );
          ctx.lineTo(labelPlan.leaderLine.to.x + wobble.x, labelPlan.leaderLine.to.y + wobble.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.textAlign = labelPlan?.textAlign ?? "center";
        ctx.textBaseline = "middle";
        ctx.font = `${labelPlan?.fontSize ?? Math.round(14 * fs)}px "Cormorant", Georgia, serif`;
        ctx.fillStyle = rgba(labelColor, alpha);
        ctx.fillText(
          labelPlan?.text ?? node.label,
          labelPlan ? labelPlan.x + wobble.x : x,
          labelPlan ? labelPlan.y + wobble.y : y,
          labelPlan?.maxWidth,
        );
      }

      // 4 — gold check-glints lifting off the concepts while Viva is thinking
      for (let i = 0; i < nodeCount; i++) {
        const tw = 0.5 + 0.5 * Math.sin(t * 1.8 + i * 1.6);
        const a = cur.gather * tw * 0.45 * calm * nodes[i].emphasis;
        if (a < 0.04) continue;
        const x = nodePos[i].x * cssW;
        const y = nodePos[i].y * cssH - 12 * fs;
        const s = 4 * fs * (0.7 + tw * 0.5);
        ctx.strokeStyle = rgba(GOLD, a);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - s, y);
        ctx.lineTo(x + s, y);
        ctx.moveTo(x, y - s);
        ctx.lineTo(x, y + s);
        ctx.stroke();
      }

      // 5 — central listening bloom — breathes with the real voice: it swells to
      // the student's mic level (plum) and to the examiner's TTS level (gold),
      // with a gentle floor so silence still reads as attention. (Replaces the
      // old fake `0.5 + 0.5*sin(t)` pulse — the page now literally listens.)
      const bx = 0.5 * cssW;
      const by = 0.7 * cssH;
      const pulse = voiceTraceBloomPulse({ textMode: textModeActive, time: t, voice });
      const speaking = !textModeActive && agentLevel > userLevel + 0.02;
      const bloomColor = mix(speaking ? GOLD : LAV, OCHRE, cur.warm);
      const presence = Math.max(cur.marker, 0.45 + sceneWeight * 0.12);
      const ringR = (10 + pulse * 10) * fs * (0.7 + cur.marker * 0.4);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgba(bloomColor, (0.12 + 0.12 * voice) * presence * calm);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(bx, by, ringR, 0, Math.PI * 2);
      ctx.stroke();
      const coreR = (11 + voice * 6) * fs;
      const core = ctx.createRadialGradient(bx, by, 0, bx, by, coreR);
      core.addColorStop(0, rgba(bloomColor, (0.45 + 0.4 * voice) * presence * calm));
      core.addColorStop(1, rgba(bloomColor, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(bx, by, coreR, 0, Math.PI * 2);
      ctx.fill();
    }

    /**
     * The plan for the current generation/size/font scale, taken from the cache
     * rather than solved here: on a steady frame this is a key comparison, and
     * the returned array is the *same object* the previous frame drew from.
     */
    function currentLabelPlan(fontScale: number, anchors: Vec[]): VoiceTraceConceptLabelPlan[] {
      return labelCache.plan({
        canvasHeight: cssH,
        canvasWidth: cssW,
        conceptGeneration: conceptGenerationRef.current,
        fontScale,
        items: conceptNodesRef.current.map((node, i) => ({
          emphasis: node.emphasis,
          label: node.label,
          point: anchors[i],
        })),
      });
    }

    function loop(now: number) {
      if (!animating) return;
      raf = requestAnimationFrame(loop);
      const frame = policy.fps > 0 ? 1000 / policy.fps : 0;
      if (frame <= 0) return;
      if (now - last < frame) return;
      // Advance the budget clock by whole frames rather than snapping it to
      // `now`: snapping turns a 32 Hz display into 16 fps under a 24 fps budget,
      // because every second callback lands one budget short.
      last += frame * Math.floor((now - last) / frame);
      const dt = Math.min(0.1, (now - lastDrawAt) / 1000);
      lastDrawAt = now;
      draw(now / 1000, dt);
    }

    function startAnim() {
      if (animating || policy.fps <= 0) return;
      animating = true;
      last = performance.now();
      lastDrawAt = last;
      raf = requestAnimationFrame(loop);
    }

    function stopAnim() {
      animating = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function rebuild() {
      resize();
      makeParticles();
      draw(performance.now() / 1000, 0.016);
      if (policy.fps <= 0) stopAnim();
      else startAnim();
    }

    /**
     * One policy path for every signal that can change it — media query, stored
     * preference, viewport. A changed policy stops the current loop before
     * rebuilding, so a mode flip can never leave two animation loops running.
     */
    function applyPolicy() {
      const next = resolvePolicy();
      const changed =
        next.mode !== policy.mode ||
        next.fps !== policy.fps ||
        next.dprCap !== policy.dprCap ||
        next.glyphCountScale !== policy.glyphCountScale;
      policy = next;
      setEffectsPolicy((current) => (current && !changed ? current : next));
      if (!changed) return;
      stopAnim();
      labelCache.reset();
      rebuild();
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuild, 180);
    });
    ro.observe(host);

    const onVisibility = () => {
      if (document.hidden) stopAnim();
      else startAnim();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onPolicySignal = () => applyPolicy();
    reduceMotionMQ.addEventListener("change", onPolicySignal);
    reduceTransparencyMQ.addEventListener("change", onPolicySignal);
    window.addEventListener(VIVA_EFFECTS_CHANGE_EVENT, onPolicySignal);

    rebuildRef.current = rebuild;
    rebuild();

    return () => {
      rebuildRef.current = null;
      stopAnim();
      clearTimeout(resizeTimer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotionMQ.removeEventListener("change", onPolicySignal);
      reduceTransparencyMQ.removeEventListener("change", onPolicySignal);
      window.removeEventListener(VIVA_EFFECTS_CHANGE_EVENT, onPolicySignal);
    };
  }, []);

  const conceptCount = conceptNodes?.length ?? 0;

  return (
    <div
      aria-hidden="true"
      className="voice-trace"
      data-concept-count={conceptCount}
      data-concept-density={voiceTraceConceptDensity(conceptCount)}
      data-dpr-cap={effectsPolicy ? String(effectsPolicy.dprCap) : undefined}
      data-fps-budget={effectsPolicy ? String(effectsPolicy.fps) : undefined}
      data-render-mode={effectsPolicy ? (effectsPolicy.fps > 0 ? "animated" : "static") : undefined}
      data-scene-emphasis={scene?.emphasis ?? "quiet"}
      data-scene-entity-count={scene?.entities.length ?? 0}
      data-scene-register={scene?.register ?? "examining"}
      data-state={state}
      data-text-mode={textMode ? "true" : "false"}
      data-viva-effects={effectsPolicy?.mode}
    >
      <canvas className="voice-trace__canvas" ref={canvasRef} />
    </div>
  );
}
