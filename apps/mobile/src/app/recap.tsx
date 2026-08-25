import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionButton } from "@/components/actions";
import { ArrowUpRightIcon, OrnamentRule, SparkIcon } from "@/components/brand";
import { VivaText } from "@/components/type";
import { VoiceOrb } from "@/components/voice-orb";
import { colors, fonts, layout, radius, space } from "@/theme/tokens";

const ledger = [
  { count: 12, label: "strong", color: colors.sageDeep },
  { count: 3, label: "shaky", color: colors.ochre },
  { count: 2, label: "tomorrow", color: colors.plumVivid },
];

const moments = [
  {
    detail: "The course uses a shuttle-dependent range rather than one fixed yield.",
    source: "Lecture 5 · slide 12",
    title: "ATP yield—you said 36; use 30–32 for this course.",
  },
  {
    detail: "Connect NADH electron donation to proton pumping and the gradient.",
    source: "Lecture 5 · slide 18",
    title: "You skipped the mechanism of the proton shuttle.",
  },
];

export default function RecapScreen() {
  const router = useRouter();
  const [openMoment, setOpenMoment] = useState<number | null>(null);
  const [scheduled, setScheduled] = useState(false);

  const scheduleReview = () => {
    setScheduled(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const backToToday = () => {
    if (router.canDismiss()) {
      router.dismissAll();
    } else {
      router.replace("/");
    }
  };

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Close recap"
          accessibilityRole="button"
          hitSlop={10}
          onPress={backToToday}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <VivaText style={styles.closeGlyph}>×</VivaText>
        </Pressable>
        <VivaText style={styles.headerTitle} variant="caption">
          Session recap
        </VivaText>
        <Pressable
          accessibilityLabel="Share recap"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() =>
            void Share.share({
              message: "Viva session: 12 concepts strong, 3 shaky, and 2 scheduled for tomorrow.",
              title: "Viva session recap",
            })
          }
          style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}
        >
          <ArrowUpRightIcon size={19} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <VoiceOrb size={72} state="complete" />
          <VivaText accessibilityRole="header" style={styles.title} variant="display">
            Session complete
          </VivaText>
          <OrnamentRule align="center" compact />
          <VivaText style={styles.summary} tone="muted">
            Your mechanism held. ATP accounting needs one more pass.
          </VivaText>
        </View>

        <View accessibilityLabel="Mastery summary" style={styles.ledger}>
          {ledger.map((item, index) => (
            <View
              key={item.label}
              style={[styles.ledgerRow, index < ledger.length - 1 && styles.ledgerRowBorder]}
            >
              <View style={[styles.ledgerDot, { backgroundColor: item.color }]} />
              <VivaText style={[styles.ledgerCount, { color: item.color }]}>{item.count}</VivaText>
              <VivaText style={styles.ledgerLabel} variant="lead">
                {item.label}
              </VivaText>
            </View>
          ))}
        </View>

        <View style={styles.momentsSection}>
          <VivaText variant="lead">Moments worth revisiting</VivaText>
          <View style={styles.momentsList}>
            {moments.map((moment, index) => {
              const expanded = openMoment === index;
              return (
                <Pressable
                  accessibilityHint={expanded ? "Collapse source detail" : "Expand source detail"}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  key={moment.source}
                  onPress={() => setOpenMoment(expanded ? null : index)}
                  style={({ pressed }) => [
                    styles.moment,
                    index < moments.length - 1 && styles.momentBorder,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.momentRule} />
                  <View style={styles.momentTopline}>
                    <View style={styles.momentCopy}>
                      <VivaText style={styles.momentTitle}>{moment.title}</VivaText>
                      <VivaText tone="plum" variant="caption">
                        {moment.source}
                      </VivaText>
                    </View>
                    <VivaText
                      aria-hidden
                      style={[styles.momentChevron, expanded && styles.momentChevronOpen]}
                    >
                      ›
                    </VivaText>
                  </View>
                  {expanded ? (
                    <VivaText
                      accessibilityLiveRegion="polite"
                      style={styles.momentDetail}
                      tone="muted"
                    >
                      {moment.detail}
                    </VivaText>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.plan}>
          <View style={styles.planDate}>
            <VivaText tone="plum" variant="eyebrow">
              Next recall
            </VivaText>
            <VivaText style={styles.planTitle} variant="title">
              Tomorrow · 8 min
            </VivaText>
          </View>
          <VivaText tone="muted">NADH · ATP yield · shuttle systems</VivaText>
        </View>

        <View style={styles.actions}>
          {scheduled ? (
            <View accessibilityLiveRegion="polite" style={styles.scheduledNote}>
              <SparkIcon color={colors.sageDeep} size={15} />
              <VivaText style={styles.scheduledText} tone="sage">
                Tomorrow’s drill is scheduled.
              </VivaText>
            </View>
          ) : (
            <ActionButton onPress={scheduleReview}>Schedule tomorrow’s drill</ActionButton>
          )}
          <ActionButton onPress={backToToday} tone="secondary">
            Back to Today
          </ActionButton>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: space.sm,
    paddingBottom: space.lg,
  },
  closeGlyph: {
    fontSize: 28,
    lineHeight: 30,
  },
  header: {
    alignItems: "center",
    borderBottomColor: colors.hairlineSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 56,
    paddingHorizontal: layout.gutter,
  },
  headerButton: {
    alignItems: "flex-start",
    justifyContent: "center",
    minHeight: layout.minTouch,
    minWidth: layout.minTouch,
  },
  headerTitle: {
    fontFamily: fonts.bodySemibold,
  },
  hero: {
    alignItems: "center",
    gap: space.sm,
    paddingBottom: space.lg,
    paddingTop: space.md,
  },
  ledger: {
    backgroundColor: colors.sheet,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.md,
  },
  ledgerCount: {
    fontFamily: fonts.display,
    fontSize: 36,
    lineHeight: 38,
    minWidth: 52,
  },
  ledgerDot: {
    borderRadius: 6,
    height: 11,
    width: 11,
  },
  ledgerLabel: {
    color: colors.inkSecondary,
    flex: 1,
    textAlign: "right",
  },
  ledgerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
    minHeight: 68,
  },
  ledgerRowBorder: {
    borderBottomColor: colors.hairlineSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  moment: {
    gap: space.sm,
    paddingLeft: space.sm,
    paddingVertical: space.md,
    position: "relative",
  },
  momentBorder: {
    borderBottomColor: colors.hairlineSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  momentChevron: {
    color: colors.inkMuted,
    fontSize: 24,
    lineHeight: 26,
  },
  momentChevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  momentCopy: {
    flex: 1,
    gap: space.xs,
  },
  momentDetail: {
    borderTopColor: colors.hairlineSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.sm,
  },
  momentRule: {
    backgroundColor: "rgba(189, 154, 85, 0.55)",
    bottom: space.md + 2,
    left: 0,
    position: "absolute",
    top: space.md + 2,
    width: 1,
  },
  momentTitle: {
    color: colors.inkSecondary,
  },
  momentTopline: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
  },
  momentsList: {
    backgroundColor: colors.sheet,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.md,
  },
  momentsSection: {
    gap: space.sm,
    marginTop: space.xl,
  },
  plan: {
    borderBottomColor: colors.hairline,
    borderBottomWidth: 1,
    borderTopColor: colors.hairline,
    borderTopWidth: 1,
    gap: space.xs,
    marginVertical: space.xl,
    paddingVertical: space.lg,
  },
  planDate: {
    gap: space.xs,
  },
  planTitle: {
    fontSize: 28,
  },
  pressed: {
    opacity: 0.62,
  },
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  scheduledNote: {
    alignItems: "center",
    backgroundColor: colors.sageWash,
    borderColor: "rgba(102, 124, 97, 0.24)",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: space.sm,
    justifyContent: "center",
    minHeight: 56,
    padding: space.md,
  },
  scheduledText: {
    fontFamily: fonts.bodySemibold,
  },
  scrollContent: {
    alignSelf: "center",
    maxWidth: layout.maxContent,
    paddingHorizontal: layout.gutter,
    width: "100%",
  },
  shareButton: {
    alignItems: "flex-end",
    justifyContent: "center",
    minHeight: layout.minTouch,
    minWidth: layout.minTouch,
  },
  summary: {
    maxWidth: 330,
    textAlign: "center",
  },
  title: {
    fontSize: 40,
    lineHeight: 44,
    textAlign: "center",
  },
});
