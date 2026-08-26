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

/**
 * A cool sink at the extreme edge, so the page reads as embedded.
 *
 * **Layout rule: only `colors.inkStrong` may carry body-size text inside this
 * band.** At the corners both tiers clamp to the full `edgeOpacity`, which puts
 * the ground at `VELLUM_VIGNETTED` (#AA9E99) — dark enough that every other text
 * token lands between 3:1 and 4.5:1 there. Keep other tokens clear of the band,
 * or make the text large (>=24dp, or >=18.7dp bold), where 3:1 is the bar.
 * `src/theme/contrast.test.ts` pins this rule so it cannot rot.
 */
export const VIGNETTE = {
  cx: 0.5,
  cy: 0.5,
  rx: 0.74,
  ry: 0.64,
  innerStop: 0.52,
  edgeOpacity: 0.16,
} as const;

/**
 * The scalar radius that approximates an `rx` x `ry` ellipse.
 *
 * The geometric mean, not the arithmetic one: it preserves the ellipse's area,
 * so the circle web draws covers the same ground as the ellipse native draws
 * rather than the wider pool an averaged radius would give.
 */
export function meanRadius(rx: number, ry: number): number {
  return Math.sqrt(rx * ry);
}

/**
 * `rx`/`ry` on a `RadialGradient` are a react-native-svg *native extension*, not
 * DOM attributes: the web element is a bare pass-through, so the browser drops
 * them and falls back to the SVG default `r = 50%`. That shrinks the well to a
 * 0.50 pool and starts the vignette darkening at 0.26 of the box, which measured
 * about 15% below the luminance Task 1's contrast suite certifies against — and
 * took seven of the eight text tokens under 4.5:1 on the web tier.
 *
 * Supplying `r` alongside `rx`/`ry` fixes web and leaves native untouched, since
 * native maps `rx: rx || r`. Derived here rather than written at the call site
 * so the scalar cannot drift from the ellipse it summarises.
 */
export const WELL_RADIUS = meanRadius(WELL.rx, WELL.ry);
export const VIGNETTE_RADIUS = meanRadius(VIGNETTE.rx, VIGNETTE.ry);

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
