export const vivaColors = {
  bg: "#f4efe6",
  bgDeep: "#efe8dc",
  paper: "#faf7f1",
  paperRaised: "#fdfbf6",
  ink: "#2c2536",
  inkSecondary: "#5d5670",
  inkTertiary: "#938aa4",
  inkFaint: "#b6adc1",
  plum: "#7a5ba6",
  plumDeep: "#553b78",
  plumSoft: "#a98fce",
  plumWash: "#efe7f6",
  sage: "#7f9277",
  sageWash: "#e9eee4",
  gold: "#bd9a55",
  goldWash: "#f3ebd8",
  amber: "#c1864a",
  amberWash: "#f4e7d6",
  lavender: "#c3b2dd",
} as const;

export const vivaRadii = {
  small: "12px",
  regular: "18px",
  large: "26px",
} as const;

export const vivaTypography = {
  serif: '"Cormorant", Georgia, serif',
  sans: '"Hanken Grotesk", "Avenir Next", -apple-system, BlinkMacSystemFont, sans-serif',
} as const;

export type VivaColorName = keyof typeof vivaColors;
