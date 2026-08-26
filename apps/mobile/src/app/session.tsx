import type { StudySet } from "@viva/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
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

import {
  correctionModelFromEvaluation,
  drainSessionPlayback,
  orbStateForSession,
  RECAP_PLAYBACK_MAX_WAIT_MS,
  type RetryAttemptState,
  retryAttemptResolution,
  type SessionCorrectionModel,
  sessionAnswerControlsBusy,
  sessionProviderStatusLabel,
  shouldNavigateToRecap,
  stageCopyForConnection,
} from "@/agent/session-view-model";
import { useMobileVivaSession } from "@/agent/use-mobile-viva-session";
import { ActionButton } from "@/components/actions";
import { OrnamentRule, SparkIcon } from "@/components/brand";
import { VivaText } from "@/components/type";
import { VoiceOrb, VoiceStateLabel, VoiceWaveform } from "@/components/voice-orb";
import {
  loadLibrary,
  selectMobileSessionStudySetId,
  studySetForSession,
} from "@/library/library-client";
import { loadAppConfig } from "@/runtime/config";
import { colors, fonts, layout, radius, space } from "@/theme/tokens";

// Protocol v4 is typed-only. Local PCM capture is a device/readiness seam and
// must not become a transport capability until the protocol-v5 milestone.
const voiceTurnsEnabled = false as const;

