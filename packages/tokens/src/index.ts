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

/**
 * A required minimum WCAG 2.x contrast ratio between two `theme.css` custom
 * properties, named by CSS custom-property name (not a resolved hex value)
 * so the check always tracks the live token, never a value that could drift
 * out of sync with `theme.css`.
 */
export type VivaContrastPair = {
  foreground: string;
  background: string;
  minimumRatio: number;
};

/**
 * The full set of semantic-text contrast pairs `theme.css` must satisfy
 * (`FRONTEND-002`). Both `packages/tokens/src/index.test.ts` (resolving
 * against the real `theme.css` literals) and `scripts/frontend-quality.test.mjs`
 * (the source-level checker `checkTokenAuthority` consumes this same array)
 * scan every entry here, so a new semantic-text role only needs to be added
 * once, in this array, to be covered by both.
 */
export const vivaContrastPairs: ReadonlyArray<VivaContrastPair> = [
  { background: "--viva-paper", foreground: "--viva-ochre-text", minimumRatio: 4.5 },
  { background: "--viva-bg-soft", foreground: "--viva-ochre-text", minimumRatio: 4.5 },
  { background: "--viva-paper", foreground: "--viva-ink", minimumRatio: 4.5 },
  { background: "--viva-paper", foreground: "--viva-ink-soft", minimumRatio: 4.5 },
  { background: "--viva-paper", foreground: "--viva-muted", minimumRatio: 4.5 },
] as const;
