"use client";

import { type SessionRecap, seedStudySets, VIVA_AUDIO_MAX_TURN_SAMPLES } from "@viva/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";
import { useVivaAgentSession, type VivaAgentDerivedState } from "../../lib/use-viva-agent-session";
import {
  fetchVivaAgentReadinessProbe,
  isVivaAudioSendRejectedError,
  refreshVivaSessionToken,
  type VivaAgentAudioOutput,
  type VivaAgentGenerationReason,
  type VivaAgentReadinessProbe,
  type VivaAudioChunkInput,
  type VivaAudioSendResult,
  type VivaClientSendError,
  vivaAgentHttpBaseUrl,
} from "../../lib/viva-agent-client";
import {
  createBrowserVivaAudioCaptureSource,
  isVivaAudioWorkletUnavailableError,
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaAudioCaptureEndReason,
  type VivaAudioCaptureSampleFrame,
  type VivaPcm16StreamingCaptureController,
} from "../../lib/viva-audio-capture";
import {
  createVivaAudioPlaybackSink,
  type VivaAudioPlaybackSink,
} from "../../lib/viva-audio-playback";
import { recapPlanFromSessionEvents } from "../../lib/viva-display";
import { vivaSceneReducer } from "../../lib/viva-scene-reducer";
import {
  canonicalizeSessionBrowserUrl,
  type SessionRouteIdentity,
  sessionRouteIdentityFromLocationParts,
  sessionRouteIdentityFromSearch,
} from "../../lib/viva-session-entry";
import {
  projectConceptNodes,
  projectHighlightedTokens,
  projectRuntimeCopy,
  projectSourceFolio,
  projectTrace,
  projectTurnTakingState,
  type RuntimeMicState,
  transcriptionWasUncertain,
} from "../../lib/viva-session-projection";
import { createVoiceLevelMeter } from "../../lib/viva-voice-level";
import { LiveSessionShell } from "./LiveSessionShell";
import type { TextAnswerState } from "./MarginaliaPanel";
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
  const [sessionToken, setSessionToken] = useState(routeIdentity.sessionToken ?? null);
  const [routeSessionTokenRefreshReady, setRouteSessionTokenRefreshReady] = useState(
    () => !shouldRefreshBrowserSessionToken(routeIdentity),
  );
  const activeStudySet = useMemo(
    () => ({
      ...STUDY_SET,
      id: routeIdentity.studySetId ?? STUDY_SET.id,
      userId: routeIdentity.userId ?? STUDY_SET.userId,
      sessionId: routeIdentity.sessionId ?? STUDY_SET.sessionId,
      sessionToken: sessionToken ?? STUDY_SET.sessionToken,
      serverOwned: routeIdentity.studySetId ? true : STUDY_SET.serverOwned,
      ingestionStatus: routeIdentity.studySetId ? ("ready" as const) : STUDY_SET.ingestionStatus,
    }),
    [routeIdentity, sessionToken],
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
  const [recordingConsentAcknowledged, setRecordingConsentAcknowledged] = useState(false);
  const [playbackSpeaking, setPlaybackSpeaking] = useState(false);
  const [interruptAcknowledged, setInterruptAcknowledged] = useState(false);
  const routeIdentityRef = useRef(routeIdentity);
  const sessionTokenRef = useRef(routeIdentity.sessionToken ?? STUDY_SET.sessionToken ?? null);
  const browserLifecycleAttemptRef = useRef(0);

  const agent = useVivaAgentSession({
    mode: "quiz",
    sessionId: routeIdentity.sessionId ?? process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID,
    sessionToken,
    studySet: activeStudySet,
    token: sessionRouteWsAccessToken({ sessionToken }),
    trustedStudySetId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID,
    userId: routeIdentity.userId ?? process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID,
  });
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const levelRef = useRef<VoiceTraceLevel>({ user: 0, agent: 0 });
  const captureRef = useRef<VivaPcm16StreamingCaptureController | null>(null);
  const captureStartedRef = useRef(false);
  const micStartGenerationRef = useRef(0);
  const audioTurnDriverRef = useRef<LiveAudioTurnDriver | null>(null);
  const textAnswerModeRef = useRef(false);
  const recordingConsentAcknowledgedRef = useRef(false);
  const meterRef = useRef(createVoiceLevelMeter({ coefficient: 0.3 }));
  const playbackRef = useRef<VivaAudioPlaybackSink | null>(null);
  const handledCancelRef = useRef(0);
  const reducedMotionRef = useRef(reducedMotion);
  const mountedRef = useRef(true);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    if (reducedMotion) levelRef.current.user = 0;
  }, [reducedMotion]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One lifecycle driver per page instance, wired to the live controller seam.
  const getAudioTurnDriver = useCallback(() => {
    if (audioTurnDriverRef.current) return audioTurnDriverRef.current;
    const driver = createLiveAudioTurnDriver({
      controller: {
        cancelAudioTurn: (turnId) => agentRef.current.cancelAudioTurn(turnId),
        endAudioTurn: (endInput) => agentRef.current.endAudioTurn(endInput),
        sendAudioChunk: (chunkInput) => agentRef.current.sendAudioChunk(chunkInput),
      },
      createTurnId: createOpaqueAudioTurnId,
      // At the raw 45-second cap the capture source is stopped; the driver has
      // already emitted the turn's final chunk and its single `audio_end`.
      onCapacityReached: () => {
        captureRef.current?.stop();
        captureRef.current = null;
        captureStartedRef.current = false;
        levelRef.current.user = 0;
      },
    });
    audioTurnDriverRef.current = driver;
    return driver;
  }, []);
  const cancelActiveAudioTurn = useCallback(() => {
    audioTurnDriverRef.current?.cancel();
  }, []);

  const getPlayback = useCallback(() => {
    if (playbackRef.current) return playbackRef.current;
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => {
        const audioWindow = window as WindowWithWebkitAudioContext;
        const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
        if (!AudioContextCtor) throw new Error("Browser audio playback is unavailable");
        return new AudioContextCtor({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ });
      },
      onStateChange: (playbackState) => {
        if (mountedRef.current) {
          setPlaybackSpeaking(playbackState.responding || playbackState.speaking);
        }
      },
      outputSampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
    });
    playbackRef.current = sink;
    return sink;
  }, []);
  const resetPlaybackForGeneration = useCallback(() => {
    resetPlaybackCancellationStateForGeneration({
      handledCancelRef,
      playback: playbackRef.current,
    });
  }, []);

  useEffect(() => {
    if (!shouldRefreshBrowserSessionToken(routeIdentity)) {
      setRouteSessionTokenRefreshReady(true);
      return;
    }
    let cancelled = false;
    setRouteSessionTokenRefreshReady(false);
    void refreshBrowserSessionToken(routeIdentity).then((refreshedToken) => {
      if (cancelled) return;
      if (refreshedToken) setSessionToken(refreshedToken);
      setRouteSessionTokenRefreshReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [routeIdentity]);

  // Connect once, deferred to the next tick so the dev StrictMode
  // mount→unmount→mount cycle settles first. The throwaway first mount schedules
  // a timer that its own cleanup clears; only the final, stable mount's connect
  // actually runs — so we open exactly one socket on the live controller instead
  // of opening then immediately closing a throwaway one.
  useEffect(() => {
    if (!routeSessionTokenRefreshReady) return;
    const id = window.setTimeout(() => agentRef.current.connect(), 0);
    return () => window.clearTimeout(id);
  }, [routeSessionTokenRefreshReady]);

  const reconnectForBrowserLifecycle = useCallback(
    (reason: VivaAgentGenerationReason) => {
      const nextRouteIdentity = readBrowserSessionRouteIdentity();
      const plan = browserLifecycleReconnectPlan({
        currentRouteIdentity: routeIdentityRef.current,
        nextRouteIdentity,
        recap: agentRef.current.derived.recap,
        sessionId: activeStudySet.sessionId,
        sessionToken: sessionTokenRef.current,
        status: agentRef.current.status,
        userId: activeStudySet.userId,
      });
      const attempt = browserLifecycleAttemptRef.current + 1;
      browserLifecycleAttemptRef.current = attempt;
      if (plan.action === "skip_session_over") return;
      if (plan.action === "reload") {
        window.location.reload();
        return;
      }
      setSourceOpen(false);
      setHintShown(false);
      setTextRetryOpen(false);
      setSubmittedTextAnswer(undefined);
      stopCaptureForRecap(captureRef, captureStartedRef, levelRef, cancelActiveAudioTurn);
      resetPlaybackForGeneration();
      if (plan.action === "refresh_session_token") {
        void refreshVivaSessionToken({
          sessionId: plan.sessionId,
          sessionToken: plan.sessionToken,
          studySetId: activeStudySet.id,
          userId: plan.userId,
        })
          .then((result) => {
            if (
              !isCurrentBrowserLifecycleAttempt({
                activeAttempt: browserLifecycleAttemptRef.current,
                attempt,
              })
            ) {
              return;
            }
            sessionTokenRef.current = result.session_token;
            agentRef.current.refreshSession({ reason, sessionToken: result.session_token });
          })
          .catch(() => {
            if (
              isCurrentBrowserLifecycleAttempt({
                activeAttempt: browserLifecycleAttemptRef.current,
                attempt,
              })
            ) {
              agentRef.current.reset();
              agentRef.current.connect(reason);
            }
          });
        return;
      }
      agentRef.current.reset();
      agentRef.current.connect(reason);
    },
    [
      activeStudySet.id,
      activeStudySet.sessionId,
      activeStudySet.userId,
      cancelActiveAudioTurn,
      resetPlaybackForGeneration,
    ],
  );

  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      const reason = browserSessionReconnectReason({
        persisted: event.persisted,
        type: "pageshow",
      });
      if (reason) reconnectForBrowserLifecycle(reason);
    };
    const handlePopState = () => {
      const reason = browserSessionReconnectReason({ type: "popstate" });
      if (reason) reconnectForBrowserLifecycle(reason);
    };
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [reconnectForBrowserLifecycle]);

  // Session duration clock — counts up while the session is live, then freezes
  // on its final duration once a recap arrives or the socket terminally closes.
  const sessionOver = isSessionOver({ recap: agent.derived.recap, status: agent.status });
  useEffect(() => {
    if (sessionOver) return;
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [sessionOver]);

  const stopReadinessPolling = shouldStopReadinessPolling({
    recap: agent.derived.recap,
    status: agent.status,
    ready: Boolean(agent.agentState.ready),
  });
  useEffect(() => {
    if (stopReadinessPolling) return;
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
  }, [stopReadinessPolling]);

  // Play the examiner's streamed audio (synthetic emits none yet; wired for the
  // real provider) and honour cancellations/barge-in.
  useEffect(() => {
    const audio = agent.agentState.audio;
    const cancellations = agent.agentState.cancelledResponseIds;
    if (audio.length === 0 && cancellations.length === handledCancelRef.current) return;
    const previousHandledCancel = handledCancelRef.current;
    handledCancelRef.current = drainAgentAudio({
      acknowledgeAudio: (consumed) => agentRef.current.acknowledgeAudio(consumed),
      audio,
      cancellations,
      handledCancel: handledCancelRef.current,
      sink: getPlayback(),
    });
    if (cancellations.length > previousHandledCancel) {
      setInterruptAcknowledged(true);
    }
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
      // Disposal cancels the in-flight input turn exactly once so the retained
      // ledger is released and the server never sees a half-streamed turn.
      cancelActiveAudioTurn();
      audioTurnDriverRef.current = null;
      void playbackRef.current?.close();
      playbackRef.current = null;
    },
    [cancelActiveAudioTurn],
  );

  const startMic = useCallback(async () => {
    if (
      !canStartMicrophoneCapture({
        captureStarted: captureStartedRef.current,
        consentAcknowledged: recordingConsentAcknowledgedRef.current,
        textAnswerMode: textAnswerModeRef.current,
      })
    ) {
      return;
    }
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
        cancelActiveAudioTurn();
        return;
      }
      const meter = meterRef.current;
      const capture = startVivaPcm16StreamingCapture({
        onEnded: (reason) => {
          if (startGeneration !== micStartGenerationRef.current) return;
          captureRef.current = null;
          captureStartedRef.current = false;
          levelRef.current.user = 0;
          // A device change or explicit stop mid-turn discards the partial turn
          // rather than leaving retained bytes that can never be ended.
          if (reason !== "stopped") cancelActiveAudioTurn();
          setMicState((current) => micStateForCaptureEndReason(reason, current));
        },
        onError: (error) => {
          if (startGeneration !== micStartGenerationRef.current) return;
          captureRef.current = null;
          captureStartedRef.current = false;
          levelRef.current.user = 0;
          cancelActiveAudioTurn();
          setMicState(micStateForAudioCaptureError(error));
        },
        onFrame: (frame) => {
          if (
            shouldUseLiveMicAudioTransport({
              ready: agentRef.current.agentState.ready,
              status: agentRef.current.status,
              textAnswerMode: textAnswerModeRef.current,
            })
          ) {
            getAudioTurnDriver().captureFrame(frame);
          }
        },
        onSampleFrame: (frame) => {
          levelRef.current.user = captureLevelForBloom({
            frame,
            meter,
            reducedMotion: reducedMotionRef.current,
            samples: frame.samples,
            textAnswerMode: textAnswerModeRef.current,
          });
        },
        source,
      });
      captureRef.current = capture;
      setMicState("available");
    } catch (error) {
      if (textAnswerModeRef.current || startGeneration !== micStartGenerationRef.current) {
        captureStartedRef.current = false;
        levelRef.current.user = 0;
        cancelActiveAudioTurn();
        return;
      }
      captureStartedRef.current = false; // allow another attempt on the next gesture
      levelRef.current.user = 0;
      cancelActiveAudioTurn();
      setMicState(micStateForAudioCaptureError(error));
    }
  }, [cancelActiveAudioTurn, getAudioTurnDriver]);

  const unlockPlayback = useCallback(() => {
    void getPlayback()
      .unlock()
      .catch(() => {});
  }, [getPlayback]);

  const onUserGesture = useCallback(() => {
    unlockPlayback();
    void startMic();
  }, [startMic, unlockPlayback]);

  const acknowledgeRecordingDisclosure = useCallback(() => {
    recordingConsentAcknowledgedRef.current = true;
    setRecordingConsentAcknowledged(true);
    onUserGesture();
  }, [onUserGesture]);

  // Start listening (mic + playback unlock) on the first interaction anywhere.
  useEffect(() => {
    const handler = () => onUserGesture();
    window.addEventListener("pointerdown", handler, { once: true });
    return () => window.removeEventListener("pointerdown", handler);
  }, [onUserGesture]);

  const activateTextAnswerMode = useCallback(() => {
    textAnswerModeRef.current = true;
    micStartGenerationRef.current += 1;
    enterTextAnswerMode(captureRef, captureStartedRef, levelRef, meterRef, cancelActiveAudioTurn);
  }, [cancelActiveAudioTurn]);

  const submitSpokenTurn = useCallback(() => {
    onUserGesture();
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    if (
      shouldUseLiveMicAudioTransport({
        ready: agentRef.current.agentState.ready,
        status: agentRef.current.status,
        textAnswerMode: textAnswerModeRef.current,
      })
    ) {
      // Flush the capture tail into the turn's last chunk and send exactly one
      // `audio_end`, leaving the microphone open for the next question.
      if (submitSpokenCaptureTurn(captureRef, getAudioTurnDriver())) return;
    } else {
      cancelActiveAudioTurn();
    }
    if (
      spokenTurnFallbackAction({
        websocketReady:
          Boolean(agentRef.current.agentState.ready) && agentRef.current.status === "open",
      }) === "open_text_answer"
    ) {
      activateTextAnswerMode();
      setTextAnswerEnabled(true);
      setTextRetryOpen(true);
    }
  }, [activateTextAnswerMode, cancelActiveAudioTurn, getAudioTurnDriver, onUserGesture]);
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
      const sent = agentRef.current.sendText(payload);
      if (sent) setSubmittedTextAnswer(payload);
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
    browserLifecycleAttemptRef.current += 1;
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    resetPlaybackForGeneration();
    agentRef.current.reset();
    agentRef.current.connect("socket_retry");
  }, [resetPlaybackForGeneration]);
  const refreshSession = useCallback(() => {
    const attempt = browserLifecycleAttemptRef.current + 1;
    browserLifecycleAttemptRef.current = attempt;
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    setSubmittedTextAnswer(undefined);
    resetPlaybackForGeneration();
    const sessionToken = sessionTokenRef.current;
    if (!sessionToken || !activeStudySet.userId || !activeStudySet.sessionId) {
      retryAgent();
      return;
    }
    void refreshVivaSessionToken({
      sessionId: activeStudySet.sessionId,
      sessionToken,
      studySetId: activeStudySet.id,
      userId: activeStudySet.userId,
    })
      .then((result) => {
        if (
          !isCurrentBrowserLifecycleAttempt({
            activeAttempt: browserLifecycleAttemptRef.current,
            attempt,
          })
        ) {
          return;
        }
        sessionTokenRef.current = result.session_token;
        agentRef.current.refreshSession({ sessionToken: result.session_token });
      })
      .catch(() => {
        if (
          isCurrentBrowserLifecycleAttempt({
            activeAttempt: browserLifecycleAttemptRef.current,
            attempt,
          })
        ) {
          retryAgent();
        }
      });
  }, [
    activeStudySet.id,
    activeStudySet.sessionId,
    activeStudySet.userId,
    resetPlaybackForGeneration,
    retryAgent,
  ]);
  const startNewSession = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    if (typeof window !== "undefined") window.location.assign("/");
  }, []);
  const endSession = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    stopCaptureForRecap(captureRef, captureStartedRef, levelRef, cancelActiveAudioTurn);
    agentRef.current.stop();
  }, [cancelActiveAudioTurn]);
  const cancelCheckingTurn = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    setSubmittedTextAnswer(undefined);
    cancelActiveAudioTurn();
    levelRef.current.user = 0;
    agentRef.current.cancel();
  }, [cancelActiveAudioTurn]);

  useEffect(() => {
    if (!agent.derived.recap) return;
    stopCaptureForRecap(captureRef, captureStartedRef, levelRef, cancelActiveAudioTurn);
  }, [agent.derived.recap, cancelActiveAudioTurn]);

  // The server accepted the exact in-flight turn: release the page's turn state
  // so the next capture callback can open a new one. Acceptance is not provider
  // success — the pending submission stays until the evaluation arrives.
  const acceptedAudioTurnId = agent.agentState.acceptedAudioTurn?.turnId;
  useEffect(() => {
    if (!acceptedAudioTurnId) return;
    audioTurnDriverRef.current?.release(acceptedAudioTurnId);
  }, [acceptedAudioTurnId]);

  const activeQuestionId = agent.derived.question?.id;
  const previousQuestionIdRef = useRef(activeQuestionId);

  useEffect(() => {
    if (previousQuestionIdRef.current === activeQuestionId) return;
    previousQuestionIdRef.current = activeQuestionId;
    cancelActiveAudioTurn();
    setSubmittedTextAnswer(undefined);
    setTextAnswerEnabled(false);
    setTextRetryOpen(false);
    setInterruptAcknowledged(false);
  }, [activeQuestionId, cancelActiveAudioTurn]);

  // Stable session-start reference so FSRS review intervals are deterministic
  // across renders (and don't recompute the projection every tick).
  const sessionStart = useRef(new Date()).current;
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
  const projectedDerived = useMemo(
    () => derivedStateWithProjectedRecap(agent.derived, recapPlan.recap),
    [agent.derived, recapPlan.recap],
  );
  const projection = useMemo(
    () => projectTrace(projectedDerived, agent.status, sessionStart),
    [projectedDerived, agent.status, sessionStart],
  );
  const sourceFolio = useMemo(
    () => projectSourceFolio(agent.derived, sessionStart),
    [agent.derived, sessionStart],
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
  const isRecap = projection.state === "recap";
  const effectiveState: SessionState = isRecap
    ? "recap"
    : sourceOpen
      ? "source"
      : textRetryOpen
        ? "listening"
        : projection.state;
  const highlightedTokens = isRecap
    ? projection.highlightedTokens
    : sourceOpen
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
        terminalReason: agent.derived.terminalReason,
      }),
    [
      agent.agentState.close,
      agent.agentState.ready,
      agent.derived.errors,
      agent.derived.terminalReason,
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
  const textAnswerState = useMemo(
    () =>
      textAnswerStateForSession({
        canSubmitAnswer: agent.derived.canSubmitAnswer,
        finalTranscript: agent.derived.finalTranscript,
        submittedTextAnswer,
        textAnswerActive,
        textAnswerAvailable,
        textAnswerRequired,
        textRetryOpen,
        transcriptConfidence: agent.derived.transcriptConfidence,
      }),
    [
      agent.derived.canSubmitAnswer,
      agent.derived.finalTranscript,
      agent.derived.transcriptConfidence,
      submittedTextAnswer,
      textAnswerActive,
      textAnswerAvailable,
      textAnswerRequired,
      textRetryOpen,
    ],
  );
  const turnTaking = useMemo(
    () =>
      projectTurnTakingState({
        hasPendingAudio: agent.agentState.audio.length > 0,
        interruptAcknowledged,
        playbackSpeaking,
        question: projection.question,
        runtime,
        state: effectiveState,
        textAnswerFallbackActive: shouldShowNoSpeechNudge({ textAnswerState, textRetryOpen }),
      }),
    [
      agent.agentState.audio.length,
      effectiveState,
      interruptAcknowledged,
      playbackSpeaking,
      projection.question,
      runtime,
      textAnswerState,
      textRetryOpen,
    ],
  );
  const submitRuntimePrimaryAction =
    runtime.primaryActionIntent === "refresh_session"
      ? refreshSession
      : runtime.primaryActionIntent === "retry_agent"
        ? retryAgent
        : runtime.primaryActionIntent === "start_session"
          ? startNewSession
          : submitSpokenTurn;

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
      consentDisclosure={{
        acknowledged: recordingConsentAcknowledged,
        onAcknowledge: acknowledgeRecordingDisclosure,
      }}
      contextLabel={sessionContextLabel}
      elapsed={elapsed}
      glyphState={glyphStateFor(effectiveState)}
      generationId={agent.derived.generationId}
      highlightedTokens={highlightedTokens}
      hintShown={hintShown}
      checkingControl={
        effectiveState === "thinking" && websocketReady
          ? { onCancelTurn: cancelCheckingTurn }
          : undefined
      }
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
      onSubmitAnswer={submitRuntimePrimaryAction}
      onSubmitTextAnswer={submitTextTurn}
      onTryAgain={textAnswerActive ? openTextRetry : submitSpokenTurn}
      onUseTextAnswer={() => {
        setTextAnswerEnabled(true);
        activateTextAnswerMode();
      }}
      onUseVoiceAnswer={() => {
        textAnswerModeRef.current = false;
        cancelActiveAudioTurn();
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
      transcript={agent.derived.transcript}
      textAnswer={textAnswerState}
      turnTaking={turnTaking}
    />
  );
}

export function textAnswerStateForSession(input: {
  canSubmitAnswer: boolean;
  finalTranscript?: string;
  submittedTextAnswer?: string;
  textAnswerActive: boolean;
  textAnswerAvailable: boolean;
  textAnswerRequired: boolean;
  textRetryOpen: boolean;
  transcriptConfidence?: number;
}): TextAnswerState | undefined {
  if (!input.textAnswerAvailable) return undefined;
  const lastAnswer = input.textRetryOpen
    ? undefined
    : (input.finalTranscript ?? input.submittedTextAnswer);
  return {
    active: input.textAnswerActive,
    disabled: !input.canSubmitAnswer,
    lastAnswer,
    lastAnswerUncertain: Boolean(
      lastAnswer !== undefined &&
        lastAnswer === input.finalTranscript &&
        transcriptionWasUncertain(input.transcriptConfidence),
    ),
    required: input.textAnswerRequired,
  };
}

export function shouldShowNoSpeechNudge(input: {
  textAnswerState?: TextAnswerState;
  textRetryOpen: boolean;
}) {
  const state = input.textAnswerState;
  return Boolean(state?.active && !state.lastAnswer && (state.required || input.textRetryOpen));
}

export type BrowserSessionReconnectEvent =
  | { type: "pageshow"; persisted: boolean }
  | { type: "popstate" };

export function browserSessionReconnectReason(
  event: BrowserSessionReconnectEvent,
): VivaAgentGenerationReason | null {
  if (event.type === "popstate") return "back_forward_restore";
  return event.persisted ? "bfcache_restore" : null;
}

export type BrowserLifecycleReconnectPlan =
  | { action: "skip_session_over" }
  | { action: "reload" }
  | { action: "socket_retry" }
  | {
      action: "refresh_session_token";
      sessionId: string;
      sessionToken: string;
      userId: string;
    };

export function browserLifecycleReconnectPlan(input: {
  currentRouteIdentity: SessionRouteIdentity;
  nextRouteIdentity: SessionRouteIdentity;
  recap: unknown;
  sessionId?: string | null;
  sessionToken?: string | null;
  status: string;
  userId?: string | null;
}): BrowserLifecycleReconnectPlan {
  if (!sameBrowserSessionRouteIdentity(input.currentRouteIdentity, input.nextRouteIdentity)) {
    return { action: "reload" };
  }
  if (input.recap) {
    return { action: "skip_session_over" };
  }
  if (input.status === "closed") {
    return { action: "reload" };
  }
  const sessionToken = input.sessionToken?.trim();
  const userId = input.userId?.trim();
  const sessionId = input.sessionId?.trim();
  if (sessionToken && userId && sessionId) {
    return {
      action: "refresh_session_token",
      sessionId,
      sessionToken,
      userId,
    };
  }
  return { action: "socket_retry" };
}

/**
 * The session is over once the Conductor has delivered a recap or the socket has
 * terminally closed. Session-lifecycle effects (the duration clock, the 5s
 * readiness probe) stop here so the closed manuscript doesn't keep ticking or
 * polling — the clock freezes on its final duration, not climbing forever.
 */
export function isSessionOver(input: { recap: unknown; status: string }): boolean {
  return Boolean(input.recap) || input.status === "closed";
}

/**
 * Drain the agent's pending audio to the playback sink and acknowledge it so the
 * controller drops the consumed frames (keeping `agentState.audio` a bounded
 * queue rather than an ever-growing log). New cancellations are flushed first so
 * barge-in stops a response before its remaining frames play. Returns the new
 * handled-cancellation count. Side-effects are injected (sink + acknowledge), so
 * it is deterministic and unit-testable without a socket. The exact frames
 * enqueued are handed back to `acknowledgeAudio` (by reference) so the controller
 * drops precisely those — never a positional count that a concurrent cancellation
 * could make over-remove a not-yet-enqueued survivor.
 */
export function drainAgentAudio(input: {
  audio: readonly VivaAgentAudioOutput[];
  cancellations: readonly string[];
  handledCancel: number;
  sink: {
    enqueue: (output: VivaAgentAudioOutput) => unknown;
    cancel: (responseId: string) => unknown;
  };
  acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) => void;
}): number {
  for (const responseId of input.cancellations.slice(input.handledCancel)) {
    input.sink.cancel(responseId);
  }
  for (const output of input.audio) input.sink.enqueue(output);
  if (input.audio.length > 0) input.acknowledgeAudio(input.audio);
  return input.cancellations.length;
}

