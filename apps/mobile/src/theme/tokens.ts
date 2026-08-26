import { vivaColors } from "@viva/tokens";

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
  plumVivid: "#6E429B",
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
  plumMark: "#6E429B",
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
