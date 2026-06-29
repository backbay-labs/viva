import { describe, expect, test } from "bun:test";
import type {
  AgentStudySetReadiness,
  AgentTerminalSessionReason,
  AnswerEvaluation,
  Concept,
  SessionQuestion,
  SourceReference,
  VivaReadyFrame,
} from "@viva/core";
import {
  VIVA_AGENT_TERMINAL_SESSION_REASONS,
  VIVA_LEARNER_LOOP_CONTRACT,
  VIVA_VOICE_PROTOCOL_VERSION,
} from "@viva/core";
import type { VivaAgentDerivedState } from "./use-viva-agent-session";
import {
  checklistFromExpectedTerms,
  conceptStatusColor,
  conceptStatusVerdict,
  correctionEmphasis,
  correctionFamily,
  expectedTermsRevealed,
  projectConceptNodes,
  projectHighlightedTokens,
  projectRuntimeCopy,
  projectSessionQuestion,
  projectSessionState,
  projectSourceFolio,
  projectTrace,
  projectTurnTakingState,
  transcriptionWasUncertain,
} from "./viva-session-projection";

const NOW = new Date("2026-06-17T12:00:00.000Z");
const AGENT_TERMINAL_REASONS = new Set<string>(VIVA_AGENT_TERMINAL_SESSION_REASONS);

function isAgentTerminalSessionReason(reason: string): reason is AgentTerminalSessionReason {
  return AGENT_TERMINAL_REASONS.has(reason);
}

const source: SourceReference = {
  label: "Lecture 5 · Slide 18",
  excerpt: "NADH donates electrons to the electron transport chain.",
  confidence: "high",
  span: "slide:18",
  documentId: "lec-5",
  retrievalReason: "server fixture source for oxidative phosphorylation",
};

const question: SessionQuestion = {
  id: "q1",
  prompt: "Explain the role of NADH in oxidative phosphorylation.",
  expectedTerms: ["electron donor", "electron transport chain", "proton gradient", "ATP synthase"],
  followUp: "Now connect that to ATP synthase.",
  source,
};

function evaluation(overrides: Partial<AnswerEvaluation> = {}): AnswerEvaluation {
  return {
    label: "mostly correct",
    correctionKind: "correct but incomplete",
    conciseFeedback: "Good mechanism. Connect the proton gradient to ATP synthase.",
    retryPrompt: "Try again naming the gradient.",
    source,
    conceptStatus: "strong",
    confidenceScore: 0.84,
    ...overrides,
  };
}

function derived(overrides: Partial<VivaAgentDerivedState> = {}): VivaAgentDerivedState {
  return {
    phase: "listening",
    transcript: "",
    conceptStatuses: {},
    sources: [],
    manuscriptIntents: [],
    errors: [],
    canSubmitAnswer: true,
    ...overrides,
  };
}

