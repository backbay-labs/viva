"use client";

import { useEffect, useRef } from "react";
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
  const levelRefHolder = useRef<VoiceTraceLevelRef | null>(levelRef ?? null);
  levelRefHolder.current = levelRef ?? null;
  stateRef.current = state;
  sceneRef.current = scene;
  textModeRef.current = textMode;

  useEffect(() => {
    highlightRef.current = new Set(highlightedTokens ?? []);
  }, [highlightedTokens]);

  useEffect(() => {
    conceptNodesRef.current = conceptNodes ?? [];
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
    let animating = false;
    let particles: Particle[] = [];
    const cur: Params = { ...TARGETS.listening };
    const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    const FRAME = 1000 / 32;

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
      const dpr = Math.min(2, window.devicePixelRatio || 1);
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
      // amber shaky / deep-ochre missed); labels stagger above/below the line.
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < nodeCount; i++) {
        const node = nodes[i];
        const phase = i * 1.3;
        const x = nodePos[i].x * cssW + Math.sin(t * 0.3 + phase) * 3;
        const y = nodePos[i].y * cssH + Math.cos(t * 0.24 + phase) * 2.4;
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

        // label — status-tinted ink, staggered above (even) / below (odd)
        const labelY = y + (i % 2 === 0 ? -20 : 22) * fs;
        const labelColor = mix(INK, color, 0.45 + node.emphasis * 0.3);
        const alpha = Math.min(0.88, (0.5 + emph * 0.34) * calm);
        const size = 14 + (node.emphasis >= 1 ? 2.5 : 0);
        ctx.font = `${Math.round(size * fs)}px "Cormorant", Georgia, serif`;
        ctx.fillStyle = rgba(labelColor, alpha);
        ctx.fillText(node.label, x, labelY);
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

    function loop(now: number) {
      if (!animating) return;
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      draw(now / 1000, dt);
    }

    function startAnim() {
      if (animating || reduceMQ.matches) return;
      animating = true;
      last = performance.now();
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
      if (reduceMQ.matches) stopAnim();
      else startAnim();
    }

    let resizeTimer: ReturnType<typeof setTimeout>;
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
    const onReduce = () => rebuild();
    reduceMQ.addEventListener("change", onReduce);

    rebuild();

    return () => {
      stopAnim();
      clearTimeout(resizeTimer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMQ.removeEventListener("change", onReduce);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="voice-trace"
      data-scene-emphasis={scene?.emphasis ?? "quiet"}
      data-scene-entity-count={scene?.entities.length ?? 0}
      data-scene-register={scene?.register ?? "examining"}
      data-text-mode={textMode ? "true" : "false"}
    >
      <canvas className="voice-trace__canvas" ref={canvasRef} />
    </div>
  );
}