export function resetPlaybackCancellationStateForGeneration(input: {
  handledCancelRef: { current: number };
  playback: Pick<VivaAudioPlaybackSink, "resetForGeneration"> | null;
}) {
  input.playback?.resetForGeneration();
  input.handledCancelRef.current = 0;
}

/**
 * The 5s HTTP readiness probe is the only signal while connecting, but once a
 * live WebSocket `ready` frame has arrived on an open socket it's authoritative
 * — the projection already discards contradicting probe notes — so we stop the
 * redundant polling (and on a session that's over). It resumes if the socket
 * drops back below ready.
 */
export function shouldStopReadinessPolling(input: {
  recap: unknown;
  status: string;
  ready: boolean;
}): boolean {
  return (
    isSessionOver({ recap: input.recap, status: input.status }) ||
    (input.ready && input.status === "open")
  );
}

export function stopCaptureForRecap(
  captureRef: { current: LiveCaptureController | null },
  captureStartedRef: { current: boolean },
  levelRef: { current: { user: number } },
  cancelAudioTurn?: () => void,
) {
  captureRef.current?.stop();
  captureRef.current = null;
  captureStartedRef.current = false;
  levelRef.current.user = 0;
  // The in-flight input turn is cancelled through the controller so its retained
  // bytes are released and no phantom provider turn can be created.
  cancelAudioTurn?.();
}