function ready(provider: string, overrides: Partial<VivaReadyFrame["brain"]> = {}): VivaReadyFrame {
  return {
    type: "ready",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    sample_rate_hz: 24000,
    input_encoding: "pcm_s16le",
    brain: {
      provider,
      configured: true,
      selectable: true,
      live_runtime: false,
      ...overrides,
    },
    store: {
      backend: "in_memory",
      available: true,
      durable: false,
      nonce_replay_protection: true,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
  };
}

const trustedReadiness: AgentStudySetReadiness = {
  canConnect: true,
  reason: "trusted",
  message: "Connected agent is mapped to a trusted server study set.",
};

const liveQuestion = projectSessionQuestion(derived({ question }), "open", NOW);

describe("projectSessionState", () => {
  test("maps agent phases onto the manuscript states", () => {
    expect(projectSessionState("listening", true)).toBe("listening");
    expect(projectSessionState("thinking", true)).toBe("thinking");
    expect(projectSessionState("feedback", true)).toBe("correction");
    expect(projectSessionState("correction", true)).toBe("correction");
    expect(projectSessionState("recap", true)).toBe("recap");
  });

  test("stays calm (listening) before a question arrives", () => {
    expect(projectSessionState("ready", false)).toBe("listening");
    expect(projectSessionState("ready", true)).toBe("listening");
  });
});

describe("projectRuntimeCopy", () => {
  test("labels the default no-key synthetic brain without implying live tutoring", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "open",
    });

    expect(copy.capsuleLabel).toBe("Synthetic examiner");
    expect(copy.marginaliaTitle).toBe("Synthetic examiner is listening.");
    expect(copy.marginaliaText).toContain("no provider keys");
    expect(copy.marginaliaText).not.toContain("live tutor");
    expect(copy.primaryActionDisabled).toBe(false);
    expect(copy.nextActionLabel).toBe("Answer when ready");
  });

  test("labels fake Cartesia/Gemini as a non-live provider test path", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("fake_cartesia_gemini"),
      status: "open",
    });

    expect(copy.capsuleLabel).toBe("Non-live provider test");
    expect(copy.marginaliaText).toContain("Cartesia/Gemini-shaped");
    expect(copy.marginaliaText).toContain("not a live tutor");
    expect(copy.readinessNotes.some((note) => note.label === "Provider")).toBe(true);
    expect(copy.primaryActionDisabled).toBe(false);
  });

  test("reserves live tutor copy for selectable live runtime readiness", () => {
    const gated = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("cartesia_gemini", { configured: false, selectable: false }),
      status: "open",
    });
    const live = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("cartesia_gemini", {
        configured: true,
        selectable: true,
        live_runtime: true,
      }),
      status: "open",
    });

    expect(gated.capsuleLabel).toBe("Live provider gated");
    expect(gated.marginaliaText).toContain("Act 3");
    expect(gated.primaryActionDisabled).toBe(true);
    expect(gated.nextActionLabel).toBe("Retry when live runtime is ready");
    expect(live.capsuleLabel).toBe("Live Cartesia/Gemini tutor");
    expect(live.marginaliaText).toContain("live Cartesia/Gemini runtime");
    expect(live.primaryActionDisabled).toBe(false);
  });

  test("surfaces actionable unavailable causes", () => {
    const ingestion = projectRuntimeCopy({
      readiness: {
        canConnect: false,
        reason: "processing_ingestion",
        message:
          "Connected agent is unavailable while the server is still processing this study set.",
      },
      ready: ready("synthetic"),
      status: "open",
    });
    const store = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: {
        ...ready("synthetic"),
        store: { ...ready("synthetic").store, available: false, backend: "postgres" },
      },
      status: "open",
    });
    const auth = projectRuntimeCopy({
      errors: ["session token claim mismatch"],
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "error",
    });

    expect(ingestion.cause).toBe("ingestion_pending");
    expect(ingestion.marginaliaText).toContain("server is still processing");
    expect(ingestion.nextActionLabel).toBe("Refresh ingestion");
    expect(ingestion.primaryActionDisabled).toBe(true);
    expect(store.cause).toBe("store_unavailable");
    expect(store.marginaliaText).toContain("postgres store");
    expect(store.nextActionLabel).toBe("Retry agent");
    expect(auth.cause).toBe("auth_failed");
    expect(auth.marginaliaText).toContain("auth failed");
    expect(auth.nextActionLabel).toBe("Refresh session");
    expect(auth.primaryActionDisabled).toBe(false);
    expect(auth.primaryActionIntent).toBe("refresh_session");
  });

  test("treats post-ready server rejections as unavailable instead of provider copy", () => {
    const copy = projectRuntimeCopy({
      errors: ["study set access denied"],
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "error",
    });

    expect(copy.cause).toBe("agent_offline");
    expect(copy.capsuleLabel).toBe("Agent unavailable");
    expect(copy.marginaliaTitle).toBe("Agent unavailable: session rejected.");
    expect(copy.marginaliaText).toContain("study set access denied");
    expect(copy.marginaliaText).not.toContain("Synthetic examiner");
  });

  test("sanitizes raw-looking provider diagnostics before rendering unavailable copy", () => {
    const copy = projectRuntimeCopy({
      errors: ["provider prompt transcript with bearer viva1.secret-token and raw answer text"],
      readiness: trustedReadiness,
      ready: ready("cartesia_gemini", { live_runtime: true }),
      status: "error",
    });

    expect(copy.cause).toBe("auth_failed");
    expect(copy.marginaliaText).not.toContain("viva1.secret-token");
    expect(copy.marginaliaText).not.toContain("raw answer text");
    expect(copy.marginaliaText).not.toContain("prompt transcript");
  });

  test("uses readiness facts before provider names for generic live runtimes", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("future_live_provider", {
        configured: true,
        selectable: true,
        live_runtime: true,
      }),
      status: "open",
    });

    expect(copy.cause).toBe("live_runtime");
    expect(copy.capsuleLabel).toBe("Live tutor");
    expect(copy.marginaliaText).toContain("live provider runtime");
    expect(copy.marginaliaText).not.toContain("Synthetic");
  });

  test("labels unknown non-live providers as test paths instead of synthetic", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("noop_provider", {
        configured: true,
        selectable: true,
        live_runtime: false,
      }),
      status: "open",
    });

    expect(copy.cause).toBe("fake_provider");
    expect(copy.capsuleLabel).toBe("Non-live provider test");
    expect(copy.marginaliaText).toContain("noop_provider");
    expect(copy.marginaliaText).not.toContain("Default no-key synthetic brain");
  });

  test("surfaces browser mic denial on the manuscript path", () => {
    const copy = projectRuntimeCopy({
      mic: "denied",
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "open",
    });

    expect(copy.cause).toBe("mic_denied");
    expect(copy.capsuleLabel).toBe("Mic denied");
    expect(copy.marginaliaTitle).toBe("Mic denied; write in the margin.");
    expect(copy.marginaliaText).toContain("Browser microphone capture was denied");
    expect(copy.marginaliaText).toContain("written answer");
    expect(copy.marginaliaText).toContain("finalize the transcript from the server");
    expect(copy.primaryActionDisabled).toBe(false);
    expect(copy.primaryActionIntent).toBe("submit_turn");
    expect(copy.nextActionLabel).toBe("Answer when ready");
  });

  test("surfaces unsupported microphone as the same text fallback when connected", () => {
    const copy = projectRuntimeCopy({
      mic: "unsupported",
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "open",
    });

    expect(copy.cause).toBe("mic_denied");
    expect(copy.capsuleLabel).toBe("Mic unavailable");
    expect(copy.marginaliaTitle).toBe("Mic unavailable; write in the margin.");
    expect(copy.marginaliaText).toContain("Browser microphone capture is unavailable");
    expect(copy.marginaliaText).toContain("written answer");
    expect(copy.primaryActionDisabled).toBe(false);
  });

  test("does not enable the text fallback when the WebSocket is disconnected", () => {
    const copy = projectRuntimeCopy({
      mic: "denied",
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
    });

    expect(copy.cause).toBe("session_disconnected");
    expect(copy.primaryActionDisabled).toBe(false);
    expect(copy.primaryActionIntent).toBe("retry_agent");
    expect(copy.nextActionLabel).toBe("Retry agent");
  });

  test("keeps provider gating ahead of the mic text fallback", () => {
    const copy = projectRuntimeCopy({
      mic: "denied",
      readiness: trustedReadiness,
      ready: ready("cartesia_gemini", {
        configured: true,
        selectable: false,
        live_runtime: false,
      }),
      status: "open",
    });

    expect(copy.cause).toBe("live_provider_gated");
    expect(copy.primaryActionDisabled).toBe(true);
    expect(copy.primaryActionIntent).toBe("disabled");
    expect(copy.marginaliaTitle).toBe("Agent unavailable: live provider gated.");
  });

  test("a dropped readiness poll never contradicts a live, ready socket", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      readinessProbe: {
        apiBaseUrl: "http://127.0.0.1:4318",
        error: "fetch failed",
        status: "offline",
      },
      status: "open",
    });

    // The live WS ready frame already proves the agent is reachable, so a stale
    // HTTP poll must not inject a contradicting "agent offline" line above the
    // green Provider/Store notes.
    expect(
      copy.readinessNotes.some((note) => note.label === "Agent" && note.state === "unavailable"),
    ).toBe(false);
    expect(
      copy.readinessNotes.some((note) => note.label === "Provider" && note.state === "ready"),
    ).toBe(true);
  });

  test("a still-checking poll is suppressed once the live ready frame has arrived", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      readinessProbe: { apiBaseUrl: "http://127.0.0.1:4318", status: "checking" },
      status: "open",
    });

    expect(copy.readinessNotes.some((note) => note.state === "checking")).toBe(false);
  });

  test("a stale gated /ready probe does not contradict a live ready frame", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      readinessProbe: {
        apiBaseUrl: "http://127.0.0.1:4318",
        health: {
          provider: "synthetic",
          brain: ready("synthetic").brain,
          store: ready("synthetic").store,
          status: "configured",
        },
        healthHttpStatus: 200,
        ready: { ready: false, brain: ready("synthetic").brain, store: ready("synthetic").store },
        readyHttpStatus: 503,
        status: "observed",
      },
      status: "open",
    });

    // The frozen observed-503 probe would otherwise show a "blocked /ready" line
    // alongside the green live Provider/Store notes — suppress it.
    expect(copy.readinessNotes.some((note) => note.label === "/ready")).toBe(false);
    expect(
      copy.readinessNotes.some((note) => note.label === "Provider" && note.state === "ready"),
    ).toBe(true);
  });

  test("a healthy observed probe still surfaces alongside a live ready frame", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      readinessProbe: {
        apiBaseUrl: "http://127.0.0.1:4318",
        health: {
          provider: "synthetic",
          brain: ready("synthetic").brain,
          store: ready("synthetic").store,
          status: "configured",
        },
        healthHttpStatus: 200,
        ready: { ready: true, brain: ready("synthetic").brain, store: ready("synthetic").store },
        readyHttpStatus: 200,
        status: "observed",
      },
      status: "open",
    });

    expect(copy.readinessNotes.some((note) => note.label === "/ready")).toBe(true);
  });

  test("the readiness probe still surfaces offline when there is no live ready frame", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: {
        apiBaseUrl: "http://127.0.0.1:4318",
        error: "fetch failed",
        status: "offline",
      },
      status: "connecting",
    });

    expect(
      copy.readinessNotes.some((note) => note.label === "Agent" && note.state === "unavailable"),
    ).toBe(true);
  });

  test("surfaces REST readiness as quiet marginalia for gated providers", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: {
        apiBaseUrl: "http://localhost:4318",
        health: {
          provider: "cartesia_gemini",
          brain: {
            provider: "cartesia_gemini",
            configured: true,
            selectable: false,
            live_runtime: false,
          },
          store: ready("synthetic").store,
          status: "unavailable",
        },
        healthHttpStatus: 200,
        ready: {
          ready: false,
          brain: {
            provider: "cartesia_gemini",
            configured: true,
            selectable: false,
            live_runtime: false,
          },
          store: ready("synthetic").store,
        },
        readyHttpStatus: 503,
        status: "observed",
      },
      status: "connecting",
    });

    expect(copy.cause).toBe("live_provider_gated");
    expect(copy.readinessNotes.map((note) => note.label)).toContain("/health/brain");
    expect(copy.readinessNotes.map((note) => note.label)).toContain("/ready");
    expect(copy.readinessNotes.some((note) => note.text.includes("HTTP 503"))).toBe(true);
    expect(copy.primaryActionDisabled).toBe(true);
  });

  test("does not call a REST-ready agent connected until the WebSocket is ready", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: {
        apiBaseUrl: "http://localhost:4318",
        health: {
          provider: "synthetic",
          brain: ready("synthetic").brain,
          store: ready("synthetic").store,
          status: "configured",
        },
        healthHttpStatus: 200,
        ready: {
          ready: true,
          brain: ready("synthetic").brain,
          store: ready("synthetic").store,
        },
        readyHttpStatus: 200,
        status: "observed",
      },
      status: "closed",
    });

    expect(copy.cause).toBe("session_disconnected");
    expect(copy.capsuleLabel).toBe("Session not connected");
    expect(copy.marginaliaTitle).toBe("Agent ready; session not connected.");
    expect(copy.marginaliaText).toContain("WebSocket ready frame");
    expect(copy.marginaliaTitle).not.toContain("listening");
    expect(copy.primaryActionDisabled).toBe(false);
    expect(copy.primaryActionIntent).toBe("retry_agent");
    expect(copy.nextActionLabel).toBe("Retry agent");
    expect(copy.readinessNotes.map((note) => note.label)).toContain("/ready");
  });

  test("surfaces unexpected WebSocket close diagnostics as quiet recovery marginalia", () => {
    const copy = projectRuntimeCopy({
      close: {
        code: 1006,
        reason: "proxy closed before terminal phase",
        wasClean: false,
      },
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
    });

    expect(copy.cause).toBe("unexpected_close");
    expect(copy.capsuleLabel).toBe("Session interrupted");
    expect(copy.marginaliaTitle).toBe("Session interrupted before the manuscript closed.");
    expect(copy.marginaliaText).toContain("code 1006");
    expect(copy.marginaliaText).toContain("proxy closed before terminal phase");
    expect(copy.marginaliaText).not.toContain("Synthetic examiner is listening");
    expect(copy.primaryActionIntent).toBe("retry_agent");
    expect(copy.nextActionLabel).toBe("Retry agent");
    expect(copy.readinessNotes.some((note) => note.label === "Close")).toBe(true);
  });

  test("does not classify a clean terminal socket close as an unexpected interruption", () => {
    const copy = projectRuntimeCopy({
      close: {
        code: 1000,
        reason: "client stop",
        wasClean: true,
      },
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
    });

    expect(copy.cause).toBe("session_disconnected");
    expect(copy.capsuleLabel).toBe("Session not connected");
    expect(copy.marginaliaTitle).not.toContain("interrupted");
    expect(copy.marginaliaText).not.toContain("terminal phase");
    expect(copy.readinessNotes.some((note) => note.text.includes("client stop"))).toBe(true);
  });

  test("maps controlled terminal phase reasons to honest closed manuscript copy", () => {
    const sessionCap = projectRuntimeCopy({
      close: { code: 1008, reason: "session cap", wasClean: true },
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
      terminalReason: "session_cap",
    });
    const drained = projectRuntimeCopy({
      close: { code: 1000, reason: "drained", wasClean: true },
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
      terminalReason: "drained",
    });

    expect(sessionCap.cause).toBe("session_cap");
    expect(sessionCap.capsuleLabel).toBe("Session cap reached");
    expect(sessionCap.marginaliaTitle).toBe("The session cap closed this manuscript.");
    expect(sessionCap.marginaliaText).toContain("session cap");
    expect(sessionCap.marginaliaText).not.toContain("interrupted");
    expect(sessionCap.primaryActionIntent).toBe("start_session");
    expect(sessionCap.nextActionLabel).toBe("Start a new session");
    expect(drained.cause).toBe("drained");
    expect(drained.capsuleLabel).toBe("Session drained");
    expect(drained.marginaliaText).toContain("deploy");
  });

  test("maps live provider terminal failures to user-facing degradation copy", () => {
    const cases = [
      [
        "provider_auth_failed",
        "provider_auth_failed",
        "Provider auth failed",
        "Check provider access",
      ],
      [
        "provider_rate_limited",
        "provider_rate_limited",
        "Retry window active",
        "Retry when available",
      ],
      ["provider_timeout", "provider_timeout", "Provider timeout", "Retry agent"],
      [
        "provider_malformed_stream",
        "provider_malformed_stream",
        "Provider stream failed",
        "Retry agent",
      ],
      [
        "provider_network_disconnect",
        "provider_network_disconnect",
        "Provider disconnected",
        "Retry agent",
      ],
      ["slow_client", "slow_client", "Client too slow", "Start a new session"],
      ["provider_cancelled", "provider_cancelled", "Provider cancelled", "Start a new session"],
      [
        "partial_stage_success",
        "partial_stage_success",
        "Partial live result",
        "Review partial recap",
      ],
    ] as const;

    for (const [terminalReason, cause, capsuleLabel, nextActionLabel] of cases) {
      const copy = projectRuntimeCopy({
        close: { code: 1011, reason: terminalReason, wasClean: true },
        readiness: trustedReadiness,
        ready: ready("cartesia_gemini", { live_runtime: true }),
        status: "closed",
        terminalReason,
      });

      expect(copy.cause).toBe(cause);
      expect(copy.capsuleLabel).toBe(capsuleLabel);
      expect(copy.nextActionLabel).toBe(nextActionLabel);
      expect(/payload|prompt|transcript|pcm16|secret/i.test(copy.marginaliaText)).toBe(false);
    }
  });

  test("surfaces terminal runtime copy as soon as the authoritative terminal event arrives", () => {
    const copy = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("cartesia_gemini", { live_runtime: true }),
      status: "open",
      terminalReason: "provider_timeout",
    });

    expect(copy.cause).toBe("provider_timeout");
    expect(copy.capsuleLabel).toBe("Provider timeout");
    expect(copy.primaryActionIntent).toBe("retry_agent");
  });

  test("keeps terminal runtime copy reconciled with the BAC-510 contract", () => {
    for (const state of VIVA_LEARNER_LOOP_CONTRACT.states) {
      if (!state.terminal_reason || !isAgentTerminalSessionReason(state.terminal_reason)) continue;
      const terminalReason = state.terminal_reason;

      const copy = projectRuntimeCopy({
        close: { code: 1011, reason: terminalReason, wasClean: true },
        readiness: trustedReadiness,
        ready: ready("cartesia_gemini", { live_runtime: true }),
        status: "closed",
        terminalReason,
      });

      expect(copy.capsuleLabel).toBe(state.copy.capsule_label);
      expect(copy.marginaliaTitle).toBe(state.copy.marginalia_title);
      expect(copy.marginaliaText).toBe(state.copy.marginalia_text);
      expect(copy.nextActionLabel).toBe(state.copy.next_action_label);
      expect(copy.primaryActionIntent).toBe(state.copy.primary_action_intent);
      expect(copy.primaryActionLabel).toBe(state.copy.primary_action_label);
      expect(copy.statusLabel).toBe(state.copy.status_label);
      expect(state.runtime_copy_causes).toContain(copy.cause);
      expect(/payload|prompt|transcript|pcm16|secret/i.test(copy.marginaliaText)).toBe(false);
    }
  });

  test("classifies close-only auth failures before generic interruption recovery", () => {
    const copy = projectRuntimeCopy({
      close: {
        code: 1008,
        reason: "session auth failed",
        wasClean: false,
      },
      readiness: trustedReadiness,
      ready: ready("synthetic"),
      status: "closed",
    });

    expect(copy.cause).toBe("auth_failed");
    expect(copy.capsuleLabel).toBe("Auth failed");
    expect(copy.nextActionLabel).toBe("Refresh session");
    expect(copy.primaryActionDisabled).toBe(false);
    expect(copy.primaryActionIntent).toBe("refresh_session");
    expect(copy.marginaliaText).not.toContain("terminal phase");
  });

  test("distinguishes API missing and agent offline before flattening unavailable states", () => {
    const apiMissing = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: { status: "api_missing" },
      status: "idle",
    });
    const offline = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: {
        apiBaseUrl: "http://localhost:4318",
        error: "connection refused",
        status: "offline",
      },
      status: "connecting",
    });

    expect(apiMissing.cause).toBe("api_missing");
    expect(apiMissing.nextActionLabel).toBe("Configure agent API");
    expect(apiMissing.primaryActionDisabled).toBe(true);
    expect(offline.cause).toBe("agent_offline");
    expect(offline.marginaliaText).toContain("/ready");
    expect(offline.marginaliaText).toContain("/health/brain");
    expect(offline.nextActionLabel).toBe("Retry agent");
    expect(offline.primaryActionDisabled).toBe(false);
    expect(offline.primaryActionIntent).toBe("retry_agent");
  });

  test("does not preserve upload or local-demo actions on connected session unavailable states", () => {
    const ingestionFailed = projectRuntimeCopy({
      readiness: {
        canConnect: false,
        reason: "failed_ingestion",
        message: "Connected agent is unavailable because server ingestion failed.",
      },
      status: "open",
    });
    const liveGated = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: ready("cartesia_gemini", { configured: false, selectable: false }),
      status: "open",
    });
    const apiMissing = projectRuntimeCopy({
      readiness: trustedReadiness,
      readinessProbe: { status: "api_missing" },
      status: "idle",
    });

    for (const copy of [ingestionFailed, liveGated, apiMissing]) {
      expect(copy.nextActionLabel).not.toContain("upload");
      expect(copy.nextActionLabel).not.toContain("local demo");
      expect(copy.nextActionLabel).not.toContain("Local demo");
    }
  });
});

