import { describe, expect, test } from "bun:test";
import { type SessionRecap, VIVA_AUDIO_MAX_TURN_SAMPLES } from "@viva/core";
import type { VivaAgentDerivedState } from "../../lib/use-viva-agent-session";
import {
  type VivaAgentAudioOutput,
  VivaAudioSendRejectedError,
  type VivaAudioSendResult,
} from "../../lib/viva-agent-client";
import {
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaAudioCaptureEndReason,
  type VivaAudioCaptureSampleFrame,
  type VivaAudioCaptureSource,
  type VivaAudioCaptureStartOptions,
  VivaAudioWorkletUnavailableError,
  type VivaPcm16StreamingCaptureController,
} from "../../lib/viva-audio-capture";
import { projectTrace } from "../../lib/viva-session-projection";
import {
  browserLifecycleReconnectPlan,
  browserSessionReconnectReason,
  canStartMicrophoneCapture,
  captureLevelForBloom,
  createLiveAudioTurnDriver,
  createOpaqueAudioTurnId,
  derivedStateWithProjectedRecap,
  drainAgentAudio,
  enterTextAnswerMode,
  isCurrentBrowserLifecycleAttempt,
  isRenewableBrowserSessionCredential,
  isSessionOver,
  type LiveAudioTurnSeam,
  micStateForAudioCaptureError,
  micStateForCaptureEndReason,
  resetPlaybackCancellationStateForGeneration,
  resolveEntrySessionCredential,
  sameBrowserSessionRouteIdentity,
  sessionRouteWsAccessToken,
  shouldShowNoSpeechNudge,
  shouldStopReadinessPolling,
  shouldUseLiveMicAudioTransport,
  spokenTurnFallbackAction,
  stopCaptureForRecap,
  submitSpokenCaptureTurn,
  textAnswerPayload,
  textAnswerStateForSession,
  typedAnswerUnresolved,
} from "./LiveSessionPage";

describe("drainAgentAudio", () => {
  const out = (responseId: string): VivaAgentAudioOutput =>
    ({ responseId, frame: {} }) as unknown as VivaAgentAudioOutput;

  test("flushes new cancellations, enqueues pending audio, and acknowledges the exact frames", () => {
    const enqueued: string[] = [];
    const cancelled: string[] = [];
    let acked: readonly VivaAgentAudioOutput[] = [];
    const audio = [out("r1"), out("r1"), out("r2")];

    const next = drainAgentAudio({
      acknowledgeAudio: (consumed) => {
        acked = consumed;
      },
      audio,
      cancellations: ["rX"],
      handledCancel: 0,
      sink: {
        cancel: (id) => cancelled.push(id),
        enqueue: (o) => enqueued.push(o.responseId),
      },
    });

    // Cancellations flush before enqueue so barge-in stops a response in time.
    expect(cancelled).toEqual(["rX"]);
    expect(enqueued).toEqual(["r1", "r1", "r2"]);
    // The exact frame objects are acknowledged (by reference, not a count).
    expect(acked).toBe(audio);
    expect(next).toBe(1);
  });

  test("only flushes new cancellations and skips acknowledge when no audio is pending", () => {
    const cancelled: string[] = [];
    let ackCalls = 0;

    const next = drainAgentAudio({
      acknowledgeAudio: () => {
        ackCalls += 1;
      },
      audio: [],
      cancellations: ["rA", "rB"],
      handledCancel: 1,
      sink: {
        cancel: (id) => cancelled.push(id),
        enqueue: () => {},
      },
    });

    expect(cancelled).toEqual(["rB"]);
    expect(ackCalls).toBe(0);
    expect(next).toBe(2);
  });

  test("generation reset clears handled cancellation count with playback state", () => {
    let resets = 0;
    const handledCancelRef = { current: 2 };

    resetPlaybackCancellationStateForGeneration({
      handledCancelRef,
      playback: {
        resetForGeneration: () => {
          resets += 1;
          return {
            cancelledResponseIds: [],
            nextSequence: 0,
            queue: [],
            responding: false,
            scheduledFrameCount: 0,
            speaking: false,
            userGestureUnlocked: true,
          };
        },
      },
    });

    expect(resets).toBe(1);
    expect(handledCancelRef.current).toBe(0);
  });
});

describe("shouldStopReadinessPolling", () => {
  test("keeps polling while connecting or open-but-not-yet-ready", () => {
    expect(
      shouldStopReadinessPolling({ recap: undefined, status: "connecting", ready: false }),
    ).toBe(false);
    // Open socket but no ready frame yet — the probe is still the only readiness signal.
    expect(shouldStopReadinessPolling({ recap: undefined, status: "open", ready: false })).toBe(
      false,
    );
  });

  test("stops polling once the live ready frame proves the agent is reachable", () => {
    expect(shouldStopReadinessPolling({ recap: undefined, status: "open", ready: true })).toBe(
      true,
    );
  });

  test("stops polling once the session is over, regardless of ready", () => {
    expect(
      shouldStopReadinessPolling({ recap: { headline: "x" }, status: "open", ready: false }),
    ).toBe(true);
    expect(shouldStopReadinessPolling({ recap: undefined, status: "closed", ready: false })).toBe(
      true,
    );
  });
});

