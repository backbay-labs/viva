"use client";

import { seedStudySets } from "@viva/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";
import { useVivaAgentSession } from "../../lib/use-viva-agent-session";
import {
  fetchVivaAgentReadinessProbe,
  type VivaAgentReadinessProbe,
  vivaAgentHttpBaseUrl,
} from "../../lib/viva-agent-client";
import {
  createBrowserVivaAudioCaptureSource,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaAudioCaptureSource,
} from "../../lib/viva-audio-capture";
import {
  createVivaAudioPlaybackSink,
  type VivaAudioPlaybackSink,
} from "../../lib/viva-audio-playback";
import { recapPlanFromSessionEvents } from "../../lib/viva-display";
import { vivaSceneReducer } from "../../lib/viva-scene-reducer";
import { sessionRouteIdentityFromSearch } from "../../lib/viva-session-entry";
import {
  projectConceptNodes,
  projectHighlightedTokens,
  projectRuntimeCopy,
  projectSourceFolio,
  projectTrace,
  type RuntimeMicState,
} from "../../lib/viva-session-projection";
import { createVoiceLevelMeter } from "../../lib/viva-voice-level";
import { LiveSessionShell } from "./LiveSessionShell";
import { glyphStateFor, type SessionState } from "./session-data";
import type { VoiceTraceLevel } from "./VoiceTraceCanvas";

/**
 * The live oral-exam, driven by the REAL agent event stream — no mock timer.
 *
 * The Conductor (projectTrace) maps the synthetic Rust brain's events
 * (session_phase / question_started / answer_evaluated / source_reference /
 * recap_ready, folded by the existing reducer) onto the manuscript's four
 * states + per-prompt Question + glowing tokens. The trace moves because of what
 * the examiner actually did, not a clock.
 *
 * The central bloom breathes with the real voice: the student's mic amplitude
 * (plum) and the examiner's TTS amplitude (gold), both computed client-side and
 * fed through a stable ref into the canvas rAF loop — never via React state, and
 * never over the wire. The mic is sampled for amplitude ONLY; it is not streamed
 * to the synthetic brain (which would restart the turn on every frame). A turn is
 * triggered explicitly when the student signals they are done answering.
 */
const STUDY_SET = seedStudySets[0]; // biology-midterm — the trusted synthetic study set

type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