describe("expectedTermsRevealed", () => {
  test("hides expected terms during listening and reveals them only after thinking", () => {
    expect(expectedTermsRevealed("listening")).toBe(false);
    expect(expectedTermsRevealed("thinking")).toBe(true);
    expect(expectedTermsRevealed("correction")).toBe(true);
    expect(expectedTermsRevealed("source")).toBe(true);
  });
});

describe("projectTurnTakingState", () => {
  test("gives every manuscript turn state a distinct textual phase", () => {
    const cases = [
      ["listening", "listening", "Your turn"],
      ["thinking", "thinking", "Checking"],
      ["correction", "feedback", "Feedback"],
      ["source", "source", "Source"],
      ["recap", "recap", "Recap"],
    ] as const;

    for (const [state, phase, label] of cases) {
      const turn = projectTurnTakingState({ question: liveQuestion, state });

      expect(turn.phase).toBe(phase);
      expect(turn.label).toBe(label);
      expect(turn.headline.length).toBeGreaterThan(0);
      expect(turn.detail.length).toBeGreaterThan(0);
      expect(turn.ariaStatus).toContain(turn.headline);
    }
  });

  test("prioritizes preparing, speaking, and recovery over the generic listening state", () => {
    const preparing = projectTurnTakingState({
      question: { ...liveQuestion, pending: true, prompt: "Connecting to your examiner..." },
      state: "listening",
    });
    const speaking = projectTurnTakingState({
      hasPendingAudio: true,
      question: liveQuestion,
      state: "correction",
    });
    const recovery = projectTurnTakingState({
      question: { ...liveQuestion, prompt: "This session has ended.", terminal: true },
      runtime: projectRuntimeCopy({
        readiness: trustedReadiness,
        ready: ready("cartesia_gemini", { live_runtime: true }),
        status: "open",
        terminalReason: "provider_timeout",
      }),
      state: "recap",
    });

    expect(preparing.phase).toBe("preparing");
    expect(speaking.phase).toBe("speaking");
    expect(speaking.headline).toBe("Viva is speaking.");
    expect(recovery.phase).toBe("recovery");
    expect(recovery.label).toBe("Provider timeout");
    expect(recovery.detail).toBe("Retry agent");
  });

  test("prioritizes recovery over pending placeholders when the session is unavailable", () => {
    const runtime = projectRuntimeCopy({
      readiness: trustedReadiness,
      ready: undefined,
      status: "closed",
    });
    const turn = projectTurnTakingState({
      question: { ...liveQuestion, pending: true, prompt: "Connecting to your examiner..." },
      runtime,
      state: "listening",
    });

    expect(turn.phase).toBe("recovery");
    expect(turn.label).toBe("Agent offline");
    expect(turn.detail).toBe("Retry agent");
    expect(turn.headline).not.toBe("Preparing the question.");
  });

  test("renders learner-safe no-speech and barge-in nudges", () => {
    const silence = projectTurnTakingState({
      question: liveQuestion,
      state: "listening",
      textAnswerFallbackActive: true,
    });
    const interrupted = projectTurnTakingState({
      interruptAcknowledged: true,
      question: liveQuestion,
      state: "listening",
      textAnswerFallbackActive: true,
    });

    expect(silence.nudge?.label).toBe("No speech captured");
    expect(silence.nudge?.text).toContain("Write the answer");
    expect(/raw|transcript|pcm16|secret/i.test(silence.ariaStatus)).toBe(false);
    expect(interrupted.nudge?.label).toBe("Interruption acknowledged");
    expect(interrupted.nudge?.text).toContain("stopped speaking");
    expect(interrupted.interruptAcknowledged).toBe(true);
  });

  test("projects explicit voice capture trust states without transcript UI copy", () => {
    const silence = projectTurnTakingState({
      question: liveQuestion,
      state: "listening",
    });
    const heard = projectTurnTakingState({
      question: liveQuestion,
      state: "listening",
      transcript: "NADH donates electrons",
    });
    const captured = projectTurnTakingState({
      finalTranscript: "NADH donates electrons to the electron transport chain",
      question: liveQuestion,
      state: "listening",
      transcriptConfidence: 0.42,
    });
    const checking = projectTurnTakingState({
      finalTranscript: "NADH donates electrons to the electron transport chain",
      question: liveQuestion,
      state: "thinking",
      transcriptConfidence: 0.42,
    });

    expect(silence.capture?.state).toBe("silence_hold");
    expect(heard.capture?.state).toBe("heard");
    expect(heard.capture?.ephemeralText).toBe("NADH donates electrons");
    expect(captured.capture?.state).toBe("captured");
    expect(captured.capture?.repair?.label).toBe("Mishearing repair");
    expect(checking.capture?.state).toBe("checking");
    expect(checking.capture?.text).toContain("Captured");
    for (const turn of [silence, heard, captured, checking]) {
      expect(/raw|transcript|pcm16|secret/i.test(turn.ariaStatus)).toBe(false);
    }
  });

  test("bounds ephemeral heard text so capture status cannot become a transcript surface", () => {
    const turn = projectTurnTakingState({
      finalTranscript: "NADH ".repeat(40),
      question: liveQuestion,
      state: "thinking",
    });

    expect(turn.capture?.ephemeralText?.length).toBeLessThanOrEqual(96);
    expect(turn.capture?.ephemeralText?.endsWith("...")).toBe(true);
  });

  test("clears stale barge-in and no-speech nudges after leaving listening", () => {
    const turn = projectTurnTakingState({
      interruptAcknowledged: true,
      question: liveQuestion,
      state: "thinking",
      textAnswerFallbackActive: true,
    });

    expect(turn.phase).toBe("thinking");
    expect(turn.interruptAcknowledged).toBe(false);
    expect(turn.nudge).toBeUndefined();
    expect(turn.ariaStatus).not.toContain("stopped speaking");
    expect(turn.ariaStatus).not.toContain("No speech captured");
  });

  test("captions the spoken question and feedback without surfacing source excerpts", () => {
    const feedbackQuestion = projectSessionQuestion(
      derived({ evaluation: evaluation(), phase: "feedback", question }),
      "open",
      NOW,
    );
    const turn = projectTurnTakingState({ question: feedbackQuestion, state: "correction" });

    expect(turn.captions.map((caption) => caption.label)).toEqual([
      "Question",
      "Feedback",
      "Try again",
    ]);
    expect(turn.captions.some((caption) => caption.text.includes(question.prompt))).toBe(true);
    expect(turn.captions.some((caption) => caption.text.includes("Good mechanism"))).toBe(true);
    expect(turn.captions.some((caption) => caption.text.includes("Try again naming"))).toBe(true);
    expect(turn.captions.some((caption) => caption.text.includes(source.excerpt))).toBe(false);
  });

  test("covers every BAC-510 terminal runtime state as recovery copy", () => {
    for (const state of VIVA_LEARNER_LOOP_CONTRACT.states) {
      if (!state.terminal_reason || !isAgentTerminalSessionReason(state.terminal_reason)) continue;
      const terminalReason = state.terminal_reason;

      const runtime = projectRuntimeCopy({
        close: { code: 1011, reason: terminalReason, wasClean: true },
        readiness: trustedReadiness,
        ready: ready("cartesia_gemini", { live_runtime: true }),
        status: "closed",
        terminalReason,
      });
      const turn = projectTurnTakingState({
        question: { ...liveQuestion, prompt: "This session has ended.", terminal: true },
        runtime,
        state: "recap",
      });

      expect(turn.phase).toBe("recovery");
      expect(turn.label).toBe(state.copy.capsule_label);
      expect(turn.headline).toBe(state.copy.marginalia_title);
      expect(turn.detail).toBe(state.copy.next_action_label);
      expect(/payload|prompt transcript|pcm16|secret|source excerpt/i.test(turn.ariaStatus)).toBe(
        false,
      );
    }
  });
});

