import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { VivaText } from "@/components/type";
import { colors, space } from "@/theme/tokens";

/**
 * Four-point manuscript spark. `radius` is the vertical arm; horizontal arms
 * are slightly shorter so the star reads as hand-set, not geometric.
 */
export function sparkPathD(cx: number, cy: number, radius: number) {
  const arm = radius * 0.82;
  const waist = radius * 0.16;
  return [
    `M ${cx} ${cy - radius}`,
    `Q ${cx + waist} ${cy - waist} ${cx + arm} ${cy}`,
    `Q ${cx + waist} ${cy + waist} ${cx} ${cy + radius}`,
    `Q ${cx - waist} ${cy + waist} ${cx - arm} ${cy}`,
    `Q ${cx - waist} ${cy - waist} ${cx} ${cy - radius}`,
    "Z",
  ].join(" ");
}

export function ArrowUpRightIcon({
  color = colors.inkStrong,
  size = 18,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <Svg aria-hidden height={size} viewBox="0 0 20 20" width={size}>
      <Path
        d="M 5.5 14.5 L 14 6 M 7 5.5 H 14.5 V 13"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
      />
    </Svg>
  );
}

export function SparkIcon({ color = colors.gold, size = 16 }: { color?: string; size?: number }) {
  return (
    <Svg aria-hidden height={size} viewBox="0 0 20 20" width={size}>
      <Path d={sparkPathD(10, 10, 9)} fill={color} />
    </Svg>
  );
}

export function Spark({ size = 16, color = colors.gold }: { size?: number; color?: string }) {
  return (
    <VivaText
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ color, fontSize: size, lineHeight: size }}
    >
      ✦
    </VivaText>
  );
}

export function Wordmark() {
  return (
    <View accessibilityLabel="Viva" accessibilityRole="header" style={styles.wordmark}>
      <VivaText style={styles.wordmarkText}>Viva</VivaText>
      <View style={styles.wordmarkSpark}>
        <SparkIcon size={10} />
      </View>
    </View>
  );
}

export function OrnamentRule({
  align = "leading",
  compact = false,
}: {
  align?: "center" | "leading";
  compact?: boolean;
}) {
  return (
    <View accessibilityElementsHidden style={[styles.rule, compact && styles.ruleCompact]}>
      {align === "center" ? <View style={styles.ruleLine} /> : null}
      <SparkIcon size={compact ? 10 : 12} />
      <View style={styles.ruleLine} />
    </View>
  );
}

const styles = StyleSheet.create({
  rule: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space.sm,
    width: 112,
  },
  ruleCompact: {
    alignSelf: "center",
    width: 76,
  },
  ruleLine: {
    backgroundColor: "rgba(189, 154, 85, 0.55)",
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  wordmark: {
    alignSelf: "flex-start",
    position: "relative",
  },
  wordmarkSpark: {
    position: "absolute",
    right: -12,
    top: 0,
  },
  wordmarkText: {
    color: colors.inkStrong,
    fontFamily: "Cormorant_600SemiBold",
    fontSize: 31,
    lineHeight: 32,
  },
});