export function LiveSessionPage() {
  const reducedMotion = usePrefersReducedMotion();
  const [routeIdentity] = useState(readBrowserSessionRouteIdentity);
  const activeStudySet = useMemo(
    () => ({
      ...STUDY_SET,
      id: routeIdentity.studySetId ?? STUDY_SET.id,
      userId: routeIdentity.userId ?? STUDY_SET.userId,
      sessionId: routeIdentity.sessionId ?? STUDY_SET.sessionId,
      sessionToken: routeIdentity.sessionToken ?? STUDY_SET.sessionToken,
      serverOwned: routeIdentity.studySetId ? true : STUDY_SET.serverOwned,
      ingestionStatus: routeIdentity.studySetId ? ("ready" as const) : STUDY_SET.ingestionStatus,
    }),
    [routeIdentity],
  );
  const [elapsed, setElapsed] = useState(0);
  const [hintShown, setHintShown] = useState(false);
  const [hintUsed, setHintUsed] = useState(false);
  const [micState, setMicState] = useState<RuntimeMicState>("unknown");
  const [readinessProbe, setReadinessProbe] =
    useState<VivaAgentReadinessProbe>(initialReadinessProbe);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [textAnswerEnabled, setTextAnswerEnabled] = useState(false);
  const [textRetryOpen, setTextRetryOpen] = useState(false);
  const [submittedTextAnswer, setSubmittedTextAnswer] = useState<string>();

  const agent = useVivaAgentSession({
    mode: "quiz",
    sessionId: routeIdentity.sessionId ?? process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID,
    sessionToken: routeIdentity.sessionToken,
    studySet: activeStudySet,
    trustedStudySetId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID,
    userId: routeIdentity.userId ?? process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID,
  });
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const levelRef = useRef<VoiceTraceLevel>({ user: 0, agent: 0 });
  const captureRef = useRef<VivaAudioCaptureSource | null>(null);
  const captureStartedRef = useRef(false);
  const micStartGenerationRef = useRef(0);
  const textAnswerModeRef = useRef(false);
  const meterRef = useRef(createVoiceLevelMeter({ coefficient: 0.3 }));
  const playbackRef = useRef<VivaAudioPlaybackSink | null>(null);
  const handledAudioRef = useRef(0);
  const handledCancelRef = useRef(0);

  const getPlayback = useCallback(() => {
    if (playbackRef.current) return playbackRef.current;
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => {
        const audioWindow = window as WindowWithWebkitAudioContext;
        const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
        if (!AudioContextCtor) throw new Error("Browser audio playback is unavailable");
        return new AudioContextCtor({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ });
      },
      outputSampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
    });
    playbackRef.current = sink;
    return sink;
  }, []);

  // Connect once, deferred to the next tick so the dev StrictMode
  // mount→unmount→mount cycle settles first. The throwaway first mount schedules
  // a timer that its own cleanup clears; only the final, stable mount's connect
  // actually runs — so we open exactly one socket on the live controller instead
  // of opening then immediately closing a throwaway one.
  useEffect(() => {
    const id = window.setTimeout(() => agentRef.current.connect(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // Mocked session clock (cosmetic, counts up).
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshReadiness = async () => {
      const next = await fetchVivaAgentReadinessProbe();
      if (!cancelled) setReadinessProbe(next);
    };
    void refreshReadiness();
    const id = window.setInterval(refreshReadiness, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Play the examiner's streamed audio (synthetic emits none yet; wired for the
  // real provider) and honour cancellations/barge-in.
  useEffect(() => {
    const audio = agent.agentState.audio;
    const cancellations = agent.agentState.cancelledResponseIds;
    if (
      audio.length === handledAudioRef.current &&
      cancellations.length === handledCancelRef.current
    ) {
      return;
    }
    const sink = getPlayback();
    for (const responseId of cancellations.slice(handledCancelRef.current)) sink.cancel(responseId);
    for (const output of audio.slice(handledAudioRef.current)) sink.enqueue(output);
    handledAudioRef.current = audio.length;
    handledCancelRef.current = cancellations.length;
  }, [agent.agentState.audio, agent.agentState.cancelledResponseIds, getPlayback]);

  // Examiner amplitude → bloom "breathes back in gold" (off when reduced-motion).
  useEffect(() => {
    if (reducedMotion) {
      levelRef.current.agent = 0;
      return;
    }
    const id = window.setInterval(() => {
      levelRef.current.agent = playbackRef.current?.getOutputLevel() ?? 0;
    }, 80);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  // Tear down audio on unmount.
  useEffect(
    () => () => {
      captureRef.current?.stop();
      captureRef.current = null;
      void playbackRef.current?.close();
      playbackRef.current = null;
    },
    [],
  );

  const startMic = useCallback(async () => {
    if (captureStartedRef.current || reducedMotion || textAnswerModeRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMicState("unsupported");
      return;
    }
    const audioWindow = window as WindowWithWebkitAudioContext;
    const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
    if (!AudioContextCtor) {
      setMicState("unsupported");
      return;
    }
    captureStartedRef.current = true;
    const startGeneration = ++micStartGenerationRef.current;
    try {
      const source = await createBrowserVivaAudioCaptureSource({
        AudioContextCtor,
        mediaDevices: navigator.mediaDevices,
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
      });
      if (textAnswerModeRef.current || startGeneration !== micStartGenerationRef.current) {
        source.stop();
        captureStartedRef.current = false;
        levelRef.current.user = 0;
        return;
      }
      captureRef.current = source;
      setMicState("available");
      const meter = meterRef.current;
      // Samples drive the bloom ONLY — never sent to the brain.
      void source.start((samples) => {
        if (textAnswerModeRef.current) {
          levelRef.current.user = 0;
          return;
        }
        levelRef.current.user = meter.push(samples);
      });
    } catch {
      if (textAnswerModeRef.current || startGeneration !== micStartGenerationRef.current) {
        captureStartedRef.current = false;
        levelRef.current.user = 0;
        return;
      }
      captureStartedRef.current = false; // allow another attempt on the next gesture
      levelRef.current.user = 0;
      setMicState("denied");
    }
  }, [reducedMotion]);

  const unlockPlayback = useCallback(() => {
    void getPlayback()
      .unlock()
      .catch(() => {});
  }, [getPlayback]);

  const onUserGesture = useCallback(() => {
    unlockPlayback();
    void startMic();
  }, [startMic, unlockPlayback]);

  // Start listening (mic + playback unlock) on the first interaction anywhere.
  useEffect(() => {
    const handler = () => onUserGesture();
    window.addEventListener("pointerdown", handler, { once: true });
    return () => window.removeEventListener("pointerdown", handler);
  }, [onUserGesture]);

  const activateTextAnswerMode = useCallback(() => {
    textAnswerModeRef.current = true;
    micStartGenerationRef.current += 1;
    enterTextAnswerMode(captureRef, captureStartedRef, levelRef, meterRef);
  }, []);

  const submitSpokenTurn = useCallback(() => {
    onUserGesture();
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    // Content is the student's turn signal; the synthetic brain runs its
    // deterministic evaluation sequence. A real provider receives the transcript.
    agentRef.current.sendText("(spoken answer)");
  }, [onUserGesture]);
  const submitTextTurn = useCallback(
    (answer: string) => {
      const payload = textAnswerPayload(answer);
      if (!payload) return;
      unlockPlayback();
      activateTextAnswerMode();
      setSourceOpen(false);
      setHintShown(false);
      setTextRetryOpen(false);
      setTextAnswerEnabled(true);
      setSubmittedTextAnswer(payload);
      agentRef.current.sendText(payload);
    },
    [activateTextAnswerMode, unlockPlayback],
  );
  const challengeSource = useCallback(() => {
    onUserGesture();
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    agentRef.current.sendText("(challenge citation)");
  }, [onUserGesture]);
  const retryAgent = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    agentRef.current.reset();
    agentRef.current.connect();
  }, []);
  const endSession = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    stopCaptureForRecap(captureRef, captureStartedRef, levelRef);
    agentRef.current.stop();
  }, []);

  useEffect(() => {
    if (!agent.derived.recap) return;
    stopCaptureForRecap(captureRef, captureStartedRef, levelRef);
  }, [agent.derived.recap]);

  const activeQuestionId = agent.derived.question?.id;
  const previousQuestionIdRef = useRef(activeQuestionId);

  useEffect(() => {
    if (previousQuestionIdRef.current === activeQuestionId) return;
    previousQuestionIdRef.current = activeQuestionId;
    setSubmittedTextAnswer(undefined);
    setTextAnswerEnabled(false);
    setTextRetryOpen(false);
  }, [activeQuestionId]);

  // Stable session-start reference so FSRS review intervals are deterministic
  // across renders (and don't recompute the projection every tick).
  const sessionStart = useRef(new Date()).current;
  const projection = useMemo(
    () => projectTrace(agent.derived, agent.status, sessionStart),
    [agent.derived, agent.status, sessionStart],
  );
  const sourceFolio = useMemo(
    () => projectSourceFolio(agent.derived, sessionStart),
    [agent.derived, sessionStart],
  );
  const recapPlan = useMemo(
    () =>
      recapPlanFromSessionEvents({
        conceptStatuses: agent.derived.conceptStatuses,
        now: sessionStart,
        recap: agent.derived.recap,
        signals: { hinted: hintUsed },
        studySet: activeStudySet,
      }),
    [activeStudySet, agent.derived.conceptStatuses, agent.derived.recap, hintUsed, sessionStart],
  );
  const conceptNodes = useMemo(
    () => projectConceptNodes(activeStudySet.concepts, agent.agentState.conceptStatuses),
    [activeStudySet.concepts, agent.agentState.conceptStatuses],
  );
  const scene = useMemo(() => {
    const knownEntityIds = new Set<string>([
      ...activeStudySet.concepts.map((concept) => concept.id),
      "hint-1",
      "source-folio",
      "correction-note",
      "recap-fold",
    ]);
    for (const source of agent.derived.sources) {
      if (source.sourceId) knownEntityIds.add(source.sourceId);
      if (source.documentId) knownEntityIds.add(source.documentId);
    }
    if (agent.derived.question?.source.sourceId) {
      knownEntityIds.add(agent.derived.question.source.sourceId);
    }
    if (agent.derived.question?.source.documentId) {
      knownEntityIds.add(agent.derived.question.source.documentId);
    }
    return vivaSceneReducer(agent.derived.manuscriptIntents, {
      knownEntityIds: [...knownEntityIds],
    });
  }, [
    activeStudySet.concepts,
    agent.derived.manuscriptIntents,
    agent.derived.question,
    agent.derived.sources,
  ]);
  const effectiveState: SessionState = sourceOpen
    ? "source"
    : textRetryOpen
      ? "listening"
      : projection.state;
  const highlightedTokens = sourceOpen
    ? projectHighlightedTokens("source", agent.derived)
    : textRetryOpen
      ? projectHighlightedTokens("listening", agent.derived)
      : projection.highlightedTokens;
  const runtime = useMemo(
    () =>
      projectRuntimeCopy({
        close: agent.agentState.close,
        errors: agent.derived.errors,
        mic: micState,
        readinessProbe,
        readiness: agent.readiness,
        ready: agent.agentState.ready,
        status: agent.status,
      }),
    [
      agent.agentState.close,
      agent.agentState.ready,
      agent.derived.errors,
      agent.readiness,
      agent.status,
      micState,
      readinessProbe,
    ],
  );
  const websocketReady = Boolean(agent.agentState.ready) && agent.status === "open";
  const textAnswerRequired = micState === "denied" || micState === "unsupported";
  const textAnswerAvailable = websocketReady;
  const textAnswerActive = textAnswerAvailable && (textAnswerRequired || textAnswerEnabled);
  const studentHandAnswer = textRetryOpen
    ? undefined
    : (agent.derived.finalTranscript ?? submittedTextAnswer);

  useEffect(() => {
    if (textAnswerActive) {
      activateTextAnswerMode();
    } else {
      textAnswerModeRef.current = false;
    }
  }, [activateTextAnswerMode, textAnswerActive]);

  const openTextRetry = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setSubmittedTextAnswer(undefined);
    setTextAnswerEnabled(true);
    setTextRetryOpen(true);
    activateTextAnswerMode();
  }, [activateTextAnswerMode]);

  const sessionContextLabel =
    agent.readiness.reason === "trusted"
      ? `Trusted server set: ${activeStudySet.title}`
      : `Local demo set: ${activeStudySet.title}`;

  return (
    <LiveSessionShell
      clockLabel="Local session clock"
      conceptNodes={conceptNodes}
      contextLabel={sessionContextLabel}
      elapsed={elapsed}
      glyphState={glyphStateFor(effectiveState)}
      highlightedTokens={highlightedTokens}
      hintShown={hintShown}
      levelRef={levelRef}
      onBackToQuestion={() => setSourceOpen(false)}
      onChallengeSource={challengeSource}
      onEndSession={endSession}
      onHint={() => {
        setHintUsed(true);
        setHintShown((shown) => !shown);
      }}
      onNextQuestion={submitSpokenTurn}
      onShowSource={() => setSourceOpen(true)}
      onSubmitAnswer={runtime.primaryActionIntent === "retry_agent" ? retryAgent : submitSpokenTurn}
      onSubmitTextAnswer={submitTextTurn}
      onTryAgain={textAnswerActive ? openTextRetry : submitSpokenTurn}
      onUseTextAnswer={() => {
        setTextAnswerEnabled(true);
        activateTextAnswerMode();
      }}
      onUseVoiceAnswer={() => {
        textAnswerModeRef.current = false;
        setTextAnswerEnabled(false);
        onUserGesture();
      }}
      question={projection.question}
      recap={recapPlan.recap}
      reviewPlan={recapPlan.reviewPlan}
      runtime={runtime}
      scene={scene}
      sourceFolio={sourceFolio}
      state={effectiveState}
      textAnswer={
        textAnswerAvailable
          ? {
              active: textAnswerActive,
              disabled: false,
              lastAnswer: studentHandAnswer,
              required: textAnswerRequired,
            }
          : undefined
      }
    />
  );
}

