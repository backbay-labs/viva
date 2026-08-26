import { describe, expect, test } from "bun:test";

import { TONE_COLORS } from "@/components/type-tones";
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
