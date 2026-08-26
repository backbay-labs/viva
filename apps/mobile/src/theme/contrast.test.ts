import { describe, expect, test } from "bun:test";
import { VIGNETTE } from "@/components/atmosphere-geometry";
import {
  AA_BODY,
  AA_LARGE,
  contrastOnVellum,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
  VELLUM_DARKEST,
  VELLUM_VIGNETTED,
} from "./contrast";
import {
  type ColorToken,
  colors,
  MARK_TOKENS,
  NON_HEX_TOKENS,
  ORNAMENT_TOKENS,
  SURFACE_TOKENS,
  TEXT_TOKENS,
} from "./tokens";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Turns a classification set into the `[name, hex]` pairs the assertions read. */
const swatches = (names: readonly ColorToken[]): ReadonlyArray<readonly [ColorToken, string]> =>
  names.map((name) => [name, colors[name]] as const);

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

describe("the palette is classified exhaustively", () => {
  // This block is the one that closes the hole the rest of the suite fell
  // through. `colors` is `{...vivaColors, ...local}` and every hand-written
  // list on this branch enumerated only the local half, which is how
  // inkSecondary — 3.52:1, used as 17dp body copy on the ground — was never
  // measured by anything. A token added to @viva/tokens now fails here until
  // someone decides what it is allowed to carry.
  const memberships = new Map<string, string[]>();
  for (const [label, names] of [
    ["TEXT", TEXT_TOKENS],
    ["MARK", MARK_TOKENS],
    ["ORNAMENT", ORNAMENT_TOKENS],
    ["SURFACE", SURFACE_TOKENS],
  ] as const) {
    for (const name of names) {
      memberships.set(name, [...(memberships.get(name) ?? []), label]);
    }
  }

  test("every hex-valued token is in exactly one of the four sets", () => {
    const unclassified: string[] = [];
    const classifiedTwice: string[] = [];
    for (const [name, value] of Object.entries(colors)) {
      if (!HEX.test(value)) {
        continue;
      }
      const sets = memberships.get(name) ?? [];
      if (sets.length === 0) {
        unclassified.push(name);
      } else if (sets.length > 1) {
        classifiedTwice.push(`${name} (${sets.join(" + ")})`);
      }
    }
    // Asserted as one object so a failure names the offending token rather than
    // reporting that some length is not zero.
    expect({ classifiedTwice, unclassified }).toEqual({ classifiedTwice: [], unclassified: [] });
  });

  test("the non-hex tokens are excluded by rule, not by omission", () => {
    const nonHex = Object.entries(colors)
      .filter(([, value]) => !HEX.test(value))
      .map(([name]) => name);
    expect(nonHex.sort()).toEqual([...NON_HEX_TOKENS].sort());
    for (const name of NON_HEX_TOKENS) {
      expect(memberships.get(name)).toBeUndefined();
    }
  });

  test("the four sets and the exclusions account for the whole palette", () => {
    const classified =
      TEXT_TOKENS.length + MARK_TOKENS.length + ORNAMENT_TOKENS.length + SURFACE_TOKENS.length;
    expect(classified + NON_HEX_TOKENS.length).toBe(Object.keys(colors).length);
  });
});

describe("TEXT tokens hold AA at the light's darkest excursion", () => {
  for (const [name, hex] of swatches(TEXT_TOKENS)) {
    test(`${name} clears ${AA_BODY}:1 at ${VELLUM_DARKEST}`, () => {
      expect(contrastOnVellum(hex).darkest).toBeGreaterThanOrEqual(AA_BODY);
    });
  }

  test("the brightest excursion is never the binding constraint", () => {
    for (const [, hex] of swatches(TEXT_TOKENS)) {
      const { brightest, darkest } = contrastOnVellum(hex);
      expect(brightest).toBeGreaterThan(darkest);
    }
  });

  test("the pre-fix inkMuted is recorded as failing, so a revert is caught", () => {
    expect(contrastOnVellum("#766B7E").darkest).toBeLessThan(AA_BODY);
  });
});

describe("MARK tokens hold AA_LARGE but are not text-safe on the ground", () => {
  // Meaningful non-text graphics (WCAG 1.4.11) and text >=24dp only need
  // AA_LARGE (3:1), not the full 4.5:1 TEXT bar.
  for (const [name, hex] of swatches(MARK_TOKENS)) {
    test(`${name} clears ${AA_LARGE}:1 at ${VELLUM_DARKEST}`, () => {
      expect(contrastOnVellum(hex).darkest).toBeGreaterThanOrEqual(AA_LARGE);
    });
  }

  for (const [name, hex] of swatches(MARK_TOKENS)) {
    test(`${name} is NOT safe as body copy on the ground — recorded, not accidental`, () => {
      expect(contrastOnVellum(hex).darkest).toBeLessThan(AA_BODY);
    });
  }

  // The *Mark tier only earns its place by keeping more chroma than *Ink; if a
  // future edit collapses the two, this is what catches it. Derived from the
  // set's own naming so a sixth *Mark token is covered the day it lands.
  const markToInk = MARK_TOKENS.filter((name) => name.endsWith("Mark")).map(
    (name) => [name, name.replace(/Mark$/, "Ink") as ColorToken] as const,
  );

  test("every *Mark token has an *Ink counterpart in TEXT_TOKENS", () => {
    expect(markToInk.length).toBeGreaterThan(0);
    for (const [, ink] of markToInk) {
      expect(TEXT_TOKENS).toContain(ink);
    }
  });

  for (const [mark, ink] of markToInk) {
    test(`${mark} is lighter than ${ink}`, () => {
      expect(relativeLuminance(hexToRgb(colors[mark]))).toBeGreaterThan(
        relativeLuminance(hexToRgb(colors[ink])),
      );
    });
  }
});