export function enterTextAnswerMode(
  captureRef: { current: LiveCaptureController | null },
  captureStartedRef: { current: boolean },
  levelRef: { current: { user: number } },
  meterRef?: { current: { reset: () => void } },
  cancelAudioTurn?: () => void,
) {
  const capture = captureRef.current;
  if (capture?.cancel) {
    capture.cancel();
  } else {
    capture?.stop();
  }
  captureRef.current = null;
  captureStartedRef.current = false;
  levelRef.current.user = 0;
  meterRef?.current.reset();
  cancelAudioTurn?.();
}

type LiveCaptureController = Pick<VivaPcm16StreamingCaptureController, "stop"> &
  Partial<Pick<VivaPcm16StreamingCaptureController, "cancel" | "flush">>;

/**
 * Submit the spoken answer: flush the capture tail into the turn's last chunk,
 * then send exactly one `audio_end`.
 *
 * The capture source is deliberately left running. It is session-scoped, not
 * turn-scoped: `stop`/`end`/`cancel` release the browser source, which stops
 * every `MediaStream` track and closes the `AudioContext`, while the page's
 * `captureStarted` flag stays set and no question change resets it — so ending
 * capture here would leave a dead controller behind and make every later spoken
 * answer impossible. The retained ledger is not cleared either: only
 * `audio_turn_accepted` releases it, so `pending` and `socket_closed` keep their
 * retry metadata instead of pretending the answer was sent.
 */