describe("browserSessionReconnectReason", () => {
  test("classifies bfcache and Back/Forward restores without treating normal page show as stale", () => {
    expect(browserSessionReconnectReason({ type: "pageshow", persisted: true })).toBe(
      "bfcache_restore",
    );
    expect(browserSessionReconnectReason({ type: "pageshow", persisted: false })).toBe(null);
    expect(browserSessionReconnectReason({ type: "popstate" })).toBe("back_forward_restore");
  });

  test("compares stable route identity without requiring stripped token material to reappear", () => {
    expect(
      sameBrowserSessionRouteIdentity(
        {
          sessionId: "session-1",
          sessionToken: "placeholder-initial-material",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        {
          sessionId: "session-1",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
      ),
    ).toBe(true);
    expect(
      sameBrowserSessionRouteIdentity(
        {
          sessionId: "session-1",
          sessionToken: "placeholder-initial-material",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        {
          sessionId: "session-2",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
      ),
    ).toBe(false);
  });

  test("ignores stale async lifecycle completions after a newer browser action starts", () => {
    expect(isCurrentBrowserLifecycleAttempt({ activeAttempt: 3, attempt: 3 })).toBe(true);
    expect(isCurrentBrowserLifecycleAttempt({ activeAttempt: 4, attempt: 3 })).toBe(false);
  });

  test("does not reconnect browser restores after a terminal recap", () => {
    expect(
      browserLifecycleReconnectPlan({
        currentRouteIdentity: {
          sessionId: "session-1",
          sessionToken: "spent-token",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        nextRouteIdentity: {
          sessionId: "session-1",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
        recap: { headline: "done" },
        renewable: true,
        status: "open",
      }),
    ).toEqual({ action: "skip_session_over" });
  });

  test("reloads changed route identity even when the previous session has a recap", () => {
    expect(
      browserLifecycleReconnectPlan({
        currentRouteIdentity: {
          sessionId: "session-1",
          sessionToken: "spent-token",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        nextRouteIdentity: {
          sessionId: "session-2",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
        recap: { headline: "done" },
        renewable: true,
        status: "closed",
      }),
    ).toEqual({ action: "reload" });
  });

  test("renews the rotating credential before a same-identity lifecycle reconnect", () => {
    expect(
      browserLifecycleReconnectPlan({
        currentRouteIdentity: {
          sessionId: "session-1",
          sessionToken: "spent-token",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        nextRouteIdentity: {
          sessionId: "session-1",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
        recap: undefined,
        renewable: true,
        status: "open",
      }),
    ).toEqual({ action: "renew_credential" });
  });

  test("carries no credential material in the plan itself", () => {
    const plan = browserLifecycleReconnectPlan({
      currentRouteIdentity: {
        sessionId: "session-1",
        sessionToken: "viva1.spent-access-token",
        studySetId: "study-set-1",
        userId: "user-1",
      },
      nextRouteIdentity: {
        sessionId: "session-1",
        sessionToken: null,
        studySetId: "study-set-1",
        userId: "user-1",
      },
      recap: undefined,
      renewable: true,
      status: "open",
    });

    // A plan that cannot name a token cannot replay a spent one as renewal
    // authority: D-07 Branch A's authority is the rotating refresh credential.
    expect(JSON.stringify(plan)).not.toContain("viva1.");
    expect(Object.keys(plan)).toEqual(["action"]);
  });

  test("falls back to a plain socket retry when no rotating credential exists", () => {
    expect(
      browserLifecycleReconnectPlan({
        currentRouteIdentity: {
          sessionId: "session-1",
          sessionToken: "direct-entry-token",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        nextRouteIdentity: {
          sessionId: "session-1",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
        recap: undefined,
        renewable: false,
        status: "open",
      }),
    ).toEqual({ action: "socket_retry" });
  });

  test("reloads instead of renewing a same-identity closed voice session", () => {
    expect(
      browserLifecycleReconnectPlan({
        currentRouteIdentity: {
          sessionId: "session-1",
          sessionToken: "spent-token",
          studySetId: "study-set-1",
          userId: "user-1",
        },
        nextRouteIdentity: {
          sessionId: "session-1",
          sessionToken: null,
          studySetId: "study-set-1",
          userId: "user-1",
        },
        recap: undefined,
        renewable: true,
        status: "closed",
      }),
    ).toEqual({ action: "reload" });
  });
});

describe("isSessionOver", () => {
  test("a delivered recap freezes the session clock and stops the readiness probe", () => {
    expect(isSessionOver({ recap: { headline: "done" }, status: "open" })).toBe(true);
  });

  test("a terminal socket close freezes the clock even without a recap payload", () => {
    expect(isSessionOver({ recap: undefined, status: "closed" })).toBe(true);
  });

  test("an active, connected session keeps the clock running", () => {
    expect(isSessionOver({ recap: undefined, status: "open" })).toBe(false);
    expect(isSessionOver({ recap: undefined, status: "connecting" })).toBe(false);
  });
});

describe("entry credential precedence (WEBSESSION-AUTH-01)", () => {
  const identity = {
    sessionId: "voice-session-9",
    sessionToken: "viva1.access-from-url",
    studySetId: "thermo-401",
    userId: "user-9",
  } as const;

  const vaultCredential = {
    accessToken: "viva1.access-from-vault",
    identity: {
      sessionId: "voice-session-9",
      studySetId: "thermo-401",
      userId: "user-9",
    },
    mode: "retain-token-only",
    refreshExpiresAt: Date.parse("2026-08-26T12:00:00Z"),
    refreshToken: "viva-refresh1.credential-r1",
    revision: 3,
    sessionAbsoluteExpiresAt: Date.parse("2026-08-26T20:00:00Z"),
  } as const;

  test("uses the signed route session token as the direct WebSocket access credential", () => {
    expect(sessionRouteWsAccessToken({ sessionToken: " viva1.signed-session-token " })).toBe(
      "viva1.signed-session-token",
    );
    expect(sessionRouteWsAccessToken({ sessionToken: null })).toBeUndefined();
  });

  test("an identity-matched vault credential outranks the URL access token", () => {
    expect(resolveEntrySessionCredential({ identity, vaultCredential })).toBe(vaultCredential);
  });

  test("a vault credential for another session is ignored, not merged", () => {
    const resolved = resolveEntrySessionCredential({
      identity,
      vaultCredential: {
        ...vaultCredential,
        identity: { ...vaultCredential.identity, sessionId: "voice-session-other" },
      },
    });

    expect(resolved?.accessToken).toBe("viva1.access-from-url");
    expect(isRenewableBrowserSessionCredential(resolved)).toBe(false);
  });

  test("a URL access token alone is a nonrenewable direct entry", () => {
    const resolved = resolveEntrySessionCredential({ identity, vaultCredential: null });

    expect(resolved).toEqual({
      accessToken: "viva1.access-from-url",
      identity: {
        sessionId: "voice-session-9",
        studySetId: "thermo-401",
        userId: "user-9",
      },
      mode: "retain-token-only",
      refreshExpiresAt: null,
      refreshToken: null,
      revision: 0,
      sessionAbsoluteExpiresAt: null,
    });
    expect(isRenewableBrowserSessionCredential(resolved)).toBe(false);
  });

  test("an incomplete route identity resolves no credential at all", () => {
    expect(
      resolveEntrySessionCredential({
        identity: { ...identity, studySetId: null },
        vaultCredential,
      }),
    ).toBeNull();
    expect(
      resolveEntrySessionCredential({
        identity: { ...identity, sessionToken: null },
        vaultCredential: null,
      }),
    ).toBeNull();
  });

  test("only a rotating refresh credential makes a credential renewable", () => {
    expect(isRenewableBrowserSessionCredential(vaultCredential)).toBe(true);
    expect(isRenewableBrowserSessionCredential({ ...vaultCredential, refreshToken: null })).toBe(
      false,
    );
    expect(isRenewableBrowserSessionCredential(null)).toBe(false);
  });
});

describe("LiveSessionPage recap cleanup", () => {
  test("stops microphone capture and cancels the in-flight turn on a terminal recap", () => {
    let stops = 0;
    let cancels = 0;
    const captureRef = {
      current: {
        stop: () => {
          stops += 1;
        },
      },
    };
    const captureStartedRef = { current: true };
    const levelRef = { current: { agent: 0.2, user: 0.8 } };

    stopCaptureForRecap(captureRef, captureStartedRef, levelRef, () => {
      cancels += 1;
    });

    expect(stops).toBe(1);
    expect(cancels).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.2, user: 0 });
  });

  test("stops microphone capture and leaves the bloom at floor in text answer mode", () => {
    let stops = 0;
    let cancels = 0;
    const captureRef = {
      current: {
        cancel: () => {
          cancels += 1;
        },
        stop: () => {
          stops += 1;
        },
      },
    };
    const captureStartedRef = { current: true };
    const levelRef = { current: { agent: 0.1, user: 0.9 } };
    let resets = 0;
    const meterRef = {
      current: {
        reset: () => {
          resets += 1;
        },
      },
    };
    let audioTurnCancels = 0;

    enterTextAnswerMode(captureRef, captureStartedRef, levelRef, meterRef, () => {
      audioTurnCancels += 1;
    });

    expect(cancels).toBe(1);
    expect(stops).toBe(0);
    expect(resets).toBe(1);
    expect(audioTurnCancels).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.1, user: 0 });
  });

  test("classifies Worklet support failures separately from mic permission denial", () => {
    expect(micStateForAudioCaptureError(new VivaAudioWorkletUnavailableError())).toBe(
      "unsupported",
    );
    expect(micStateForAudioCaptureError(new Error("permission denied"))).toBe("denied");
    expect(micStateForCaptureEndReason("processor_error", "available")).toBe("unsupported");
    expect(micStateForCaptureEndReason("devicechange", "available")).toBe("unknown");
    expect(micStateForCaptureEndReason("stopped", "available")).toBe("available");
  });

  test("normalizes written answers before sending them to the agent text frame", () => {
    expect(textAnswerPayload("  NADH donates electrons to the ETC.  ")).toBe(
      "NADH donates electrons to the ETC.",
    );
    expect(textAnswerPayload("   \n\t   ")).toBe(null);
  });

  test("disables written answer submission while a generation has a pending provider turn", () => {
    expect(
      textAnswerStateForSession({
        canSubmitAnswer: false,
        finalTranscript: undefined,
        submittedTextAnswer: "first typed response",
        textAnswerActive: true,
        textAnswerAvailable: true,
        textAnswerRequired: false,
        textRetryOpen: false,
        transcriptConfidence: undefined,
      }),
    ).toEqual({
      active: true,
      disabled: true,
      lastAnswer: "first typed response",
      lastAnswerUncertain: false,
      required: false,
    });
  });

  test("only streams buffered mic PCM to selectable live runtimes", () => {
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: true, selectable: true } },
        status: "open",
        textAnswerMode: false,
      }),
    ).toBe(true);
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: false, selectable: true } },
        status: "open",
        textAnswerMode: false,
      }),
    ).toBe(false);
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: true, selectable: true } },
        status: "closed",
        textAnswerMode: false,
      }),
    ).toBe(false);
    expect(
      shouldUseLiveMicAudioTransport({
        ready: { brain: { live_runtime: true, selectable: true } },
        status: "open",
        textAnswerMode: true,
      }),
    ).toBe(false);
  });

  test("does not start microphone capture before recording disclosure acknowledgement", () => {
    expect(
      canStartMicrophoneCapture({
        captureStarted: false,
        consentAcknowledged: false,
        textAnswerMode: false,
      }),
    ).toBe(false);
    expect(
      canStartMicrophoneCapture({
        captureStarted: false,
        consentAcknowledged: true,
        textAnswerMode: false,
      }),
    ).toBe(true);
    expect(
      canStartMicrophoneCapture({
        captureStarted: true,
        consentAcknowledged: true,
        textAnswerMode: false,
      }),
    ).toBe(false);
    expect(
      canStartMicrophoneCapture({
        captureStarted: false,
        consentAcknowledged: true,
        textAnswerMode: true,
      }),
    ).toBe(false);
  });

  test("opens typed answer mode instead of synthesizing a spoken-answer placeholder", () => {
    expect(spokenTurnFallbackAction({ websocketReady: true })).toBe("open_text_answer");
    expect(spokenTurnFallbackAction({ websocketReady: false })).toBe("ignore");
  });

  test("labels only failed spoken fallback as no-speech, not voluntary text entry", () => {
    const voluntaryText = textAnswerStateForSession({
      canSubmitAnswer: true,
      finalTranscript: undefined,
      submittedTextAnswer: undefined,
      textAnswerActive: true,
      textAnswerAvailable: true,
      textAnswerRequired: false,
      textRetryOpen: false,
      transcriptConfidence: undefined,
    });
    const failedSpokenFallback = textAnswerStateForSession({
      canSubmitAnswer: true,
      finalTranscript: undefined,
      submittedTextAnswer: undefined,
      textAnswerActive: true,
      textAnswerAvailable: true,
      textAnswerRequired: false,
      textRetryOpen: true,
      transcriptConfidence: undefined,
    });
    const requiredFallback = textAnswerStateForSession({
      canSubmitAnswer: true,
      finalTranscript: undefined,
      submittedTextAnswer: undefined,
      textAnswerActive: true,
      textAnswerAvailable: true,
      textAnswerRequired: true,
      textRetryOpen: false,
      transcriptConfidence: undefined,
    });

    expect(shouldShowNoSpeechNudge({ textAnswerState: voluntaryText, textRetryOpen: false })).toBe(
      false,
    );
    expect(
      shouldShowNoSpeechNudge({
        textAnswerState: failedSpokenFallback,
        textRetryOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldShowNoSpeechNudge({ textAnswerState: requiredFallback, textRetryOpen: false }),
    ).toBe(true);
  });

  test("uses worklet-computed RMS for the user bloom while reduced motion keeps it at floor", () => {
    const calls: string[] = [];
    const meter = {
      push: () => {
        calls.push("samples");
        return 0.4;
      },
      pushRms: (rms: number) => {
        calls.push(`rms:${rms}`);
        return 0.7;
      },
    };

    expect(
      captureLevelForBloom({
        frame: { rms: 0.12, sampleRateHz: 24_000, samples: Float32Array.from([0.5]) },
        meter,
        reducedMotion: false,
        samples: Float32Array.from([0.5]),
        textAnswerMode: false,
      }),
    ).toBe(0.7);
    expect(calls).toEqual(["rms:0.12"]);
    expect(
      captureLevelForBloom({
        frame: { rms: 0.12, sampleRateHz: 24_000, samples: Float32Array.from([0.5]) },
        meter,
        reducedMotion: true,
        samples: Float32Array.from([0.5]),
        textAnswerMode: false,
      }),
    ).toBe(0);
    expect(calls).toEqual(["rms:0.12"]);
  });

  test("uses projected recap buckets for center trace highlights", () => {
    const staleRawRecap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Good session, Ananya.",
      missedConcepts: ["Fixture stale id"],
      nextAction: "Fixture action",
      plan: [],
      reviewLater: ["Fixture stale id"],
      shakyConcepts: [],
      sourceMoments: [],
      strongConcepts: [],
      summary: "Server recap summary.",
    };
    const projectedRecap: SessionRecap = {
      ...staleRawRecap,
      missedConcepts: ["ATP synthase"],
      nextAction: "Rebuild ATP synthase from the source.",
      reviewLater: ["ATP synthase"],
      strongConcepts: ["NADH"],
    };
    const derived: VivaAgentDerivedState = {
      canSubmitAnswer: true,
      conceptStatuses: {},
      diagnostics: [],
      manuscriptIntents: [],
      structuredErrors: [],
      phase: "recap",
      recap: staleRawRecap,
      sources: [],
      transcript: "",
    };

    const projection = projectTrace(
      derivedStateWithProjectedRecap(derived, projectedRecap),
      "open",
      new Date("2026-06-17T12:00:00.000Z"),
    );

    expect(projection.question.highlights).toEqual(["NADH", "ATP synthase"]);
    expect(projection.question.highlights).not.toContain("Fixture stale id");
  });
});

