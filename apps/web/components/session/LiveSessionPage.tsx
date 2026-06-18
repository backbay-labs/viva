"use client";

import { seedStudySets } from "@viva/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";
import { useVivaAgentSession } from "../../lib/use-viva-agent-session";
import {
  createBrowserVivaAudioCaptureSource,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaAudioCaptureSource,
} from "../../lib/viva-audio-capture";
import {
  createVivaAudioPlaybackSink,
  type VivaAudioPlaybackSink,
} from "../../lib/viva-audio-playback";
import { vivaSceneReducer } from "../../lib/viva-scene-reducer";
import {
  projectConceptNodes,
  projectHighlightedTokens,
  projectRuntimeCopy,
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

export function LiveSessionPage() {
  const reducedMotion = usePrefersReducedMotion();
  const [elapsed, setElapsed] = useState(0);
  const [hintShown, setHintShown] = useState(false);
  const [micState, setMicState] = useState<RuntimeMicState>("unknown");
  const [sourceOpen, setSourceOpen] = useState(false);

  const agent = useVivaAgentSession({
    mode: "quiz",
    sessionId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID,
    studySet: STUDY_SET,
    trustedStudySetId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID,
    userId: process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID,
  });
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const levelRef = useRef<VoiceTraceLevel>({ user: 0, agent: 0 });
  const captureRef = useRef<VivaAudioCaptureSource | null>(null);
  const captureStartedRef = useRef(false);
  const meterRef = useRef(createVoiceLevelMeter({ coefficient: 0.3 }));
  const playbackRef = useRef<VivaAudioPlaybackSink | null>(null);
  const handledAudioRef = useRef(0);
  const handledCancelRef = useRef(0);

  const getPlayback = useCallback(() => {
    if (playbackRef.current) return playbackRef.current;
    const sink = createVivaAudioPlaybackSink({
      contextFactory: () => {
        const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
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
    if (captureStartedRef.current || reducedMotion) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMicState("unsupported");
      return;
    }
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) {
      setMicState("unsupported");
      return;
    }
    captureStartedRef.current = true;
    try {
      const source = await createBrowserVivaAudioCaptureSource({
        AudioContextCtor,
        mediaDevices: navigator.mediaDevices,
        sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
      });
      captureRef.current = source;
      setMicState("available");
      const meter = meterRef.current;
      // Samples drive the bloom ONLY — never sent to the brain.
      void source.start((samples) => {
        levelRef.current.user = meter.push(samples);
      });
    } catch {
      captureStartedRef.current = false; // allow another attempt on the next gesture
      levelRef.current.user = 0;
      setMicState("denied");
    }
  }, [reducedMotion]);

  const onUserGesture = useCallback(() => {
    void getPlayback()
      .unlock()
      .catch(() => {});
    void startMic();
  }, [getPlayback, startMic]);

  // Start listening (mic + playback unlock) on the first interaction anywhere.
  useEffect(() => {
    const handler = () => onUserGesture();
    window.addEventListener("pointerdown", handler, { once: true });
    return () => window.removeEventListener("pointerdown", handler);
  }, [onUserGesture]);

  const submitTurn = useCallback(() => {
    onUserGesture();
    setSourceOpen(false);
    setHintShown(false);
    // Content is the student's turn signal; the synthetic brain runs its
    // deterministic evaluation sequence. A real provider receives the transcript.
    agentRef.current.sendText("(spoken answer)");
  }, [onUserGesture]);

  // Stable session-start reference so FSRS review intervals are deterministic
  // across renders (and don't recompute the projection every tick).
  const sessionStart = useRef(new Date()).current;
  const projection = useMemo(
    () => projectTrace(agent.derived, agent.status, sessionStart),
    [agent.derived, agent.status, sessionStart],
  );
  const conceptNodes = useMemo(
    () => projectConceptNodes(STUDY_SET.concepts, agent.agentState.conceptStatuses),
    [agent.agentState.conceptStatuses],
  );
  const scene = useMemo(() => {
    const knownEntityIds = new Set<string>([
      ...STUDY_SET.concepts.map((concept) => concept.id),
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
  }, [agent.derived.manuscriptIntents, agent.derived.question, agent.derived.sources]);
  const effectiveState: SessionState = sourceOpen ? "source" : projection.state;
  const highlightedTokens = sourceOpen
    ? projectHighlightedTokens("source", agent.derived)
    : projection.highlightedTokens;
  const runtime = useMemo(
    () =>
      projectRuntimeCopy({
        errors: agent.derived.errors,
        mic: micState,
        readiness: agent.readiness,
        ready: agent.agentState.ready,
        status: agent.status,
      }),
    [agent.agentState.ready, agent.derived.errors, agent.readiness, agent.status, micState],
  );

  return (
    <LiveSessionShell
      conceptNodes={conceptNodes}
      elapsed={elapsed}
      glyphState={glyphStateFor(effectiveState)}
      highlightedTokens={highlightedTokens}
      hintShown={hintShown}
      levelRef={levelRef}
      onBackToQuestion={() => setSourceOpen(false)}
      onHint={() => setHintShown((shown) => !shown)}
      onNextQuestion={submitTurn}
      onShowSource={() => setSourceOpen(true)}
      onSubmitAnswer={submitTurn}
      onTryAgain={submitTurn}
      question={projection.question}
      runtime={runtime}
      scene={scene}
      state={effectiveState}
    />
  );
}
