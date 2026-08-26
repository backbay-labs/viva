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
