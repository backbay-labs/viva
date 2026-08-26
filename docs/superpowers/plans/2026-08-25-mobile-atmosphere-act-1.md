# Viva Mobile Atmosphere — Act 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a real, lit vellum surface under every screen of `apps/mobile`, and fix the text-contrast and haptic-timing defects that the design work uncovered.

**Architecture:** Act 1 ships the *fallback tier* described in the atmosphere spec §14 — a baked vellum plate plus a screen-relative readability well and vignette — with **no new native dependency**. The plate is generated from the same locked shader that Act 2 will run live, by a committed bake script, so the two tiers cannot drift. Because Act 1 and the fallback tier are the same artifact, the fallback gets exercised on every launch instead of rotting until it is needed.

**Tech Stack:** Expo SDK 57 / RN 0.86.2 · `react-native-svg` 15.15.4 (already a dependency, and the only gradient path proven on this New Architecture build) · `expo-asset`, `expo-system-ui`, `expo-splash-screen`, `expo-haptics` (all already dependencies) · `bun:test` · Playwright + `cwebp` for the offline bake only.

**Spec:**
- `docs/superpowers/specs/2026-08-25-mobile-atmosphere-design.md`
- `docs/superpowers/specs/2026-08-25-mobile-component-system-design.md`

## Global Constraints

- **No new runtime dependency in Act 1.** Skia arrives in Act 2. `expo-linear-gradient` is forbidden — it ignores `borderRadius` on the New Architecture (2026-08-24 design pass).
- **Locked ground parameters, verbatim:** `material 1.65 · drama 0.40 · warmth 0.82 · leafScale 1.90 · grain 0.024`.
- **Every length is in dp, never a fraction of the viewport.** A viewport-relative length turned a 3 px die edge into a 17 px smear when the canvas widened.
- **Grain never animates.** It is material, not effect.
- **Contrast is checked at the light's darkest excursion**, `#C2B7AC`, not at a screenshot. Body text needs 4.5:1, large text (≥24 dp, or ≥18.7 dp bold) needs 3:1.
- **The atmosphere is decorative.** It must set `accessibilityElementsHidden` and `importantForAccessibility="no-hide-descendants"`, and must never receive touches.
- Validation gates for every task: `bun run --cwd apps/mobile typecheck`, `lint`, `test`, `build`.
- Biome: double quotes, 2-space indent, 100-column lines, organized imports. Keep `StyleSheet.create` keys alphabetically sorted to match the existing files.
- Work on branch `mobile-atmosphere` (already created; specs are committed there).

---

### Task 1: Contrast module and the text-safe token split

The atmosphere spec §11 found that `inkMuted` — used by every caption and every piece of metadata in the app — measures 2.55:1 against the vellum at the light's darkest and 4.64:1 at its brightest. It fails WCAG AA at both ends, and it was already failing on the flat `#F7F0E7` canvas before any of this work. This task makes that a test, then fixes it.

**Files:**
- Create: `apps/mobile/src/theme/contrast.ts`
- Create: `apps/mobile/src/theme/contrast.test.ts`
- Modify: `apps/mobile/src/theme/tokens.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hexToRgb(hex: string): Rgb`, `relativeLuminance(rgb: Rgb): number`, `contrastRatio(a: Rgb, b: Rgb): number`, `contrastOnVellum(hex: string): { brightest: number; darkest: number }`, and the constants `VELLUM_BRIGHTEST`, `VELLUM_DARKEST`, `AA_BODY`, `AA_LARGE`. New colour tokens on `colors`: `inkMuted` (changed value), `sageInk`, `ochreInk`, `goldInk`, `copperInk`, `prussianInk`, `plumInk`, `copper`, `prussian`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/theme/contrast.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  AA_BODY,
  contrastOnVellum,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
  VELLUM_BRIGHTEST,
  VELLUM_DARKEST,
} from "./contrast";
import { colors } from "./tokens";

describe("WCAG primitives", () => {
  test("luminance of the endpoints", () => {
    expect(relativeLuminance(hexToRgb("#000000"))).toBeCloseTo(0, 5);
    expect(relativeLuminance(hexToRgb("#FFFFFF"))).toBeCloseTo(1, 5);
  });

  test("black on white is 21:1", () => {
    expect(contrastRatio(hexToRgb("#000000"), hexToRgb("#FFFFFF"))).toBeCloseTo(21, 1);
  });

  test("the ratio does not depend on argument order", () => {
    const a = hexToRgb("#271A30");
    const b = hexToRgb(VELLUM_DARKEST);
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 6);
  });
});