export function submitSpokenCaptureTurn(
  captureRef: { current: LiveCaptureController | null },
  driver: Pick<LiveAudioTurnDriver, "submit">,
): VivaAudioSendResult | null {
  captureRef.current?.flush?.();
  return driver.submit();
}

export function micStateForAudioCaptureError(error: unknown): RuntimeMicState {
  return isVivaAudioWorkletUnavailableError(error) ? "unsupported" : "denied";
}

export function micStateForCaptureEndReason(
  reason: VivaAudioCaptureEndReason,
  current: RuntimeMicState,
): RuntimeMicState {
  if (reason === "processor_error") return "unsupported";
  if (reason === "devicechange") return "unknown";
  return current;
}

export function shouldUseLiveMicAudioTransport(input: {
  ready?: { brain?: { live_runtime?: boolean; selectable?: boolean } } | null;
  status: string;
  textAnswerMode: boolean;
}): boolean {
  return (
    input.status === "open" &&
    !input.textAnswerMode &&
    input.ready?.brain?.live_runtime === true &&
    input.ready.brain.selectable === true
  );
}

export function canStartMicrophoneCapture(input: {
  captureStarted: boolean;
  consentAcknowledged: boolean;
  textAnswerMode: boolean;
}): boolean {
  return input.consentAcknowledged && !input.captureStarted && !input.textAnswerMode;
}

