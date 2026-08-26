import { describe, expect, test } from "bun:test";

import { TONE_COLORS } from "@/components/type-tones";
import { AA_BODY, contrastOnVellum } from "@/theme/contrast";
import { colors, MARK_TOKENS, ORNAMENT_TOKENS, TEXT_TOKENS } from "@/theme/tokens";

describe("every text tone is legible on the vellum", () => {
  for (const [tone, hex] of Object.entries(TONE_COLORS)) {
    test(`tone "${tone}" clears ${AA_BODY}:1 at the darkest excursion`, () => {
      expect(contrastOnVellum(hex).darkest).toBeGreaterThanOrEqual(AA_BODY);
    });
  }
});

describe("tones point at text-safe tokens", () => {
  // Derived from the classification in @/theme/tokens rather than restated, so
  // these lists cannot drift apart from the contrast suite's — which is what
  // they had already done: the two hand-written ornament lists disagreed about
  // sageDeep, and neither of them contained plumVivid.
  const textValues = TEXT_TOKENS.map((name) => colors[name]) as string[];
  const ornamentValues = ORNAMENT_TOKENS.map((name) => colors[name]) as string[];
  const markValues = MARK_TOKENS.map((name) => colors[name]) as string[];

  test("every tone is a TEXT token", () => {
    const strays = Object.entries(TONE_COLORS)
      .filter(([, hex]) => !textValues.includes(hex))
      .map(([tone, hex]) => `${tone} (${hex})`);
    expect(strays).toEqual([]);
  });

  test("no tone uses an ornament value", () => {
    for (const hex of Object.values(TONE_COLORS)) {
      expect(ornamentValues).not.toContain(hex);
    }
  });

  test("no tone uses a mark value — 3:1 is not the bar for a tone", () => {
    for (const hex of Object.values(TONE_COLORS)) {
      expect(markValues).not.toContain(hex);
    }
  });
});