describe("transcriptionWasUncertain", () => {
  test("flags only genuinely low transcription confidence", () => {
    expect(transcriptionWasUncertain(0.4)).toBe(true);
    expect(transcriptionWasUncertain(0.69)).toBe(true);
    // 0.7 threshold (exclusive) and the fixture values (0.78 / 0.91) stay quiet.
    expect(transcriptionWasUncertain(0.7)).toBe(false);
    expect(transcriptionWasUncertain(0.78)).toBe(false);
    expect(transcriptionWasUncertain(0.91)).toBe(false);
    // Missing / null confidence is never "uncertain".
    expect(transcriptionWasUncertain(undefined)).toBe(false);
    expect(transcriptionWasUncertain(null)).toBe(false);
  });
});

describe("projectHighlightedTokens", () => {
  test("never leaks the answer key while the student is still speaking", () => {
    expect(projectHighlightedTokens("listening", derived({ question }))).toEqual([]);
  });

  test("highlights the question's expected terms once Viva is thinking", () => {
    expect(projectHighlightedTokens("thinking", derived({ phase: "thinking", question }))).toEqual(
      question.expectedTerms,
    );
  });

  test("is empty when there is no agent question", () => {
    expect(projectHighlightedTokens("thinking", derived({ phase: "thinking" }))).toEqual([]);
  });
});