export function captureLevelForBloom(input: {
  samples: Float32Array;
  frame?: VivaAudioCaptureSampleFrame;
  meter: {
    push: (samples: Float32Array) => number;
    pushRms: (rms: number) => number;
  };
  reducedMotion: boolean;
  textAnswerMode: boolean;
}): number {
  if (input.reducedMotion || input.textAnswerMode) return 0;
  const rms = input.frame?.rms;
  if (typeof rms === "number" && Number.isFinite(rms)) return input.meter.pushRms(rms);
  return input.meter.push(input.samples);
}

export type ActiveAudioTurn = {
  turnId: string;
  nextSequence: number;
  capturedSamples: number;
};

/** The exact controller surface the page's audio lifecycle depends on. */
export type LiveAudioTurnSeam = {
  sendAudioChunk: (input: VivaAudioChunkInput) => VivaAudioSendResult;
  endAudioTurn: (input: Readonly<{ turnId: string; finalSequence: number }>) => VivaAudioSendResult;
  cancelAudioTurn: (turnId: string) => void;
};

export type LiveAudioCaptureOutcome = {
  chunk: { sequence: number; result: VivaAudioSendResult } | null;
  end: VivaAudioSendResult | null;
  ignored: "empty" | "awaiting_acceptance" | "capped" | "rejected" | null;
};

