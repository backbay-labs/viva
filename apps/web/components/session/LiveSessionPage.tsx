"use client";

import {
  type AuthenticatedStudyProjectionV1,
  type SessionRecap,
  type StudySetIngestionStatus,
  VIVA_AUDIO_MAX_TURN_SAMPLES,
  type VivaClientTurnIntent,
} from "@viva/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";
import {
  type BrowserSessionCredential,
  type RenewBrowserSessionCredential,
  type RenewBrowserSessionCredentialResult,
  readBrowserSessionCredential,
  renewBrowserSessionCredential,
  replaceBrowserSessionCredential,
  studyProjectionToAgentSessionConfig,
  useVivaAgentSession,
  type VivaAgentDerivedState,
} from "../../lib/use-viva-agent-session";
import {
  type AuthenticatedStudyProjectionFailureCause,
  createVivaAgentSessionController,
  fetchAuthenticatedStudyProjection,
  fetchVivaAgentReadinessProbe,
  isVivaAudioSendRejectedError,
  reconnectDelayMs,
  VIVA_AGENT_RECONNECT_DELAYS_MS,
  type VivaAgentAudioOutput,
  type VivaAgentGenerationReason,
  type VivaAgentReadinessProbe,
  type VivaAgentReconnectState,
  type VivaAgentRetainedAudioTurn,
  type VivaAudioChunkInput,
  type VivaAudioSendResult,
  type VivaClientSendError,
  vivaAgentHttpBaseUrl,
  vivaAgentReconnectDecision,
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
import {
  type SessionReviewPlanItem,
  sessionReviewPlanFromProjection,
  studyProjectionReadiness,
} from "../../lib/viva-display";
import { vivaSceneReducer } from "../../lib/viva-scene-reducer";
import {
  canonicalizeSessionBrowserUrl,
  type SessionRouteIdentity,
  sessionRouteIdentityFromLocationParts,
} from "../../lib/viva-session-entry";
import {
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
type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

/**
 * The page's one scheduling seam. Every deferred/bounded timer this component
 * arms goes through it, so a mounted test drives them deterministically instead
 * of racing the real event loop.
 */
export type VivaAgentReconnectClock = Readonly<{
  random: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}>;

export const defaultVivaAgentReconnectClock: VivaAgentReconnectClock = {
  clearTimeout: (...args) => globalThis.clearTimeout(...args),
  random: () => Math.random(),
  setTimeout: ((...args: Parameters<typeof globalThis.setTimeout>) =>
    globalThis.setTimeout(...args)) as typeof globalThis.setTimeout,
};

/**
 * A production dependency seam, not a test-only global: every default below is a
 * fixed module import, and a caller may replace any subset. It is what lets the
 * mounted suite prove the real component's bootstrap ordering without a socket,
 * a microphone, or a network.
 */
export type LiveSessionPageDependencies = Readonly<{
  createAgentController: typeof createVivaAgentSessionController;
  createAudioCaptureSource: typeof createBrowserVivaAudioCaptureSource;
  createAudioPlaybackSink: typeof createVivaAudioPlaybackSink;
  fetchReadiness: typeof fetchVivaAgentReadinessProbe;
  fetchStudyProjection: typeof fetchAuthenticatedStudyProjection;
  readCredential: typeof readBrowserSessionCredential;
  replaceCredential: typeof replaceBrowserSessionCredential;
  renewCredential: RenewBrowserSessionCredential;
  reconnectClock: VivaAgentReconnectClock;
}>;

export const defaultLiveSessionPageDependencies: LiveSessionPageDependencies = {
  createAgentController: createVivaAgentSessionController,
  createAudioCaptureSource: createBrowserVivaAudioCaptureSource,
  createAudioPlaybackSink: createVivaAudioPlaybackSink,
  fetchReadiness: fetchVivaAgentReadinessProbe,
  fetchStudyProjection: fetchAuthenticatedStudyProjection,
  reconnectClock: defaultVivaAgentReconnectClock,
  readCredential: readBrowserSessionCredential,
  renewCredential: renewBrowserSessionCredential,
  replaceCredential: replaceBrowserSessionCredential,
};

export type LiveSessionPageProps = {
  dependencies?: Partial<LiveSessionPageDependencies>;
};

/**
 * The bootstrap gate. `connect` is eligible only at `ready`, and every failure
 * is a sanitized pre-loop cause — never a fetch message, a close reason, or a
 * credential fragment.
 */
export type SessionCredentialStage =
  | { kind: "resolving" }
  | { kind: "renewing" }
  | { kind: "ready" }
  | {
      kind: "failed";
      cause: "missing_identity" | "missing_credential" | "auth_terminal" | "renewal_unavailable";
    };

/**
 * The authenticated projection's own gate. `identity_mismatch` is separate from
 * `invalid_projection` so a projection that parsed but describes ANOTHER session
 * is never reported as a malformed one.
 */
export type SessionProjectionStage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | {
      kind: "failed";
      cause: AuthenticatedStudyProjectionFailureCause | "identity_mismatch";
      retryAfterSeconds?: number;
    };

/** The all-null identity both the server render and the first client render use. */
export const NEUTRAL_SESSION_ROUTE_IDENTITY: SessionRouteIdentity = {
  sessionId: null,
  sessionToken: null,
  studySetId: null,
  userId: null,
};

export function LiveSessionPage({ dependencies }: LiveSessionPageProps = {}) {
  const depsRef = useRef<LiveSessionPageDependencies>(defaultLiveSessionPageDependencies);
  depsRef.current = dependencies
    ? { ...defaultLiveSessionPageDependencies, ...dependencies }
    : defaultLiveSessionPageDependencies;

  const reducedMotion = usePrefersReducedMotion();
  // `WEBSESSION-ROUTE-01`: the first render — server and browser alike — reads no
  // browser state at all. Route identity, the credential, and the URL
  // canonicalization all happen in the mount effect, so the two renders produce
  // byte-identical markup and hydration has nothing to reconcile.
  const [routeIdentity, setRouteIdentity] = useState<SessionRouteIdentity>(
    NEUTRAL_SESSION_ROUTE_IDENTITY,
  );
  const [credential, setCredentialState] = useState<BrowserSessionCredential | null>(null);
  const [credentialStage, setCredentialStage] = useState<SessionCredentialStage>({
    kind: "resolving",
  });
  // The token the controller is CREATED with. It is seeded exactly once, when
  // the entry credential first becomes eligible; later rotations reach the same
  // controller through `refreshSession` so Plan 03's retained audio ledger
  // survives a credential renewal instead of being thrown away with the
  // controller.
  const [bootstrapAccessToken, setBootstrapAccessToken] = useState<string | null>(null);
  const credentialRef = useRef<BrowserSessionCredential | null>(null);
  const mountAttemptRef = useRef(0);
  const renewalAbortRef = useRef<AbortController | null>(null);
  // `WEBSESSION-DATA-01`: the server-owned projection is the ONLY study/session
  // read model. There is no seed overlay and no library-metadata fallback to
  // fall back to, so `null` here means the page cannot render a session at all.
  const [studyProjection, setStudyProjection] = useState<AuthenticatedStudyProjectionV1 | null>(
    null,
  );
  const [projectionStage, setProjectionStage] = useState<SessionProjectionStage>({ kind: "idle" });
  const [projectionAttemptTick, setProjectionAttemptTick] = useState(0);
  const projectionAttemptRef = useRef("");
  const projectionAbortRef = useRef<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hintShown, setHintShown] = useState(false);
  const [micState, setMicState] = useState<RuntimeMicState>("unknown");
  const [readinessProbe, setReadinessProbe] =
    useState<VivaAgentReadinessProbe>(initialReadinessProbe);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [textAnswerEnabled, setTextAnswerEnabled] = useState(false);
  const [textRetryOpen, setTextRetryOpen] = useState(false);
  const [submittedTextAnswer, setSubmittedTextAnswer] = useState<string>();
  const [recordingConsentAcknowledged, setRecordingConsentAcknowledged] = useState(false);
  const acknowledgedIdentityRef = useRef<string | null>(null);
  const [playbackSpeaking, setPlaybackSpeaking] = useState(false);
  const [interruptAcknowledged, setInterruptAcknowledged] = useState(false);
  const routeIdentityRef = useRef(routeIdentity);
  const browserLifecycleAttemptRef = useRef(0);
  // `WEBSESSION-RECOVERY-01`: this page is the SINGLE owner of reconnect state.
  // The controller keeps socket/generation state; the hook creates no timer.
  const [reconnect, setReconnect] = useState<VivaAgentReconnectState>({
    attempts: 0,
    kind: "idle",
  });
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptTokenRef = useRef(0);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const explicitlyStoppedRef = useRef(false);
  const replayedGenerationRef = useRef<string | null>(null);
  const [retainedAudioTurn, setRetainedAudioTurn] = useState<VivaAgentRetainedAudioTurn | null>(
    null,
  );

  // The signed session config is built from the projection alone; the only
  // caller-supplied member is `user_id`, taken from the COMMITTED credential's
  // verified identity rather than from the raw route. The memo key is that id,
  // not the credential object, so a rotation never rebuilds the config and
  // never costs the controller its retained audio ledger.
  const credentialUserId = credential?.identity.userId ?? null;
  const sessionConfig = useMemo(
    () =>
      studyProjection && credentialUserId
        ? studyProjectionToAgentSessionConfig(studyProjection, credentialUserId)
        : null,
    [studyProjection, credentialUserId],
  );
  const agent = useVivaAgentSession({
    controllerFactory: depsRef.current.createAgentController,
    session: sessionConfig,
    sessionToken: bootstrapAccessToken,
    token: sessionRouteWsAccessToken({ sessionToken: bootstrapAccessToken }),
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
  /**
   * The explicit-discard path: a terminal recap, a session cap, an explicit turn
   * cancel, or the learner ending the session. Only these release a turn whose
   * `audio_end` already reached the server.
   */
  const discardActiveAudioTurn = useCallback(() => {
    if (audioTurnDriverRef.current?.cancel({ discardSubmitted: true })) return;
    const retained = agentRef.current.getRetainedAudioTurn();
    if (retained) agentRef.current.cancelAudioTurn(retained.turnId);
  }, []);

  const getPlayback = useCallback(() => {
    if (playbackRef.current) return playbackRef.current;
    const sink = depsRef.current.createAudioPlaybackSink({
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

  /**
   * The single authoritative credential write. Every browser lifecycle callback
   * reads `credentialRef` — never a captured `sessionToken` closure — so a
   * rotation is visible to an in-flight callback the moment it commits, and no
   * caller can observe half a rotated pair.
   */
  const commitCredential = useCallback((next: BrowserSessionCredential | null) => {
    credentialRef.current = next;
    setCredentialState(next);
  }, []);

  /**
   * One bounded renewal. `isCurrent` is the supersession guard (mount attempt
   * for entry, browser-lifecycle attempt afterwards); the abort signal is the
   * unmount guard. A superseded or aborted renewal updates nothing.
   */
  const runCredentialRenewal = useCallback(
    async (input: {
      entry: boolean;
      isCurrent: () => boolean;
      reason: Parameters<RenewBrowserSessionCredential>[0]["reason"];
      signal: AbortSignal;
    }): Promise<RenewBrowserSessionCredentialResult | null> => {
      const current = credentialRef.current;
      if (!current) return null;
      const deps = depsRef.current;
      let result: RenewBrowserSessionCredentialResult;
      try {
        result = await deps.renewCredential({
          credential: current,
          reason: input.reason,
          signal: input.signal,
        });
      } catch {
        // A thrown renewal is never a UI message; it is a retained credential.
        result = { credential: current, reason: "unavailable", status: "retained" };
      }
      if (input.signal.aborted || !input.isCurrent()) return null;

      if (result.status === "renewed") {
        commitCredential(result.credential);
        deps.replaceCredential(result.credential);
        if (input.entry) {
          setBootstrapAccessToken(result.credential.accessToken);
          setCredentialStage({ kind: "ready" });
        }
        return result;
      }
      if (result.status === "terminal") {
        commitCredential(null);
        deps.replaceCredential(null);
        setCredentialStage({ cause: "auth_terminal", kind: "failed" });
        return result;
      }
      // `retained`: before any socket has consumed it, the entry credential may
      // still be tried once rather than hanging the learner. After a generation
      // has opened, a retained credential is not eligible for a new one — the
      // page stays fail-closed and keeps the Plan 03 ledger for manual recovery.
      if (input.entry) {
        setBootstrapAccessToken(result.credential.accessToken);
        setCredentialStage({ kind: "ready" });
      } else {
        setCredentialStage({ cause: "renewal_unavailable", kind: "failed" });
      }
      return result;
    },
    [commitCredential],
  );

  // Mount effect: read the browser identity WITHOUT mutating history, merge only
  // an identity-matched in-memory credential (or a nonrenewable direct entry),
  // commit it, then canonicalize the URL exactly once.
  useEffect(() => {
    const attempt = mountAttemptRef.current + 1;
    mountAttemptRef.current = attempt;
    const identity = sessionRouteIdentityFromLocationParts(
      window.location.search,
      window.location.hash,
    );
    const deps = depsRef.current;
    const entry = resolveEntrySessionCredential({
      envAccessToken: process.env.NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN?.trim() || null,
      identity,
      vaultCredential: deps.readCredential(),
    });
    routeIdentityRef.current = identity;
    setRouteIdentity(identity);
    // The credential is committed to the in-memory vault BEFORE the URL is
    // canonicalized, because canonicalization destroys the only other copy of a
    // direct-entry access token. Without this, a StrictMode remount (or any
    // later re-read) would find a stripped URL, an empty vault, and no
    // credential at all — the entry would silently become unauthenticated.
    if (entry) deps.replaceCredential(entry);
    commitCredential(entry ? (deps.readCredential() ?? entry) : null);
    setCredentialStage(
      entry
        ? { kind: "renewing" }
        : {
            cause: completeSessionRouteIdentity(identity)
              ? "missing_credential"
              : "missing_identity",
            kind: "failed",
          },
    );
    canonicalizeSessionBrowserUrl(window);
  }, [commitCredential]);

  // Entry renewal, deferred by one tick so the dev StrictMode
  // mount→unmount→mount cycle settles before a ONE-TIME rotating credential is
  // spent. The attempt guard below is the correctness mechanism; the deferral is
  // what keeps the throwaway mount from consuming R1.
  useEffect(() => {
    if (credentialStage.kind !== "renewing") return;
    const clock = depsRef.current.reconnectClock;
    const controller = new AbortController();
    renewalAbortRef.current = controller;
    const attempt = mountAttemptRef.current;
    const timer = clock.setTimeout(() => {
      void runCredentialRenewal({
        entry: true,
        isCurrent: () => attempt === mountAttemptRef.current && mountedRef.current,
        reason: "session_entry",
        signal: controller.signal,
      });
    }, 0);
    return () => {
      clock.clearTimeout(timer);
      controller.abort();
      if (renewalAbortRef.current === controller) renewalAbortRef.current = null;
    };
  }, [credentialStage.kind, runCredentialRenewal]);

  /**
   * `WEBSESSION-DATA-01` — fetch and identity-verify the authenticated
   * projection. One in-flight request per attempt: a route change, a browser
   * lifecycle replacement, a retry supersession, and unmount all abort it, and a
   * superseded response updates nothing.
   */
  useEffect(() => {
    if (credentialStage.kind !== "ready") return;
    const credential = credentialRef.current;
    const identity = routeIdentityRef.current;
    const studySetId = identity.studySetId?.trim();
    const voiceSessionId = identity.sessionId?.trim();
    if (!credential || !studySetId || !voiceSessionId) return;

    const clock = depsRef.current.reconnectClock;
    const controller = new AbortController();
    projectionAbortRef.current?.abort();
    projectionAbortRef.current = controller;
    // The attempt key carries the explicit-refetch tick, so a retry supersedes
    // an in-flight fetch by identity rather than by ordering luck.
    const attempt = `${projectionAttemptTick}:${studySetId}:${voiceSessionId}`;
    projectionAttemptRef.current = attempt;
    setProjectionStage({ kind: "loading" });

    const timer = clock.setTimeout(() => {
      void depsRef.current
        .fetchStudyProjection({
          accessToken: credential.accessToken,
          signal: controller.signal,
          studySetId,
          voiceSessionId,
        })
        .then((result) => {
          if (controller.signal.aborted || !mountedRef.current) return;
          if (attempt !== projectionAttemptRef.current) return;
          if (result.status === "failed") {
            setStudyProjection(null);
            setProjectionStage({
              cause: result.cause,
              kind: "failed",
              ...(result.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: result.retryAfterSeconds }),
            });
            return;
          }
          // The BFF already binds identity, but the browser verifies it again:
          // a projection describing another set or session must never be
          // rendered as this learner's own state, whatever produced it.
          if (
            result.projection.studySet.id !== studySetId ||
            result.projection.session.id !== voiceSessionId
          ) {
            setStudyProjection(null);
            setProjectionStage({ cause: "identity_mismatch", kind: "failed" });
            return;
          }
          setStudyProjection(result.projection);
          setProjectionStage({ kind: "ready" });
        });
    }, 0);

    return () => {
      clock.clearTimeout(timer);
      controller.abort();
      if (projectionAbortRef.current === controller) projectionAbortRef.current = null;
    };
  }, [credentialStage.kind, projectionAttemptTick]);

  const projectionReadiness = useMemo(
    () => (studyProjection ? studyProjectionReadiness(studyProjection) : null),
    [studyProjection],
  );

  // Connect once, and only once route resolution, the selected D-07 branch's
  // renewal, AND projection validation have all completed for this attempt. The
  // zero-delay deferral survives from the StrictMode fix, but eligibility — not
  // the timer — is what makes exactly one socket open.
  const connectionEligible =
    credentialStage.kind === "ready" &&
    projectionStage.kind === "ready" &&
    projectionReadiness?.canConnect === true;
  useEffect(() => {
    if (!connectionEligible) return;
    const clock = depsRef.current.reconnectClock;
    const id = clock.setTimeout(() => agentRef.current.connect(), 0);
    return () => clock.clearTimeout(id);
  }, [connectionEligible]);

  /**
   * Opens the next generation with the CURRENT credential, through the existing
   * controller so the retained audio ledger survives the rotation.
   */
  const openGenerationWithCurrentCredential = useCallback((reason: VivaAgentGenerationReason) => {
    const current = credentialRef.current;
    if (!current) return;
    agentRef.current.refreshSession({ reason, sessionToken: current.accessToken });
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    const timer = reconnectTimerRef.current;
    if (timer === null) return;
    depsRef.current.reconnectClock.clearTimeout(timer);
    reconnectTimerRef.current = null;
  }, []);

  /**
   * One bounded recovery attempt, in the fixed order the plan pins:
   * lease-grace delay -> D-07 credential renewal -> authenticated projection
   * refetch -> replacement generation. An attempt token supersedes a stale
   * async step, so a late renewal can never open a generation for an attempt
   * that has already been replaced, and no later step runs if an earlier one
   * was aborted, superseded, or failed.
   */
  const runRecoveryAttemptRef = useRef<(attempt: 1 | 2 | 3) => void>(() => {});
  const scheduleRecoveryAttempt = useCallback(
    (attempt: 1 | 2 | 3, delayMs: number) => {
      clearRecoveryTimer();
      setReconnect({ attempt, delayMs, kind: "scheduled" });
      const clock = depsRef.current.reconnectClock;
      reconnectTimerRef.current = clock.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!mountedRef.current) return;
        runRecoveryAttemptRef.current(attempt);
      }, delayMs);
    },
    [clearRecoveryTimer],
  );

  const consumeFailedRecoveryAttempt = useCallback(
    (attempt: 1 | 2 | 3) => {
      if (attempt >= VIVA_AGENT_RECONNECT_DELAYS_MS.length) {
        setReconnect({ attempts: 3, kind: "exhausted" });
        return;
      }
      const next = (attempt + 1) as 1 | 2 | 3;
      scheduleRecoveryAttempt(
        next,
        reconnectDelayMs(next, depsRef.current.reconnectClock.random()),
      );
    },
    [scheduleRecoveryAttempt],
  );

  const runRecoveryAttempt = useCallback(
    (attempt: 1 | 2 | 3) => {
      const token = reconnectAttemptTokenRef.current + 1;
      reconnectAttemptTokenRef.current = token;
      const isCurrent = () => mountedRef.current && reconnectAttemptTokenRef.current === token;
      const abort = new AbortController();
      recoveryAbortRef.current?.abort();
      recoveryAbortRef.current = abort;
      setReconnect({ attempt, kind: "refreshing_credential" });
      void (async () => {
        // Step 1: renew through the SELECTED D-07 path, so a consumed and
        // replay-protected access token is never reused on a new generation.
        const renewal = await runCredentialRenewal({
          entry: false,
          isCurrent,
          reason: "transport_reconnect",
          signal: abort.signal,
        });
        if (!isCurrent() || abort.signal.aborted) return;
        if (renewal?.status !== "renewed") {
          // The ledger is untouched and no socket is opened; the page shows its
          // sanitized credential-unavailable state with an explicit retry.
          consumeFailedRecoveryAttempt(attempt);
          return;
        }

        // Step 2: refetch and identity-validate the projection with the NEW
        // access token before any socket exists to consume it.
        const identity = routeIdentityRef.current;
        const studySetId = identity.studySetId?.trim();
        const voiceSessionId = identity.sessionId?.trim();
        if (!studySetId || !voiceSessionId) {
          consumeFailedRecoveryAttempt(attempt);
          return;
        }
        const projection = await depsRef.current.fetchStudyProjection({
          accessToken: renewal.credential.accessToken,
          signal: abort.signal,
          studySetId,
          voiceSessionId,
        });
        if (!isCurrent() || abort.signal.aborted) return;
        if (
          projection.status !== "ready" ||
          projection.projection.studySet.id !== studySetId ||
          projection.projection.session.id !== voiceSessionId
        ) {
          setProjectionStage(
            projection.status === "failed"
              ? { cause: projection.cause, kind: "failed" }
              : { cause: "identity_mismatch", kind: "failed" },
          );
          consumeFailedRecoveryAttempt(attempt);
          return;
        }
        setStudyProjection(projection.projection);
        setProjectionStage({ kind: "ready" });

        // Step 3: only now open the replacement generation, through the SAME
        // controller so Plan 03's retained ledger survives the rotation.
        setReconnect({ attempt, kind: "connecting" });
        openGenerationWithCurrentCredential("socket_retry");
      })();
    },
    [consumeFailedRecoveryAttempt, openGenerationWithCurrentCredential, runCredentialRenewal],
  );
  runRecoveryAttemptRef.current = runRecoveryAttempt;

  const renewAndReopen = useCallback(
    (reason: VivaAgentGenerationReason, renewalReason: "browser_restore" | "auth_expired") => {
      const attempt = browserLifecycleAttemptRef.current;
      const controller = new AbortController();
      renewalAbortRef.current?.abort();
      renewalAbortRef.current = controller;
      void runCredentialRenewal({
        entry: false,
        isCurrent: () =>
          mountedRef.current &&
          isCurrentBrowserLifecycleAttempt({
            activeAttempt: browserLifecycleAttemptRef.current,
            attempt,
          }),
        reason: renewalReason,
        signal: controller.signal,
      }).then((result) => {
        if (result?.status !== "renewed") return;
        if (
          !mountedRef.current ||
          !isCurrentBrowserLifecycleAttempt({
            activeAttempt: browserLifecycleAttemptRef.current,
            attempt,
          })
        ) {
          return;
        }
        openGenerationWithCurrentCredential(reason);
      });
    },
    [openGenerationWithCurrentCredential, runCredentialRenewal],
  );

  const reconnectForBrowserLifecycle = useCallback(
    (reason: VivaAgentGenerationReason) => {
      const nextRouteIdentity = sessionRouteIdentityFromLocationParts(
        window.location.search,
        window.location.hash,
      );
      const current = credentialRef.current;
      const plan = browserLifecycleReconnectPlan({
        currentRouteIdentity: routeIdentityRef.current,
        nextRouteIdentity,
        recap: agentRef.current.derived.recap,
        renewable: isRenewableBrowserSessionCredential(current),
        status: agentRef.current.status,
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
      if (plan.action === "renew_credential") {
        renewAndReopen(reason, "browser_restore");
        return;
      }
      agentRef.current.reset();
      agentRef.current.connect(reason);
    },
    [cancelActiveAudioTurn, renewAndReopen, resetPlaybackForGeneration],
  );

  const agentTermination = agent.derived.termination;
  const agentTerminalReason = agent.derived.terminalReason;
  const agentRecapState = agent.derived.recapState;
  const agentStructuredErrors = agent.derived.structuredErrors;
  const agentStatus = agent.status;

  // Classify-then-schedule. NO timer is registered until a close has actually
  // been classified by Plan 05's typed termination.
  useEffect(() => {
    if (!agentTermination) return;
    const clock = depsRef.current.reconnectClock;
    const decision = vivaAgentReconnectDecision({
      attempts: reconnectAttemptsUsed(reconnectRef.current),
      explicitlyStopped: explicitlyStoppedRef.current,
      random: clock.random(),
      state: {
        recap: agentRecapState,
        status: agentStatus,
        structuredErrors: agentStructuredErrors,
        terminalReason: agentTerminalReason,
        termination: agentTermination,
      },
    });
    if (decision.action === "stop") {
      clearRecoveryTimer();
      return;
    }
    if (decision.action === "exhausted") {
      clearRecoveryTimer();
      setReconnect({ attempts: 3, kind: "exhausted" });
      return;
    }
    scheduleRecoveryAttempt(decision.attempt, decision.delayMs);
  }, [
    agentRecapState,
    agentStatus,
    agentStructuredErrors,
    agentTerminalReason,
    agentTermination,
    clearRecoveryTimer,
    scheduleRecoveryAttempt,
  ]);

  // The attempt budget resets on a REACHED READY generation, never merely on a
  // socket that started opening: a replacement that fails during its handshake
  // must consume its attempt rather than restart the whole budget.
  const agentGenerationId = agent.agentState.generation?.id;
  const agentReachedReady = Boolean(agent.agentState.ready) && agent.status === "open";
  useEffect(() => {
    if (!agentReachedReady) return;
    clearRecoveryTimer();
    reconnectAttemptTokenRef.current += 1;
    setReconnect((current) => (current.kind === "idle" ? current : { attempts: 0, kind: "idle" }));
  }, [agentReachedReady, clearRecoveryTimer]);

  // `WEBSESSION-AUDIO-01`: exactly one replay per ready generation, and only
  // when Plan 03 still holds a turn. Nothing here re-chunks or re-numbers.
  useEffect(() => {
    if (!agentReachedReady || !agentGenerationId) return;
    if (replayedGenerationRef.current === agentGenerationId) return;
    replayedGenerationRef.current = agentGenerationId;
    if (!agentRef.current.getRetainedAudioTurn()) return;
    agentRef.current.retryPendingAudio();
  }, [agentGenerationId, agentReachedReady]);

  // What Plan 03 still holds, mirrored for copy. Compared field by field so a
  // fresh read of an unchanged ledger cannot loop the renderer. `agentState` is
  // the deliberate trigger: the ledger is the CONTROLLER's, so every agent state
  // change is the only signal the browser has that it may have moved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentState is the change trigger, not a read value.
  useEffect(() => {
    setRetainedAudioTurn((previous) => {
      const next = agentRef.current.getRetainedAudioTurn();
      if (previous === next) return previous;
      if (!previous || !next) return next;
      return sameRetainedAudioTurn(previous, next) ? previous : next;
    });
  }, [agent.agentState]);

  // A session that has said its last word releases the retained turn: the bytes
  // can no longer be admitted, so holding them would be a false promise.
  const sessionTerminal = Boolean(agentRecapState) || agentTerminalReason !== undefined;
  useEffect(() => {
    if (!sessionTerminal) return;
    if (!agentRef.current.getRetainedAudioTurn()) return;
    discardActiveAudioTurn();
    setRetainedAudioTurn(null);
  }, [discardActiveAudioTurn, sessionTerminal]);

  useEffect(() => {
    return () => {
      clearRecoveryTimer();
      recoveryAbortRef.current?.abort();
    };
  }, [clearRecoveryTimer]);

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
      const next = await depsRef.current.fetchReadiness();
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
        liveProvider: liveProviderRef.current,
        scope: VIVA_DISCLOSURE_SCOPE,
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
      const source = await depsRef.current.createAudioCaptureSource({
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

  /**
   * The disclosure identity: the acknowledgment belongs to THIS study set and
   * THIS voice session under THIS D-08 scope, and to nothing else.
   */
  const disclosureKey =
    routeIdentity.studySetId && routeIdentity.sessionId
      ? disclosureAcknowledgementKey({
          scope: VIVA_DISCLOSURE_SCOPE,
          studySetId: routeIdentity.studySetId,
          voiceSessionId: routeIdentity.sessionId,
        })
      : null;

  // Hydrate the boolean only once the route identity has resolved, and clear
  // in-memory consent whenever that identity changes — before any capture for
  // the new identity could start.
  useEffect(() => {
    if (acknowledgedIdentityRef.current === disclosureKey) return;
    acknowledgedIdentityRef.current = disclosureKey;
    recordingConsentAcknowledgedRef.current = false;
    setRecordingConsentAcknowledged(false);
    if (!disclosureKey) return;
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(disclosureKey);
    } catch {
      // A blocked or unavailable store is simply "not acknowledged".
      stored = null;
    }
    if (stored === "1") {
      recordingConsentAcknowledgedRef.current = true;
      setRecordingConsentAcknowledged(true);
    }
  }, [disclosureKey]);

  const acknowledgeRecordingDisclosure = useCallback(() => {
    recordingConsentAcknowledgedRef.current = true;
    setRecordingConsentAcknowledged(true);
    if (disclosureKey) {
      try {
        // ONLY the boolean: never a token, an identity, a transcript, or audio.
        window.sessionStorage.setItem(disclosureKey, "1");
      } catch {
        // Persistence is a convenience; the in-memory acknowledgment stands.
      }
    }
    onUserGesture();
  }, [disclosureKey, onUserGesture]);

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
      if (
        !providerInputAllowed({
          acknowledged: recordingConsentAcknowledgedRef.current,
          input: "typed_answer",
          liveProvider: liveProviderRef.current,
          scope: VIVA_DISCLOSURE_SCOPE,
        })
      ) {
        return;
      }
      unlockPlayback();
      activateTextAnswerMode();
      setSourceOpen(false);
      setHintShown(false);
      setTextRetryOpen(false);
      setTextAnswerEnabled(true);
      const result = agentRef.current.sendTurnIntent({
        intent: { kind: "answer_text", text: payload },
        turnId: createOpaqueIntentTurnId(),
      });
      // Typed content stays visible on EVERY outcome — sent, pending, rejected,
      // or socket_closed — so the learner can retry it deliberately. It is never
      // auto-resent, and a rejected frame is projected from its typed diagnostic
      // alone, never from the content that was refused.
      setSubmittedTextAnswer(payload);
      void result;
    },
    [activateTextAnswerMode, unlockPlayback],
  );
  const challengeSource = useCallback(() => {
    const target = citationChallengeTarget({
      currentResponseId: challengeResponseIdRef.current,
      currentSourceId: challengeSourceIdRef.current,
    });
    if (!target) return;
    if (
      !providerInputAllowed({
        acknowledged: recordingConsentAcknowledgedRef.current,
        input: "citation_challenge",
        liveProvider: liveProviderRef.current,
        scope: VIVA_DISCLOSURE_SCOPE,
      })
    ) {
      return;
    }
    onUserGesture();
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    // A citation challenge is its OWN typed intent. It is never answer text, it
    // never reuses the pending answer state, and it never enters the audio
    // ledger or the replay path.
    agentRef.current.sendTurnIntent({ intent: target, turnId: createOpaqueIntentTurnId() });
  }, [onUserGesture]);
  const retryAgent = useCallback(() => {
    browserLifecycleAttemptRef.current += 1;
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    // The one explicit manual recovery: it clears the bounded budget so the
    // automatic loop is available again, and it never duplicates a scheduled
    // attempt (the scheduled state disables this control).
    clearRecoveryTimer();
    reconnectAttemptTokenRef.current += 1;
    explicitlyStoppedRef.current = false;
    setReconnect({ attempts: 0, kind: "idle" });
    resetPlaybackForGeneration();
    agentRef.current.reset();
    agentRef.current.connect("socket_retry");
  }, [clearRecoveryTimer, resetPlaybackForGeneration]);
  const refreshSession = useCallback(() => {
    browserLifecycleAttemptRef.current += 1;
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    setSubmittedTextAnswer(undefined);
    resetPlaybackForGeneration();
    if (!isRenewableBrowserSessionCredential(credentialRef.current)) {
      retryAgent();
      return;
    }
    renewAndReopen("token_refresh", "auth_expired");
  }, [renewAndReopen, resetPlaybackForGeneration, retryAgent]);
  /**
   * `WEBSESSION-DATA-01` retry: reruns the selected D-07 renewal AND the
   * projection fetch for the latest route attempt. It never calls `connect`, and
   * it never falls back to the library snapshot endpoint.
   */
  const retryBootstrap = useCallback(() => {
    const identity = routeIdentityRef.current;
    if (!completeSessionRouteIdentity(identity)) return;
    projectionAbortRef.current?.abort();
    setStudyProjection(null);
    setProjectionStage({ kind: "idle" });
    setProjectionAttemptTick((tick) => tick + 1);
  }, []);

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
    // An explicit learner stop is final: no automatic reconnect may follow it.
    explicitlyStoppedRef.current = true;
    clearRecoveryTimer();
    stopCaptureForRecap(captureRef, captureStartedRef, levelRef, discardActiveAudioTurn);
    agentRef.current.stop();
  }, [clearRecoveryTimer, discardActiveAudioTurn]);
  const cancelCheckingTurn = useCallback(() => {
    setSourceOpen(false);
    setHintShown(false);
    setTextRetryOpen(false);
    setSubmittedTextAnswer(undefined);
    // An explicit learner cancel IS a discard: the turn is thrown away on
    // purpose, so its retained bytes go with it.
    discardActiveAudioTurn();
    levelRef.current.user = 0;
    agentRef.current.cancel();
  }, [discardActiveAudioTurn]);

  // Capture stops here; the retained turn is released by the terminal effect
  // above, which owns the single discard for a session that has ended.
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

  // Stable session-start reference so the rendered review intervals are computed
  // against one instant for the whole session rather than drifting every tick.
  const sessionStart = useRef(new Date()).current;
  // `WEBSESSION-RECAP-01` boundary: the validated server recap is rendered as
  // emitted. Nothing here re-buckets its concepts, rewrites its next action, or
  // fabricates a study plan out of local status events.
  const trace = useMemo(
    () => projectTrace(agent.derived, agent.status, sessionStart),
    [agent.derived, agent.status, sessionStart],
  );
  const sourceFolio = useMemo(
    () => projectSourceFolio(agent.derived, sessionStart),
    [agent.derived, sessionStart],
  );
  // The review plan is READ from the projection: the persisted `dueAt`, the
  // projection's own concept label, and the interval the shared reader derives
  // from that instant. Nothing is scheduled in the browser.
  const reviewPlanProjection = useMemo(
    () => (studyProjection ? sessionReviewPlanFromProjection(studyProjection, sessionStart) : null),
    [studyProjection, sessionStart],
  );
  const reviewPlan: SessionReviewPlanItem[] =
    reviewPlanProjection?.status === "ready" ? reviewPlanProjection.items : [];
  const projectionConcepts = useMemo(() => studyProjection?.concepts ?? [], [studyProjection]);
  const conceptNodes = useMemo(
    () =>
      projectionConcepts.map((concept) => {
        const live = agent.agentState.conceptStatuses[concept.id];
        return {
          emphasis: live !== undefined ? 1 : 0.5,
          id: concept.id,
          label: concept.label,
          status: live ?? concept.status,
        };
      }),
    [projectionConcepts, agent.agentState.conceptStatuses],
  );
  const scene = useMemo(() => {
    const knownEntityIds = new Set<string>([
      ...projectionConcepts.map((concept) => concept.id),
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
    projectionConcepts,
    agent.derived.manuscriptIntents,
    agent.derived.question,
    agent.derived.sources,
  ]);
  const isRecap = trace.state === "recap";
  const effectiveState: SessionState = isRecap
    ? "recap"
    : sourceOpen
      ? "source"
      : textRetryOpen
        ? "listening"
        : trace.state;
  const highlightedTokens = isRecap
    ? trace.highlightedTokens
    : sourceOpen
      ? projectHighlightedTokens("source", agent.derived)
      : textRetryOpen
        ? projectHighlightedTokens("listening", agent.derived)
        : trace.highlightedTokens;
  // Readiness comes from the AUTHENTICATED projection plus the readiness probe.
  // With no projection there is no readiness to state, so no runtime copy is
  // produced at all — the page renders its pre-loop shell instead of asserting
  // an ingestion status the server never sent.
  const runtime = useMemo(
    () =>
      projectionReadiness
        ? projectRuntimeCopy({
            close: agent.agentState.close,
            deferredTurn: agent.derived.deferredTurn,
            diagnostics: agent.derived.diagnostics,
            lastServerError: agent.derived.lastServerError,
            mic: micState,
            readiness: projectionReadiness,
            readinessProbe,
            pendingTypedAnswer: typedAnswerUnresolved({
              canSubmitAnswer: agent.derived.canSubmitAnswer,
              finalTranscript: agent.derived.finalTranscript,
              submittedTextAnswer,
            }),
            ready: agent.agentState.ready,
            recap: agent.derived.recapState,
            reconnect,
            retainedAudioTurn,
            status: agent.status,
            structuredErrors: agent.derived.structuredErrors,
            termination: agent.derived.termination,
            terminalReason: agent.derived.terminalReason,
          })
        : null,
    [
      agent.agentState.close,
      agent.agentState.ready,
      agent.derived.deferredTurn,
      agent.derived.diagnostics,
      agent.derived.lastServerError,
      agent.derived.recapState,
      agent.derived.structuredErrors,
      agent.derived.termination,
      agent.derived.terminalReason,
      projectionReadiness,
      agent.status,
      micState,
      readinessProbe,
      reconnect,
      retainedAudioTurn,
      submittedTextAnswer,
      agent.derived.canSubmitAnswer,
      agent.derived.finalTranscript,
    ],
  );
  const websocketReady = Boolean(agent.agentState.ready) && agent.status === "open";
  // The selected provider is LIVE when the server's own ready frame says so.
  const liveProvider = agent.agentState.ready?.brain.live_runtime === true;
  const liveProviderRef = useRef(liveProvider);
  liveProviderRef.current = liveProvider;
  const challengeResponseIdRef = useRef<string | undefined>(undefined);
  challengeResponseIdRef.current = agent.agentState.activeResponseId;
  const challengeSourceIdRef = useRef<string | undefined>(undefined);
  challengeSourceIdRef.current =
    agent.derived.currentSource?.sourceId ?? agent.derived.question?.source.sourceId;
  const challengeDisabled =
    citationChallengeTarget({
      currentResponseId: agent.agentState.activeResponseId,
      currentSourceId: challengeSourceIdRef.current,
    }) === null ||
    !providerInputAllowed({
      acknowledged: recordingConsentAcknowledged,
      input: "citation_challenge",
      liveProvider,
      scope: VIVA_DISCLOSURE_SCOPE,
    });
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
      runtime
        ? projectTurnTakingState({
            hasPendingAudio: agent.agentState.audio.length > 0,
            interruptAcknowledged,
            playbackSpeaking,
            question: trace.question,
            runtime,
            state: effectiveState,
            textAnswerFallbackActive: shouldShowNoSpeechNudge({ textAnswerState, textRetryOpen }),
          })
        : null,
    [
      agent.agentState.audio.length,
      effectiveState,
      interruptAcknowledged,
      playbackSpeaking,
      trace.question,
      runtime,
      textAnswerState,
      textRetryOpen,
    ],
  );
  const submitRuntimePrimaryAction =
    runtime?.primaryActionIntent === "refresh_session"
      ? refreshSession
      : runtime?.primaryActionIntent === "retry_agent"
        ? retryAgent
        : runtime?.primaryActionIntent === "start_session"
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

  // Before the mount effect has resolved a credential — which is exactly the
  // server render and the first client render — the header states the neutral
  // truth rather than naming a study set the page has not been authorized for.
  const sessionContextLabel = studyProjection
    ? `${studyProjection.studySet.title}${
        studyProjection.studySet.course ? ` · ${studyProjection.studySet.course}` : ""
      }`
    : "Preparing your session";

  // `WEBSESSION-DATA-01` / Step 6: while the authenticated projection is
  // unresolved or failed, the page renders a neutral pre-loop state with every
  // microphone, text, and connection control disabled. It never opens a socket
  // and never calls the library snapshot endpoint to fill the gap.
  if (
    !studyProjection ||
    projectionStage.kind !== "ready" ||
    !runtime ||
    !turnTaking ||
    projectionReadiness?.canConnect !== true
  ) {
    return (
      <SessionPreloopShell
        credentialStage={credentialStage}
        ingestionStatus={studyProjection?.studySet.ingestionStatus}
        onRetry={retryBootstrap}
        projectionStage={projectionStage}
        reviewPlanInvalid={reviewPlanProjection?.status === "invalid_projection"}
      />
    );
  }

  return (
    <LiveSessionShell
      clockLabel="Local session clock"
      conceptNodes={conceptNodes}
      challengeDisabled={challengeDisabled}
      consentDisclosure={{
        acknowledged: recordingConsentAcknowledged,
        onAcknowledge: acknowledgeRecordingDisclosure,
        scope: VIVA_DISCLOSURE_SCOPE,
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
      onHint={() => setHintShown((shown) => !shown)}
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
      question={trace.question}
      recap={agent.derived.recap}
      reviewPlan={reviewPlan}
      runtime={runtime}
      scene={scene}
      sourceFolio={sourceFolio}
      state={effectiveState}
      studyContext={{
        activeQuestionPrompt: studyProjection.activeQuestion?.prompt ?? null,
        concepts: studyProjection.concepts.map(({ id, label, status }) => ({
          id,
          label,
          status,
        })),
        course: studyProjection.studySet.course,
        examLabel: studyProjection.studySet.examLabel,
        ingestionStatus: studyProjection.studySet.ingestionStatus,
        progress: studyProjection.questionProgress,
        sessionGoal: studyProjection.session.goal,
        sessionMode: studyProjection.session.mode,
        title: studyProjection.studySet.title,
      }}
      transcript={agent.derived.transcript}
      textAnswer={textAnswerState}
      turnTaking={turnTaking}
    />
  );
}

/**
 * The exact learner-facing copy for every unresolved or failed pre-loop state.
 *
 * Every string here is a sanitized classification, never a parser excerpt, a
 * close reason, a fetch message, or any credential material — the projection
 * client's discriminated `cause` is the only input.
 */
export type SessionPreloopCopy = Readonly<{
  headline: string;
  detail: string;
  actionLabel: string | null;
  statusLabel: string;
}>;

export function sessionPreloopCopy(input: {
  credentialStage: SessionCredentialStage;
  ingestionStatus?: StudySetIngestionStatus;
  projectionStage: SessionProjectionStage;
  reviewPlanInvalid: boolean;
}): SessionPreloopCopy {
  if (input.credentialStage.kind === "failed") {
    switch (input.credentialStage.cause) {
      case "missing_identity":
        return {
          actionLabel: null,
          detail: "Open this session from your library so Viva knows which study set to load.",
          headline: "This session link is incomplete",
          statusLabel: "missing session identity",
        };
      case "missing_credential":
        return {
          actionLabel: null,
          detail: "Start the session again from your library to get a fresh signed session.",
          headline: "This session needs a fresh sign-in",
          statusLabel: "missing session credential",
        };
      case "auth_terminal":
        return {
          actionLabel: null,
          detail: "Your signed session ended. Start it again from your library to continue.",
          headline: "Your signed session ended",
          statusLabel: "session auth terminal",
        };
      default:
        return {
          actionLabel: "Try again",
          detail: "Viva could not renew this session's credential. Try again in a moment.",
          headline: "Session credential unavailable",
          statusLabel: "credential renewal unavailable",
        };
    }
  }

  if (input.reviewPlanInvalid) {
    return {
      actionLabel: "Try again",
      detail: "Viva refused a study projection it could not fully trust. Nothing was guessed.",
      headline: "This session's study data did not check out",
      statusLabel: "invalid projection",
    };
  }

  if (input.projectionStage.kind === "failed") {
    switch (input.projectionStage.cause) {
      case "unauthorized":
        return {
          actionLabel: null,
          detail:
            "Your signed session is no longer valid here. Start the session again from your library.",
          headline: "Your signed session ended",
          statusLabel: "session auth terminal",
        };
      case "not_found":
        return {
          actionLabel: null,
          detail: "Viva has no session for this link. Start a new one from your library.",
          headline: "This session was not found",
          statusLabel: "projection not found",
        };
      case "rate_limited":
        return {
          actionLabel: "Try again",
          detail:
            input.projectionStage.retryAfterSeconds === undefined
              ? "Too many session requests. Wait a moment and try again."
              : `Too many session requests. Try again in about ${input.projectionStage.retryAfterSeconds} seconds.`,
          headline: "Too many session requests",
          statusLabel: "rate limited",
        };
      case "timeout":
        return {
          actionLabel: "Try again",
          detail: "Loading your study set took too long. Try again.",
          headline: "Your study set took too long to load",
          statusLabel: "projection timeout",
        };
      case "invalid_request":
      case "invalid_projection":
      case "identity_mismatch":
        return {
          actionLabel: "Try again",
          detail: "Viva refused a study projection it could not fully trust. Nothing was guessed.",
          headline: "This session's study data did not check out",
          statusLabel: "invalid projection",
        };
      default:
        return {
          actionLabel: "Try again",
          detail: "Viva could not load your study set right now. Try again in a moment.",
          headline: "Your study set is unavailable",
          statusLabel: "projection unavailable",
        };
    }
  }

  // A projection the server marked anything but `ready` states that status as
  // the server gave it. The only way past it is a fresh projection: the page
  // never overwrites a server ingestion status with a local `ready`.
  if (input.ingestionStatus === "failed") {
    return {
      actionLabel: "Check again",
      detail: "Your study set could not be processed. Re-upload it or check its ingestion status.",
      headline: "Ingestion failed for this study set",
      statusLabel: "ingestion failed",
    };
  }
  if (input.ingestionStatus && input.ingestionStatus !== "ready") {
    return {
      actionLabel: "Check again",
      detail: "Viva is still preparing this study set on the server. Check again in a moment.",
      headline: `Your study set is still ${input.ingestionStatus}`,
      statusLabel: `ingestion ${input.ingestionStatus}`,
    };
  }

  return {
    actionLabel: null,
    detail: "Loading the study set and question this session was authorized for.",
    headline: "Preparing your session",
    statusLabel: "preparing session",
  };
}

/**
 * The neutral, control-free pre-loop shell.
 *
 * It renders the same markup on the server and on the first client render (it
 * reads no browser state), and it exposes no microphone, text-answer, or
 * connection control at all — a disabled control the learner could still focus
 * would be an invitation to act on a session that does not exist yet.
 */
function SessionPreloopShell({
  credentialStage,
  ingestionStatus,
  onRetry,
  projectionStage,
  reviewPlanInvalid,
}: {
  credentialStage: SessionCredentialStage;
  ingestionStatus?: StudySetIngestionStatus;
  onRetry: () => void;
  projectionStage: SessionProjectionStage;
  reviewPlanInvalid: boolean;
}) {
  const copy = sessionPreloopCopy({
    credentialStage,
    ingestionStatus,
    projectionStage,
    reviewPlanInvalid,
  });
  return (
    <section aria-label="Session status" className="live-session live-session--preloop">
      <div className="session-preloop">
        <p className="session-preloop__status" data-status={copy.statusLabel}>
          {copy.statusLabel}
        </p>
        <h1 className="session-preloop__headline">{copy.headline}</h1>
        <p className="session-preloop__detail">{copy.detail}</p>
        {copy.actionLabel ? (
          <button className="session-preloop__action" onClick={onRetry} type="button">
            {copy.actionLabel}
          </button>
        ) : null}
        <p aria-atomic="true" aria-live="polite" className="sr-only">
          {copy.headline}. {copy.detail}
        </p>
      </div>
    </section>
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

/**
 * `WEBSESSION-RECOVERY-01` Step 5: whether learner-entered text is still
 * unresolved. It stays visible and is NEVER auto-resent — only the server
 * advancing the turn (a final transcript, or a fresh submittable turn) resolves
 * it, and after an ambiguous close the learner retries it deliberately.
 */
export function typedAnswerUnresolved(input: {
  canSubmitAnswer: boolean;
  finalTranscript?: string;
  submittedTextAnswer?: string;
}): boolean {
  if (!input.submittedTextAnswer) return false;
  if (input.finalTranscript !== undefined) return false;
  return !input.canSubmitAnswer;
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
  | { action: "renew_credential" };

/**
 * The plan carries NO credential material at all.
 *
 * Under D-07 Branch A the renewal authority is the rotating one-time refresh
 * credential held in the vault, never an access token, so the only thing a plan
 * needs to say is whether one exists. Passing the token through here is what let
 * a spent token be replayed as renewal authority; a boolean cannot.
 */
export function browserLifecycleReconnectPlan(input: {
  currentRouteIdentity: SessionRouteIdentity;
  nextRouteIdentity: SessionRouteIdentity;
  recap: unknown;
  renewable: boolean;
  status: string;
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
  return input.renewable ? { action: "renew_credential" } : { action: "socket_retry" };
}

/** A credential is renewable only when it carries a rotating refresh credential. */
export function isRenewableBrowserSessionCredential(
  credential: BrowserSessionCredential | null,
): boolean {
  return credential?.mode === "retain-token-only" && Boolean(credential.refreshToken);
}

/** Every route identity member the authenticated session needs, all present. */
export function completeSessionRouteIdentity(identity: SessionRouteIdentity): boolean {
  return Boolean(
    identity.userId?.trim() && identity.studySetId?.trim() && identity.sessionId?.trim(),
  );
}

/**
 * `WEBSESSION-AUTH-01` — the one entry credential, resolved once at mount.
 *
 * Precedence under D-07 Branch A: an identity-matched in-memory credential wins,
 * because only it carries the rotating refresh credential a renewal needs. A URL
 * (or bundled env) access token is accepted only as a NONRENEWABLE direct entry
 * — it can open one generation and can never be renewed, so a full reload may
 * legitimately require a fresh authenticated start rather than a replayed token.
 */
export function resolveEntrySessionCredential(input: {
  envAccessToken?: string | null;
  identity: SessionRouteIdentity;
  vaultCredential: BrowserSessionCredential | null;
}): BrowserSessionCredential | null {
  const userId = input.identity.userId?.trim();
  const studySetId = input.identity.studySetId?.trim();
  const sessionId = input.identity.sessionId?.trim();
  if (!userId || !studySetId || !sessionId) return null;

  const vault = input.vaultCredential;
  if (
    vault &&
    vault.identity.userId === userId &&
    vault.identity.studySetId === studySetId &&
    vault.identity.sessionId === sessionId
  ) {
    return vault;
  }

  const directToken = input.identity.sessionToken?.trim() || input.envAccessToken?.trim();
  if (!directToken) return null;
  return {
    accessToken: directToken,
    identity: { sessionId, studySetId, userId },
    mode: "retain-token-only",
    refreshExpiresAt: null,
    refreshToken: null,
    revision: 0,
    sessionAbsoluteExpiresAt: null,
  };
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

/**
 * `WEBSESSION-DISCLOSURE-01`: the microphone eligibility rule has exactly ONE
 * home — `providerInputAllowed`. A disabled button or a hidden panel is not the
 * gate; this is, and it runs before the capture source can be constructed.
 */
export function canStartMicrophoneCapture(input: {
  captureStarted: boolean;
  consentAcknowledged: boolean;
  liveProvider?: boolean;
  scope?: DisclosureScope;
  textAnswerMode: boolean;
}): boolean {
  if (input.captureStarted || input.textAnswerMode) return false;
  return providerInputAllowed({
    acknowledged: input.consentAcknowledged,
    input: "microphone_audio",
    liveProvider: input.liveProvider ?? true,
    scope: input.scope ?? VIVA_DISCLOSURE_SCOPE,
  });
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

/* --------------------------------------------------------------------- *
 * `WEBSESSION-DISCLOSURE-01` — D-08 disclosure scope.
 * -------------------------------------------------------------------- */

export type DisclosureScope = "all_live_provider_content" | "microphone_audio_only";

/**
 * The RECORDED program decision is D-08 Branch A: the acknowledgment covers ALL
 * live provider content, typed as well as spoken. Branch B stays executable in
 * `providerInputAllowed` so the alternative is testable, but it is not selected
 * anywhere in this lane.
 */
export const VIVA_DISCLOSURE_SCOPE: DisclosureScope = "all_live_provider_content";

/**
 * The single eligibility rule for anything that could reach a provider.
 *
 * Microphone audio is gated before acknowledgment under BOTH branches — the
 * capture source may not even be constructed. Under Branch A a live provider
 * additionally gates typed answers and citation challenges, because under that
 * branch they reach the same provider as the spoken turn. A non-live path keeps
 * its explicitly labelled behavior for typed content.
 */
export function providerInputAllowed(input: {
  acknowledged: boolean;
  input: "microphone_audio" | "typed_answer" | "citation_challenge";
  liveProvider: boolean;
  scope: DisclosureScope;
}): boolean {
  if (input.acknowledged) return true;
  if (input.input === "microphone_audio") return false;
  if (!input.liveProvider) return true;
  return input.scope === "microphone_audio_only";
}

/**
 * A BOOLEAN's key, scoped to branch + study set + voice session. A different
 * scope, study set, or session is a different key, so no acknowledgment can be
 * inherited across any of them. Nothing but the boolean is ever stored.
 */
export function disclosureAcknowledgementKey(input: {
  scope: DisclosureScope;
  studySetId: string;
  voiceSessionId: string;
}): string {
  return `viva:disclosure:v1:${input.scope}:${input.studySetId}:${input.voiceSessionId}`;
}

/**
 * `WEBSESSION-INTENT-01`: the challenge target, or `null` when the response or
 * source the learner was looking at is no longer current. A stale challenge is
 * DISABLED rather than re-aimed at a different response.
 */
export function citationChallengeTarget(input: {
  currentResponseId?: string;
  currentSourceId?: string;
}): VivaClientTurnIntent | null {
  const responseId = input.currentResponseId?.trim();
  const sourceId = input.currentSourceId?.trim();
  if (!responseId || !sourceId) return null;
  return { kind: "citation_challenge", response_id: responseId, source_id: sourceId };
}

/** An opaque per-intent turn id. It carries no learner or transcript material. */
export function createOpaqueIntentTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `turn-${crypto.randomUUID()}`;
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** How many of the three bounded attempts the current state has already used. */
export function reconnectAttemptsUsed(state: VivaAgentReconnectState): 0 | 1 | 2 | 3 {
  if (state.kind === "idle") return 0;
  if (state.kind === "exhausted") return 3;
  return state.attempt;
}

function sameRetainedAudioTurn(
  a: VivaAgentRetainedAudioTurn,
  b: VivaAgentRetainedAudioTurn,
): boolean {
  return (
    a.turnId === b.turnId &&
    a.retainedFromSequence === b.retainedFromSequence &&
    a.acceptedThroughSequence === b.acceptedThroughSequence &&
    a.finalSequence === b.finalSequence &&
    a.endRequested === b.endRequested &&
    a.retainedBytes === b.retainedBytes
  );
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
  /**
   * Abandons the turn. Without `discardSubmitted`, only a turn that is still
   * OPEN is cancelled: once `audio_end` is on the wire the assembly belongs to
   * the server, and the bytes are exactly what `WEBSESSION-AUDIO-01` replays, so
   * a plain cancel must neither scope a `cancel` at that turn nor drop it.
   */
  cancel: (options?: { discardSubmitted?: boolean }) => boolean;
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
    cancel(options: { discardSubmitted?: boolean } = {}) {
      const openTurnId = turn?.turnId ?? null;
      if (openTurnId !== null) {
        turn = null;
        awaitingTurnId = null;
        lastResult = null;
        input.controller.cancelAudioTurn(openTurnId);
        return true;
      }
      // A submitted turn is released ONLY on an explicit discard — a terminal
      // recap, a session cap, or the learner throwing the answer away.
      const submittedTurnId = awaitingTurnId;
      if (!options.discardSubmitted || submittedTurnId === null) return false;
      awaitingTurnId = null;
      lastResult = null;
      input.controller.cancelAudioTurn(submittedTurnId);
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

export function sessionRouteWsAccessToken(routeIdentity: { sessionToken?: string | null }) {
  return routeIdentity.sessionToken?.trim() || undefined;
}

type BrowserSessionRouteIdentity = {
  sessionId?: string | null;
  sessionToken?: string | null;
  studySetId?: string | null;
  userId?: string | null;
};

export function sameBrowserSessionRouteIdentity(
  left: BrowserSessionRouteIdentity,
  right: BrowserSessionRouteIdentity,
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
