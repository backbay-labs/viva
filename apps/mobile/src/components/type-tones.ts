import { colors } from "@/theme/tokens";

// Split out from type.tsx (rather than living inline) so this pure colour data
// can be imported — and its contrast asserted in type.test.ts — without pulling
// in "react-native". type.tsx imports react-native for its Text component, and
// this repo's bun:test cannot parse react-native's untranspiled Flow source
// (see `import typeof` in its index.js): any test that transitively imports a
// component file crashes before a single assertion runs. type.tsx re-exports
// both of these so callers still reach them at "@/components/type".
export type TextTone = "ink" | "muted" | "plum" | "sage" | "ochre";

/**
 * Semantic tone -> text-safe colour. Every value here must clear WCAG AA
 * against the vellum's darkest excursion; `type.test.ts` enforces it. Ornament
 * values (colors.gold, colors.ochre, ...) are deliberately absent — they are for
 * hairlines and marks, never for type.
 */
export const TONE_COLORS: Record<TextTone, string> = {
  ink: colors.inkStrong,
  muted: colors.inkMuted,
  plum: colors.plumInk,
  sage: colors.sageInk,
  ochre: colors.ochreInk,
};