describe("text tokens hold AA at the light's darkest excursion", () => {
  // Every token below is used as TEXT somewhere in apps/mobile. Ornament-only
  // values (colors.gold on hairlines, the spark) are deliberately absent: WCAG
  // 1.4.11 exempts purely decorative marks.
  const textTokens: ReadonlyArray<readonly [string, string]> = [
    ["inkStrong", colors.inkStrong],
    ["inkMuted", colors.inkMuted],
    ["sageInk", colors.sageInk],
    ["ochreInk", colors.ochreInk],
    ["goldInk", colors.goldInk],
    ["copperInk", colors.copperInk],
    ["prussianInk", colors.prussianInk],
    ["plumInk", colors.plumInk],
  ];

  for (const [name, hex] of textTokens) {
    test(`${name} clears ${AA_BODY}:1 at ${VELLUM_DARKEST}`, () => {
      expect(contrastOnVellum(hex).darkest).toBeGreaterThanOrEqual(AA_BODY);
    });
  }

  test("the brightest excursion is never the binding constraint", () => {
    for (const [, hex] of textTokens) {
      const { brightest, darkest } = contrastOnVellum(hex);
      expect(brightest).toBeGreaterThan(darkest);
    }
  });

  test("the pre-fix inkMuted is recorded as failing, so a revert is caught", () => {
    expect(contrastOnVellum("#766B7E").darkest).toBeLessThan(AA_BODY);
  });

  test("ornament values are NOT safe as text and must not be used as text", () => {
    for (const ornament of [colors.gold, colors.copper, colors.prussian, colors.ochre]) {
      expect(contrastOnVellum(ornament).darkest).toBeLessThan(AA_BODY);
    }
  });
});

