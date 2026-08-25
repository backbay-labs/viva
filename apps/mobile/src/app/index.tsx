import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { ActionButton } from "@/components/actions";
import { OrnamentRule, SparkIcon, Wordmark } from "@/components/brand";
import { VivaText } from "@/components/type";
import { OrbBackdrop, VoiceOrb } from "@/components/voice-orb";
import { colors, fonts, layout, radius, space } from "@/theme/tokens";

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const beginRecall = () => {
    router.push("/session");
  };

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <ScrollView
        alwaysBounceVertical={false}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, space.md) + space.xs },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Wordmark />
          <Pressable
            accessibilityHint="Open your uploaded study materials"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => router.push("/library")}
            style={({ pressed }) => [styles.libraryLink, pressed && styles.pressed]}
          >
            <VivaText style={styles.libraryLinkText} variant="caption">
              Library
            </VivaText>
          </Pressable>
        </View>

        <Pressable
          accessibilityHint="Open the Biology Midterm study set"
          accessibilityRole="button"
          hitSlop={{ bottom: 4, top: 4 }}
          onPress={() => router.push("/library")}
          style={({ pressed }) => [styles.studyContext, pressed && styles.pressed]}
        >
          <VivaText aria-hidden style={styles.leafText} tone="sage">
            ◇
          </VivaText>
          <VivaText style={styles.contextTitle} variant="caption">
            Biology Midterm
          </VivaText>
          <VivaText tone="muted" variant="caption">
            · exam Friday
          </VivaText>
          <VivaText aria-hidden style={styles.contextChevron}>
            ›
          </VivaText>
        </Pressable>

        <View style={styles.heroCopy}>
          <VivaText tone="muted" variant="eyebrow">
            Monday · 24 August
          </VivaText>
          <VivaText accessibilityRole="header" style={styles.greeting} variant="display">
            Good evening,{"\n"}Ananya.
          </VivaText>
          <OrnamentRule />
          <VivaText style={styles.promise}>Close the notes. Begin recall.</VivaText>
        </View>

        <View style={styles.orbStage}>
          <OrbBackdrop />
          <Pressable
            accessibilityHint="Starts your voice session"
            accessibilityLabel="Begin recall"
            accessibilityRole="button"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              beginRecall();
            }}
            style={({ pressed }) => pressed && styles.orbPressed}
          >
            <VoiceOrb size={166} state="ready" />
          </Pressable>
        </View>

        <Pressable
          accessibilityHint="Review the weak concept before starting"
          accessibilityRole="button"
          onPress={() => router.push("/library")}
          style={({ pressed }) => [styles.conceptRow, pressed && styles.cardPressed]}
        >
          <View style={styles.conceptMark}>
            <SparkIcon color={colors.plumVivid} size={18} />
          </View>
          <View style={styles.conceptCopy}>
            <VivaText tone="muted" variant="caption">
              Weak concept · missed twice
            </VivaText>
            <VivaText style={styles.conceptTitle} variant="lead">
              Cellular respiration
            </VivaText>
          </View>
          <VivaText aria-hidden style={styles.chevron}>
            ›
          </VivaText>
        </Pressable>

        <View style={styles.primaryBlock}>
          <ActionButton
            accessibilityHint="Starts a spoken recall session"
            icon={<SparkIcon color={colors.plumSoft} size={15} />}
            onPress={beginRecall}
          >
            Begin recall
          </ActionButton>
          <VivaText style={styles.privacyNote} tone="muted" variant="caption">
            Microphone access starts only after you tap Start listening.
          </VivaText>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cardPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  chevron: {
    color: colors.inkMuted,
    fontFamily: fonts.body,
    fontSize: 24,
    lineHeight: 26,
  },
  conceptCopy: {
    flex: 1,
    gap: 3,
  },
  conceptMark: {
    alignItems: "center",
    backgroundColor: colors.plumWash,
    borderColor: colors.plumLine,
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 46,
    justifyContent: "center",
    width: 46,
  },
  conceptRow: {
    alignItems: "center",
    backgroundColor: colors.sheet,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: space.sm,
    minHeight: 88,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  conceptTitle: {
    fontSize: 22,
    lineHeight: 27,
  },
  contextChevron: {
    color: colors.inkMuted,
    fontFamily: fonts.body,
    fontSize: 17,
    lineHeight: 18,
  },
  contextTitle: {
    color: colors.inkStrong,
    fontFamily: fonts.bodySemibold,
  },
  greeting: {
    marginTop: space.xxs,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
  },
  heroCopy: {
    alignItems: "flex-start",
    gap: space.sm,
    marginTop: space.md,
  },
  leafText: {
    fontSize: 14,
    lineHeight: 16,
  },
  libraryLink: {
    alignItems: "center",
    borderColor: colors.hairline,
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  libraryLinkText: {
    fontFamily: fonts.bodySemibold,
  },
  orbPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.97 }],
  },
  orbStage: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "center",
    minHeight: 250,
    position: "relative",
  },
  pressed: {
    opacity: 0.68,
  },
  primaryBlock: {
    gap: space.sm,
    marginTop: space.md,
  },
  privacyNote: {
    alignSelf: "center",
    maxWidth: 320,
    textAlign: "center",
  },
  promise: {
    color: colors.inkSecondary,
    fontSize: 17,
    lineHeight: 24,
  },
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  scrollContent: {
    alignSelf: "center",
    flexGrow: 1,
    maxWidth: layout.maxContent,
    paddingHorizontal: layout.gutter,
    width: "100%",
  },
  studyContext: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.sheet,
    borderColor: colors.hairlineSoft,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    height: 40,
    marginTop: space.sm,
    paddingHorizontal: 14,
  },
});