describe("checklistFromExpectedTerms", () => {
  test("marks terms present in the transcript as done and the rest as missing", () => {
    expect(
      checklistFromExpectedTerms(["NADH", "proton gradient"], "nadh donates electrons, that's it"),
    ).toEqual([
      { label: "NADH", status: "done" },
      { label: "proton gradient", status: "missing" },
    ]);
  });

  test("is empty when there are no expected terms", () => {
    expect(checklistFromExpectedTerms([], "anything")).toEqual([]);
  });
});

describe("conceptStatusVerdict", () => {
  test("pairs the status label with a real FSRS review interval", () => {
    const strong = conceptStatusVerdict("strong", NOW);
    expect(strong).toContain("Strong");
    expect(/today|tomorrow|day/.test(strong)).toBe(true);
    expect(conceptStatusVerdict("shaky", NOW)).toContain("Shaky");
    expect(conceptStatusVerdict("missed", NOW)).toContain("Missed");
    expect(conceptStatusVerdict("review", NOW)).toContain("Review");
  });
});

describe("correctionFamily", () => {
  test("affirms strong answers, re-prompts partial ones, caveats non-answers", () => {
    expect(correctionFamily("strong")).toBe("affirm");
    expect(correctionFamily("mostly correct")).toBe("affirm");
    expect(correctionFamily("partially correct")).toBe("reprompt");
    expect(correctionFamily("vague")).toBe("reprompt");
    expect(correctionFamily("wrong")).toBe("reprompt");
    expect(correctionFamily("off-topic")).toBe("reprompt");
    expect(correctionFamily("insufficient evidence")).toBe("caveat");
  });
});

