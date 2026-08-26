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

/**
 * A representative bright excursion, reported to show the span.
 *
 * Not a ceiling: decoding the committed plate puts 2.94% of it already brighter
 * than this before the readability well adds anything, and its brightest pixel
 * is #FFFFE6. Nothing binding is asserted against this constant — the floor is
 * what every check runs at — so it stays as a companion to VELLUM_DARKEST
 * rather than as a claim about the light.
 */
export const VELLUM_BRIGHTEST = "#FFF5DD";
/** Shadow tint x multiply field x occlusion inside a well. The binding case. */
export const VELLUM_DARKEST = "#C2B7AC";
/**
 * The worst case *inside the vignette band*, where the SVG vignette composites
 * its full `edgeOpacity` of #2B1D34 over the plate floor. Both tiers clamp here
 * at the corners: a corner sits at objectBoundingBox distance 0.707, past the
 * last gradient stop, so `r`/`rx`/`ry` cannot lighten it on either platform.
 *
 * Derived, not sampled — it is VELLUM_DARKEST composited at VIGNETTE.color and
 * VIGNETTE.edgeOpacity, and ./contrast.test.ts pins that arithmetic so the
 * constant cannot go stale.
 *
 * Three TEXT tokens still clear 4.5:1 against it — `ink`, `inkStrong` and
 * `pressedInk` — and the suite asserts exactly that list, so it stays true.
 * Every other TEXT token lands near 3.4-3.5:1 here, which still clears 3:1, so
 * large text is fine anywhere. This is an accepted limit rather than a rule:
 * all four screens scroll, so body text passes through the band transiently no
 * matter where it is authored. See VIGNETTE in components/atmosphere-geometry.
 */
export const VELLUM_VIGNETTED = "#AA9E99";

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
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
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