export function stopCaptureForRecap(
  captureRef: { current: Pick<VivaAudioCaptureSource, "stop"> | null },
  captureStartedRef: { current: boolean },
  levelRef: { current: { user: number } },
) {
  captureRef.current?.stop();
  captureRef.current = null;
  captureStartedRef.current = false;
  levelRef.current.user = 0;
}

export function enterTextAnswerMode(
  captureRef: { current: Pick<VivaAudioCaptureSource, "stop"> | null },
  captureStartedRef: { current: boolean },
  levelRef: { current: { user: number } },
  meterRef?: { current: { reset: () => void } },
) {
  captureRef.current?.stop();
  captureRef.current = null;
  captureStartedRef.current = false;
  levelRef.current.user = 0;
  meterRef?.current.reset();
}

export function textAnswerPayload(answer: string): string | null {
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBrowserSessionRouteIdentity() {
  const envToken = process.env.NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN?.trim() || null;
  if (typeof window === "undefined") {
    return {
      ...sessionRouteIdentityFromSearch(""),
      sessionToken: envToken,
    };
  }

  const routeIdentity = sessionRouteIdentityFromSearch(window.location.search);
  if (
    routeIdentity.userId ||
    routeIdentity.studySetId ||
    routeIdentity.sessionId ||
    routeIdentity.sessionToken
  ) {
    return routeIdentity;
  }
  return {
    ...routeIdentity,
    sessionToken: envToken,
  };
}

function initialReadinessProbe(): VivaAgentReadinessProbe {
  const apiBaseUrl = vivaAgentHttpBaseUrl();
  return apiBaseUrl ? { apiBaseUrl, status: "checking" } : { status: "api_missing" };
}