describe("correctionEmphasis (hypercorrection)", () => {
  test("a confident wrong answer earns heavier ink than a hesitant one", () => {
    expect(correctionEmphasis(0.9, "wrong")).toBeGreaterThan(correctionEmphasis(0.3, "wrong"));
  });

  test("a confident correct answer stays light", () => {
    expect(correctionEmphasis(0.9, "strong")).toBeLessThan(0.3);
  });

  test("is always within 0..1", () => {
    expect(correctionEmphasis(1, "wrong")).toBeLessThanOrEqual(1);
    expect(correctionEmphasis(0, "strong")).toBeGreaterThanOrEqual(0);
  });
});

describe("projectSessionQuestion", () => {
  test("returns a calm placeholder while connecting, never mock biology data", () => {
    const projected = projectSessionQuestion(derived({ phase: "ready" }), "connecting", NOW);
    expect(projected.prompt).toContain("Connecting");
    expect(projected.checklist).toEqual([]);
    expect(projected.correctionBody).toBe("");
    expect(projected.status).toBe("");
    expect(projected.correctionFamily).toBeUndefined();
    // The placeholder is marked pending so the plate can render a warming-up
    // state instead of dressing it up as a real question.
    expect(projected.pending).toBe(true);
  });

  test("marks the warming-up placeholder pending, but never a terminal or real question", () => {
    expect(projectSessionQuestion(derived({ phase: "ready" }), "idle", NOW).pending).toBe(true);
    expect(projectSessionQuestion(derived({ phase: "ready" }), "error", NOW).pending).toBe(false);
    expect(projectSessionQuestion(derived({ phase: "ready" }), "closed", NOW).pending).toBe(false);
    // A real agent question is never pending.
    const real = projectSessionQuestion(derived({ phase: "listening", question }), "open", NOW);
    expect(real.pending ?? false).toBe(false);
  });

  test("an unreachable or interrupted close is honest copy, never a finished session", () => {
    // Agent offline / unclean 1006 close: no graceful terminal reason was ever
    // delivered. Calling this "This session has ended." misframes an infra
    // failure as a completed session — say it was interrupted instead.
    const offline = projectSessionQuestion(derived({ phase: "ready" }), "closed", NOW);
    expect(offline.prompt).toBe("The connection was interrupted.");
    expect(offline.terminal).toBe(true);
    const errored = projectSessionQuestion(derived({ phase: "ready" }), "error", NOW);
    expect(errored.prompt).toBe("The connection was interrupted.");
    expect(errored.terminal).toBe(true);
  });

  test("a graceful end (terminal reason delivered) still reads as a finished session", () => {
    const ended = projectSessionQuestion(
      derived({ phase: "ready", terminalReason: "session_cap" }),
      "closed",
      NOW,
    );
    expect(ended.prompt).toBe("This session has ended.");
    expect(ended.terminal).toBe(true);
  });

  test("a clean user-initiated close reads as ended even without a terminal reason", () => {
    // The production brain ends a student-initiated stop with a clean 1000 close
    // and NO terminal reason and NO recap (e.g. ending during warm-up). That is a
    // deliberate end, not an interruption — the close cleanliness is the signal.
    const ended = projectSessionQuestion(
      derived({ phase: "ready", close: { code: 1000, reason: "client_stop", wasClean: true } }),
      "closed",
      NOW,
    );
    expect(ended.prompt).toBe("This session has ended.");
  });

  test("a live question and the warming-up placeholder are never terminal", () => {
    expect(
      projectSessionQuestion(derived({ phase: "listening", question }), "open", NOW).terminal ??
        false,
    ).toBe(false);
    expect(
      projectSessionQuestion(derived({ phase: "ready" }), "connecting", NOW).terminal ?? false,
    ).toBe(false);
  });

  test("projects the live agent question with no verdict before evaluation", () => {
    const projected = projectSessionQuestion(
      derived({ phase: "listening", question, finalTranscript: "NADH gives electrons" }),
      "open",
      NOW,
    );
    expect(projected.prompt).toBe(question.prompt);
    expect(projected.sourceRef).toBe("Lecture 5 · Slide 18");
    expect(projected.highlights).toEqual(question.expectedTerms);
    expect(projected.status).toBe("");
    expect(projected.correctionFamily).toBeUndefined();
    // No agent re-prompt before the answer is marked.
    expect(projected.retryPrompt ?? "").toBe("");
  });

  test("projects the evaluation into family, emphasis, verdict and correction copy", () => {
    const projected = projectSessionQuestion(
      derived({
        phase: "correction",
        question,
        evaluation: evaluation({ label: "wrong", conceptStatus: "missed", confidenceScore: 0.9 }),
        finalTranscript: "NADH",
      }),
      "open",
      NOW,
    );
    expect(projected.correctionBody).toBe(
      "Good mechanism. Connect the proton gradient to ATP synthase.",
    );
    expect(projected.explanation).toBe(source.excerpt);
    expect(projected.status).toContain("Missed");
    expect(projected.correctionFamily).toBe("reprompt");
    expect(projected.correctionEmphasis ?? 0).toBeGreaterThan(0.6);
    // The agent's Socratic re-prompt is carried through so the retry is guided,
    // not a bare repeat of the original prompt.
    expect(projected.retryPrompt).toBe("Try again naming the gradient.");
  });

  test("collapses an empty re-prompt to undefined so the cue is omitted, not blank", () => {
    const projected = projectSessionQuestion(
      derived({
        phase: "correction",
        question,
        evaluation: evaluation({ retryPrompt: "" }),
        finalTranscript: "NADH",
      }),
      "open",
      NOW,
    );
    expect(projected.retryPrompt).toBe(undefined);
  });

  test("terminal session phases suppress stale active questions", () => {
    const projected = projectSessionQuestion(
      derived({
        phase: "recap",
        terminalReason: "provider_timeout",
        question,
      }),
      "open",
      NOW,
    );

    expect(projected.prompt).toBe("This session has ended.");
    expect(projected.terminal).toBe(true);
    expect(projected.pending).toBe(false);
  });
});