describe("ORNAMENT tokens are not safe as text and must not be used as text", () => {
  for (const [name, hex] of swatches(ORNAMENT_TOKENS)) {
    test(`${name} is below ${AA_BODY}:1 at ${VELLUM_DARKEST}`, () => {
      expect(contrastOnVellum(hex).darkest).toBeLessThan(AA_BODY);
    });
  }
});

describe("the text that lives on a surface rather than on the ground", () => {
  // inkSecondary and sheet are classified MARK and SURFACE because neither can
  // carry body copy on the vellum. Both still print text on an opaque fill, and
  // those pairings are the guarantee the classification would otherwise drop.
  const onSurface = (ink: ColorToken, surface: ColorToken) =>
    contrastRatio(hexToRgb(colors[ink]), hexToRgb(colors[surface]));

  for (const surface of ["sheet", "plumWash", "amberWash"] as const) {
    test(`inkSecondary clears ${AA_BODY}:1 on ${surface}`, () => {
      expect(onSurface("inkSecondary", surface)).toBeGreaterThanOrEqual(AA_BODY);
    });
  }

  test("inkSecondary is below the bar on the ground, which is why the hero line moved", () => {
    // apps/mobile/src/app/index.tsx `styles.promise` used to be inkSecondary and
    // renders with no background of its own. 6.13:1 on the flat canvas this
    // branch replaced; 3.52:1 here.
    expect(contrastOnVellum(colors.inkSecondary).darkest).toBeLessThan(AA_BODY);
  });

  test(`the primary button's sheet label clears ${AA_BODY}:1 on plumNight`, () => {
    expect(onSurface("sheet", "plumNight")).toBeGreaterThanOrEqual(AA_BODY);
  });
});

describe("the vellum floor matches the atmosphere spec", () => {
  test("the darkest excursion is the spec's composited value", () => {
    expect(VELLUM_DARKEST).toBe("#C2B7AC");
  });
});

describe("the contrast floor inside the vignette band", () => {
  // The band is where the SVG vignette composites its full edgeOpacity over the
  // plate floor. Both tiers clamp there: a corner sits at objectBoundingBox
  // distance 0.707, past the last gradient stop, so neither r nor rx/ry can
  // lighten it on either platform. edgeOpacity 0.16 is approved design and
  // stays; what this block does is keep the cost of it measured. See the note on
  // VIGNETTE in @/components/atmosphere-geometry for why it is an accepted limit
  // rather than an enforceable rule.
  const onVignette = (hex: string) => contrastRatio(hexToRgb(hex), hexToRgb(VELLUM_VIGNETTED));

  test("only the three darkest TEXT tokens still clear AA_BODY in the band", () => {
    // A golden list, not a recomputation: it changes if a TEXT token is
    // retoned or a new one is classified, which is exactly when someone should
    // re-read the accepted-limit note.
    const survivors = TEXT_TOKENS.filter((name) => onVignette(colors[name]) >= AA_BODY);
    expect(survivors).toEqual(["ink", "inkStrong", "pressedInk"]);
  });

  for (const [name, hex] of swatches(TEXT_TOKENS)) {
    test(`${name} still clears ${AA_LARGE}:1 there, so large text is fine`, () => {
      expect(onVignette(hex)).toBeGreaterThanOrEqual(AA_LARGE);
    });
  }

  test("the band is darker than the certified floor, which is why it needs its own note", () => {
    expect(relativeLuminance(hexToRgb(VELLUM_VIGNETTED))).toBeLessThan(
      relativeLuminance(hexToRgb(VELLUM_DARKEST)),
    );
  });

  test("the constant is the certified floor pushed through the vignette", () => {
    // VELLUM_VIGNETTED is not a sampled pixel, it is a derivation: the darkest
    // certified ground composited with the vignette's full edge opacity. All
    // three inputs come from the shipped constants — VIGNETTE.color is the same
    // object atmosphere.tsx paints with — so changing any of them fails here
    // instead of silently leaving this constant stale.
    const vignette = hexToRgb(VIGNETTE.color);
    const floor = hexToRgb(VELLUM_DARKEST);
    const composited = floor.map((channel, index) =>
      Math.round(channel * (1 - VIGNETTE.edgeOpacity) + vignette[index] * VIGNETTE.edgeOpacity),
    );
    expect(composited).toEqual([...hexToRgb(VELLUM_VIGNETTED)]);
  });
});
