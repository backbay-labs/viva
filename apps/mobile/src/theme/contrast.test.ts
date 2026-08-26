import { describe, expect, test } from "bun:test";
import { VIGNETTE } from "@/components/atmosphere-geometry";
import {
  AA_BODY,
  AA_LARGE,
  contrastOnVellum,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
  VELLUM_BRIGHTEST,
  VELLUM_DARKEST,
  VELLUM_VIGNETTED,
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

describe("the *Mark tier holds AA_LARGE and stays lighter than *Ink", () => {
  // Meaningful non-text graphics (WCAG 1.4.11) and text >=24dp only need
  // AA_LARGE (3:1), not the full 4.5:1 *Ink bar. The tier only earns its place
  // by keeping more chroma than *Ink; if a future edit collapses the two, the
  // "lighter than its *Ink counterpart" assertion below is what catches it.
  const markToInk: ReadonlyArray<readonly [string, string, string]> = [
    ["ochre", colors.ochreMark, colors.ochreInk],
    ["plum", colors.plumMark, colors.plumInk],
    ["sage", colors.sageMark, colors.sageInk],
    ["gold", colors.goldMark, colors.goldInk],
    ["copper", colors.copperMark, colors.copperInk],
  ];

  for (const [name, mark] of markToInk) {
    test(`${name}Mark clears ${AA_LARGE}:1 at ${VELLUM_DARKEST}`, () => {
      expect(contrastOnVellum(mark).darkest).toBeGreaterThanOrEqual(AA_LARGE);
    });
  }

  for (const [name, mark, ink] of markToInk) {
    test(`${name}Mark is lighter than ${name}Ink`, () => {
      const markLuminance = relativeLuminance(hexToRgb(mark));
      const inkLuminance = relativeLuminance(hexToRgb(ink));
      expect(markLuminance).toBeGreaterThan(inkLuminance);
    });
  }
});

describe("the vellum endpoints match the atmosphere spec", () => {
  test("brightest and darkest are the spec's composited values", () => {
    expect(VELLUM_BRIGHTEST).toBe("#FFF5DD");
    expect(VELLUM_DARKEST).toBe("#C2B7AC");
  });
});

describe("inside the vignette band, only inkStrong may carry body text", () => {
  // The band is where the SVG vignette composites its full edgeOpacity over the
  // plate floor. Both tiers clamp there: a corner sits at objectBoundingBox
  // distance 0.707, past the last gradient stop, so neither r nor rx/ry can
  // lighten it on either platform. edgeOpacity 0.16 is approved design and
  // stays; what this block prevents is the invisible failure of someone later
  // placing muted body text in the outer band, which no other test would catch.
  const textTokens: ReadonlyArray<readonly [string, string]> = [
    ["inkMuted", colors.inkMuted],
    ["sageInk", colors.sageInk],
    ["ochreInk", colors.ochreInk],
    ["goldInk", colors.goldInk],
    ["copperInk", colors.copperInk],
    ["prussianInk", colors.prussianInk],
    ["plumInk", colors.plumInk],
  ];

  const onVignette = (hex: string) => contrastRatio(hexToRgb(hex), hexToRgb(VELLUM_VIGNETTED));

  test(`inkStrong clears ${AA_BODY}:1 at ${VELLUM_VIGNETTED}`, () => {
    expect(onVignette(colors.inkStrong)).toBeGreaterThanOrEqual(AA_BODY);
  });

  for (const [name, hex] of textTokens) {
    test(`${name} does NOT clear ${AA_BODY}:1 there — recorded, not accidental`, () => {
      expect(onVignette(hex)).toBeLessThan(AA_BODY);
    });
  }

  for (const [name, hex] of [["inkStrong", colors.inkStrong] as const, ...textTokens]) {
    test(`${name} still clears ${AA_LARGE}:1 there, so large text is fine`, () => {
      expect(onVignette(hex)).toBeGreaterThanOrEqual(AA_LARGE);
    });
  }

  test("the band is darker than the certified floor, which is why it needs its own rule", () => {
    expect(relativeLuminance(hexToRgb(VELLUM_VIGNETTED))).toBeLessThan(
      relativeLuminance(hexToRgb(VELLUM_DARKEST)),
    );
  });

  test("the constant is the certified floor pushed through the vignette", () => {
    // VELLUM_VIGNETTED is not a sampled pixel, it is a derivation: the darkest
    // certified ground composited with the vignette's full edge opacity. Pinning
    // the arithmetic means changing VIGNETTE.edgeOpacity — or VELLUM_DARKEST —
    // fails here instead of silently leaving this constant stale.
    const VIGNETTE_COLOR = hexToRgb("#2B1D34"); // atmosphere.tsx's vignette stops
    const floor = hexToRgb(VELLUM_DARKEST);
    const composited = floor.map((channel, index) =>
      Math.round(
        channel * (1 - VIGNETTE.edgeOpacity) + VIGNETTE_COLOR[index] * VIGNETTE.edgeOpacity,
      ),
    );
    expect(composited).toEqual([...hexToRgb(VELLUM_VIGNETTED)]);
  });
});