describe("the vellum endpoints match the atmosphere spec", () => {
  test("brightest and darkest are the spec's composited values", () => {
    expect(VELLUM_BRIGHTEST).toBe("#FFF5DD");
    expect(VELLUM_DARKEST).toBe("#C2B7AC");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test --cwd apps/mobile src/theme/contrast.test.ts`
Expected: FAIL — `Cannot find module './contrast'`.

- [ ] **Step 3: Write the contrast module**

Create `apps/mobile/src/theme/contrast.ts`:

```ts
/**
 * WCAG contrast against the living vellum.
 *
 * The ground drifts, so the background luminance under text is a *range*, not a
 * value. Every check runs at the darkest excursion; the brightest is reported
 * only to show the span. Both endpoints are the composited output of the locked
 * shader parameters (material 1.65 / drama 0.40 / warmth 0.82 / grain 0.024) —
 * see the atmosphere spec §11. If those parameters change, recompute these two
 * constants and this suite will tell you which tokens broke.
 */
export type Rgb = readonly [number, number, number];

/** Light tint + readability well, the most light content ever sits in. */
export const VELLUM_BRIGHTEST = "#FFF5DD";
/** Shadow tint x multiply field x occlusion inside a well. The binding case. */
export const VELLUM_DARKEST = "#C2B7AC";

export const AA_BODY = 4.5;
export const AA_LARGE = 3;

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ] as const;
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return (
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastOnVellum(hex: string): { brightest: number; darkest: number } {
  const ink = hexToRgb(hex);
  return {
    brightest: contrastRatio(ink, hexToRgb(VELLUM_BRIGHTEST)),
    darkest: contrastRatio(ink, hexToRgb(VELLUM_DARKEST)),
  };
}
```

- [ ] **Step 4: Add the text-safe tokens**

In `apps/mobile/src/theme/tokens.ts`, replace the `colors` object with:

```ts
export const colors = {
  ...vivaColors,
  canvas: "#F7F0E7",
  canvasDeep: "#F1E8DC",
  sheet: "#FFFCF7",
  sheetRaised: "#FFFDF9",
  inkStrong: "#271A30",
  // Was #766B7E, which measured 2.55:1 on the vellum's darkest excursion and
  // 4.64:1 on its brightest — failing WCAG AA at both ends, and already failing
  // on the flat canvas before the atmosphere existed. Darkened to clear 4.5:1
  // at the darkest. See ./contrast.ts and the atmosphere spec §11.
  inkMuted: "#4E4753",
  plumVivid: "#6E429B",
  plumNight: "#351A47",
  plumLine: "#DFD0EB",
  sageDeep: "#667C61",
  ochre: "#B77831",
  copper: "#B06A3B",
  prussian: "#3C5A78",
  // Text-safe counterparts. Ornament values above stay as they are for
  // hairlines, keylines, sparks and rules; anything that renders as TEXT uses
  // the *Ink value. A component picks a role, never a hex.
  sageInk: "#3F4D3C",
  ochreInk: "#65421B",
  goldInk: "#574727",
  copperInk: "#6A4023",
  prussianInk: "#324C65",
  plumInk: "#5C3782",
  hairline: "rgba(39, 26, 48, 0.11)",
  hairlineSoft: "rgba(39, 26, 48, 0.065)",
  pressedInk: "#1D1224",
} as const;
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `bun test --cwd apps/mobile src/theme/contrast.test.ts`
Expected: PASS, all assertions.

- [ ] **Step 6: Run the full gates**

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
```
Expected: all pass. `lint` may reformat `tokens.ts`; accept its output.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/theme/contrast.ts apps/mobile/src/theme/contrast.test.ts apps/mobile/src/theme/tokens.ts
git commit -m "fix(mobile): darken inkMuted and add text-safe accent tokens

inkMuted measured 2.55:1 against the vellum's darkest excursion and 4.64:1
against its brightest — failing WCAG AA at both ends, and already failing on
the flat canvas. Darkened to #4E4753 and added *Ink counterparts for the
accents, so ornament values stay put while text gets a compliant variant.

Contrast is enforced as a unit test that recomputes the ratio from the
composited vellum endpoints, so a future change to the ground parameters or a
token fails CI rather than silently shipping unreadable metadata."
```

---

### Task 2: Adopt the text-safe tokens

`VivaText` maps semantic tones to colours in one place, so most of the fix lands there. 22 call sites use `tone="muted"`, 9 use `tone="ochre"`, 2 use `tone="sage"`, 11 use `tone="plum"` — all of them are fixed by changing the map, not the call sites.

**Files:**
- Modify: `apps/mobile/src/components/type.tsx:18-24`
- Create: `apps/mobile/src/components/type.test.ts`

**Interfaces:**
- Consumes: `colors.sageInk`, `colors.ochreInk`, `colors.plumInk`, `colors.inkMuted` from Task 1.
- Produces: `TONE_COLORS: Record<TextTone, string>` and the `TextTone` type, both exported from `type.tsx`, so tones can be asserted without rendering.

- [ ] **Step 1: Write the failing test**

There is no `@testing-library/react-native` in this repo and tests are pure `bun:test`, so assert the exported map rather than rendering.

Create `apps/mobile/src/components/type.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { TONE_COLORS } from "@/components/type";
import { AA_BODY, contrastOnVellum } from "@/theme/contrast";
import { colors } from "@/theme/tokens";

describe("every text tone is legible on the vellum", () => {
  for (const [tone, hex] of Object.entries(TONE_COLORS)) {
    test(`tone "${tone}" clears ${AA_BODY}:1 at the darkest excursion`, () => {
      expect(contrastOnVellum(hex).darkest).toBeGreaterThanOrEqual(AA_BODY);
    });
  }
});

describe("tones point at text-safe tokens, not ornament tokens", () => {
  test("no tone uses an ornament value", () => {
    const ornament = [colors.gold, colors.ochre, colors.copper, colors.prussian, colors.sageDeep];
    for (const hex of Object.values(TONE_COLORS)) {
      expect(ornament).not.toContain(hex);
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test --cwd apps/mobile src/components/type.test.ts`
Expected: FAIL — `TONE_COLORS` is not exported.

- [ ] **Step 3: Rewrite the tone map**

In `apps/mobile/src/components/type.tsx`, export the tone union (it is currently module-private, and `TONE_COLORS`'s annotation needs it):

```ts
export type TextTone = "ink" | "muted" | "plum" | "sage" | "ochre";
```

Then replace the `toneStyles` block:

```ts
/**
 * Semantic tone -> text-safe colour. Every value here must clear WCAG AA
 * against the vellum's darkest excursion; `type.test.ts` enforces it. Ornament
 * values (colors.gold, colors.ochre, ...) are deliberately absent — they are for
 * hairlines and marks, never for type.
 */
export const TONE_COLORS: Record<TextTone, string> = {
  ink: colors.inkStrong,
  muted: colors.inkMuted,
  plum: colors.plumInk,
  sage: colors.sageInk,
  ochre: colors.ochreInk,
};

const toneStyles: Record<TextTone, TextStyle> = {
  ink: { color: TONE_COLORS.ink },
  muted: { color: TONE_COLORS.muted },
  plum: { color: TONE_COLORS.plum },
  sage: { color: TONE_COLORS.sage },
  ochre: { color: TONE_COLORS.ochre },
};
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test --cwd apps/mobile src/components/type.test.ts`
Expected: PASS.

- [ ] **Step 5: Audit the 27 direct colour references in screens**

Run: `grep -rn "colors.inkMuted\|colors.gold\|colors.ochre\|colors.sageDeep\|colors.plumVivid" apps/mobile/src --include="*.tsx"`

For each hit, decide by what it draws and change only the text ones:
- **Text** (a `color:` in a text style, or a `<VivaText style={{ color }}>`) → the `*Ink` value.
- **Ornament** (`backgroundColor` on a hairline rule, an SVG `fill`/`stroke`, a dot, the spark) → leave unchanged.

Known ornament sites to leave alone: `brand.tsx` `ruleLine.backgroundColor`, `SparkIcon` fill, and every `colors.gold` inside `voice-orb.tsx`'s `OrbBackdrop` SVG.

- [ ] **Step 6: Run the full gates**

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/type.tsx apps/mobile/src/components/type.test.ts apps/mobile/src/app
git commit -m "fix(mobile): route text tones through the text-safe tokens

VivaText's tone map is the single place 44 call sites resolve their colour, so
pointing it at the *Ink values fixes them all at once. Ornament references
(hairlines, the spark, the orb backdrop) keep their original values — WCAG
1.4.11 exempts decorative marks, and darkening them would flatten the page."
```

---

### Task 3: The haptic fires on press-in

`ActionButton` calls `Haptics.impactAsync` inside `onPress`, which fires on **release**. Once Act 2 lands, the visual well deepens on **press-in**. As written, the tap you feel and the dent you see are 100–300 ms apart. Fixing it now means the interaction is already correct when the depth arrives.

**Files:**
- Modify: `apps/mobile/src/components/actions.tsx:38-49`

**Interfaces:**
- Consumes: nothing.
- Produces: no API change — `ActionButton`'s props are unchanged.

- [ ] **Step 1: Read the current handler**

Run: `sed -n '30,60p' apps/mobile/src/components/actions.tsx`
Expected: the `onPress` prop contains both the `Haptics.impactAsync` call and the `onPress?.(event)` forward.

- [ ] **Step 2: Move the impact to `onPressIn`**

Replace the `onPress` prop on the `Pressable` with these two props:

```tsx
      onPress={onPress}
      onPressIn={(event) => {
        // Fires on press-IN, not release: the impact has to coincide with the
        // moment the surface deepens, or the tap you feel and the dent you see
        // are different events. See the component spec section 12.
        void Haptics.impactAsync(
          tone === "primary"
            ? Haptics.ImpactFeedbackStyle.Medium
            : Haptics.ImpactFeedbackStyle.Light,
        );
        onPressIn?.(event);
      }}
```

Add `onPressIn` to the destructured props so a caller's own handler is still honoured:

```tsx
export function ActionButton({
  children,
  disabled,
  icon,
  loading = false,
  onPress,
  onPressIn,
  style,
  tone = "primary",
  ...props
}: ActionButtonProps) {
```

- [ ] **Step 3: Verify no caller relied on the old timing**

Run: `grep -rn "onPressIn" apps/mobile/src --include="*.tsx"`
Expected: only the new `actions.tsx` occurrence. If any screen passes `onPressIn` to `ActionButton`, confirm it is still called — the code above forwards it.

- [ ] **Step 4: Run the full gates**

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/actions.tsx
git commit -m "fix(mobile): fire the button haptic on press-in

It was firing in onPress, which is release. The impression system deepens a
surface on press-in, so as written the tap you feel and the dent you see are
100-300ms apart. Forwards any caller-supplied onPressIn."
```

---

### Task 4: Bake the vellum plate

Generates the Act 1 / fallback-tier asset from the same shader Act 2 will run live, so the two tiers cannot drift. This runs offline and occasionally; the output is committed.

Measured during planning at 1242×2688: PNG 2827 KB, WebP q92 132 KB (half the grain lost), **WebP q95 311 KB (grain fully retained)**, q98 597 KB. q95 is the chosen point.

**Files:**
- Create: `apps/mobile/scripts/bake-vellum.mjs`
- Create: `apps/mobile/assets/images/vellum-plate.webp` (generated, committed)
- Create: `apps/mobile/src/theme/vellum-asset.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the asset at `apps/mobile/assets/images/vellum-plate.webp`, 1242×2688, ≤ 420 KB.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/theme/vellum-asset.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

// bun test runs from apps/mobile, so this resolves against the app root.
const PLATE = join(import.meta.dir, "../../assets/images/vellum-plate.webp");

describe("the baked vellum plate", () => {
  test("exists", () => {
    expect(() => statSync(PLATE)).not.toThrow();
  });

  test("stays inside its size budget", () => {
    // 311 KB when baked at q95/1242x2688. The ceiling leaves room for a
    // re-bake at slightly different parameters without silently bloating the
    // bundle; blowing past it means someone changed quality or dimensions.
    const kb = statSync(PLATE).size / 1024;
    expect(kb).toBeLessThan(420);
    expect(kb).toBeGreaterThan(120); // a q85 re-bake would lose most of the grain
  });

  test("is a RIFF/WEBP container", async () => {
    const bytes = new Uint8Array(await Bun.file(PLATE).slice(0, 12).arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WEBP");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test --cwd apps/mobile src/theme/vellum-asset.test.ts`
Expected: FAIL — the asset does not exist.

- [ ] **Step 3: Write the bake script**

Create `apps/mobile/scripts/bake-vellum.mjs`:

```js
#!/usr/bin/env node
/**
 * Bakes the Act 1 / fallback-tier vellum plate from the locked shader.
 *
 * This is the SAME fragment shader Act 2 runs live in Skia, frozen at one drift
 * phase. Keeping the bake in-repo is the only thing preventing the static tier
 * and the live tier from drifting apart.
 *
 * Offline tool. Requires Playwright (already at the workspace root) and cwebp
 * (`brew install webp`). Not part of any build; the output is committed.
 *
 *   node apps/mobile/scripts/bake-vellum.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "../assets/images");
const OUT_PNG = join(OUT_DIR, "vellum-plate.png");
const OUT_WEBP = join(OUT_DIR, "vellum-plate.webp");

// Locked in the atmosphere spec section 4.1. Do not tune these here.
const GROUND = { material: 1.65, drama: 0.4, warmth: 0.82, leafScale: 1.9, grain: 0.024 };
// The frozen drift phase, in shader seconds. Arbitrary but fixed: changing it
// re-frames the light, so a re-bake at a different phase is a visual change.
const PHASE = 12.0;
// 3x of a 414pt phone. `resizeMode="cover"` handles every other geometry.
const WIDTH = 1242;
const HEIGHT = 2688;
// q95 keeps the grain (measured: high-frequency energy 0.79 vs 0.70 in the
// source PNG). q92 halves it, q85 loses 80% of it.
const QUALITY = 95;

const FRAGMENT = `
precision highp float;
uniform vec2 uRes, uD1, uD2;
uniform float uMat, uDrama, uWarm, uScale, uGrain;
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm5(vec2 p){ float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return v / 0.96875; }
float fbm3(vec2 p){ float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = p * 2.11 + vec2(3.7, 11.9); a *= 0.5; } return v / 0.875; }
vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; uv.y = 1.0 - uv.y;
  float ar = uRes.y / uRes.x;
  vec2 p = vec2(uv.x, uv.y * ar);

  float m = uMat;
  vec3 base = vec3(0.936, 0.914, 0.884);
  base += vec3((fbm5(p * 3.1) - 0.5) * 0.072 * m);
  base += vec3((fbm5(p * 11.0) - 0.5) * 0.026 * m);
  base += vec3((vnoise(vec2(p.x * 52.0, p.y * 4.0)) - 0.5) * 0.020 * m);
  base += vec3(pow(clamp(fbm3(p * 22.0), 0.0, 1.0), 3.0) * 0.040 * m) * vec3(1.0, 0.93, 0.77);
  base  = mix(base, vec3(0.800, 0.672, 0.418), smoothstep(0.88, 0.995, vnoise(p * 64.0)) * 0.13 * m);

  float dK = uDrama, sc = uScale;
  vec2 r = rot(p, -0.44);
  float f1 = fbm3(vec2(r.x * 4.2 / sc, r.y * 7.0 / sc) + uD1);
  float f2 = fbm3(vec2(r.x * 8.6 / sc, r.y * 13.4 / sc) - uD2);
  float leaf = smoothstep(mix(0.36, 0.44, dK), mix(0.70, 0.56, dK), f1 * 0.70 + f2 * 0.34);
  float ramp = clamp(1.24 - (p.x * 0.40 + p.y * 0.34), 0.0, 1.0);
  float la = clamp(leaf * (0.50 + 0.50 * ramp), 0.0, 1.0);

  vec3 wg = mix(vec3(0.996, 1.000, 1.010), vec3(1.026, 1.002, 0.952), uWarm);
  vec3 sT = mix(vec3(0.948, 0.938, 0.926), vec3(0.796, 0.778, 0.766), dK)
          * mix(vec3(1.0), vec3(1.008, 0.999, 0.980), uWarm);
  vec3 lT = mix(vec3(1.030, 1.020, 1.002), vec3(1.118, 1.082, 1.000), dK) * wg;
  vec3 col = base * mix(sT, lT, la);
  col += pow(la, mix(3.0, 4.4, dK)) * mix(vec3(0.026, 0.021, 0.012), vec3(0.072, 0.058, 0.030), dK);

  float shade = smoothstep(0.15, 0.95, fbm5(p * 1.9 - uD2 * 0.5));
  col *= mix(vec3(1.0), vec3(0.948, 0.938, 0.940), (1.0 - shade) * (0.10 + 0.16 * dK));

  // Static grain, one cell per 1.25 device px at this bake density. Never animated.
  vec2 cell = floor(gl_FragCoord.xy / 1.25);
  col *= 1.0 - (hash21(cell) - 0.5) * uGrain;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on("console", (message) => {
  if (/SHADER|LINK/.test(message.text())) errors.push(message.text());
});

await page.setContent(
  `<style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>` +
    `<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>`,
);

await page.evaluate(
  ({ width, height, fragment, ground, phase }) => {
    const canvas = document.getElementById("c");
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.log(`SHADER: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(
      program,
      compile(gl.VERTEX_SHADER, "attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}"),
    );
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.log(`LINK: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);

    const at = (name) => gl.getUniformLocation(program, name);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(at("uRes"), width, height);
    const t1 = phase / 38;
    const t2 = phase / 47;
    gl.uniform2f(at("uD1"), Math.sin(t1 * 6.2831) * 0.375, Math.cos(t1 * 6.2831) * 0.275);
    gl.uniform2f(at("uD2"), Math.cos(t2 * 6.2831) * 0.36, Math.sin(t2 * 6.2831) * 0.51);
    gl.uniform1f(at("uMat"), ground.material);
    gl.uniform1f(at("uDrama"), ground.drama);
    gl.uniform1f(at("uWarm"), ground.warmth);
    gl.uniform1f(at("uScale"), ground.leafScale);
    gl.uniform1f(at("uGrain"), ground.grain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },
  { width: WIDTH, height: HEIGHT, fragment: FRAGMENT, ground: GROUND, phase: PHASE },
);

await page.locator("#c").screenshot({ path: OUT_PNG });
await browser.close();

if (errors.length > 0) {
  throw new Error(`shader failed to build:\n${errors.join("\n")}`);
}

execFileSync("cwebp", ["-q", String(QUALITY), OUT_PNG, "-o", OUT_WEBP, "-quiet"]);
unlinkSync(OUT_PNG);

const kb = statSync(OUT_WEBP).size / 1024;
console.log(`baked ${WIDTH}x${HEIGHT} @ q${QUALITY} -> ${OUT_WEBP} (${kb.toFixed(0)} KB)`);
if (kb > 420) {
  throw new Error(`plate is ${kb.toFixed(0)} KB, over the 420 KB budget`);
}
```

- [ ] **Step 4: Run the bake**

```bash
cd /Users/connor/Medica/backbay/viva && node apps/mobile/scripts/bake-vellum.mjs
```
Expected: `baked 1242x2688 @ q95 -> .../vellum-plate.webp (311 KB)` — some variance is fine, the script fails itself above 420 KB.

If `cwebp` is missing: `brew install webp`. If `playwright` cannot resolve, run from the workspace root as shown (the dependency lives in the root `node_modules`).

- [ ] **Step 5: Look at the output before trusting it**

Open `apps/mobile/assets/images/vellum-plate.webp` and confirm: warm ivory, large soft masses of gold light entering from the upper-left, visible follicle mottle and a few gold flecks, fine static grain, and **no** vignette or centre glow (those are drawn per-screen in Task 5).

- [ ] **Step 6: Run the test and verify it passes**

Run: `bun test --cwd apps/mobile src/theme/vellum-asset.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/scripts/bake-vellum.mjs apps/mobile/assets/images/vellum-plate.webp apps/mobile/src/theme/vellum-asset.test.ts
git commit -m "feat(mobile): bake the vellum plate from the locked shader

Generates the Act 1 / fallback-tier ground from the same fragment shader Act 2
will run live in Skia, frozen at one drift phase, so the static and live tiers
cannot drift apart.

1242x2688 at cwebp q95 = ~311KB. Measured alternatives: q92 is 132KB but loses
half the grain's high-frequency energy, q85 loses 80%, lossless is 2.1MB. Metro
bundles .webp by default and both platforms decode it natively."
```

---

### Task 5: The atmosphere layer, behind every screen

The visible payoff. The plate goes down full-bleed; the readability well and vignette are drawn per-screen in SVG so they scale to any geometry instead of being cropped with the bitmap; every screen background becomes transparent; and the splash is held until the plate is decoded so the app never flashes flat canvas.

**Files:**
- Create: `apps/mobile/src/components/atmosphere-geometry.ts`
- Create: `apps/mobile/src/components/atmosphere-geometry.test.ts`
- Create: `apps/mobile/src/components/atmosphere.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx`
- Modify: `apps/mobile/src/app/index.tsx:312-314` (`styles.safeArea`)
- Modify: `apps/mobile/src/app/session.tsx` (`styles.safeArea`)
- Modify: `apps/mobile/src/app/recap.tsx:426-428` (`styles.safeArea`)
- Modify: `apps/mobile/src/app/library.tsx:304-306` (`styles.safeArea`)

**Interfaces:**
- Consumes: `colors` from Task 1, the plate from Task 4.
- Produces: `VivaAtmosphere` (no props) and `VELLUM_PLATE` (the asset module reference) from `@/components/atmosphere`; `gaussianStops(peak: number, count: number)`, `WELL`, `VIGNETTE` from `@/components/atmosphere-geometry`.

- [ ] **Step 1: Write the failing geometry test**

Create `apps/mobile/src/components/atmosphere-geometry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { gaussianStops, VIGNETTE, WELL } from "./atmosphere-geometry";

describe("gaussianStops", () => {
  test("returns the requested number of stops", () => {
    expect(gaussianStops(0.13, 5)).toHaveLength(5);
  });

  test("offsets span 0 to 1 inclusive", () => {
    const stops = gaussianStops(0.13, 5);
    expect(stops[0].offset).toBe(0);
    expect(stops[stops.length - 1].offset).toBe(1);
  });

  test("peaks at the centre with the requested opacity", () => {
    expect(gaussianStops(0.13, 5)[0].opacity).toBeCloseTo(0.13, 4);
  });

  test("falls off monotonically", () => {
    const stops = gaussianStops(0.13, 6);
    for (let i = 1; i < stops.length; i += 1) {
      expect(stops[i].opacity).toBeLessThan(stops[i - 1].opacity);
    }
  });

  test("approximates the shader's exp(-(d*1.15)^2) falloff", () => {
    // The shader lifts by exp(-(distance*1.15)^2); the SVG stops must track it
    // or the readability well will not match the live tier in Act 2.
    const stops = gaussianStops(1, 5);
    for (const { offset, opacity } of stops) {
      const d = offset * 1.15;
      expect(opacity).toBeCloseTo(Math.exp(-(d * d)), 3);
    }
  });

  test("rejects a degenerate stop count", () => {
    expect(() => gaussianStops(0.13, 1)).toThrow();
  });
});

describe("locked geometry", () => {
  test("the well sits where the shader puts it", () => {
    expect(WELL.cx).toBe(0.5);
    expect(WELL.cy).toBe(0.44);
    expect(WELL.peakOpacity).toBeCloseTo(0.13, 4);
  });

  test("the vignette only darkens the outer third", () => {
    expect(VIGNETTE.innerStop).toBeGreaterThan(0.4);
    expect(VIGNETTE.edgeOpacity).toBeLessThan(0.25);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test --cwd apps/mobile src/components/atmosphere-geometry.test.ts`
Expected: FAIL — `Cannot find module './atmosphere-geometry'`.

- [ ] **Step 3: Write the geometry module**

Create `apps/mobile/src/components/atmosphere-geometry.ts`:

```ts
/**
 * Screen-relative geometry for the atmosphere's light.
 *
 * The vellum plate is a bitmap and gets cropped by `resizeMode="cover"`, so
 * anything that must stay anchored to the *screen* — the readability well and
 * the vignette — is drawn in SVG on top instead of baked in. These constants
 * mirror the shader in the atmosphere spec section 4.3 so the static tier and
 * Act 2's live tier agree.
 */
export type GradientStop = { offset: number; opacity: number };

/** Content sits in a rise of light, centred slightly above the middle. */
export const WELL = {
  cx: 0.5,
  cy: 0.44,
  rx: 0.86,
  ry: 0.6,
  peakOpacity: 0.13,
} as const;

/** A cool sink at the extreme edge, so the page reads as embedded. */
export const VIGNETTE = {
  innerStop: 0.52,
  edgeOpacity: 0.16,
} as const;

/**
 * Discretises the shader's `exp(-(distance * 1.15)^2)` falloff into SVG stops.
 * SVG gradients interpolate linearly between stops, so a handful of samples
 * along the true curve beats two stops and a guess.
 */
export function gaussianStops(peak: number, count: number): GradientStop[] {
  if (count < 2) {
    throw new Error(`gaussianStops needs at least 2 stops, received ${count}`);
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = index / (count - 1);
    const distance = offset * 1.15;
    return { offset, opacity: peak * Math.exp(-(distance * distance)) };
  });
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test --cwd apps/mobile src/components/atmosphere-geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the atmosphere component**

Create `apps/mobile/src/components/atmosphere.tsx`:

```tsx
import { useId } from "react";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { gaussianStops, VIGNETTE, WELL } from "@/components/atmosphere-geometry";

// Relative, not "@/assets/...": the tsconfig maps @/assets/* but nothing in the
// app imports through it yet, so Metro's resolution of that branch is unproven.
// A relative asset path is guaranteed. Exported so _layout.tsx preloads the same
// module reference rather than duplicating the path.
export const VELLUM_PLATE = require("../../assets/images/vellum-plate.webp");

const WELL_STOPS = gaussianStops(WELL.peakOpacity, 5);

/**
 * The ground every screen sits on.
 *
 * Act 1 (this): a baked plate carrying the material and the light, plus a
 * screen-relative readability well and vignette in SVG. No Skia, no new
 * dependency. Act 2 replaces the plate with the live shader and keeps this
 * component's shape; this implementation then survives as the fallback tier for
 * web and for devices that miss the frame-time gate, so it stays exercised.
 *
 * Purely decorative: hidden from assistive technology and never touchable.
 */
export function VivaAtmosphere() {
  const gradientId = `viva${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Image resizeMode="cover" source={VELLUM_PLATE} style={StyleSheet.absoluteFill} />
      <Svg height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <RadialGradient
            cx={`${WELL.cx * 100}%`}
            cy={`${WELL.cy * 100}%`}
            id={`${gradientId}Well`}
            rx={`${WELL.rx * 100}%`}
            ry={`${WELL.ry * 100}%`}
          >
            {WELL_STOPS.map((stop) => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor="#FFFDFA"
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
          <RadialGradient cx="50%" cy="50%" id={`${gradientId}Vignette`} rx="74%" ry="64%">
            <Stop offset={VIGNETTE.innerStop} stopColor="#2B1D34" stopOpacity={0} />
            <Stop offset={1} stopColor="#2B1D34" stopOpacity={VIGNETTE.edgeOpacity} />
          </RadialGradient>
        </Defs>
        <Rect fill={`url(#${gradientId}Well)`} height="100%" width="100%" />
        <Rect fill={`url(#${gradientId}Vignette)`} height="100%" width="100%" />
      </Svg>
    </View>
  );
}
```

- [ ] **Step 6: Mount it and hold the splash**

Replace `apps/mobile/src/app/_layout.tsx` with:

```tsx
import { installRuntimeGlobals } from "@/runtime/globals";

installRuntimeGlobals();

import { Cormorant_500Medium_Italic, Cormorant_600SemiBold } from "@expo-google-fonts/cormorant";
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from "@expo-google-fonts/hanken-grotesk";
import { Asset } from "expo-asset";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { VELLUM_PLATE, VivaAtmosphere } from "@/components/atmosphere";
import { colors } from "@/theme/tokens";

void SplashScreen.preventAutoHideAsync();
void SystemUI.setBackgroundColorAsync(colors.canvas);

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Cormorant_500Medium_Italic,
    Cormorant_600SemiBold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
  });
  const [plateReady, setPlateReady] = useState(false);

  // The splash background is already the vellum's base colour, so holding it
  // until the plate is decoded makes the handoff seamless. Hiding on fonts
  // alone flashes flat canvas first, which is the exact impression this work
  // exists to remove. A failed decode must not wedge the splash.
  useEffect(() => {
    let active = true;
    Asset.fromModule(VELLUM_PLATE)
      .downloadAsync()
      .catch(() => undefined)
      .finally(() => {
        if (active) setPlateReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const ready = (fontsLoaded || fontError) && plateReady;

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.root}>
        <VivaAtmosphere />
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            animation: "fade_from_bottom",
            contentStyle: { backgroundColor: "transparent" },
            gestureEnabled: true,
            headerShown: false,
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="session" options={{ gestureEnabled: false }} />
          <Stack.Screen name="recap" />
          <Stack.Screen name="library" />
        </Stack>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
});
```

- [ ] **Step 7: Make every screen background transparent**

In each of `index.tsx`, `session.tsx`, `recap.tsx`, `library.tsx`, find the `safeArea` entry in `StyleSheet.create` and change its background:

```ts
  safeArea: {
    // The atmosphere is mounted once at the root and shows through every screen.
    backgroundColor: "transparent",
    flex: 1,
  },
```

Then confirm nothing else paints over it:

```bash
grep -rn "backgroundColor: colors.canvas" apps/mobile/src
```
Expected: only `_layout.tsx`'s `styles.root`, which is the base colour behind the plate.

- [ ] **Step 8: Run the full gates**

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
bun run --cwd apps/mobile build
```
Expected: all pass. `build` runs `expo export --platform web` and will fail loudly if the `.webp` require cannot be resolved.

- [ ] **Step 9: Verify on a simulator**

```bash
bun run --cwd apps/mobile ios
```

Then confirm, capturing evidence with `xcrun simctl io booted screenshot`:
1. **No white or flat-canvas flash** between splash and first paint.
2. The vellum is visible on **all four screens** — home, session, recap, library.
3. Copy is still legible over the light; the metadata line under the greeting is noticeably darker than before (that is Task 1 landing).
4. Navigating home → library → home shows the ground **staying still**, not re-entering with the screen. If it slides with the transition, the atmosphere has been mounted inside the Stack rather than behind it.
5. Nothing on any screen is untappable — if taps stop working, the atmosphere is capturing touches and `pointerEvents="none"` was dropped.

Known simulator caveat: the iOS 26 simulator's audio stack can freeze the JS thread for 60–90 s when a recorder starts. Verify the session screen's *visuals* on web (`bun run --cwd apps/mobile web`) if that happens.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src/components/atmosphere.tsx apps/mobile/src/components/atmosphere-geometry.ts apps/mobile/src/components/atmosphere-geometry.test.ts apps/mobile/src/app
git commit -m "feat(mobile): put the living vellum under every screen

Act 1 of the atmosphere. The baked plate carries the material and the light;
the readability well and vignette are drawn per-screen in react-native-svg so
they stay anchored to the screen instead of being cropped with the bitmap.

Mounted once at the root behind the Stack, with every screen background made
transparent, so the ground stays still while screens move over it. The splash
is now held until the plate is decoded rather than until fonts load — hiding on
fonts alone flashes flat canvas, which is precisely the dead-paper impression
this work removes.

No new dependency: react-native-svg was already here and is the only gradient
path proven on this New Architecture build."
```

---

## Out of scope for Act 1

Recorded so a reviewer does not read their absence as an oversight:

- **Skia, drift, breath, the OU walk, tilt, touch response, the clock-bound sun** — Act 2. The plate is a frozen frame of exactly the shader Act 2 runs live.
- **Session-reactive light and the palimpsest** — Act 3.
- **The impression component system** (`Surface`, `Card`, `Chip`, `Field`, `ListRow`, `Group`) — that plan follows this one and depends on Skia, because the wells are cut into the height map.
- **The grouping accent swap to `copperInk`** — it lands with `Group`, which does not exist yet. Task 1 ships the token so it is ready.
- **`packages/tokens`** is untouched. The web app has a different ground (parchment plus the muse) and therefore a different luminance range; it needs its own audit rather than mobile's numbers.
- **O-6, O-7, O-8** (grouping device count, type pairing, global accent) are open and block none of the above.

## Spec clauses Act 1 satisfies trivially

Stated so a reviewer can tick them rather than hunt:

- **Reduce Motion** (atmosphere spec §12) — Act 1 contains **no motion at all**. The plate is static,
  the SVG gradients are static, grain is baked. The setting is satisfied by construction, and the
  obligation only becomes real in Act 2.
- **Reduce Transparency** (§12) — nothing is blurred or translucent. Satisfied by construction, and a
  permanent dividend of having chosen impression over glass.
- **Dynamic Type** (§12, component spec §11) — Act 1 measures no rects, so a font-scale change is a
  plain layout event. The re-measurement obligation arrives with the impression system.
- **Performance** (§14) — one `Image` and two SVG rects, none of them animating. There is no frame
  budget to hit; the §14 criteria bind Act 2.
- **Web parity** (§16) — Act 1 *is* the web tier, and `bun run --cwd apps/mobile build` exports it, so
  every task exercises the fallback path rather than deferring it.

## Verification of the whole act

After Task 5, run once from the workspace root:

```bash
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
bun run --cwd apps/mobile build
```

Then answer these against the spec:

- [ ] Every text token clears 4.5:1 at `#C2B7AC` (Task 1's suite proves it).
- [ ] The plate is under 420 KB and the bake script reproduces it from the locked parameters.
- [ ] The atmosphere is hidden from assistive tech and takes no touches.
- [ ] Grain does not animate anywhere.
- [ ] No new entry in `apps/mobile/package.json` dependencies.
- [ ] The splash hands off to the vellum with no flat-canvas flash.
