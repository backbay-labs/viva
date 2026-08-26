import * as Haptics from "expo-haptics";
import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";

import { VivaText } from "@/components/type";
import { colors, layout, radius, space } from "@/theme/tokens";

type ActionTone = "primary" | "secondary" | "quiet" | "tint";

type ActionButtonProps = PropsWithChildren<
  Omit<PressableProps, "style"> & {
    icon?: ReactNode;
    loading?: boolean;
    tone?: ActionTone;
    style?: StyleProp<ViewStyle>;
  }
>;

export function ActionButton({
  children,
  disabled,
  icon,
  loading = false,
  onPress,
  onPressIn,
  style,
  tone = "primary",
  ...props
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      onPressIn={(event) => {
        // Fires on press-IN, not release: the impact has to coincide with the
        // moment the surface deepens, or the tap you feel and the dent you see
        // are different events. See the component spec section 12.
        void Haptics.impactAsync(
          tone === "primary"
            ? Haptics.ImpactFeedbackStyle.Medium
            : Haptics.ImpactFeedbackStyle.Light,
        );
        onPressIn?.(event);
      }}
      style={({ pressed }) => [
        styles.base,
        tone === "primary" && styles.primaryShape,
        styles[tone],
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        style,
      ]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={tone === "primary" ? colors.sheet : colors.plumVivid} />
      ) : (
        <>
          {icon ? <View style={styles.icon}>{icon}</View> : null}
          <VivaText
            style={[styles.label, tone === "primary" ? styles.primaryLabel : styles.defaultLabel]}
          >
            {children}
          </VivaText>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space.sm,
    justifyContent: "center",
    minHeight: layout.minTouch + 6,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  primaryShape: {
    borderRadius: radius.pill,
    minHeight: 56,
    paddingHorizontal: space.lg,
  },
  defaultLabel: {
    color: colors.inkStrong,
  },
  disabled: {
    opacity: 0.52,
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 20,
  },
  label: {
    fontFamily: "HankenGrotesk_600SemiBold",
    fontSize: 15,
    letterSpacing: 0.2,
    lineHeight: 20,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.985 }],
  },
  primary: {
    backgroundColor: colors.plumNight,
    boxShadow: "0 12px 26px rgba(53, 26, 71, 0.22)",
    elevation: 5,
  },
  primaryLabel: {
    color: colors.sheet,
  },
  quiet: {
    backgroundColor: "transparent",
  },
  secondary: {
    backgroundColor: colors.sheetRaised,
    borderColor: colors.hairline,
    borderWidth: 1,
  },
  tint: {
    backgroundColor: colors.plumWash,
    borderColor: colors.plumLine,
    borderWidth: 1,
  },
});