type CaptureState = "blocked" | "idle" | "listening" | "requesting" | "stopping";
type SessionLoadState =
  | { kind: "loading" }
  | { kind: "ready"; studySet: StudySet }
  | { kind: "error"; message: string };

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export default function SessionScreen() {
  const params = useLocalSearchParams<{ studySetId?: string | string[] }>();
  const router = useRouter();
  const config = useMemo(() => loadAppConfig(), []);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<SessionLoadState>({ kind: "loading" });
  const requestedStudySetId = Array.isArray(params.studySetId)
    ? params.studySetId[0]
    : params.studySetId;

  useEffect(() => {
    const requestAttempt = loadAttempt;
    void requestAttempt;
    let active = true;
    setLoadState({ kind: "loading" });
    void loadLibrary(config).then(
      ({ snapshot }) => {
        if (!active) return;
        try {
          setLoadState({
            kind: "ready",
            studySet: studySetForSession(
              snapshot,
              selectMobileSessionStudySetId(requestedStudySetId, config),
              config,
              Platform.OS,
            ),
          });
        } catch (error) {
          setLoadState({ kind: "error", message: errorMessage(error) });
        }
      },
      (error) => {
        if (active) setLoadState({ kind: "error", message: errorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [config, loadAttempt, requestedStudySetId]);

  if (loadState.kind === "ready") {
    return <LiveSessionScreen studySet={loadState.studySet} />;
  }

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.safeArea}>
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
        <VivaText style={styles.sessionIdentityText} variant="caption">
          Viva session
        </VivaText>
        <View style={styles.headerAction} />
      </View>
      <View style={styles.loadState}>
        <VoiceOrb size={96} state={loadState.kind === "loading" ? "thinking" : "ready"} />
        <VivaText accessibilityRole="header" style={styles.loadTitle} variant="title">
          {loadState.kind === "loading" ? "Opening your study set…" : "Study set unavailable"}
        </VivaText>
        <VivaText style={styles.loadDetail} tone="muted">
          {loadState.kind === "loading"
            ? "Loading the current library snapshot from the local agent."
            : `${loadState.message} Start the local agent, then retry.`}
        </VivaText>
        {loadState.kind === "error" ? (
          <ActionButton onPress={() => setLoadAttempt((attempt) => attempt + 1)}>
            Retry library
          </ActionButton>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function LiveSessionScreen({ studySet }: { studySet: StudySet }) {
  const router = useRouter();
  const agent = useMobileVivaSession({ mode: "quiz", platform: Platform.OS, studySet });
  const [elapsed, setElapsed] = useState(0);
  const [hintVisible, setHintVisible] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [submittedText, setSubmittedText] = useState<string>();
  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [captureMessage, setCaptureMessage] = useState<string>();
  const [ending, setEnding] = useState(false);
  const [orbLevel, setOrbLevel] = useState(0);
  const [retryAttempt, setRetryAttempt] = useState<RetryAttemptState>();
  const [recapPlaybackWaitExpired, setRecapPlaybackWaitExpired] = useState(false);
  const endingRef = useRef(false);
  const captureCancellationRef = useRef<Promise<void> | null>(null);
  const handledCancelRef = useRef(0);
  const handledGenerationRef = useRef<string | undefined>(undefined);
  const playbackUnlockedRef = useRef(false);
  const previousQuestionRef = useRef<string | undefined>(undefined);
  const hasRecap = Boolean(agent.derived.recap);
  const retrying = retryAttempt !== undefined;
  const retrySubmitted = retryAttempt?.phase === "submitted";

  useEffect(() => {
    if (agent.status !== "open" || agent.derived.recap) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [agent.derived.recap, agent.status]);

  useEffect(() => {
    if (captureState === "requesting") {
      AccessibilityInfo.announceForAccessibility("Requesting microphone access");
    } else if (captureState === "stopping") {
      AccessibilityInfo.announceForAccessibility("Stopping local microphone capture");
    } else if (captureState === "listening") {
      AccessibilityInfo.announceForAccessibility("Viva is listening locally");
    } else if (captureState === "blocked") {
      AccessibilityInfo.announceForAccessibility("Microphone unavailable. Typed answer is ready.");
    } else if (agent.derived.evaluation && !retrying) {
      AccessibilityInfo.announceForAccessibility("Correction ready");
    }
  }, [agent.derived.evaluation, captureState, retrying]);

  useEffect(
    () => () => {
      captureCancellationRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const generationId = agent.agentState.generation?.id;
    if (handledGenerationRef.current !== generationId) {
      handledGenerationRef.current = generationId;
      handledCancelRef.current = 0;
    }
    const audio = agent.agentState.audio;
    const cancellations = agent.agentState.cancelledResponseIds;
    if (audio.length === 0 && cancellations.length === handledCancelRef.current) return;
    handledCancelRef.current = drainSessionPlayback({
      acknowledgeAudio: agent.acknowledgeAudio,
      audio,
      cancellations,
      ending,
      handledCancel: handledCancelRef.current,
      playback: agent.playback,
    });
  }, [
    agent.acknowledgeAudio,
    agent.agentState.audio,
    agent.agentState.cancelledResponseIds,
    agent.agentState.generation?.id,
    agent.playback,
    ending,
  ]);

  useEffect(() => {
    const timer = setInterval(() => {
      const level = agent.speaking
        ? agent.playback.getOutputLevel()
        : captureState === "listening"
          ? agent.capture.getInputLevel()
          : 0;
      setOrbLevel(level);
    }, 80);
    return () => clearInterval(timer);
  }, [agent.capture, agent.playback, agent.speaking, captureState]);

  useEffect(() => {
    const questionId = agent.derived.question?.id;
    if (!questionId || questionId === previousQuestionRef.current) return;
    previousQuestionRef.current = questionId;
    setCaptureMessage(undefined);
    setCaptureState("idle");
    setHintVisible(false);
    setRetryAttempt(undefined);
    setSourceVisible(false);
    setTypedAnswer("");
  }, [agent.derived.question?.id]);

  useEffect(() => {
    if (!retryAttempt) return;
    const resolution = retryAttemptResolution({
      attempt: retryAttempt,
      currentEvaluation: agent.agentState.evaluation,
      generationId: agent.agentState.generation?.id,
      status: agent.status,
    });
    if (resolution !== "keep") setRetryAttempt(undefined);
  }, [agent.agentState.evaluation, agent.agentState.generation?.id, agent.status, retryAttempt]);

  useEffect(() => {
    if (!hasRecap) {
      setRecapPlaybackWaitExpired(false);
      return;
    }
    const timer = setTimeout(() => setRecapPlaybackWaitExpired(true), RECAP_PLAYBACK_MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [hasRecap]);

  useEffect(() => {
    if (
      shouldNavigateToRecap({
        hasRecap,
        hasPendingAudio: agent.agentState.audio.length > 0,
        playbackActive: agent.speaking,
        playbackWaitExpired: recapPlaybackWaitExpired,
        questionEverStarted: Boolean(agent.derived.question),
        status: agent.status,
        terminalReason: agent.derived.terminalReason,
      })
    ) {
      router.replace("/recap");
    }
  }, [
    agent.agentState.audio.length,
    agent.derived.question,
    agent.derived.terminalReason,
    agent.speaking,
    agent.status,
    hasRecap,
    recapPlaybackWaitExpired,
    router,
  ]);

  useEffect(() => {
    if (
      !agent.captureIssue ||
      (captureState !== "listening" && captureState !== "requesting" && captureState !== "stopping")
    ) {
      return;
    }
    setCaptureState("blocked");
    setTyping(true);
    setCaptureMessage(
      agent.captureIssue.kind === "ended"
        ? "Local microphone capture stopped. Your session is intact; type the answer to continue."
        : "The microphone stopped unexpectedly. Your session is intact; type the answer to continue.",
    );
  }, [agent.captureIssue, captureState]);

  useEffect(() => {
    if (!agent.speaking || (captureState !== "listening" && captureState !== "requesting")) {
      return;
    }
    if (captureCancellationRef.current) return;
    setCaptureState("stopping");
    setCaptureMessage("Examiner playback started, so local microphone capture was stopped.");
    const cancellation = agent.capture.cancel();
    captureCancellationRef.current = cancellation;
    const settleCancellation = () => {
      if (captureCancellationRef.current !== cancellation) return;
      captureCancellationRef.current = null;
      setCaptureState((state) => (state === "stopping" ? "idle" : state));
    };
    void cancellation.then(settleCancellation, settleCancellation);
  }, [agent.capture, agent.speaking, captureState]);

  const unlockPlayback = () => {
    if (playbackUnlockedRef.current) return;
    playbackUnlockedRef.current = true;
    void agent.playback.unlock().catch(() => {
      playbackUnlockedRef.current = false;
    });
  };

  const startListening = async () => {
    if (endingRef.current || agent.playback.isActive()) return;
    unlockPlayback();
    agent.clearCaptureIssue();
    setCaptureMessage(undefined);
    setCaptureState("requesting");
    setTyping(false);

    let outcome: "failed" | "pending" | "recording" = "pending";
    const failToTyping = (message: string) => {
      if (outcome !== "pending") return;
      outcome = "failed";
      setCaptureMessage(message);
      setCaptureState("blocked");
      setTyping(true);
      void agent.capture.cancel();
    };
    const watchdog = setTimeout(() => {
      failToTyping("The microphone did not start. Your session is intact; answer in writing.");
    }, 8000);

    try {
      await agent.capture.start();
      if (outcome !== "pending") {
        await agent.capture.cancel();
        return;
      }
      const playbackActive = agent.playback.isActive();
      if (playbackActive || !agent.capture.isActive()) {
        outcome = "failed";
        await agent.capture.cancel();
        setCaptureMessage(
          playbackActive
            ? "Wait for the examiner to finish, then start your answer."
            : "Microphone capture was interrupted. Start listening again when you are ready.",
        );
        setCaptureState("idle");
        return;
      }
      outcome = "recording";
      setCaptureState("listening");
    } catch (error) {
      const permissionDenied =
        error instanceof Error && error.name === "MobileAudioPermissionError";
      failToTyping(
        permissionDenied
          ? "Microphone access is off. You can answer in writing or enable it in Settings."
          : "Viva could not start the microphone. Your session is intact; answer in writing.",
      );
    } finally {
      clearTimeout(watchdog);
    }
  };

  const finishSpokenAnswer = async () => {
    if (endingRef.current) return;
    await agent.capture.stop();
    const frames = agent.capture.getFrames().length;
    setCaptureState("idle");
    setCaptureMessage(
      voiceTurnsEnabled
        ? "Voice answer ready to send."
        : `Voice capture stayed on this device (${frames} local frames). Type the answer to send it in Stage 0.`,
    );
    setTyping(true);
  };

  const submitTypedAnswer = () => {
    unlockPlayback();
    const answer = typedAnswer.trim();
    if (!answer) {
      AccessibilityInfo.announceForAccessibility("Write an answer before submitting.");
      return;
    }
    if (
      endingRef.current ||
      agent.playback.isActive() ||
      !agent.derived.canSubmitAnswer ||
      !agent.sendText(answer)
    ) {
      if (retryAttempt) setRetryAttempt(undefined);
      AccessibilityInfo.announceForAccessibility(
        "The agent is not ready for an answer. Wait for the question or retry the connection.",
      );
      return;
    }
    setSubmittedText(answer);
    setCaptureMessage(undefined);
    setSourceVisible(false);
    setTyping(false);
    if (retryAttempt) {
      setRetryAttempt({ ...retryAttempt, phase: "submitted" });
    }
  };

  const finishSession = async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    agent.playback.resetForGeneration();
    agent.stop();
    await agent.capture.stop();
  };

  const retry = () => {
    if (endingRef.current) return;
    unlockPlayback();
    setCaptureMessage(undefined);
    setTypedAnswer("");
    setHintVisible(false);
    setSourceVisible(false);
    setRetryAttempt({
      baselineEvaluation: agent.agentState.evaluation,
      generationId: agent.agentState.generation?.id,
      phase: "editing",
    });
    setTyping(true);
  };

  const retryConnection = () => {
    unlockPlayback();
    handledCancelRef.current = 0;
    setCaptureMessage(undefined);
    setCaptureState("idle");
    setRetryAttempt(undefined);
    endingRef.current = false;
    setEnding(false);
    agent.refreshSession({ reason: "socket_retry" });
  };

  const correction = agent.derived.evaluation
    ? correctionModelFromEvaluation(
        agent.derived.evaluation,
        agent.derived.finalTranscript,
        submittedText,
        agent.derived.transcriptConfidence,
      )
    : undefined;
  const connectionCopy = stageCopyForConnection({
    close: agent.derived.close,
    questionEverStarted: Boolean(agent.derived.question),
    status: agent.status,
    terminalReason: agent.derived.terminalReason,
  });
  const disconnected = agent.status === "closed" || agent.status === "error";
  const activePrompt =
    retrying && correction
      ? correction.retryPrompt
      : (agent.derived.question?.prompt ?? connectionCopy.title);
  const captureTransitioning = captureState === "requesting" || captureState === "stopping";
  const localPhase = retrying
    ? "listening"
    : captureTransitioning
      ? "thinking"
      : captureState === "listening"
        ? "listening"
        : agent.derived.phase;
  const orbState = orbStateForSession({
    phase: localPhase,
    speaking: agent.speaking,
    status: agent.status,
  });
  const busy =
    ending ||
    disconnected ||
    retrySubmitted ||
    Boolean(agent.agentState.pendingSubmission) ||
    agent.derived.phase === "thinking";
  const answerControlsBusy = sessionAnswerControlsBusy({ busy, speaking: agent.speaking });
  const showCorrection = Boolean(correction) && !retrying && !disconnected;
  const webInstrumentation = {
    dataSet: { vivaSpeaking: agent.speaking ? "true" : "false" },
  };

  return (
    <SafeAreaView
      {...webInstrumentation}
      edges={["top", "left", "right", "bottom"]}
      style={styles.safeArea}
      testID="session-live-root"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        onTouchStart={unlockPlayback}
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Leave session"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => {
              agent.close();
              if (router.canDismiss()) router.dismissAll();
              else router.replace("/");
            }}
            style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
          >
            <VivaText style={styles.closeGlyph}>×</VivaText>
          </Pressable>
          <View style={styles.sessionIdentity}>
            <SparkIcon color={colors.sageDeep} size={11} />
            <VivaText style={styles.sessionIdentityText} variant="caption">
              {studySet.title}
            </VivaText>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={ending}
            hitSlop={8}
            onPress={() => void finishSession()}
            style={({ pressed }) => [styles.endAction, pressed && styles.pressed]}
            testID="session-end"
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
          {showCorrection && correction ? (
            <CorrectionView feedback={correction} />
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
                <View testID="session-provider-status">
                  <VoiceStateLabel>
                    {sessionProviderStatusLabel({
                      busy,
                      captureState,
                      connectionStatusLabel: connectionCopy.statusLabel,
                      disconnected,
                      hasQuestion: Boolean(agent.derived.question),
                      speaking: agent.speaking,
                    })}
                  </VoiceStateLabel>
                </View>
              </View>

              <View style={styles.orbBlock}>
                <VoiceOrb level={orbLevel} size={156} state={orbState} />
              </View>

              <View style={styles.questionBlock}>
                <VivaText
                  accessibilityRole="header"
                  style={styles.question}
                  testID="session-question"
                  variant="title"
                >
                  {activePrompt}
                </VivaText>
                {captureState === "listening" || agent.speaking ? <VoiceWaveform /> : null}
                {!agent.derived.question ? (
                  <VivaText style={styles.loadDetail} tone="muted">
                    {connectionCopy.detail}
                  </VivaText>
                ) : null}
              </View>

              {hintVisible && agent.derived.question ? (
                <View accessibilityLiveRegion="polite" style={styles.disclosure}>
                  <VivaText tone="plum" variant="eyebrow">
                    One foothold
                  </VivaText>
                  <VivaText style={styles.disclosureCopy}>
                    {agent.derived.question.followUp}
                  </VivaText>
                </View>
              ) : null}

              {sourceVisible && agent.derived.question ? (
                <View accessibilityLiveRegion="polite" style={styles.disclosure}>
                  <VivaText tone="plum" variant="eyebrow">
                    Source boundary
                  </VivaText>
                  <VivaText style={styles.disclosureCopy}>
                    {agent.derived.question.source.label}.{" "}
                    {agent.derived.question.source.retrievalReason}
                  </VivaText>
                </View>
              ) : null}

              {captureMessage ? (
                <View accessibilityLiveRegion="assertive" style={styles.recovery}>
                  <VivaText tone="ochre" variant="eyebrow">
                    {captureState === "blocked" ? "Microphone unavailable" : "Typed-only stage"}
                  </VivaText>
                  <VivaText style={styles.recoveryCopy}>{captureMessage}</VivaText>
                </View>
              ) : null}

              {disconnected ? (
                <View accessibilityLiveRegion="assertive" style={styles.recovery}>
                  <VivaText tone="ochre" variant="eyebrow">
                    {connectionCopy.statusLabel}
                  </VivaText>
                  <VivaText style={styles.recoveryCopy}>{connectionCopy.detail}</VivaText>
                  {connectionCopy.canRetry ? (
                    <ActionButton onPress={retryConnection} tone="secondary">
                      Retry connection
                    </ActionButton>
                  ) : null}
                </View>
              ) : null}

              {typing ? (
                <View style={styles.answerField}>
                  <VivaText nativeID="answer-label" tone="muted" variant="eyebrow">
                    Your answer
                  </VivaText>
                  <TextInput
                    accessibilityLabelledBy="answer-label"
                    autoFocus={captureState === "blocked" || retrying}
                    editable={!answerControlsBusy}
                    multiline
                    onChangeText={setTypedAnswer}
                    placeholder="Explain it from memory…"
                    placeholderTextColor={colors.inkTertiary}
                    style={styles.input}
                    testID="session-answer-input"
                    textAlignVertical="top"
                    value={typedAnswer}
                  />
                  <ActionButton
                    disabled={
                      answerControlsBusy || !agent.derived.canSubmitAnswer || !typedAnswer.trim()
                    }
                    onPress={submitTypedAnswer}
                    testID="session-submit"
                  >
                    Submit answer
                  </ActionButton>
                </View>
              ) : null}

              <View style={styles.actionDock}>
                {agent.derived.question && captureState === "idle" && !typing ? (
                  <ActionButton
                    disabled={!agent.derived.canSubmitAnswer || answerControlsBusy}
                    icon={<SparkIcon color={colors.plumSoft} size={15} />}
                    onPress={() => void startListening()}
                  >
                    Start listening
                  </ActionButton>
                ) : null}
                {captureState === "requesting" ? (
                  <ActionButton loading>Opening microphone</ActionButton>
                ) : null}
                {captureState === "stopping" ? (
                  <ActionButton loading>Stopping microphone</ActionButton>
                ) : null}
                {captureState === "listening" ? (
                  <ActionButton
                    disabled={answerControlsBusy}
                    onPress={() => void finishSpokenAnswer()}
                  >
                    Finish answer
                  </ActionButton>
                ) : null}
                <View style={styles.secondaryActions}>
                  <ActionButton
                    disabled={!agent.derived.question || captureTransitioning || answerControlsBusy}
                    onPress={() => {
                      unlockPlayback();
                      setHintVisible((value) => !value);
                    }}
                    style={styles.secondaryAction}
                    tone="tint"
                  >
                    {hintVisible ? "Hide hint" : "Hint"}
                  </ActionButton>
                  <ActionButton
                    disabled={!agent.derived.question || captureTransitioning || answerControlsBusy}
                    onPress={() => {
                      unlockPlayback();
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
                  disabled={!agent.derived.question || captureTransitioning || answerControlsBusy}
                  onPress={() => {
                    unlockPlayback();
                    setSourceVisible((value) => !value);
                  }}
                  tone="quiet"
                >
                  {sourceVisible ? "Close source note" : "Why this source?"}
                </ActionButton>
              </View>
            </View>
          )}
        </ScrollView>

        {showCorrection ? (
          <View style={styles.correctionDock}>
            <ActionButton
              disabled={ending}
              icon={<SparkIcon color={colors.plumSoft} size={15} />}
              onPress={retry}
              testID="session-retry"
            >
              Try again
            </ActionButton>
            <ActionButton disabled={ending} onPress={() => void finishSession()} tone="secondary">
              {ending ? "Ending session…" : "Complete session"}
            </ActionButton>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function CorrectionView({ feedback }: { feedback: SessionCorrectionModel }) {
  const [sourceExpanded, setSourceExpanded] = useState(false);

  return (
    <View style={styles.correctionBody} testID="session-correction">
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
            {feedback.answer}
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
        <View style={styles.manuscriptSection}>
          <VivaText tone="plum" variant="caption">
            Try this next
          </VivaText>
          <VivaText style={styles.correctionCopy}>{feedback.retryPrompt}</VivaText>
          {feedback.uncertainTranscript ? (
            <VivaText tone="ochre" variant="caption">
              The transcript confidence was low; verify the quoted answer before retrying.
            </VivaText>
          ) : null}
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
              {feedback.sourceLabel}
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "The library request failed.";
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
  loadDetail: {
    maxWidth: 340,
    textAlign: "center",
  },
  loadState: {
    alignItems: "center",
    flex: 1,
    gap: space.md,
    justifyContent: "center",
    paddingHorizontal: layout.gutter,
  },
  loadTitle: {
    maxWidth: 340,
    textAlign: "center",
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
    // The atmosphere is mounted once at the root and shows through every screen.
    backgroundColor: "transparent",
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
