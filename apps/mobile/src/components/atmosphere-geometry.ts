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