describe("projectTrace", () => {
  test("composes a live thinking projection from real agent state", () => {
    const projection = projectTrace(derived({ phase: "thinking", question }), "open", NOW);
    expect(projection.state).toBe("thinking");
    expect(projection.highlightedTokens).toEqual(question.expectedTerms);
    expect(projection.hasAgentQuestion).toBe(true);
    expect(projection.question.prompt).toBe(question.prompt);
  });

  test("stays calm and spoiler-free during listening", () => {
    const projection = projectTrace(derived({ phase: "listening", question }), "open", NOW);
    expect(projection.state).toBe("listening");
    expect(projection.highlightedTokens).toEqual([]);
  });

  test("projects recap_ready as the manuscript closing fold, not a source-retry state", () => {
    const projection = projectTrace(
      derived({
        phase: "correction",
        question,
        recap: {
          durationLabel: "Agent session",
          headline: "Good session, Ananya.",
          summary: "The Conductor folded the source-grounded answer into a kept study artifact.",
          strongConcepts: ["NADH"],
          shakyConcepts: ["Oxidative phosphorylation"],
          missedConcepts: ["ATP synthase"],
          reviewLater: ["Oxidative phosphorylation", "ATP synthase"],
          nextAction: "Rebuild ATP synthase from the source.",
          plan: [],
          sourceMoments: [
            {
              source,
              status: "shaky",
              text: "Question source: oxidative phosphorylation.",
            },
          ],
        },
      }),
      "open",
      NOW,
    );

    expect(projection.state).toBe("recap");
    expect(projection.question.prompt).toBe("Good session,\nAnanya.");
    expect(projection.question.explanation).toContain("kept study artifact");
    expect(projection.question.sourceRef).toBe("Lecture 5 · Slide 18");
    expect(projection.question.highlights).toEqual([
      "NADH",
      "Oxidative phosphorylation",
      "ATP synthase",
    ]);
  });

  test("preserves recap highlights after a later terminal close", () => {
    const projection = projectTrace(
      derived({
        phase: "recap",
        terminalReason: "session_cap",
        question,
        recap: {
          durationLabel: "Agent session",
          headline: "Good session, Ananya.",
          summary: "The completed recap should stay visible after terminal close.",
          strongConcepts: ["NADH"],
          shakyConcepts: ["Oxidative phosphorylation"],
          missedConcepts: ["ATP synthase"],
          reviewLater: ["Oxidative phosphorylation", "ATP synthase"],
          nextAction: "Rebuild ATP synthase from the source.",
          plan: [],
          sourceMoments: [],
        },
      }),
      "open",
      NOW,
    );

    expect(projection.state).toBe("recap");
    expect(projection.question.prompt).toBe("Good session,\nAnanya.");
    expect(projection.question.highlights).toEqual([
      "NADH",
      "Oxidative phosphorylation",
      "ATP synthase",
    ]);
    expect(projection.highlightedTokens).toEqual(question.expectedTerms);
  });

  test("terminal session phases become one learner-safe trace state", () => {
    const projection = projectTrace(
      derived({ phase: "recap", terminalReason: "provider_timeout", question }),
      "open",
      NOW,
    );

    expect(projection.state).toBe("recap");
    expect(projection.hasAgentQuestion).toBe(false);
    expect(projection.highlightedTokens).toEqual([]);
    expect(projection.question.prompt).toBe("This session has ended.");
    expect(projection.question.terminal).toBe(true);
  });

  test("terminal provider rate limit overrides a stale thinking question", () => {
    const projection = projectTrace(
      derived({ phase: "thinking", terminalReason: "provider_rate_limited", question }),
      "open",
      NOW,
    );

    expect(projection.state).toBe("recap");
    expect(projection.hasAgentQuestion).toBe(false);
    expect(projection.highlightedTokens).toEqual([]);
    expect(projection.question.prompt).toBe("This session has ended.");
    expect(projection.question.terminal).toBe(true);
    expect(projection.question.pending).toBe(false);
  });
});