export type LiveAudioTurnDriver = {
  captureFrame: (frame: { pcm16Bytes: Uint8Array }) => LiveAudioCaptureOutcome;
  submit: () => VivaAudioSendResult | null;
  release: (turnId: string) => boolean;
  cancel: () => boolean;
  getTurn: () => ActiveAudioTurn | null;
  getLastResult: () => VivaAudioSendResult | null;
  isAwaitingAcceptance: () => boolean;
};

/**
 * The page's whole microphone-turn lifecycle, extracted from the component so it
 * is provable without a DOM (`bun:test` has no DOM environment at this base).
 *
 * It never merges a turn into one payload: each capture callback becomes one
 * bounded, contiguous `audio_chunk`, and the turn is submitted with exactly one
 * `audio_end`. Captured samples are counted with checked arithmetic and capture
 * stops before the 45-second raw cap can be exceeded. A submitted turn stays
 * retained by the controller until `audio_turn_accepted` releases it, so a later
 * capture callback is dropped rather than opening a second input turn, and a
 * `socket_closed` result is preserved as retry metadata instead of being read as
 * a successful answer.
 */
export function createLiveAudioTurnDriver(input: {
  controller: LiveAudioTurnSeam;
  createTurnId: () => string;
  maxTurnSamples?: number;
  onCapacityReached?: () => void;
  onSendRejected?: (error: VivaClientSendError) => void;
}): LiveAudioTurnDriver {
  const maxTurnSamples = input.maxTurnSamples ?? VIVA_AUDIO_MAX_TURN_SAMPLES;
  let turn: ActiveAudioTurn | null = null;
  let awaitingTurnId: string | null = null;
  let lastResult: VivaAudioSendResult | null = null;

  function endActiveTurn(active: ActiveAudioTurn): VivaAudioSendResult | null {
    if (active.nextSequence === 0) {
      turn = null;
      return null;
    }
    try {
      const result = input.controller.endAudioTurn({
        finalSequence: active.nextSequence - 1,
        turnId: active.turnId,
      });
      lastResult = result;
      awaitingTurnId = active.turnId;
      turn = null;
      return result;
    } catch (error) {
      if (!isVivaAudioSendRejectedError(error)) throw error;
      turn = null;
      input.onSendRejected?.(error.error);
      return null;
    }
  }

  return {
    captureFrame(frame) {
      const byteLength = frame.pcm16Bytes.byteLength;
      if (byteLength === 0 || byteLength % 2 !== 0) {
        return { chunk: null, end: null, ignored: "empty" };
      }
      if (awaitingTurnId !== null) {
        return { chunk: null, end: null, ignored: "awaiting_acceptance" };
      }
      const active = turn ?? {
        capturedSamples: 0,
        nextSequence: 0,
        turnId: input.createTurnId(),
      };
      const capturedSamples = active.capturedSamples + byteLength / 2;
      if (!Number.isSafeInteger(capturedSamples) || capturedSamples > maxTurnSamples) {
        // End before notifying — see the comment on the exact-cap branch below.
        const end = turn ? endActiveTurn(turn) : null;
        input.onCapacityReached?.();
        return { chunk: null, end, ignored: "capped" };
      }
      let result: VivaAudioSendResult;
      try {
        result = input.controller.sendAudioChunk({
          pcm16Bytes: frame.pcm16Bytes,
          sequence: active.nextSequence,
          turnId: active.turnId,
        });
      } catch (error) {
        if (!isVivaAudioSendRejectedError(error)) throw error;
        input.onSendRejected?.(error.error);
        return { chunk: null, end: null, ignored: "rejected" };
      }
      lastResult = result;
      const chunk = { result, sequence: active.nextSequence };
      turn = {
        capturedSamples,
        nextSequence: active.nextSequence + 1,
        turnId: active.turnId,
      };
      if (capturedSamples === maxTurnSamples) {
        // The turn's single `audio_end` is sent BEFORE the capacity callback,
        // because that callback stops the capture source and the source flushes
        // its buffered tail synchronously back into `captureFrame`. Ending first
        // leaves this driver awaiting acceptance, so the flushed tail is ignored
        // instead of re-entering this branch and calling back into the stop that
        // produced it — which recursed until the stack was exhausted.
        const end = endActiveTurn(turn);
        input.onCapacityReached?.();
        return { chunk, end, ignored: null };
      }
      return { chunk, end: null, ignored: null };
    },
    submit() {
      return turn ? endActiveTurn(turn) : null;
    },
    release(turnId: string) {
      if (awaitingTurnId !== turnId) return false;
      awaitingTurnId = null;
      lastResult = null;
      return true;
    },
    cancel() {
      const cancelledTurnId = turn?.turnId ?? awaitingTurnId;
      if (cancelledTurnId === null) return false;
      turn = null;
      awaitingTurnId = null;
      lastResult = null;
      input.controller.cancelAudioTurn(cancelledTurnId);
      return true;
    },
    getLastResult: () => lastResult,
    getTurn: () => turn,
    isAwaitingAcceptance: () => awaitingTurnId !== null,
  };
}

