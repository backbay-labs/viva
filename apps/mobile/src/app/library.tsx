import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionButton } from "@/components/actions";
import { OrnamentRule, SparkIcon, Wordmark } from "@/components/brand";
import { VivaText } from "@/components/type";
import { colors, fonts, layout, radius, space } from "@/theme/tokens";

type Source = {
  detail: string;
  id: string;
  name: string;
  type: string;
};

const startingSources: Source[] = [
  { detail: "48 slides", id: "lecture-5", name: "Lecture 5 · Respiration", type: "Slides" },
  { detail: "12 pages", id: "midterm-guide", name: "Midterm study guide", type: "PDF" },
  { detail: "6 pages", id: "review-notes", name: "Ananya’s review notes", type: "Notes" },
];

export default function LibraryScreen() {
  const router = useRouter();
  const [sources, setSources] = useState<Source[]>(startingSources);
  const [picking, setPicking] = useState(false);

  const chooseDocument = async () => {
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: ["application/pdf", "text/plain", "application/vnd.ms-powerpoint"],
      });
      if (!result.canceled) {
        const newSources = result.assets.map((asset) => ({
          detail: asset.size ? `${Math.max(1, Math.round(asset.size / 1024))} KB` : "Ready",
          id: asset.uri,
          name: asset.name,
          type: asset.mimeType?.includes("pdf") ? "PDF" : "Document",
        }));
        setSources((current) => [...current, ...newSources]);
      }
    } finally {
      setPicking(false);
    }
  };

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Today"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <VivaText aria-hidden style={styles.backGlyph}>
            ‹
          </VivaText>
        </Pressable>
        <Wordmark />
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <VivaText tone="muted" variant="eyebrow">
            Your folios
          </VivaText>
          <VivaText accessibilityRole="header" style={styles.title} variant="display">
            Study from what your course actually says.
          </VivaText>
          <OrnamentRule />
          <VivaText style={styles.intro} tone="muted">
            Add slides, readings, or notes. Viva uses them to ask and settle each question.
          </VivaText>
        </View>

        <View style={styles.studySetHeader}>
          <View style={styles.studySetIdentity}>
            <View style={styles.studySetMark}>
              <SparkIcon color={colors.sageDeep} size={15} />
            </View>
            <View>
              <VivaText variant="lead">Biology Midterm</VivaText>
              <VivaText tone="muted" variant="caption">
                {sources.length} sources · exam Friday
              </VivaText>
            </View>
          </View>
          <VivaText tone="sage" variant="caption">
            Ready
          </VivaText>
        </View>

        <View accessibilityLabel="Biology Midterm sources" style={styles.sourceList}>
          {sources.map((source, index) => (
            <View
              key={source.id}
              style={[styles.sourceRow, index < sources.length - 1 && styles.sourceRowBorder]}
            >
              <View style={styles.documentMark}>
                <VivaText aria-hidden tone="plum">
                  §
                </VivaText>
              </View>
              <View style={styles.sourceCopy}>
                <VivaText style={styles.sourceName}>{source.name}</VivaText>
                <VivaText tone="muted" variant="caption">
                  {source.type} · {source.detail}
                </VivaText>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.uploadSection}>
          <VivaText variant="lead">Add course material</VivaText>
          <VivaText tone="muted">
            Files stay attached to this study set. Each correction names the passage it used.
          </VivaText>
          <ActionButton loading={picking} onPress={() => void chooseDocument()} tone="tint">
            Choose PDFs, slides, or notes
          </ActionButton>
        </View>

        <View style={styles.actions}>
          <ActionButton onPress={() => router.push("/session")}>
            Begin recall from this folio
          </ActionButton>
          <ActionButton
            onPress={() => (router.canDismiss() ? router.dismissAll() : router.replace("/"))}
            tone="secondary"
          >
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
  backButton: {
    alignItems: "flex-start",
    justifyContent: "center",
    minHeight: layout.minTouch,
    minWidth: layout.minTouch,
  },
  backGlyph: {
    fontSize: 32,
    lineHeight: 32,
  },
  documentMark: {
    alignItems: "center",
    backgroundColor: colors.plumWash,
    borderRadius: radius.sm,
    height: 42,
    justifyContent: "center",
    width: 42,
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
  headerSpacer: {
    width: layout.minTouch,
  },
  hero: {
    alignItems: "flex-start",
    gap: space.sm,
    paddingBottom: space.xl,
    paddingTop: space.xl,
  },
  intro: {
    maxWidth: 430,
  },
  pressed: {
    opacity: 0.62,
  },
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  scrollContent: {
    alignSelf: "center",
    maxWidth: layout.maxContent,
    paddingHorizontal: layout.gutter,
    width: "100%",
  },
  sourceCopy: {
    flex: 1,
    gap: 2,
  },
  sourceList: {
    backgroundColor: colors.sheet,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.md,
  },
  sourceName: {
    color: colors.inkStrong,
    fontFamily: fonts.bodySemibold,
  },
  sourceRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
    minHeight: 72,
  },
  sourceRowBorder: {
    borderBottomColor: colors.hairlineSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  studySetHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: space.sm,
  },
  studySetIdentity: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
  },
  studySetMark: {
    alignItems: "center",
    borderColor: "rgba(102, 124, 97, 0.28)",
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  title: {
    fontSize: 38,
    lineHeight: 42,
    maxWidth: 420,
  },
  uploadSection: {
    borderBottomColor: colors.hairline,
    borderBottomWidth: 1,
    borderTopColor: colors.hairline,
    borderTopWidth: 1,
    gap: space.sm,
    marginVertical: space.xl,
    paddingVertical: space.lg,
  },
});