describe("projectSourceFolio", () => {
  test("uses the latest source_reference event as the bounded museum label", () => {
    const folio = projectSourceFolio(
      derived({
        currentConceptStatus: "shaky",
        currentSource: {
          ...source,
          excerpt: "Bounded source_reference event excerpt.",
          sourceId: "src-lecture-5-slide-18",
        },
        evaluation: evaluation({ conceptStatus: "strong" }),
        phase: "correction",
        question,
        sources: [
          {
            confidence: "high",
            documentId: "lec-5",
            excerpt: "Older source event.",
            label: "Lecture 5 · Slide 12",
            retrievalReason: "older source span",
            sourceId: "src-old",
            span: "slide:12",
          },
        ],
      }),
      NOW,
    );

    expect(folio.state).toBe("present");
    expect(folio.source.sourceId).toBe("src-lecture-5-slide-18");
    expect(folio.source.excerpt).toBe("Bounded source_reference event excerpt.");
    expect(folio.conceptStatus).toContain("Shaky");
    expect(folio.confidenceLabel).toBe("High confidence");
    expect(folio.regionNavigation).toBe(
      "Document span only; exact page and bounding-box navigation is unverified.",
    );
  });

  test("does not let a stale prior source_reference override the active question source", () => {
    const activeQuestion: SessionQuestion = {
      ...question,
      source: {
        ...source,
        excerpt: "Active question bounded source.",
        label: "Lecture 6 · Slide 3",
        sourceId: "src-active-question",
        span: "slide:3",
      },
    };
    const folio = projectSourceFolio(
      derived({
        phase: "listening",
        question: activeQuestion,
        sources: [
          {
            ...source,
            excerpt: "Stale prior correction source.",
            label: "Lecture 5 · Slide 18",
            sourceId: "src-prior-correction",
          },
        ],
      }),
      NOW,
    );

    expect(folio.source.sourceId).toBe("src-active-question");
    expect(folio.source.excerpt).toBe("Active question bounded source.");
    expect(folio.source.excerpt).not.toContain("Stale prior");
  });

  test("labels low-confidence source material honestly", () => {
    const folio = projectSourceFolio(
      derived({
        evaluation: evaluation({
          label: "insufficient evidence",
          source: {
            ...source,
            confidence: "low",
            retrievalReason: "retrieval confidence below threshold",
          },
        }),
        phase: "correction",
        question,
      }),
      NOW,
    );

    expect(folio.state).toBe("low_confidence");
    expect(folio.confidenceLabel).toBe("Low confidence");
    expect(folio.caveat).toContain("retrieval confidence below threshold");
  });

  test("labels conflicting source material as a caveat", () => {
    const folio = projectSourceFolio(
      derived({
        evaluation: evaluation({
          label: "insufficient evidence",
          source: {
            ...source,
            confidence: "medium",
            retrievalReason: "conflicting source spans disagree",
          },
        }),
        phase: "correction",
        question,
      }),
      NOW,
    );

    expect(folio.state).toBe("conflicting");
    expect(folio.confidenceLabel).toBe("Medium confidence");
    expect(folio.caveat).toContain("Conflicting source material");
  });

  test("does not turn answer-level insufficient evidence into source conflict", () => {
    const folio = projectSourceFolio(
      derived({
        evaluation: evaluation({
          label: "insufficient evidence",
          source: {
            ...source,
            confidence: "high",
            retrievalReason: "server fixture source for oxidative phosphorylation",
          },
        }),
        phase: "correction",
        question,
      }),
      NOW,
    );

    expect(folio.state).toBe("present");
    expect(folio.caveat).not.toContain("Conflicting source material");
  });

  test("does not display stale concept_status values before the current response reports one", () => {
    const folio = projectSourceFolio(
      derived({
        conceptStatuses: { "prior-concept": "missed" },
        phase: "listening",
        question,
      }),
      NOW,
    );

    expect(folio.conceptStatus).toBe("Awaiting concept status");
    expect(folio.conceptStatus).not.toContain("Missed");
  });

  test("records source unavailable without exposing fallback document text", () => {
    const folio = projectSourceFolio(
      derived({
        question: {
          ...question,
          source: { confidence: "low", excerpt: "", label: "" },
        },
      }),
      NOW,
    );

    expect(folio.state).toBe("unavailable");
    expect(folio.source.excerpt).toBe("");
    expect(folio.confidenceLabel).toBe("Source unavailable");
    expect(folio.caveat).toContain("No bounded source_reference");
  });
});

function concept(id: string, label: string, status: Concept["status"]): Concept {
  return {
    id,
    label,
    status,
    misses: 0,
    centrality: 50,
    source: { label: "src", excerpt: "", confidence: "high" },
  };
}

describe("conceptStatusColor", () => {
  test("gives strong the sage tone and every status a distinct colour", () => {
    expect(conceptStatusColor("strong")).toEqual({ r: 127, g: 146, b: 119 });
    const distinct = new Set(
      (["strong", "shaky", "missed", "review"] as const).map((s) =>
        JSON.stringify(conceptStatusColor(s)),
      ),
    );
    expect(distinct.size).toBe(4);
  });
});

describe("projectConceptNodes", () => {
  test("overlays live concept statuses onto the study set, preserving order", () => {
    const nodes = projectConceptNodes(
      [concept("nadh", "NADH", "review"), concept("op", "Oxidative phosphorylation", "shaky")],
      { nadh: "strong" },
    );
    expect(nodes.map((n) => n.id)).toEqual(["nadh", "op"]);
    expect(nodes[0]).toMatchObject({ id: "nadh", label: "NADH", status: "strong" });
    expect(nodes[1].status).toBe("shaky");
  });

  test("emphasises concepts touched this session over untouched ones", () => {
    const nodes = projectConceptNodes([concept("a", "A", "shaky"), concept("b", "B", "strong")], {
      a: "missed",
    });
    expect(nodes[0].emphasis).toBeGreaterThan(nodes[1].emphasis);
  });

  test("is empty when there are no concepts", () => {
    expect(projectConceptNodes([], {})).toEqual([]);
  });
});
