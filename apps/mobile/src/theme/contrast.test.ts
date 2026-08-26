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
