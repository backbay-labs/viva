import { vivaColors } from "@viva/tokens";

// Plum already clears 3:1 against the vellum's darkest excursion, so the mark
// tier needs no separate value for it. Hoisted and used twice rather than
// written out twice, so `plumMark` reads as a deliberate alias of `plumVivid`
// instead of a duplicated literal someone will later "fix" by nudging one.
const PLUM_VIVID = "#6E429B";

export const colors = {
  ...vivaColors,
  canvas: "#F7F0E7",
  canvasDeep: "#F1E8DC",
  sheet: "#FFFCF7",
  sheetRaised: "#FFFDF9",
  inkStrong: "#271A30",
  // Was #766B7E, which measured 2.55:1 on the vellum's darkest excursion and
  // 4.64:1 on its brightest — failing WCAG AA at both ends, and already failing
  // on the flat canvas before the atmosphere existed. Darkened to clear 4.5:1
  // at the darkest. See ./contrast.ts and the atmosphere spec §11.
  inkMuted: "#4E4753",
  plumVivid: PLUM_VIVID,
  plumNight: "#351A47",
  plumLine: "#DFD0EB",
  sageDeep: "#667C61",
  ochre: "#B77831",
  copper: "#B06A3B",
  prussian: "#3C5A78",
  // Mid tier: >=3:1 (AA_LARGE) against the vellum's darkest excursion, for
  // meaningful non-text graphics (WCAG 1.4.11) and text >=24dp (or >=18.7dp
  // bold) — not the full 4.5:1 *Ink bar, but no longer WCAG-exempt ornament
  // either. Keeps more chroma than *Ink so states relying on this hue for
  // meaning (e.g. the recap ledger's strong/shaky/due dot + numeral) stay
  // distinguishable. See task-2-fix-1.md.
  ochreMark: "#865824",
  plumMark: PLUM_VIVID,
  sageMark: "#546750",
  goldMark: "#745F34",
  copperMark: "#8C542F",
  // Text-safe counterparts. Ornament values above stay as they are for
  // hairlines, keylines, sparks and rules; anything that renders as TEXT uses
  // the *Ink value. A component picks a role, never a hex.
  sageInk: "#3F4D3C",
  ochreInk: "#65421B",
  goldInk: "#574727",
  copperInk: "#693F23",
  prussianInk: "#324C65",
  plumInk: "#5C3782",
  hairline: "rgba(39, 26, 48, 0.11)",
  hairlineSoft: "rgba(39, 26, 48, 0.065)",
  pressedInk: "#1D1224",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * What each colour is safe to *carry*, against the living vellum.
 *
 * `colors` is `{...vivaColors, ...local}`, so half of it arrives through a
 * spread. Before these sets existed the contrast suites enumerated only the
 * local half by hand, in five lists that had already drifted apart, and
 * `inkSecondary` — a body-text colour at 3.52:1 on the ground — sat outside
 * every one of them. `../theme/contrast.test.ts` now asserts that **every**
 * hex-valued key of `colors` appears in exactly one of the four sets below, so
 * a token added to `@viva/tokens` fails the suite until someone classifies it.
 *
 * These are capability tiers, not usage records: a token's set says what it may
 * be used for on the atmosphere, not where it happens to appear today. That
 * distinction matters in both directions — `sheet` is SURFACE even though the
 * primary button prints its label in it (on `plumNight`, 14.76:1), and
 * `inkSecondary` is MARK even though it is a text colour upstream, because it
 * cannot clear the body bar on this ground.
 *
 * Deciding where a new token goes:
 * - clears 4.5:1 vs `VELLUM_DARKEST` and is meant to be read -> TEXT
 * - a meaningful non-text graphic, or text >=24dp, at >=3:1 -> MARK
 * - decoration a user loses nothing by missing (WCAG 1.4.11 exempt) -> ORNAMENT
 * - a background, wash or fill that something else sits on -> SURFACE
 *
 * When it is genuinely unclear, choose the strictest bar the value can hold.
 */

/** Body text anywhere, including directly on the vellum's darkest excursion. */
export const TEXT_TOKENS = [
  "ink",
  "inkStrong",
  "inkMuted",
  "pressedInk",
  "plumDeep",
  "plumInk",
  "sageInk",
  "ochreInk",
  "goldInk",
  "copperInk",
  "prussianInk",
] as const satisfies readonly ColorToken[];

/**
 * Meaningful non-text graphics (WCAG 1.4.11) and text >=24dp. Clears 3:1 on the
 * ground, not 4.5:1 — never body copy on the atmosphere.
 *
 * `inkSecondary` is here rather than in TEXT deliberately. It is a text colour
 * in `@viva/tokens` and is still used as text in four places in this app, but
 * all four are on opaque surfaces (plumWash 5.75:1, amberWash 5.69:1, sheet
 * 6.77:1) where it is comfortably legible; on the vellum it is 3.52:1. TEXT
 * would be a claim it cannot honour. `contrast.test.ts` records both facts.
 */
export const MARK_TOKENS = [
  "inkSecondary",
  "plumVivid",
  "plumMark",
  "sageMark",
  "ochreMark",
  "goldMark",
  "copperMark",
] as const satisfies readonly ColorToken[];

/**
 * Decorative marks — sparks, keylines, hairlines, gradient stops — plus the
 * placeholder tone. Outside WCAG 1.4.11, and none of them is safe as text.
 *
 * `inkTertiary` is the placeholder colour on the session composer (3.20:1 on
 * `sheet`). Placeholder text is exempt in practice and the field's real label
 * carries the meaning, so it is recorded honestly here rather than "fixed".
 */
export const ORNAMENT_TOKENS = [
  "inkTertiary",
  "inkFaint",
  "plum",
  "plumSoft",
  "plumLine",
  "sage",
  "sageDeep",
  "gold",
  "ochre",
  "amber",
  "copper",
  "prussian",
  "lavender",
] as const satisfies readonly ColorToken[];

/** Backgrounds, washes and fills. Something else sits on these; they are never a tone. */
export const SURFACE_TOKENS = [
  "bg",
  "bgDeep",
  "paper",
  "paperRaised",
  "canvas",
  "canvasDeep",
  "sheet",
  "sheetRaised",
  "plumNight",
  "plumWash",
  "sageWash",
  "goldWash",
  "amberWash",
] as const satisfies readonly ColorToken[];

/**
 * Excluded from the four sets by rule, not by omission: these are `rgba()`
 * composites whose contrast depends on whatever they are laid over, so a fixed
 * ratio against the ground is not a thing they have. Both are hairlines.
 */
export const NON_HEX_TOKENS = ["hairline", "hairlineSoft"] as const satisfies readonly ColorToken[];

export const fonts = {
  display: "Cormorant_600SemiBold",
  displayItalic: "Cormorant_500Medium_Italic",
  body: "HankenGrotesk_400Regular",
  bodyMedium: "HankenGrotesk_500Medium",
  bodySemibold: "HankenGrotesk_600SemiBold",
  bodyBold: "HankenGrotesk_700Bold",
} as const;

export const space = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  sm: 12,
  md: 18,
  lg: 26,
  pill: 999,
} as const;

export const type = {
  label: 11,
  caption: 13,
  body: 16,
  lead: 20,
  title: 30,
  display: 44,
} as const;

export const layout = {
  gutter: 20,
  maxContent: 520,
  minTouch: 48,
} as const;
