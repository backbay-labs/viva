import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { useRouter } from "expo-router";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActionButton } from "@/components/actions";
import { OrnamentRule, SparkIcon } from "@/components/brand";
import { VivaText } from "@/components/type";
import { VoiceOrb, VoiceStateLabel, VoiceWaveform } from "@/components/voice-orb";
import {
  buildPrototypeCorrection,
  initialSessionState,
  type SessionPhase,
  sessionReducer,
} from "@/features/session/session-machine";
import { colors, fonts, layout, radius, space } from "@/theme/tokens";

const question = "Explain the role of NADH in oxidative phosphorylation.";
const syntheticAnswer = "I think it produces 36 ATP.";

const phaseAnnouncements: Record<SessionPhase, string> = {
  correction: "Correction ready",
  listening: "Viva is listening",
  "mic-blocked": "Microphone unavailable. Typed answer is ready.",
  ready: "Question ready",
  requesting: "Requesting microphone access",
  thinking: "Viva is reading your answer",
};

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export default function SessionScreen() {
  const router = useRouter();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [session, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [elapsed, setElapsed] = useState(0);
  const [hintVisible, setHintVisible] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const evaluationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (session.phase !== "listening") {
      return;
    }
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [session.phase]);

  useEffect(() => {
    if (session.phase !== "ready") {
      AccessibilityInfo.announceForAccessibility(phaseAnnouncements[session.phase]);
    }
  }, [session.phase]);

  useEffect(
    () => () => {
      if (evaluationTimer.current) {
        clearTimeout(evaluationTimer.current);
      }
    },
    [],
  );

  const scheduleEvaluation = () => {
    evaluationTimer.current = setTimeout(() => {
      dispatch({ type: "EVALUATED" });
    }, 1200);
  };

  const startListening = async () => {
    dispatch({ type: "BEGIN" });
    setTyping(false);
    // The recorder can stall without rejecting (notably on simulators), so a
    // watchdog converts a silent hang into the honest typed-answer fallback.
    let outcome: "failed" | "pending" | "recording" = "pending";
    const failToTyping = (message: string) => {
      if (outcome !== "pending") {
        return;
      }
      outcome = "failed";
      dispatch({ message, type: "MIC_DENIED" });
      setTyping(true);
    };
    const watchdog = setTimeout(() => {
      failToTyping("The microphone did not start. Your session is intact; answer in writing.");
    }, 8000);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (outcome !== "pending") {
        return;
      }
      if (!permission.granted) {
        failToTyping(
          "Microphone access is off. You can answer in writing or enable it in Settings.",
        );
        return;
      }

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (outcome !== "pending") {
        return;
      }
      recorder.record();
      outcome = "recording";
      dispatch({ type: "MIC_GRANTED" });
    } catch {
      failToTyping(
        "Viva could not start the microphone. Your session is intact; answer in writing.",
      );
    } finally {
      clearTimeout(watchdog);
    }
  };

  const finishSpokenAnswer = async () => {
    try {
      await recorder.stop();
    } finally {
      dispatch({ type: "SUBMIT" });
      scheduleEvaluation();
    }
  };

  const submitTypedAnswer = () => {
    if (!typedAnswer.trim()) {
      AccessibilityInfo.announceForAccessibility("Write an answer before submitting.");
      return;
    }
    dispatch({ type: "SUBMIT" });
    scheduleEvaluation();
  };

  const finishSession = async () => {
    if (session.phase === "listening") {
      try {
        await recorder.stop();
      } catch {
        // The recorder may already be stopped by the native audio session.
      }
    }
    router.replace("/recap");
  };

  const retry = () => {
    dispatch({ type: "RETRY" });
    setTypedAnswer("");
    setHintVisible(false);
    setSourceVisible(false);
    setTyping(false);
  };

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Leave session"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => (router.canDismiss() ? router.dismissAll() : router.replace("/"))}
            style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          >
            <VivaText style={styles.closeGlyph}>×</VivaText>
          </Pressable>
          <View style={styles.sessionIdentity}>
            <SparkIcon color={colors.sageDeep} size={11} />
            <VivaText style={styles.sessionIdentityText} variant="caption">
              Biology Midterm
            </VivaText>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => void finishSession()}
            style={({ pressed }) => [styles.endAction, pressed && styles.pressed]}
          >
            <VivaText tone="ochre" variant="caption">
              End
            </VivaText>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {session.phase === "correction" ? (
            <CorrectionView
              answer={typedAnswer.trim() || syntheticAnswer}
              feedback={buildPrototypeCorrection(typedAnswer.trim() || syntheticAnswer)}
            />
          ) : (
            <View style={styles.sessionBody}>
              <View style={styles.statusBlock}>
                <View style={styles.timerRow}>
                  <View style={styles.timerDot} />
                  <VivaText accessibilityLabel={`${elapsed} seconds elapsed`} style={styles.timer}>
                    {formatElapsed(elapsed)}
                  </VivaText>
                  <View style={styles.timerDot} />
                </View>
                <VoiceStateLabel>
                  {session.phase === "requesting"
                    ? "Opening microphone…"
                    : session.phase === "listening"
                      ? "Listening"
                      : session.phase === "thinking"
                        ? "Reading your answer…"
                        : "Question ready"}
                </VoiceStateLabel>
              </View>

              <View style={styles.orbBlock}>
                <VoiceOrb
                  size={156}
                  state={
                    session.phase === "listening"
                      ? "listening"
                      : session.phase === "thinking" || session.phase === "requesting"
                        ? "thinking"
                        : "ready"
                  }
                />
              </View>

              <View style={styles.questionBlock}>
                <VivaText accessibilityRole="header" style={styles.question} variant="title">
                  {question}
                </VivaText>
                {session.phase === "listening" ? <VoiceWaveform /> : null}
              </View>

              {hintVisible ? (
                <View accessibilityLiveRegion="polite" style={styles.disclosure}>
                  <VivaText tone="plum" variant="eyebrow">
                    One foothold
                  </VivaText>
                  <VivaText style={styles.disclosureCopy}>
                    Start with what NADH donates, then explain what that transfer makes possible.
                  </VivaText>
                </View>
              ) : null}

              {sourceVisible ? (
                <View accessibilityLiveRegion="polite" style={styles.disclosure}>
                  <VivaText tone="plum" variant="eyebrow">
                    Source boundary
                  </VivaText>
                  <VivaText style={styles.disclosureCopy}>
                    Lecture 5 · slides 12–18. The passage stays closed until after recall.
                  </VivaText>
                </View>
              ) : null}

              {session.phase === "mic-blocked" ? (
                <View accessibilityLiveRegion="assertive" style={styles.recovery}>
                  <VivaText tone="ochre" variant="eyebrow">
                    Microphone unavailable
                  </VivaText>
                  <VivaText style={styles.recoveryCopy}>{session.recoveryMessage}</VivaText>
                </View>
              ) : null}

              {typing ? (
                <View style={styles.answerField}>
                  <VivaText nativeID="answer-label" tone="muted" variant="eyebrow">
                    Your answer
                  </VivaText>
                  <TextInput
                    accessibilityLabelledBy="answer-label"
                    autoFocus={session.phase === "mic-blocked"}
                    multiline
                    onChangeText={setTypedAnswer}
                    placeholder="Explain it from memory…"
                    placeholderTextColor={colors.inkTertiary}
                    style={styles.input}
                    textAlignVertical="top"
                    value={typedAnswer}
                  />
                  <ActionButton onPress={submitTypedAnswer}>Submit answer</ActionButton>
                </View>
              ) : null}

              <View style={styles.actionDock}>
                {session.phase === "ready" && !typing ? (
                  <ActionButton
                    icon={<SparkIcon color={colors.plumSoft} size={15} />}
                    onPress={() => void startListening()}
                  >
                    Start listening
                  </ActionButton>
                ) : null}
                {session.phase === "requesting" ? (
                  <ActionButton loading>Opening microphone</ActionButton>
                ) : null}
                {session.phase === "listening" ? (
                  <ActionButton onPress={() => void finishSpokenAnswer()}>
                    Finish answer
                  </ActionButton>
                ) : null}
                <View style={styles.secondaryActions}>
                  <ActionButton
                    disabled={session.phase === "requesting" || session.phase === "thinking"}
                    onPress={() => setHintVisible((value) => !value)}
                    style={styles.secondaryAction}
                    tone="tint"
                  >
                    {hintVisible ? "Hide hint" : "Hint"}
                  </ActionButton>
                  <ActionButton
                    disabled={session.phase === "requesting" || session.phase === "thinking"}
                    onPress={() => {
                      setTyping((value) => !value);
                      if (!typing) setSourceVisible(false);
                    }}
                    style={styles.secondaryAction}
                    tone="secondary"
                  >
                    {typing ? "Hide typing" : "Type answer"}
                  </ActionButton>
                </View>
                <ActionButton
                  disabled={session.phase === "requesting" || session.phase === "thinking"}
                  onPress={() => setSourceVisible((value) => !value)}
                  tone="quiet"
                >
                  {sourceVisible ? "Close source note" : "Why this source?"}
                </ActionButton>
              </View>
            </View>
          )}
        </ScrollView>

        {session.phase === "correction" ? (
          <View style={styles.correctionDock}>
            <ActionButton icon={<SparkIcon color={colors.plumSoft} size={15} />} onPress={retry}>
              Try again
            </ActionButton>
            <ActionButton onPress={() => void finishSession()} tone="secondary">
              Complete session
            </ActionButton>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function CorrectionView({
  answer,
  feedback,
}: {
  answer: string;
  feedback: ReturnType<typeof buildPrototypeCorrection>;
}) {
  const [sourceExpanded, setSourceExpanded] = useState(false);

  return (
    <View style={styles.correctionBody}>
      <View style={styles.correctionHeading}>
        <VoiceOrb size={76} state="correcting" />
        <VivaText tone="ochre" variant="eyebrow">
          Gentle correction
        </VivaText>
        <VivaText accessibilityRole="header" style={styles.correctionTitle} variant="title">
          {feedback.title}
        </VivaText>
        <OrnamentRule align="center" compact />
      </View>

      <View style={styles.manuscript}>
        <View style={styles.manuscriptSection}>
          <VivaText tone="plum" variant="caption">
            You said
          </VivaText>
          <VivaText style={styles.answerQuote} variant="lead">
            {answer}
          </VivaText>
        </View>
        <View style={styles.manuscriptRule} />
        <View style={styles.manuscriptSection}>
          <VivaText tone="plum" variant="caption">
            Correction
          </VivaText>
          <VivaText style={styles.correctionCopy}>{feedback.correction}</VivaText>
        </View>
        <View style={styles.manuscriptRule} />
        <Pressable
          accessibilityHint="Open the bounded source reference"
          accessibilityRole="button"
          accessibilityState={{ expanded: sourceExpanded }}
          onPress={() => setSourceExpanded((value) => !value)}
          style={({ pressed }) => [styles.sourceRow, pressed && styles.pressed]}
        >
          <View style={styles.sourceMark}>
            <VivaText aria-hidden tone="plum">
              §
            </VivaText>
          </View>
          <View style={styles.sourceCopy}>
            <VivaText tone="plum" variant="caption">
              Source
            </VivaText>
            <VivaText style={styles.sourceTitle} variant="caption">
              {feedback.source}
            </VivaText>
          </View>
          <VivaText
            aria-hidden
            style={[styles.sourceChevron, sourceExpanded && styles.sourceChevronOpen]}
          >
            ›
          </VivaText>
        </Pressable>
        {sourceExpanded ? (
          <View accessibilityLiveRegion="polite" style={styles.sourceExcerpt}>
            <VivaText tone="muted" variant="caption">
              “{feedback.sourceExcerpt}”
            </VivaText>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actionDock: {
    gap: space.sm,
    marginTop: "auto",
    paddingTop: space.lg,
  },
  answerField: {
    gap: space.sm,
    marginTop: space.md,
  },
  answerQuote: {
    fontSize: 21,
    lineHeight: 27,
  },
  closeGlyph: {
    fontFamily: fonts.body,
    fontSize: 28,
    lineHeight: 30,
  },
  correctionBody: {
    flex: 1,
    paddingBottom: space.sm,
  },
  correctionDock: {
    alignSelf: "center",
    gap: space.sm,
    maxWidth: layout.maxContent,
    paddingHorizontal: layout.gutter,
    paddingTop: space.sm,
    width: "100%",
  },
  correctionCopy: {
    fontFamily: fonts.displayItalic,
    fontSize: 22,
    lineHeight: 29,
  },
  correctionHeading: {
    alignItems: "center",
    gap: space.xs,
    paddingTop: space.xs,
  },
  correctionTitle: {
    maxWidth: 330,
    textAlign: "center",
  },
  disclosure: {
    backgroundColor: colors.plumWash,
    borderColor: colors.plumLine,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: space.xs,
    marginTop: space.md,
    padding: space.md,
  },
  disclosureCopy: {
    color: colors.inkSecondary,
  },
  endAction: {
    alignItems: "flex-end",
    justifyContent: "center",
    minHeight: layout.minTouch,
    minWidth: layout.minTouch,
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
  headerAction: {
    alignItems: "flex-start",
    justifyContent: "center",
    minHeight: layout.minTouch,
    minWidth: layout.minTouch,
  },
  input: {
    backgroundColor: colors.sheet,
    borderColor: colors.plumLine,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.inkStrong,
    fontFamily: fonts.body,
    fontSize: 17,
    lineHeight: 25,
    minHeight: 124,
    padding: space.md,
  },
  keyboardView: {
    flex: 1,
  },
  manuscript: {
    backgroundColor: colors.sheet,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: space.lg,
    overflow: "hidden",
  },
  manuscriptRule: {
    backgroundColor: colors.hairlineSoft,
    height: StyleSheet.hairlineWidth,
  },
  manuscriptSection: {
    gap: space.sm,
    padding: space.md,
  },
  orbBlock: {
    alignItems: "center",
    marginTop: -space.xs,
  },
  pressed: {
    opacity: 0.62,
  },
  question: {
    fontSize: 30,
    lineHeight: 37,
    maxWidth: 340,
    textAlign: "center",
  },
  questionBlock: {
    alignItems: "center",
    gap: space.sm,
    marginTop: space.xs,
  },
  recovery: {
    backgroundColor: colors.amberWash,
    borderColor: "rgba(183, 120, 49, 0.25)",
    borderRadius: radius.md,
    borderWidth: 1,
    gap: space.xs,
    marginTop: space.md,
    padding: space.md,
  },
  recoveryCopy: {
    color: colors.inkSecondary,
  },
  safeArea: {
    backgroundColor: colors.canvasDeep,
    flex: 1,
  },
  scrollContent: {
    alignSelf: "center",
    flexGrow: 1,
    maxWidth: layout.maxContent,
    paddingBottom: space.lg,
    paddingHorizontal: layout.gutter,
    width: "100%",
  },
  secondaryAction: {
    flex: 1,
  },
  secondaryActions: {
    flexDirection: "row",
    gap: space.sm,
  },
  sessionBody: {
    flex: 1,
    paddingTop: space.sm,
  },
  sessionIdentity: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.xs,
  },
  sessionIdentityText: {
    fontFamily: fonts.bodySemibold,
  },
  sourceChevron: {
    color: colors.inkMuted,
    fontSize: 24,
    lineHeight: 26,
  },
  sourceChevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  sourceCopy: {
    flex: 1,
    gap: 2,
  },
  sourceMark: {
    alignItems: "center",
    backgroundColor: colors.plumWash,
    borderRadius: radius.pill,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  sourceRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
    minHeight: 58,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  sourceExcerpt: {
    backgroundColor: colors.goldWash,
    borderTopColor: colors.hairlineSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: space.md,
  },
  sourceTitle: {
    color: colors.inkStrong,
    fontFamily: fonts.bodySemibold,
  },
  statusBlock: {
    alignItems: "center",
    gap: space.xxs,
    paddingTop: space.xs,
  },
  timer: {
    color: colors.inkStrong,
    fontFamily: fonts.display,
    fontSize: 28,
    fontVariant: ["tabular-nums"],
    lineHeight: 32,
  },
  timerDot: {
    backgroundColor: colors.gold,
    borderRadius: 2,
    height: 3.5,
    opacity: 0.85,
    width: 3.5,
  },
  timerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
    justifyContent: "center",
  },
});
