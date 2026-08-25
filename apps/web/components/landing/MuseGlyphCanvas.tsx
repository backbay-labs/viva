"use client";

import { useEffect, useRef } from "react";

/**
 * MuseGlyphCanvas — the "living manuscript" layer.
 *
 * A single <canvas> (not hundreds of DOM nodes) draws a field of tiny study
 * glyphs and formulas that breathe and drift over the static muse artwork. The
 * muse image itself is sampled as a density map: more particles land where the
 * artwork has ink/structure (hair, notes, face), so the moving text feels like
 * it belongs to her rather than floating at random. Copy stays readable because
 * particle density/opacity falls off softly behind the headline, command surface
 * and chips. Inspired by Prometheus — a figure made of many small moving glyphs —
 * translated into a warm, scholarly, parchment aesthetic.
 *
 * Performance: requestAnimationFrame throttled to ~32fps, devicePixelRatio-aware,
 * particle count scaled to viewport, paused on tab hide, rebuilt (debounced) on
 * resize, and reduced to a single static frame under prefers-reduced-motion.
 */
export type MuseGlyphState = "idle" | "focus" | "listening" | "thinking" | "correcting";

export type MuseGlyphCanvasProps = {
  state?: MuseGlyphState;
  highlightedTokens?: string[];
};

type RGB = { r: number; g: number; b: number };

/** Parses a `#rrggbb` literal. Only used as a last-resort fallback if a
 * design token somehow fails to resolve in the browser (see
 * `resolveTokenRgb` below) — never a second source of truth for a color a
 * token already names. */
function hexToRgb(hex: string): RGB {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

// Heavy on dots/operators so most of the field reads as faint marginalia.
const GLYPH_POOL = ["·", "·", "·", "+", "→", "∴", "§", "H⁺", "e⁻", "+"];
const TERM_POOL = [
  "ATP",
  "NADH",
  "Krebs cycle",
  "Lecture 5",
  "Slide 18",
  "proton gradient",
  "ATP synthase",
  "chemiosmosis",
  "ADP + Pi",
  "def.",
  "key process",
  "electron transport chain",
  "oxidative phosphorylation",
];
const LARGE_POOL = ["Photosynthesis", "Cellular respiration", "NADH", "Krebs cycle", "ATP"];

const STATE_ENERGY: Record<MuseGlyphState, number> = {
  idle: 0,
  focus: 1,
  listening: 1,
  thinking: 0.7,
  correcting: 0.85,
};

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  iw: number;
  ih: number;
  px: number;
  py: number;
};

type Glyph = {
  token: string;
  ax: number;
  ay: number;
  size: number;
  italic: boolean;
  colorKey: string;
  fontKey: string;
  baseAlpha: number;
  phase: number;
  speed: number;
  driftX: number;
  driftY: number;
  fadeSpeed: number;
  fadePhase: number;
  safe: number;
  near: number;
  large: boolean;
};

