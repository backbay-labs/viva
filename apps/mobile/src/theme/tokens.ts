import { vivaColors } from "@viva/tokens";

export const colors = {
  ...vivaColors,
  canvas: "#F7F0E7",
  canvasDeep: "#F1E8DC",
  sheet: "#FFFCF7",
  sheetRaised: "#FFFDF9",
  inkStrong: "#271A30",
  inkMuted: "#766B7E",
  plumVivid: "#6E429B",
  plumNight: "#351A47",
  plumLine: "#DFD0EB",
  sageDeep: "#667C61",
  ochre: "#B77831",
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
