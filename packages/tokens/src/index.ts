/**
 * `@viva/tokens` — the design-token authority's TypeScript surface.
 *
 * `theme.css` (exported as `@viva/tokens/theme.css`) is the *only* place
 * that assigns literal color/radius/typography/target-size/shadow values.
 * This module exports CSS custom-property *names* so TypeScript/JS
 * consumers can reference the same tokens (for example via
 * `getComputedStyle(el).getPropertyValue(vivaColorTokens.paper)`) without a
 * second hardcoded value table that could drift from the CSS.
 */

/** Canonical semantic color tokens, keyed by a JS-friendly name. */
export const vivaColorTokens = {
  bg: "--viva-bg",
  bgSoft: "--viva-bg-soft",
  paper: "--viva-paper",
  ink: "--viva-ink",
  inkSoft: "--viva-ink-soft",
  muted: "--viva-muted",
  lavender: "--viva-lavender",
  lavenderStrong: "--viva-lavender-strong",
  amethyst: "--viva-amethyst",
  amethystDeep: "--viva-amethyst-deep",
  plum: "--viva-plum",
  gold: "--viva-gold",
  ochre: "--viva-ochre",
  /** Text/label role for the ochre hue; AA-contrast, unlike `--viva-ochre`. */
  ochreText: "--viva-ochre-text",
  sage: "--viva-sage",
} as const;

/** Corner-radius tokens. */
export const vivaRadiusTokens = {
  small: "--radius-sm",
  regular: "--radius",
  large: "--radius-lg",
} as const;

/** Typography tokens: the serif/sans family stacks. */
export const vivaTypographyTokens = {
  serif: "--viva-serif",
  sans: "--viva-sans",
} as const;

/** Minimum actionable (touch/click) target size. */
export const vivaTargetMinToken = "--viva-target-min" as const;

export type VivaColorTokenName = keyof typeof vivaColorTokens;
export type VivaRadiusTokenName = keyof typeof vivaRadiusTokens;
export type VivaTypographyTokenName = keyof typeof vivaTypographyTokens;