type Spark = {
  ax: number;
  ay: number;
  len: number;
  baseAlpha: number;
  phase: number;
  speed: number;
  twinkle: number;
  safe: number;
};

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function pick<T>(arr: readonly T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

function colorKey(c: RGB) {
  return `rgb(${c.r},${c.g},${c.b})`;
}

// Stable ordering so per-frame canvas font/colour state changes stay minimal.
function byFontThenColor(a: Glyph, b: Glyph): number {
  if (a.fontKey !== b.fontKey) return a.fontKey < b.fontKey ? -1 : 1;
  if (a.colorKey !== b.colorKey) return a.colorKey < b.colorKey ? -1 : 1;
  return 0;
}

export function MuseGlyphCanvas({ state = "idle", highlightedTokens }: MuseGlyphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<MuseGlyphState>(state);
  const highlightRef = useRef<Set<string>>(new Set());
  stateRef.current = state;

  useEffect(() => {
    highlightRef.current = new Set(highlightedTokens ?? []);
  }, [highlightedTokens]);

  useEffect(() => {
    const canvas = canvasRef.current;
    // canvas -> aria-hidden wrapper -> .viva-hero
    const hero = canvas?.parentElement?.parentElement;
    if (!canvas || !hero) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cv = canvas;

    // `FRONTEND-007`: resolve the field's colors from the real design
    // tokens (`packages/tokens/src/theme.css`, the one runtime token
    // authority) instead of a second hardcoded approximation of them.
    // Resolved once per mount, not per frame — style recalculation is
    // comparatively expensive, and these values never change over a
    // mount's lifetime. The hex fallbacks only cover a token somehow
    // failing to resolve; they are not a parallel palette to keep in sync.
    function resolveTokenRgb(customProperty: string, fallbackHex: string): RGB {
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.color = `var(${customProperty})`;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      const match = resolved.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return match
        ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
        : hexToRgb(fallbackHex);
    }
    // --viva-bg is the muse artwork's own parchment background, so
    // ink-density sampling (inkWeight, below) diffs against it. The other
    // four are the glyph/spark ink colors themselves.
    const PARCHMENT = resolveTokenRgb("--viva-bg", "#f6efe4");
    const PLUM = resolveTokenRgb("--viva-amethyst-deep", "#5d347f");
    const LAVENDER = resolveTokenRgb("--viva-lavender-strong", "#b38de5");
    const INK = resolveTokenRgb("--viva-ink-soft", "#4e4259");
    const GOLD = resolveTokenRgb("--viva-gold", "#d6a85f");

    let glyphs: Glyph[] = [];
    let sparks: Spark[] = [];
    let safeRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    let cmd = { x: 0, y: 0, r: 240 };
    let cssW = 0;
    let cssH = 0;
    let energy = 0;
    let raf = 0;
    let last = 0;
    let animating = false;
    let sampler: { data: Uint8ClampedArray; w: number; h: number } | null = null;
    let samplerReady = false;

    const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    const SAFE_MARGIN = 66;
    const FRAME = 1000 / 32;

    // --- muse density map (offscreen, same-origin so getImageData is allowed) ---
    const img = new Image();
    img.decoding = "async";

    function buildSampler() {
      if (samplerReady) return;
      const ow = 256;
      const oh = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * ow));
      const off = document.createElement("canvas");
      off.width = ow;
      off.height = oh;
      const octx = off.getContext("2d");
      if (octx) {
        octx.drawImage(img, 0, 0, ow, oh);
        try {
          sampler = { data: octx.getImageData(0, 0, ow, oh).data, w: ow, h: oh };
        } catch {
          sampler = null;
        }
      }
      samplerReady = true;
    }

    function handleImageReady() {
      buildSampler();
      rebuild();
    }

    img.onload = handleImageReady;
    img.onerror = () => {
      if (img.src.endsWith(".webp")) {
        img.src = "/viva-muse.png";
      } else {
        rebuild();
      }
    };
    img.src = "/viva-muse.webp";

    function inkWeight(u: number, v: number): number {
      if (!sampler) return 0.4;
      const px = Math.min(sampler.w - 1, Math.max(0, (u * sampler.w) | 0));
      const py = Math.min(sampler.h - 1, Math.max(0, (v * sampler.h) | 0));
      const i = (py * sampler.w + px) * 4;
      const r = sampler.data[i];
      const g = sampler.data[i + 1];
      const b = sampler.data[i + 2];
      const diff =
        Math.abs(r - PARCHMENT.r) + Math.abs(g - PARCHMENT.g) + Math.abs(b - PARCHMENT.b);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      return diff / 255 + sat / 255;
    }

    function museBox(): Box | null {
      const m = hero?.querySelector<HTMLImageElement>(".viva-muse__img");
      if (!m) return null;
      const cRect = cv.getBoundingClientRect();
      const r = m.getBoundingClientRect();
      // object-position matches the breakpoints in globals.css
      let px = 0.44;
      let py = 0.4;
      if (cssW <= 620) {
        px = 0.3;
        py = 0.22;
      } else if (cssW <= 900) {
        px = 0.3;
        py = 0.26;
      }
      return {
        x: r.left - cRect.left,
        y: r.top - cRect.top,
        w: r.width,
        h: r.height,
        iw: m.naturalWidth || 1672,
        ih: m.naturalHeight || 941,
        px,
        py,
      };
    }

    function mapUV(box: Box, sx: number, sy: number): { u: number; v: number } | null {
      const lx = sx - box.x;
      const ly = sy - box.y;
      if (lx < 0 || ly < 0 || lx > box.w || ly > box.h) return null;
      const scale = Math.max(box.w / box.iw, box.h / box.ih);
      const dw = box.iw * scale;
      const dh = box.ih * scale;
      const ox = (box.w - dw) * box.px;
      const oy = (box.h - dh) * box.py;
      const u = (lx - ox) / scale / box.iw;
      const v = (ly - oy) / scale / box.ih;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      return { u, v };
    }

    function measureSafe() {
      const cRect = cv.getBoundingClientRect();
      safeRects = [];
      for (const s of [".viva-context", ".viva-copy", ".viva-command", ".viva-hero__chips"]) {
        const el = hero?.querySelector(s);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        safeRects.push({ x: r.left - cRect.left, y: r.top - cRect.top, w: r.width, h: r.height });
      }
      const cmdEl = hero?.querySelector(".viva-command");
      if (cmdEl) {
        const r = cmdEl.getBoundingClientRect();
        cmd = {
          x: r.left - cRect.left + r.width / 2,
          y: r.top - cRect.top + r.height / 2,
          r: Math.max(r.width, r.height) * 0.85,
        };
      }
    }

    function safeFactor(x: number, y: number): number {
      let f = 1;
      for (const r of safeRects) {
        const dx = Math.max(r.x - x, x - (r.x + r.w), 0);
        const dy = Math.max(r.y - y, y - (r.y + r.h), 0);
        const d = Math.hypot(dx, dy);
        if (d < SAFE_MARGIN) {
          const local = 0.2 + 0.8 * (d / SAFE_MARGIN);
          if (local < f) f = local;
        }
      }
      return f;
    }

    function nearFactor(x: number, y: number): number {
      const d = Math.hypot(x - cmd.x, y - cmd.y);
      return Math.max(0, 1 - d / (cmd.r * 2.2));
    }

    function counts() {
      if (cssW <= 620) return { glyph: 240, spark: 10, large: 4 };
      if (cssW <= 900) return { glyph: 520, spark: 18, large: 6 };
      return { glyph: 880, spark: 26, large: 9 };
    }

    function glyphColorKey(): string {
      const r = Math.random();
      if (r < 0.4) return colorKey(PLUM);
      if (r < 0.74) return colorKey(LAVENDER);
      return colorKey(INK);
    }

    function createParticles() {
      glyphs = [];
      sparks = [];
      const box = museBox();
      if (!box) return;
      const c = counts();
      const largeScale = cssW <= 620 ? 0.7 : cssW <= 900 ? 0.85 : 1;

      let tries = 0;
      while (glyphs.length < c.glyph && tries++ < c.glyph * 30) {
        const sx = box.x + Math.random() * box.w;
        const sy = box.y + Math.random() * box.h;
        const uv = mapUV(box, sx, sy);
        if (!uv) continue;
        const accept = 0.12 + inkWeight(uv.u, uv.v) * 1.5;
        if (Math.random() > Math.min(accept, 0.9)) continue;
        const isTerm = Math.random() < 0.34;
        const token = isTerm ? pick(TERM_POOL) : pick(GLYPH_POOL);
        const size = Math.round(isTerm ? rand(10, 15) : rand(8, 12.5));
        const italic = isTerm && Math.random() < 0.4;
        glyphs.push({
          token,
          ax: sx,
          ay: sy,
          size,
          italic,
          colorKey: glyphColorKey(),
          fontKey: `${italic ? "italic " : ""}${size}px "Cormorant", Georgia, serif`,
          baseAlpha: isTerm ? rand(0.16, 0.34) : rand(0.12, 0.28),
          phase: rand(0, Math.PI * 2),
          speed: rand(0.16, 0.4),
          driftX: rand(3, 10),
          driftY: rand(2, 8),
          fadeSpeed: rand(0.08, 0.2),
          fadePhase: rand(0, Math.PI * 2),
          safe: safeFactor(sx, sy),
          near: nearFactor(sx, sy),
          large: false,
        });
      }

      // a few larger readable terms, kept in inky areas and out of the copy zone
      let placed = 0;
      let lt = 0;
      while (placed < c.large && lt++ < c.large * 80) {
        const sx = box.x + Math.random() * box.w;
        const sy = box.y + Math.random() * box.h;
        const uv = mapUV(box, sx, sy);
        if (!uv || inkWeight(uv.u, uv.v) < 0.16) continue;
        const sf = safeFactor(sx, sy);
        if (sf < 0.62) continue;
        const size = Math.round(rand(20, 34) * largeScale);
        const italic = Math.random() < 0.5;
        glyphs.push({
          token: pick(LARGE_POOL),
          ax: sx,
          ay: sy,
          size,
          italic,
          colorKey: colorKey(Math.random() < 0.5 ? PLUM : LAVENDER),
          fontKey: `${italic ? "italic " : ""}${size}px "Cormorant", Georgia, serif`,
          baseAlpha: rand(0.2, 0.32),
          phase: rand(0, Math.PI * 2),
          speed: rand(0.1, 0.22),
          driftX: rand(3, 9),
          driftY: rand(3, 8),
          fadeSpeed: rand(0.05, 0.12),
          fadePhase: rand(0, Math.PI * 2),
          safe: sf,
          near: nearFactor(sx, sy),
          large: true,
        });
        placed++;
      }

      let st = 0;
      while (sparks.length < c.spark && st++ < c.spark * 50) {
        const sx = box.x + Math.random() * box.w;
        const sy = box.y + Math.random() * box.h;
        if (!mapUV(box, sx, sy)) continue;
        const sf = safeFactor(sx, sy);
        if (sf < 0.5 && Math.random() < 0.7) continue;
        sparks.push({
          ax: sx,
          ay: sy,
          len: rand(2.5, 5),
          baseAlpha: rand(0.28, 0.48),
          phase: rand(0, Math.PI * 2),
          speed: rand(0.15, 0.3),
          twinkle: rand(0.7, 1.4),
          safe: sf,
        });
      }

      // group by font then colour so per-frame canvas state changes stay cheap
      glyphs.sort(byFontThenColor);
    }

    function resize() {
      const rect = hero?.getBoundingClientRect();
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

    function drawFrame(t: number) {
      if (!ctx) return;
      ctx.clearRect(0, 0, cssW, cssH);
      const e = animating ? energy : 0;
      const motion = 1 + e * 0.13;
      const hl = highlightRef.current;

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let curFont = "";
      let curColor = "";
      for (const p of glyphs) {
        const breathe = 0.6 + 0.4 * Math.sin(t * 0.8 + p.phase);
        const fade = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * p.fadeSpeed + p.fadePhase));
        let a = p.baseAlpha * breathe * fade * p.safe;
        if (p.large) a *= 1 + e * 0.25;
        if (e > 0) a *= 1 + e * p.near * 0.5;
        if (hl.size > 0 && hl.has(p.token)) a *= 1.8;
        a = Math.min(a, 0.45); // spec ceiling — keep even focused/large terms subtle
        if (a < 0.012) continue;
        if (p.fontKey !== curFont) {
          ctx.font = p.fontKey;
          curFont = p.fontKey;
        }
        if (p.colorKey !== curColor) {
          ctx.fillStyle = p.colorKey;
          curColor = p.colorKey;
        }
        ctx.globalAlpha = a;
        const ox = Math.sin(t * p.speed + p.phase) * p.driftX * motion;
        const oy = Math.cos(t * p.speed * 0.7 + p.phase) * p.driftY * motion;
        ctx.fillText(p.token, p.ax + ox, p.ay + oy);
      }

      ctx.strokeStyle = colorKey(GOLD);
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      for (const s of sparks) {
        const tw = 0.5 + 0.5 * Math.sin(t * s.twinkle + s.phase);
        const a = s.baseAlpha * tw * s.safe * (1 + e * 0.2);
        if (a < 0.02) continue;
        ctx.globalAlpha = a;
        const x = s.ax + Math.sin(t * s.speed + s.phase) * 2;
        const y = s.ay + Math.cos(t * s.speed + s.phase) * 2;
        const l = s.len * (0.8 + 0.2 * tw);
        const d = l * 0.5;
        ctx.beginPath();
        ctx.moveTo(x - l, y);
        ctx.lineTo(x + l, y);
        ctx.moveTo(x, y - l);
        ctx.lineTo(x, y + l);
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x - d, y + d);
        ctx.lineTo(x + d, y - d);
        ctx.stroke();
      }

      if (e > 0.01) {
        const pr = cmd.r * (1.5 + 0.12 * Math.sin(t * 1.4));
        const grad = ctx.createRadialGradient(cmd.x, cmd.y, pr * 0.35, cmd.x, cmd.y, pr);
        const pa = e * (0.05 + 0.025 * Math.sin(t * 1.4));
        grad.addColorStop(0, `rgba(179,141,229,${pa})`);
        grad.addColorStop(1, "rgba(179,141,229,0)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cmd.x, cmd.y, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function loop(now: number) {
      if (!animating) return;
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = STATE_ENERGY[stateRef.current] ?? 0;
      energy += (target - energy) * Math.min(1, dt * 4);
      drawFrame(now / 1000);
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
      measureSafe();
      createParticles();
      // Always paint one frame synchronously so the field is visible immediately —
      // before the first rAF, and even while the tab is hidden (rAF is suspended
      // when backgrounded). Continuous motion then resumes via startAnim().
      drawFrame(reduceMQ.matches ? 0 : performance.now() / 1000);
      if (reduceMQ.matches) stopAnim();
      else startAnim();
    }

    let resizeTimer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuild, 200);
    });
    ro.observe(hero);

    const onVisibility = () => {
      if (document.hidden) stopAnim();
      else startAnim();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onReduce = () => rebuild();
    reduceMQ.addEventListener("change", onReduce);

    // If the muse is already decoded (commonly cached by MuseBackdrop), sample it
    // now so the very first frame — including the static reduced-motion frame — is
    // density-aware. Otherwise show a provisional frame and refine on load.
    if (img.complete && img.naturalWidth > 0) {
      handleImageReady();
    } else {
      rebuild();
    }

    return () => {
      stopAnim();
      clearTimeout(resizeTimer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMQ.removeEventListener("change", onReduce);
      img.onload = null;
      img.onerror = null;
    };
  }, []);

  return (
    <div aria-hidden="true" className="viva-glyphs">
      <canvas className="viva-glyphs__canvas" ref={canvasRef} />
    </div>
  );
}
