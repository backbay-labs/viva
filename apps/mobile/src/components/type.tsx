import type { PropsWithChildren } from "react";
import { StyleSheet, Text, type TextProps, type TextStyle } from "react-native";

import { colors, fonts, type as typeScale } from "@/theme/tokens";

type TextVariant = "caption" | "display" | "eyebrow" | "lead" | "title" | "body";
type TextTone = "ink" | "muted" | "plum" | "sage" | "ochre";

type VivaTextProps = PropsWithChildren<
  TextProps & {
    variant?: TextVariant;
    tone?: TextTone;
  }
>;

const toneStyles: Record<TextTone, TextStyle> = {
  ink: { color: colors.inkStrong },
  muted: { color: colors.inkMuted },
  plum: { color: colors.plumVivid },
  sage: { color: colors.sageDeep },
  ochre: { color: colors.ochre },
};

export function VivaText({
  children,
  style,
  tone = "ink",
  variant = "body",
  ...props
}: VivaTextProps) {
  return (
    <Text
      allowFontScaling
      maxFontSizeMultiplier={variant === "display" ? 1.45 : 1.8}
      style={[styles.base, styles[variant], toneStyles[tone], style]}
      {...props}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    fontFamily: fonts.body,
    includeFontPadding: false,
  },
  body: {
    fontSize: typeScale.body,
    lineHeight: 24,
  },
  caption: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    lineHeight: 18,
  },
  display: {
    fontFamily: fonts.display,
    fontSize: typeScale.display,
    letterSpacing: -0.4,
    lineHeight: 46,
  },
  eyebrow: {
    fontFamily: fonts.bodyBold,
    fontSize: typeScale.label,
    letterSpacing: 1.7,
    lineHeight: 16,
    textTransform: "uppercase",
  },
  lead: {
    fontFamily: fonts.display,
    fontSize: typeScale.lead,
    lineHeight: 26,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: typeScale.title,
    letterSpacing: -0.15,
    lineHeight: 35,
  },
});
