import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionButton } from "@/components/actions";
import { OrnamentRule, SparkIcon, Wordmark } from "@/components/brand";
import { VivaText } from "@/components/type";
import {
  decideMobileLibraryStart,
  type LoadedLibrary,
  loadLibrary,
} from "@/library/library-client";
import { loadAppConfig } from "@/runtime/config";
import { colors, fonts, layout, radius, space } from "@/theme/tokens";

export default function LibraryScreen() {
  const router = useRouter();
  const config = useMemo(() => loadAppConfig(), []);
  const [library, setLibrary] = useState<LoadedLibrary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickerNote, setPickerNote] = useState<string | null>(null);

  const refreshLibrary = useCallback(
    async (pulled = false) => {
      if (pulled) setRefreshing(true);
      setLoadError(false);
      try {
        setLibrary(await loadLibrary(config));
      } catch {
        setLoadError(true);
      } finally {
        if (pulled) setRefreshing(false);
      }
    },
    [config],
  );

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const chooseDocument = async () => {
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: ["application/pdf", "text/plain", "application/vnd.ms-powerpoint"],
      });
      if (!result.canceled) {
        const count = result.assets.length;
        setPickerNote(
          `${count} file${count === 1 ? "" : "s"} selected locally — nothing was uploaded.`,
        );
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

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            onRefresh={() => void refreshLibrary(true)}
            refreshing={refreshing}
            tintColor={colors.plumVivid}
          />
        }
        showsVerticalScrollIndicator={false}
      >
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
              <VivaText variant="lead">Your study sets</VivaText>
              <VivaText tone="muted" variant="caption">
                {library
                  ? `${library.projection.libraryRows.length} live folios`
                  : "From the agent"}
              </VivaText>
            </View>
          </View>
        </View>

        <View accessibilityLabel="Study sets from the Viva agent" style={styles.sourceList}>
          {!library && !loadError ? (
            <View accessibilityLiveRegion="polite" style={styles.stateCard}>
              <ActivityIndicator color={colors.plumVivid} />
              <VivaText tone="muted">Opening the library…</VivaText>
            </View>
          ) : null}
          {loadError ? (
            <View accessibilityLiveRegion="polite" style={styles.stateCard}>
              <VivaText style={styles.stateTitle} variant="lead">
                The folios are out of reach.
              </VivaText>
              <VivaText tone="muted">
                The library is unreachable. Start the local agent, then pull to retry.
              </VivaText>
            </View>
          ) : null}
          {library && library.projection.libraryRows.length === 0 ? (
            <View accessibilityLiveRegion="polite" style={styles.stateCard}>
              <VivaText style={styles.stateTitle} variant="lead">
                No folios yet.
              </VivaText>
              <VivaText tone="muted">
                The agent returned an empty library. Stage 2 will add ingestion from mobile.
              </VivaText>
            </View>
          ) : null}
          {library?.projection.libraryRows.map((row, index) => {
            const startDecision = decideMobileLibraryStart(config, library.snapshot, row.id);
            return (
              <View
                key={row.id}
                style={[
                  styles.sourceRow,
                  index < library.projection.libraryRows.length - 1 && styles.sourceRowBorder,
                ]}
              >
                <View style={styles.documentMark}>
                  <VivaText aria-hidden tone="plum">
                    §
                  </VivaText>
                </View>
                <View style={styles.sourceCopy}>
                  <View style={styles.rowHeading}>
                    <VivaText style={styles.sourceName}>{row.title}</VivaText>
                    <VivaText
                      tone={row.statusLabel === "Ready" ? "sage" : "muted"}
                      variant="caption"
                    >
                      {row.statusLabel}
                    </VivaText>
                  </View>
                  <VivaText tone="muted" variant="caption">
                    {[row.course, row.detail, row.documentSummary].filter(Boolean).join(" · ")}
                  </VivaText>
                  <ActionButton
                    accessibilityHint={`Starts recall from ${row.title}`}
                    disabled={!startDecision.canStart}
                    onPress={() =>
                      router.push({ pathname: "/session", params: { studySetId: row.id } })
                    }
                    style={styles.startButton}
                    tone="tint"
                  >
                    {startDecision.canStart ? "Begin recall" : "Recall unavailable"}
                  </ActionButton>
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.uploadSection}>
          <VivaText variant="lead">Add course material</VivaText>
          <VivaText tone="muted">
            File selection is preview-only. Ingestion upload arrives with the library milestone in
            Stage 2; nothing selected here is saved to Viva.
          </VivaText>
          {pickerNote ? (
            <VivaText tone="ochre" variant="caption">
              {pickerNote}
            </VivaText>
          ) : null}
          <ActionButton loading={picking} onPress={() => void chooseDocument()} tone="tint">
            Preview PDFs, slides, or notes
          </ActionButton>
        </View>

        <View style={styles.actions}>
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
  rowHeading: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: space.sm,
    justifyContent: "space-between",
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
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space.sm,
    minHeight: 72,
    paddingVertical: space.md,
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
  startButton: {
    alignSelf: "flex-start",
    marginTop: space.xs,
    minHeight: layout.minTouch,
  },
  stateCard: {
    alignItems: "flex-start",
    gap: space.sm,
    minHeight: 112,
    justifyContent: "center",
    paddingVertical: space.lg,
  },
  stateTitle: {
    color: colors.inkStrong,
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