/**
 * CRIT-AUDIO-01 page lifecycle. The wiring is exercised through the extracted
 * controller-driven helpers, not a mounted component: `bun:test` has no DOM
 * environment at this base and this lane does not add one. The real mounted
 * lifecycle is covered by the browser E2E proofs.
 */
describe("live audio turn driver", () => {
  const sent = (acceptedThroughSequence: number): VivaAudioSendResult => ({
    acceptedThroughSequence,
    status: "sent",
  });

  type RecordedCall =
    | { kind: "chunk"; turnId: string; sequence: number; byteLength: number }
    | { kind: "end"; turnId: string; finalSequence: number }
    | { kind: "cancel"; turnId: string };

  function recordingSeam(overrides: Partial<LiveAudioTurnSeam> = {}): {
    seam: LiveAudioTurnSeam;
    calls: RecordedCall[];
    payloads: string[];
  } {
    const calls: RecordedCall[] = [];
    const payloads: string[] = [];
    const seam: LiveAudioTurnSeam = {
      cancelAudioTurn: (turnId) => {
        calls.push({ kind: "cancel", turnId });
      },
      endAudioTurn: (input) => {
        calls.push({ finalSequence: input.finalSequence, kind: "end", turnId: input.turnId });
        return sent(input.finalSequence);
      },
      sendAudioChunk: (input) => {
        calls.push({
          byteLength: input.pcm16Bytes.byteLength,
          kind: "chunk",
          sequence: input.sequence,
          turnId: input.turnId,
        });
        payloads.push(JSON.stringify({ ...input, pcm16Bytes: Array.from(input.pcm16Bytes) }));
        return sent(input.sequence);
      },
      ...overrides,
    };
    return { calls, payloads, seam };
  }

  function fixedTurnIds(...ids: string[]) {
    let index = 0;
    return () => ids[index++] ?? `unexpected-turn-${index}`;
  }

  const frame = (byteLength: number) => ({ pcm16Bytes: new Uint8Array(byteLength) });

  test("streams contiguous chunks for a turn and submits exactly one end", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-a"),
    });

    for (let callback = 0; callback < 4; callback += 1) driver.captureFrame(frame(960));
    const end = driver.submit();

    expect(calls).toEqual([
      { byteLength: 960, kind: "chunk", sequence: 0, turnId: "turn-a" },
      { byteLength: 960, kind: "chunk", sequence: 1, turnId: "turn-a" },
      { byteLength: 960, kind: "chunk", sequence: 2, turnId: "turn-a" },
      { byteLength: 960, kind: "chunk", sequence: 3, turnId: "turn-a" },
      { finalSequence: 3, kind: "end", turnId: "turn-a" },
    ]);
    expect(end).toEqual(sent(3));
    expect(driver.getTurn()).toBe(null);
    expect(driver.isAwaitingAcceptance()).toBe(true);
    // Nothing is submitted twice, and an empty turn never produces an end frame.
    expect(driver.submit()).toBe(null);
    expect(calls.filter((call) => call.kind === "end")).toHaveLength(1);
  });

  test("never sends a merged whole-turn payload", () => {
    const { calls, payloads, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-b"),
    });

    for (let callback = 0; callback < 50; callback += 1) driver.captureFrame(frame(960));
    driver.submit();

    const chunkBytes = calls.filter((call) => call.kind === "chunk");
    expect(chunkBytes).toHaveLength(50);
    for (const call of chunkBytes) expect(call.byteLength).toBe(960);
    for (const payload of payloads) expect(payload.length).toBeLessThan(64 * 1024);
  });

  test("keeps pending and socket_closed results as retry metadata, never as a sent answer", () => {
    const pending: VivaAudioSendResult = {
      acceptedThroughSequence: 0,
      retainedFromSequence: 0,
      status: "pending",
    };
    const closed: VivaAudioSendResult = {
      acceptedThroughSequence: 0,
      error: { code: "socket_closed", message: "Viva voice WebSocket is not open" },
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    };
    const results: VivaAudioSendResult[] = [sent(0), pending, closed];
    let index = 0;
    const recorded = recordingSeam();
    const { calls } = recorded;
    const seam: LiveAudioTurnSeam = {
      ...recorded.seam,
      sendAudioChunk: (input) => {
        recorded.seam.sendAudioChunk(input);
        return results[index++] ?? closed;
      },
    };
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-c"),
    });

    expect(driver.captureFrame(frame(960)).chunk?.result).toEqual(sent(0));
    expect(driver.captureFrame(frame(960)).chunk?.result).toEqual(pending);
    expect(driver.captureFrame(frame(960)).chunk?.result).toEqual(closed);
    expect(driver.getLastResult()).toEqual(closed);
    // The turn is still live and contiguous — nothing was dropped or reordered.
    expect(driver.getTurn()).toEqual({
      capturedSamples: 1_440,
      nextSequence: 3,
      turnId: "turn-c",
    });
    expect(calls.map((call) => (call.kind === "chunk" ? call.sequence : call.kind))).toEqual([
      0, 1, 2,
    ]);
  });

  test("stops and ends exactly at the 45-second raw sample cap", () => {
    const { calls, seam } = recordingSeam();
    let capacityReached = 0;
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-d"),
      maxTurnSamples: 960,
      onCapacityReached: () => {
        capacityReached += 1;
      },
    });

    // 480 samples per production 20 ms callback.
    driver.captureFrame(frame(960));
    const atCap = driver.captureFrame(frame(960));
    const afterCap = driver.captureFrame(frame(960));

    expect(atCap.chunk?.sequence).toBe(1);
    expect(atCap.end).toEqual(sent(1));
    expect(afterCap).toEqual({ chunk: null, end: null, ignored: "awaiting_acceptance" });
    expect(capacityReached).toBe(1);
    expect(calls).toEqual([
      { byteLength: 960, kind: "chunk", sequence: 0, turnId: "turn-d" },
      { byteLength: 960, kind: "chunk", sequence: 1, turnId: "turn-d" },
      { finalSequence: 1, kind: "end", turnId: "turn-d" },
    ]);
  });

  test("drops an over-cap callback instead of exceeding 1,080,000 samples", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-e"),
      maxTurnSamples: 1_000,
    });

    driver.captureFrame(frame(960));
    const overCap = driver.captureFrame(frame(2_000));

    expect(overCap.chunk).toBe(null);
    expect(overCap.ignored).toBe("capped");
    expect(overCap.end).toEqual(sent(0));
    expect(calls).toEqual([
      { byteLength: 960, kind: "chunk", sequence: 0, turnId: "turn-e" },
      { finalSequence: 0, kind: "end", turnId: "turn-e" },
    ]);
    expect(VIVA_AUDIO_MAX_TURN_SAMPLES).toBe(1_080_000);
  });

  test("only audio_turn_accepted release lets a new turn open", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-f", "turn-g"),
    });

    driver.captureFrame(frame(960));
    driver.submit();

    expect(driver.captureFrame(frame(960))).toEqual({
      chunk: null,
      end: null,
      ignored: "awaiting_acceptance",
    });
    expect(driver.release("turn-mismatched")).toBe(false);
    expect(driver.captureFrame(frame(960)).ignored).toBe("awaiting_acceptance");

    expect(driver.release("turn-f")).toBe(true);
    expect(driver.captureFrame(frame(960)).chunk).toEqual({ result: sent(0), sequence: 0 });
    expect(calls.at(-1)).toEqual({ byteLength: 960, kind: "chunk", sequence: 0, turnId: "turn-g" });
  });

  test("every abort path cancels the live turn exactly once", () => {
    for (const abort of ["switch_to_text", "device_error", "disposal", "explicit_cancel"]) {
      const { calls, seam } = recordingSeam();
      const driver = createLiveAudioTurnDriver({
        controller: seam,
        createTurnId: fixedTurnIds(`turn-${abort}`),
      });
      driver.captureFrame(frame(960));

      expect(driver.cancel()).toBe(true);
      // Repeated teardown (unmount after an explicit cancel) never double-cancels.
      expect(driver.cancel()).toBe(false);

      expect(calls.filter((call) => call.kind === "cancel")).toEqual([
        { kind: "cancel", turnId: `turn-${abort}` },
      ]);
      expect(driver.getTurn()).toBe(null);
      expect(driver.isAwaitingAcceptance()).toBe(false);
    }
  });

  /**
   * `WEBSESSION-AUDIO-01`, cancel-after-submit. Once `audio_end` is on the wire
   * the assembly belongs to the server, so a plain cancel must NOT fall back to
   * the awaiting turn id: doing so scoped a `cancel` at an assembly the server
   * had already consumed, and it also threw away bytes the recovery path still
   * needs for an idempotent replay.
   */
  test("a plain cancel never targets a turn whose audio_end already went out", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-h"),
    });
    driver.captureFrame(frame(960));
    driver.submit();

    expect(driver.cancel()).toBe(false);

    expect(calls.filter((call) => call.kind === "cancel")).toEqual([]);
    // The submitted turn stays claimed so a later ack can release it and a later
    // capture callback cannot open a second concurrent input turn.
    expect(driver.isAwaitingAcceptance()).toBe(true);
    expect(driver.captureFrame(frame(960))).toEqual({
      chunk: null,
      end: null,
      ignored: "awaiting_acceptance",
    });
  });

  test("an explicit discard releases the submitted turn through the controller", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-h2"),
    });
    driver.captureFrame(frame(960));
    driver.submit();

    expect(driver.cancel({ discardSubmitted: true })).toBe(true);

    expect(calls.at(-1)).toEqual({ kind: "cancel", turnId: "turn-h2" });
    expect(driver.isAwaitingAcceptance()).toBe(false);
  });

  test("a discard with nothing submitted or open is a no-op", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-h3"),
    });

    expect(driver.cancel({ discardSubmitted: true })).toBe(false);
    expect(calls).toEqual([]);
  });

  test("ignores empty and odd-byte capture callbacks without opening a turn", () => {
    const { calls, seam } = recordingSeam();
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-i"),
    });

    expect(driver.captureFrame(frame(0))).toEqual({ chunk: null, end: null, ignored: "empty" });
    expect(driver.captureFrame(frame(961))).toEqual({ chunk: null, end: null, ignored: "empty" });

    expect(calls).toEqual([]);
    expect(driver.getTurn()).toBe(null);
  });

  test("surfaces a rejected send without raw payload material or a partial turn", () => {
    const rejection = new VivaAudioSendRejectedError({
      code: "audio_queue_limit",
      message: "Audio turn exceeds the maximum retained turn size",
    });
    const errors: string[] = [];
    const { seam } = recordingSeam({
      sendAudioChunk: () => {
        throw rejection;
      },
    });
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-j"),
      onSendRejected: (error) => errors.push(`${error.code}:${error.message}`),
    });

    const outcome = driver.captureFrame({ pcm16Bytes: Uint8Array.from([0x11, 0x22, 0x33, 0x44]) });

    expect(outcome).toEqual({ chunk: null, end: null, ignored: "rejected" });
    expect(errors).toEqual(["audio_queue_limit:Audio turn exceeds the maximum retained turn size"]);
    expect(errors.join(" ")).not.toContain("ESIz");
    expect(driver.getTurn()).toBe(null);
  });

  test("typed content stays unresolved across an ambiguous close and is never auto-resent", () => {
    // Submitted, socket lost mid-turn: no final transcript, no submittable turn.
    expect(
      typedAnswerUnresolved({
        canSubmitAnswer: false,
        submittedTextAnswer: "NADH donates electrons",
      }),
    ).toBe(true);
    // The server advanced the turn: the answer is resolved, not pending.
    expect(
      typedAnswerUnresolved({
        canSubmitAnswer: false,
        finalTranscript: "NADH donates electrons",
        submittedTextAnswer: "NADH donates electrons",
      }),
    ).toBe(false);
    // A fresh submittable turn means the previous one is no longer in flight.
    expect(
      typedAnswerUnresolved({
        canSubmitAnswer: true,
        submittedTextAnswer: "NADH donates electrons",
      }),
    ).toBe(false);
    expect(typedAnswerUnresolved({ canSubmitAnswer: false })).toBe(false);
  });

  test("mints opaque turn ids that carry no learner material", () => {
    const first = createOpaqueAudioTurnId();
    const second = createOpaqueAudioTurnId();

    expect(first).not.toBe(second);
    expect(first.startsWith("turn-")).toBe(true);
    expect(/^turn-[A-Za-z0-9-]+$/.test(first)).toBe(true);
  });

  test("the real capture source at the raw sample cap ends once and stops without recursion", () => {
    const { calls, seam } = recordingSeam();
    const source = new FakeLiveCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const captureRef: { current: VivaPcm16StreamingCaptureController | null } = { current: null };
    let capacityReached = 0;
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-cap"),
      maxTurnSamples: 960,
      // The page's exact capacity wiring, in the page's exact order: the stop
      // runs before the ref is cleared, so a re-entrant callback still sees the
      // live controller.
      onCapacityReached: () => {
        capacityReached += 1;
        captureRef.current?.stop();
        captureRef.current = null;
      },
    });
    captureRef.current = startVivaPcm16StreamingCapture({
      onFrame: (frame) => {
        driver.captureFrame(frame);
      },
      source,
    });

    // 700-sample worklet callbacks leave a partial tail buffered at the exact
    // moment the cap is reached, and stopping capture flushes that tail straight
    // back into `captureFrame` while the capping callback is still on the stack.
    source.push(new Float32Array(700).fill(0.25));
    source.push(new Float32Array(700).fill(-0.25));

    expect(capacityReached).toBe(1);
    expect(calls).toEqual([
      { byteLength: 960, kind: "chunk", sequence: 0, turnId: "turn-cap" },
      { byteLength: 960, kind: "chunk", sequence: 1, turnId: "turn-cap" },
      { finalSequence: 1, kind: "end", turnId: "turn-cap" },
    ]);
    expect(driver.getTurn()).toBe(null);
    expect(driver.isAwaitingAcceptance()).toBe(true);
    expect(source.stopped).toBe(true);
  });

  test("submitting a spoken turn flushes the tail and keeps the microphone open", () => {
    const { calls, seam } = recordingSeam();
    const source = new FakeLiveCaptureSource(VIVA_AUDIO_SAMPLE_RATE_HZ);
    const driver = createLiveAudioTurnDriver({
      controller: seam,
      createTurnId: fixedTurnIds("turn-first", "turn-second"),
    });
    const capture = startVivaPcm16StreamingCapture({
      onFrame: (frame) => {
        driver.captureFrame(frame);
      },
      source,
    });
    const captureRef = { current: capture };

    source.push(new Float32Array(700).fill(0.25));

    expect(submitSpokenCaptureTurn(captureRef, driver)).toEqual({
      acceptedThroughSequence: 1,
      status: "sent",
    });

    // The buffered 220-sample tail is the turn's last chunk, ahead of the end.
    expect(calls).toEqual([
      { byteLength: 960, kind: "chunk", sequence: 0, turnId: "turn-first" },
      { byteLength: 440, kind: "chunk", sequence: 1, turnId: "turn-first" },
      { finalSequence: 1, kind: "end", turnId: "turn-first" },
    ]);
    // Submitting an answer must not tear the microphone down. The page keeps
    // `captureStarted` true for the whole session and nothing resets it on a
    // question change, so a stopped source here would silently make every later
    // spoken answer impossible.
    expect(capture.isActive()).toBe(true);
    expect(source.stopped).toBe(false);
    expect(captureRef.current).toBe(capture);
    expect(
      canStartMicrophoneCapture({
        captureStarted: true,
        consentAcknowledged: true,
        textAnswerMode: false,
      }),
    ).toBe(false);

    // Next question: acceptance releases the turn and the same live capture opens
    // a second one with no new gesture and no new getUserMedia prompt.
    expect(driver.release("turn-first")).toBe(true);
    source.push(new Float32Array(480).fill(-0.25));

    expect(calls.at(-1)).toEqual({
      byteLength: 960,
      kind: "chunk",
      sequence: 0,
      turnId: "turn-second",
    });
  });
});

class FakeLiveCaptureSource implements VivaAudioCaptureSource {
  readonly sampleRateHz: number;
  stopped = false;
  #onSamples:
    | ((samples: Float32Array, sampleRateHz: number, frame?: VivaAudioCaptureSampleFrame) => void)
    | null = null;
  #onEnded: ((reason: VivaAudioCaptureEndReason) => void) | null = null;

  constructor(sampleRateHz: number) {
    this.sampleRateHz = sampleRateHz;
  }

  start(
    onSamples: (
      samples: Float32Array,
      sampleRateHz: number,
      frame?: VivaAudioCaptureSampleFrame,
    ) => void,
    options?: VivaAudioCaptureStartOptions,
  ) {
    this.#onSamples = onSamples;
    this.#onEnded = options?.onEnded ?? null;
  }

  stop() {
    this.stopped = true;
    this.#onSamples = null;
    this.#onEnded?.("stopped");
  }

  push(samples: Float32Array) {
    this.#onSamples?.(samples, this.sampleRateHz, {
      rms: 0,
      sampleRateHz: this.sampleRateHz,
      samples,
    });
  }
}