/** Opaque per-turn identifier; it never carries learner or transcript material. */
export function createOpaqueAudioTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `turn-${crypto.randomUUID()}`;
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function spokenTurnFallbackAction(input: {
  websocketReady: boolean;
}): "open_text_answer" | "ignore" {
  return input.websocketReady ? "open_text_answer" : "ignore";
}

export function textAnswerPayload(answer: string): string | null {
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function derivedStateWithProjectedRecap(
  derived: VivaAgentDerivedState,
  recap?: SessionRecap,
): VivaAgentDerivedState {
  return recap ? { ...derived, recap } : derived;
}

function readBrowserSessionRouteIdentity() {
  const envToken = process.env.NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN?.trim() || null;
  if (typeof window === "undefined") {
    return {
      ...sessionRouteIdentityFromSearch(""),
      sessionToken: envToken,
    };
  }

  const routeIdentity = sessionRouteIdentityFromLocationParts(
    window.location.search,
    window.location.hash,
  );
  canonicalizeSessionBrowserUrl(window);
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

export function sessionRouteWsAccessToken(routeIdentity: { sessionToken?: string | null }) {
  return routeIdentity.sessionToken?.trim() || undefined;
}

type BrowserSessionRouteIdentity = {
  sessionId?: string | null;
  sessionToken?: string | null;
  studySetId?: string | null;
  userId?: string | null;
};

export function shouldRefreshBrowserSessionToken(identity: BrowserSessionRouteIdentity): boolean {
  return Boolean(
    identity.sessionId?.trim() &&
      identity.sessionToken?.trim() &&
      identity.studySetId?.trim() &&
      identity.userId?.trim(),
  );
}

export async function refreshBrowserSessionToken(
  identity: BrowserSessionRouteIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const fallbackToken = identity.sessionToken?.trim() || null;
  if (!shouldRefreshBrowserSessionToken(identity)) return fallbackToken;
  try {
    const response = await fetchImpl("/api/viva-session/refresh", {
      body: JSON.stringify({
        session_id: identity.sessionId?.trim(),
        session_token: fallbackToken,
        study_set_id: identity.studySetId?.trim(),
        user_id: identity.userId?.trim(),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) return fallbackToken;
    const body = (await response.json()) as { session_token?: unknown };
    const refreshedToken = typeof body.session_token === "string" ? body.session_token.trim() : "";
    return refreshedToken || fallbackToken;
  } catch {
    return fallbackToken;
  }
}

export function sameBrowserSessionRouteIdentity(
  left: ReturnType<typeof readBrowserSessionRouteIdentity>,
  right: ReturnType<typeof readBrowserSessionRouteIdentity>,
): boolean {
  return (
    left.userId === right.userId &&
    left.studySetId === right.studySetId &&
    left.sessionId === right.sessionId
  );
}

export function isCurrentBrowserLifecycleAttempt(input: {
  activeAttempt: number;
  attempt: number;
}): boolean {
  return input.activeAttempt === input.attempt;
}

function initialReadinessProbe(): VivaAgentReadinessProbe {
  const apiBaseUrl = vivaAgentHttpBaseUrl();
  return apiBaseUrl ? { apiBaseUrl, status: "checking" } : { status: "api_missing" };
}
