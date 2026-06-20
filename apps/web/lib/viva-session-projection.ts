import {
  type AgentStudySetReadiness,
  type AgentTerminalSessionReason,
  type Concept,
  type ConceptStatus,
  type EvaluationLabel,
  reviewIntervalForStatus,
  type SourceReference,
  type VivaReadyFrame,
} from "@viva/core";
import type {
  ChecklistItem,
  ConceptNode,
  CorrectionFamily,
  Question,
  SessionState,
} from "../components/session/session-data";
import type { VivaAgentDerivedState } from "./use-viva-agent-session";
import type {
  VivaAgentCloseDiagnostics,
  VivaAgentConnectionStatus,
  VivaAgentReadinessProbe,
  VivaAgentReadyEndpoint,
} from "./viva-agent-client";

/**
 * The Conductor — a pure projection from the real agent event stream
 * (VivaAgentDerivedState, folded by the existing reducer) onto the inputs the
 * gorgeous "Listening Manuscript" already consumes: a session state,
 * the per-prompt Question the marginalia renders, and the tokens that glow on
 * the trace.
 *
 * This is what replaces LiveSessionPage's hardcoded 4-state timer + biology
 * fixtures: the manuscript now moves because of what the examiner actually did,
 * not a clock. It is deliberately pure so it can be unit-tested and so every
 * later backend swap (real evaluator, retrieval, mastery) flows through it
 * unchanged.
 *
 * Reveal-timing rule (anti-spoiler, learning-science): the question's
 * expected_terms are server-only fuel during listening and are revealed to the
 * page only once Viva is thinking — never as a pre-answer answer key.
 */

export type TraceProjection = {
  state: SessionState;
  question: Question;
  highlightedTokens: string[];
  hasAgentQuestion: boolean;
};

export type SourceFolioState = "present" | "low_confidence" | "conflicting" | "unavailable";

export type SourceFolioProjection = {
  state: SourceFolioState;
  source: SourceReference;
  conceptStatus: string;
  confidenceLabel: string;
  caveat: string;
  challengeLabel: string;
  regionNavigation: string;
};

export type RuntimeCopyCause =
  | "api_missing"
  | "agent_offline"
  | "auth_failed"
  | "cost_budget"
  | "drained"
  | "fake_provider"
  | "ingestion_failed"
  | "ingestion_pending"
  | "live_provider_gated"
  | "live_runtime"
  | "mic_denied"
  | "partial_stage_success"
  | "provider_auth_failed"
  | "provider_cancelled"
  | "provider_malformed_stream"
  | "provider_network_disconnect"
  | "provider_rate_limited"
  | "provider_timeout"
  | "rate_limit"
  | "session_cap"
  | "session_disconnected"
  | "slow_client"
  | "store_unavailable"
  | "synthetic"
  | "turn_cap"
  | "unexpected_close";

export type RuntimeCopy = {
  capsuleLabel: string;
  marginaliaTitle: string;
  marginaliaText: string;
  nextActionLabel: string;
  primaryActionIntent: RuntimePrimaryActionIntent;
  primaryActionDisabled: boolean;
  primaryActionLabel: string;
  readinessNotes: RuntimeReadinessNote[];
  statusLabel: string;
  cause: RuntimeCopyCause;
};

export type RuntimePrimaryActionIntent =
  | "disabled"
  | "retry_agent"
  | "start_session"
  | "submit_turn";

export type RuntimeReadinessNote = {
  label: string;
  state: "blocked" | "checking" | "ready" | "unavailable";
  text: string;
};

export type RuntimeMicState = "available" | "denied" | "unsupported" | "unknown";

type RuntimeProjectionContext = {
  readiness: AgentStudySetReadiness;
  readinessProbe?: VivaAgentReadinessProbe;
  ready?: VivaReadyFrame | VivaAgentReadyEndpoint;
  websocketReady: boolean;
  status: VivaAgentConnectionStatus;
  mic: RuntimeMicState;
  close?: VivaAgentCloseDiagnostics;
  terminalReason?: AgentTerminalSessionReason;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function projectSessionState(
  phase: VivaAgentDerivedState["phase"],
  _hasQuestion: boolean,
): SessionState {
  switch (phase) {
    case "thinking":
      return "thinking";
    case "feedback":
    case "correction":
      return "correction";
    case "recap":
      return "recap";
    default:
      return "listening";
  }
}

export function expectedTermsRevealed(state: SessionState): boolean {
  return state !== "listening";
}

/**
 * The agent emits a transcription confidence on `transcript_final`. Below this
 * threshold the Conductor genuinely may have misheard the spoken answer, so the
 * manuscript flags it honestly (REQUIREMENTS §8.4) rather than grading silently
 * against a possibly-wrong transcript. Decent/high confidence stays quiet.
 */
export const LOW_TRANSCRIPTION_CONFIDENCE = 0.7;

export function transcriptionWasUncertain(confidence: number | null | undefined): boolean {
  return typeof confidence === "number" && confidence < LOW_TRANSCRIPTION_CONFIDENCE;
}

export function projectHighlightedTokens(
  state: SessionState,
  derived: VivaAgentDerivedState,
): string[] {
  if (!expectedTermsRevealed(state)) return [];
  return derived.question?.expectedTerms ?? [];
}

/** The Concept Mastery Field palette: each status reads as a distinct ink tone. */
export function conceptStatusColor(status: ConceptStatus): { r: number; g: number; b: number } {
  switch (status) {
    case "strong":
      return { r: 127, g: 146, b: 119 }; // sage
    case "review":
      return { r: 195, g: 178, b: 221 }; // lavender
    case "shaky":
      return { r: 193, g: 134, b: 74 }; // amber
    case "missed":
      return { r: 176, g: 98, b: 52 }; // deep ochre
  }
}

export function projectRuntimeCopy({
  readiness,
  ready,
  status,
  errors = [],
  mic = "unknown",
  close,
  readinessProbe,
  terminalReason,
}: {
  readiness: AgentStudySetReadiness;
  ready?: VivaReadyFrame;
  readinessProbe?: VivaAgentReadinessProbe;
  status: VivaAgentConnectionStatus;
  errors?: string[];
  mic?: RuntimeMicState;
  close?: VivaAgentCloseDiagnostics;
  terminalReason?: AgentTerminalSessionReason;
}): RuntimeCopy {
  const rawNewestError = errors.at(-1) ?? "";
  const rawCloseReason = close?.reason ?? "";
  const newestError = sanitizeRuntimeDiagnostic(rawNewestError);
  const closeReason = sanitizeRuntimeDiagnostic(rawCloseReason);
  const diagnosticText = `${rawNewestError} ${rawCloseReason}`;
  const authFailed = /auth|token|claim|unauthori[sz]ed/i.test(diagnosticText);
  const endpointReady = readinessProbe?.status === "observed" ? readinessProbe.ready : undefined;
  const readinessFacts = ready ?? endpointReady;
  const context: RuntimeProjectionContext = {
    mic,
    close,
    readiness,
    readinessProbe,
    ready: readinessFacts,
    status,
    terminalReason,
    websocketReady: Boolean(ready) && status === "open",
  };

  if (status === "closed" && terminalReason) {
    return controlledTerminalCopy(terminalReason, context);
  }

  if (authFailed) {
    return runtimeCopy(
      {
        capsuleLabel: "Auth failed",
        marginaliaTitle: "Agent unavailable: auth failed.",
        marginaliaText:
          "The Conductor auth failed for this session identity; refresh the signed session before the manuscript opens another question.",
        statusLabel: "Auth failed",
        cause: "auth_failed",
      },
      context,
      { disabled: true, nextActionLabel: "Refresh session" },
    );
  }

  if (!readiness.canConnect) {
    const ingestionFailed = readiness.reason === "failed_ingestion";
    return runtimeCopy(
      {
        capsuleLabel: ingestionFailed ? "Ingestion failed" : "Ingestion pending",
        marginaliaTitle: ingestionFailed
          ? "Agent unavailable: ingestion failed."
          : "Agent unavailable: ingestion pending.",
        marginaliaText: readiness.message,
        statusLabel: readiness.reason.replace(/_/g, " "),
        cause: ingestionFailed ? "ingestion_failed" : "ingestion_pending",
      },
      context,
      {
        disabled: true,
        nextActionLabel: ingestionFailed ? "Review ingestion status" : "Refresh ingestion",
      },
    );
  }

  if (!readinessFacts) {
    if (readinessProbe?.status === "api_missing") {
      return runtimeCopy(
        {
          capsuleLabel: "API missing",
          marginaliaTitle: "Agent unavailable: API missing.",
          marginaliaText:
            "The manuscript cannot derive an HTTP readiness URL for `/ready` or `/health/brain`.",
          statusLabel: "api missing",
          cause: "api_missing",
        },
        context,
        { disabled: true, nextActionLabel: "Configure agent API" },
      );
    }

    if (readinessProbe?.status === "offline") {
      return runtimeCopy(
        {
          capsuleLabel: "Agent offline",
          marginaliaTitle: "Agent unavailable: service offline.",
          marginaliaText: `The manuscript could not reach \`/ready\` or \`/health/brain\` at ${readinessProbe.apiBaseUrl}: ${readinessProbe.error}`,
          statusLabel: "agent offline",
          cause: "agent_offline",
        },
        context,
        retryAgentAction(),
      );
    }

    const connecting = status === "connecting" || status === "idle";
    return runtimeCopy(
      {
        capsuleLabel: connecting ? "Agent connecting" : "Agent offline",
        marginaliaTitle: connecting
          ? "Waiting for the Conductor."
          : "Agent unavailable: service offline.",
        marginaliaText: connecting
          ? "The manuscript has not received provider readiness from the Conductor yet."
          : newestError ||
            "The `/ws` stream closed before provider readiness reached the manuscript.",
        statusLabel: connecting ? "connecting" : "agent offline",
        cause: "agent_offline",
      },
      context,
      retryAgentAction(),
    );
  }

  if (newestError && (status === "error" || status === "closed")) {
    return runtimeCopy(
      {
        capsuleLabel: "Agent unavailable",
        marginaliaTitle: "Agent unavailable: session rejected.",
        marginaliaText: newestError,
        statusLabel: "session rejected",
        cause: "agent_offline",
      },
      context,
      retryAgentAction(),
    );
  }

  if (status === "closed" && close && !context.websocketReady && isUnexpectedClose(close)) {
    const reason = closeReason ? ` Reason: ${closeReason}.` : "";
    return runtimeCopy(
      {
        capsuleLabel: "Session interrupted",
        marginaliaTitle: "Session interrupted before the manuscript closed.",
        marginaliaText: `The WebSocket closed with code ${close.code} before the Conductor sent a terminal phase.${reason} Retry the agent or share the close details with a developer.`,
        statusLabel: "unexpected close",
        cause: "unexpected_close",
      },
      context,
      retryAgentAction(),
    );
  }

  if (!readinessFacts.store.available) {
    const backend = readinessFacts.store.backend.replace(/_/g, " ");
    return runtimeCopy(
      {
        capsuleLabel: "Store unavailable",
        marginaliaTitle: "Agent unavailable: store unavailable.",
        marginaliaText: `The ${backend} store is unavailable, so Viva will not ask or mark questions for this session.`,
        statusLabel: `${backend} store unavailable`,
        cause: "store_unavailable",
      },
      context,
      retryAgentAction(),
    );
  }

  if (
    context.websocketReady &&
    readinessFacts.brain.configured &&
    readinessFacts.brain.selectable &&
    (mic === "denied" || mic === "unsupported")
  ) {
    const denied = mic === "denied";
    return runtimeCopy(
      {
        capsuleLabel: denied ? "Mic denied" : "Mic unavailable",
        marginaliaTitle: denied
          ? "Mic denied; write in the margin."
          : "Mic unavailable; write in the margin.",
        marginaliaText: denied
          ? "Browser microphone capture was denied. Submit a written answer; the Conductor will evaluate the same agent text path and finalize the transcript from the server."
          : "Browser microphone capture is unavailable in this browser context. Submit a written answer; the Conductor will evaluate the same agent text path and finalize the transcript from the server.",
        statusLabel: denied ? "mic denied" : "mic unavailable",
        cause: "mic_denied",
      },
      context,
      trustedTurnAction(context),
    );
  }

  if (
    !context.websocketReady &&
    readinessFacts.brain.configured &&
    readinessFacts.brain.selectable &&
    readinessFacts.store.available
  ) {
    return runtimeCopy(
      {
        capsuleLabel: "Session not connected",
        marginaliaTitle: "Agent ready; session not connected.",
        marginaliaText: `HTTP readiness is green for ${readinessFacts.brain.provider}, but the manuscript has not received an open WebSocket ready frame for a trusted turn.`,
        statusLabel: "session not connected",
        cause: "session_disconnected",
      },
      context,
      retryAgentAction(),
    );
  }

  if (readinessFacts.brain.selectable && readinessFacts.brain.live_runtime) {
    if (readinessFacts.brain.provider === "cartesia_gemini") {
      return runtimeCopy(
        {
          capsuleLabel: "Live Cartesia/Gemini tutor",
          marginaliaTitle: "Live Cartesia/Gemini tutor is listening.",
          marginaliaText:
            "The live Cartesia/Gemini runtime is selected; spoken turns are handled by the Act 3 provider path.",
          statusLabel: "live runtime",
          cause: "live_runtime",
        },
        context,
        trustedTurnAction(context),
      );
    }
    return runtimeCopy(
      {
        capsuleLabel: "Live tutor",
        marginaliaTitle: "Live tutor is listening.",
        marginaliaText:
          "The live provider runtime is selected; spoken turns are handled by the Act 3 provider path.",
        statusLabel: "live runtime",
        cause: "live_runtime",
      },
      context,
      trustedTurnAction(context),
    );
  }

  if (readinessFacts.brain.provider === "synthetic") {
    return runtimeCopy(
      {
        capsuleLabel: "Synthetic examiner",
        marginaliaTitle: "Synthetic examiner is listening.",
        marginaliaText:
          "Default no-key synthetic brain: a verified Act 1 event stream with source-grounded questions and no provider keys.",
        statusLabel: "synthetic",
        cause: "synthetic",
      },
      context,
      trustedTurnAction(context),
    );
  }

  if (readinessFacts.brain.provider === "fake_cartesia_gemini") {
    return runtimeCopy(
      {
        capsuleLabel: "Non-live provider test",
        marginaliaTitle: "Non-live provider test is listening.",
        marginaliaText:
          "The Cartesia/Gemini-shaped path is running through no-key test transports; it is not a live tutor.",
        statusLabel: "fake provider",
        cause: "fake_provider",
      },
      context,
      trustedTurnAction(context),
    );
  }

  if (
    readinessFacts.brain.provider === "cartesia_gemini" ||
    !readinessFacts.brain.configured ||
    !readinessFacts.brain.selectable
  ) {
    return runtimeCopy(
      {
        capsuleLabel: "Live provider gated",
        marginaliaTitle: "Agent unavailable: live provider gated.",
        marginaliaText:
          "Cartesia/Gemini is reserved for Act 3 until provider keys and the live runtime are selectable.",
        statusLabel: "live provider gated",
        cause: "live_provider_gated",
      },
      context,
      { disabled: true, nextActionLabel: "Retry when live runtime is ready" },
    );
  }

  return runtimeCopy(
    {
      capsuleLabel: "Non-live provider test",
      marginaliaTitle: "Non-live provider test is listening.",
      marginaliaText: `${readinessFacts.brain.provider} is running through a no-key provider path; it is not a live tutor.`,
      statusLabel: "non-live provider",
      cause: "fake_provider",
    },
    context,
    trustedTurnAction(context),
  );
}

function controlledTerminalCopy(
  reason: AgentTerminalSessionReason,
  context: RuntimeProjectionContext,
): RuntimeCopy {
  const copyByReason: Record<
    AgentTerminalSessionReason,
    Pick<
      RuntimeCopy,
      "capsuleLabel" | "marginaliaTitle" | "marginaliaText" | "statusLabel" | "cause"
    >
  > = {
    drained: {
      capsuleLabel: "Session drained",
      marginaliaTitle: "The deploy drain closed this manuscript.",
      marginaliaText:
        "The Conductor entered deploy drain and closed the manuscript after emitting a terminal phase.",
      statusLabel: "drained",
      cause: "drained",
    },
    session_cap: {
      capsuleLabel: "Session cap reached",
      marginaliaTitle: "The session cap closed this manuscript.",
      marginaliaText:
        "The Conductor reached the session cap and closed the manuscript after emitting a terminal phase.",
      statusLabel: "session cap",
      cause: "session_cap",
    },
    turn_cap: {
      capsuleLabel: "Turn cap reached",
      marginaliaTitle: "The turn cap closed this manuscript.",
      marginaliaText:
        "The Conductor reached the turn cap and closed the manuscript after emitting a terminal phase.",
      statusLabel: "turn cap",
      cause: "turn_cap",
    },
    rate_limit: {
      capsuleLabel: "Rate limit reached",
      marginaliaTitle: "The rate limit closed this manuscript.",
      marginaliaText:
        "The Conductor reached the voice rate limit and closed the manuscript after emitting a terminal phase.",
      statusLabel: "rate limit",
      cause: "rate_limit",
    },
    cost_budget: {
      capsuleLabel: "Budget cap reached",
      marginaliaTitle: "The cost budget closed this manuscript.",
      marginaliaText:
        "The Conductor reached the live-provider cost budget and closed the manuscript after emitting a terminal phase.",
      statusLabel: "budget cap",
      cause: "cost_budget",
    },
    provider_auth_failed: {
      capsuleLabel: "Provider auth failed",
      marginaliaTitle: "Live provider access was denied.",
      marginaliaText:
        "The live provider rejected access before the manuscript could open another trusted turn.",
      statusLabel: "provider auth failed",
      cause: "provider_auth_failed",
    },
    provider_rate_limited: {
      capsuleLabel: "Provider rate limited",
      marginaliaTitle: "Live provider quota stopped this turn.",
      marginaliaText:
        "The provider quota or rate limit closed the manuscript before a complete live response.",
      statusLabel: "provider rate limited",
      cause: "provider_rate_limited",
    },
    provider_timeout: {
      capsuleLabel: "Provider timeout",
      marginaliaTitle: "Live provider timed out.",
      marginaliaText:
        "The live stream did not reach the next required stage within the configured cap.",
      statusLabel: "provider timeout",
      cause: "provider_timeout",
    },
    provider_malformed_stream: {
      capsuleLabel: "Provider stream failed",
      marginaliaTitle: "Live provider stream was malformed.",
      marginaliaText:
        "The stream produced an invalid or structured error frame, so Viva closed it without retaining provider contents.",
      statusLabel: "provider stream failed",
      cause: "provider_malformed_stream",
    },
    provider_network_disconnect: {
      capsuleLabel: "Provider disconnected",
      marginaliaTitle: "Live provider connection dropped.",
      marginaliaText:
        "The provider transport disconnected before the manuscript received a complete terminal phase.",
      statusLabel: "provider disconnected",
      cause: "provider_network_disconnect",
    },
    slow_client: {
      capsuleLabel: "Client too slow",
      marginaliaTitle: "The client missed the live-turn cap.",
      marginaliaText:
        "The client did not finish the live turn within the configured turn or audio cap.",
      statusLabel: "client too slow",
      cause: "slow_client",
    },
    provider_cancelled: {
      capsuleLabel: "Provider cancelled",
      marginaliaTitle: "Live provider cancelled the turn.",
      marginaliaText: "The live response was cancelled before Viva could produce a complete recap.",
      statusLabel: "provider cancelled",
      cause: "provider_cancelled",
    },
    partial_stage_success: {
      capsuleLabel: "Partial live result",
      marginaliaTitle: "Live provider reached only part of the turn.",
      marginaliaText:
        "The stream reached a later stage but missed at least one required live-smoke proof event.",
      statusLabel: "partial live result",
      cause: "partial_stage_success",
    },
  };
  const actionByReason: Record<
    AgentTerminalSessionReason,
    {
      disabled: boolean;
      intent: RuntimePrimaryActionIntent;
      nextActionLabel: string;
      primaryActionLabel: string;
    }
  > = {
    drained: startAgainAction(),
    session_cap: startAgainAction(),
    turn_cap: startAgainAction(),
    rate_limit: startAgainAction(),
    cost_budget: startAgainAction(),
    provider_auth_failed: {
      disabled: false,
      intent: "retry_agent",
      nextActionLabel: "Check provider access",
      primaryActionLabel: "Check provider access",
    },
    provider_rate_limited: {
      disabled: false,
      intent: "retry_agent",
      nextActionLabel: "Retry after quota resets",
      primaryActionLabel: "Retry after quota resets",
    },
    provider_timeout: retryAgentAction(),
    provider_malformed_stream: retryAgentAction(),
    provider_network_disconnect: retryAgentAction(),
    slow_client: startAgainAction(),
    provider_cancelled: startAgainAction(),
    partial_stage_success: {
      disabled: false,
      intent: "start_session",
      nextActionLabel: "Review partial recap",
      primaryActionLabel: "Review partial recap",
    },
  };
  return runtimeCopy(copyByReason[reason], context, actionByReason[reason]);
}

function runtimeCopy(
  copy: Omit<
    RuntimeCopy,
    | "nextActionLabel"
    | "primaryActionDisabled"
    | "primaryActionIntent"
    | "primaryActionLabel"
    | "readinessNotes"
  >,
  context: RuntimeProjectionContext,
  action: {
    disabled: boolean;
    intent?: RuntimePrimaryActionIntent;
    nextActionLabel: string;
    primaryActionLabel?: string;
  },
): RuntimeCopy {
  return {
    ...copy,
    nextActionLabel: action.nextActionLabel,
    primaryActionDisabled: action.disabled,
    primaryActionIntent: action.intent ?? (action.disabled ? "disabled" : "submit_turn"),
    primaryActionLabel: action.primaryActionLabel ?? action.nextActionLabel,
    readinessNotes: runtimeReadinessNotes(context, copy.cause),
  };
}

function sanitizeRuntimeDiagnostic(value: string): string {
  if (
    /pcm16_base64|answer_text|transcript|prompt|source_context|pasted_text|session_token|viva1\.|bearer|cartesia_api_key|gemini_api_key|secret|raw answer|source excerpt/i.test(
      value,
    )
  ) {
    return "sanitized provider error";
  }
  return value;
}

function isUnexpectedClose(close: VivaAgentCloseDiagnostics): boolean {
  return !(close.wasClean && (close.code === 1000 || close.code === 1001));
}

function trustedTurnAction(context: RuntimeProjectionContext): {
  disabled: boolean;
  intent: RuntimePrimaryActionIntent;
  nextActionLabel: string;
  primaryActionLabel: string;
} {
  if (context.websocketReady) {
    return {
      disabled: false,
      intent: "submit_turn",
      nextActionLabel: "Answer when ready",
      primaryActionLabel: "I'm ready — check it",
    };
  }
  return retryAgentAction();
}

function retryAgentAction(): {
  disabled: boolean;
  intent: RuntimePrimaryActionIntent;
  nextActionLabel: string;
  primaryActionLabel: string;
} {
  return {
    disabled: false,
    intent: "retry_agent",
    nextActionLabel: "Retry agent",
    primaryActionLabel: "Retry agent",
  };
}

function startAgainAction(): {
  disabled: boolean;
  intent: RuntimePrimaryActionIntent;
  nextActionLabel: string;
  primaryActionLabel: string;
} {
  return {
    disabled: false,
    intent: "start_session",
    nextActionLabel: "Start a new session",
    primaryActionLabel: "Start again",
  };
}

function runtimeReadinessNotes(
  context: RuntimeProjectionContext,
  cause: RuntimeCopyCause,
): RuntimeReadinessNote[] {
  const notes: RuntimeReadinessNote[] = [];

  if (!context.readiness.canConnect) {
    notes.push({
      label: "Study set",
      state: context.readiness.reason === "failed_ingestion" ? "unavailable" : "blocked",
      text: context.readiness.message,
    });
  }

  if (
    context.readinessProbe &&
    !probeContradictsLiveReady(context.readinessProbe, context.websocketReady)
  ) {
    notes.push(...probeNotes(context.readinessProbe));
  } else if (!context.readinessProbe && !context.ready) {
    const waiting = context.status === "connecting" || context.status === "idle";
    notes.push({
      label: "Socket",
      state: waiting ? "checking" : "unavailable",
      text: waiting
        ? "Waiting for the WebSocket ready frame."
        : "The WebSocket closed before a ready frame arrived.",
    });
  }

  if (context.ready) {
    notes.push({
      label: "Provider",
      state:
        context.ready.brain.configured && context.ready.brain.selectable
          ? "ready"
          : context.ready.brain.configured
            ? "blocked"
            : "unavailable",
      text: `${context.ready.brain.provider}: configured=${context.ready.brain.configured}, selectable=${context.ready.brain.selectable}, live=${context.ready.brain.live_runtime}.`,
    });
    notes.push({
      label: "Store",
      state: context.ready.store.available ? "ready" : "unavailable",
      text: `${context.ready.store.backend.replace(/_/g, " ")} store available=${context.ready.store.available}.`,
    });
  }

  if (context.mic === "denied" || context.mic === "unsupported") {
    notes.push({
      label: "Mic",
      state: "blocked",
      text:
        context.mic === "denied"
          ? "Browser microphone permission is denied."
          : "Browser microphone capture is unsupported here.",
    });
  }

  if (context.close) {
    notes.push({
      label: "Close",
      state: context.close.wasClean ? "blocked" : "unavailable",
      text: `code ${context.close.code}; ${context.close.wasClean ? "clean" : "unclean"}${context.close.reason ? `; ${context.close.reason}` : ""}.`,
    });
  }

  if (notes.length === 0) {
    notes.push({
      label: "Connected",
      state: cause === "live_provider_gated" ? "blocked" : "ready",
      text: "The Conductor has enough readiness facts to keep the manuscript calm.",
    });
  }

  return notes;
}

/**
 * A live WebSocket `ready` frame is authoritative proof the agent is reachable.
 * A stale 5s HTTP poll that is "checking", "offline", or an "observed" probe
 * whose `/ready` reports not-ready would only contradict it — a red line above
 * the green Provider/Store notes on a healthy session. Drop those once we have
 * the live facts; a healthy "observed" probe and "api_missing" still add
 * information rather than contradict. (Polling stops once the live frame lands,
 * so a not-ready probe captured just before it must not freeze as a stale
 * contradiction.)
 */
function probeContradictsLiveReady(
  probe: VivaAgentReadinessProbe,
  websocketReady: boolean,
): boolean {
  // Key off the genuine WS ready frame, NOT readinessFacts — an "observed" probe
  // is its own readiness source, so it must not self-suppress when it is the only
  // signal (the gated-provider connecting case).
  if (!websocketReady) return false;
  if (probe.status === "offline" || probe.status === "checking") return true;
  return probe.status === "observed" && !probe.ready.ready;
}

function probeNotes(probe: VivaAgentReadinessProbe): RuntimeReadinessNote[] {
  switch (probe.status) {
    case "api_missing":
      return [
        {
          label: "API",
          state: "blocked",
          text: "No HTTP readiness URL is available for `/ready` or `/health/brain`.",
        },
      ];
    case "checking":
      return [
        {
          label: "Readiness",
          state: "checking",
          text: `Checking ${probe.apiBaseUrl}/ready and ${probe.apiBaseUrl}/health/brain.`,
        },
      ];
    case "offline":
      return [
        {
          label: "Agent",
          state: "unavailable",
          text: `Could not reach /ready or /health/brain at ${probe.apiBaseUrl}.`,
        },
      ];
    case "observed":
      return [
        {
          label: "/health/brain",
          state: probe.health.status === "configured" ? "ready" : "blocked",
          text: `HTTP ${probe.healthHttpStatus}; ${probe.health.brain.provider}: configured=${probe.health.brain.configured}, selectable=${probe.health.brain.selectable}, live=${probe.health.brain.live_runtime}.`,
        },
        {
          label: "/ready",
          state: probe.ready.ready
            ? "ready"
            : probe.readyHttpStatus === 503
              ? "blocked"
              : "unavailable",
          text: `HTTP ${probe.readyHttpStatus}; ready=${probe.ready.ready}; ${probe.ready.brain.provider}.`,
        },
      ];
  }
}

/**
 * Build the live concept pathway: the study set's own concepts, each carrying
 * its current mastery. Live concept_status events (from the agent, keyed by
 * concept_id) overlay the baseline, and a concept touched this session is
 * emphasised so it warms into its new colour on the trace.
 */
export function projectConceptNodes(
  concepts: Concept[],
  liveStatuses: Record<string, ConceptStatus>,
): ConceptNode[] {
  return concepts.map((concept) => {
    const live = liveStatuses[concept.id];
    return {
      id: concept.id,
      label: concept.label,
      status: live ?? concept.status,
      emphasis: live !== undefined ? 1 : 0.5,
    };
  });
}

function statusLabel(status: ConceptStatus): string {
  switch (status) {
    case "strong":
      return "Strong";
    case "shaky":
      return "Shaky";
    case "missed":
      return "Missed";
    case "review":
      return "Review";
  }
}

export function conceptStatusVerdict(status: ConceptStatus, now: Date): string {
  return `${statusLabel(status)} · review ${reviewIntervalForStatus(status, now)}`;
}

/** The three marking families the margin uses (collapsing the 7 eval labels). */
export function correctionFamily(label: EvaluationLabel): CorrectionFamily {
  switch (label) {
    case "strong":
    case "mostly correct":
      return "affirm";
    case "insufficient evidence":
      return "caveat";
    default:
      return "reprompt";
  }
}

function labelWrongness(label: EvaluationLabel): number {
  switch (label) {
    case "wrong":
    case "off-topic":
      return 1;
    case "vague":
    case "partially correct":
      return 0.7;
    case "insufficient evidence":
      return 0.5;
    case "mostly correct":
      return 0.3;
    case "strong":
      return 0.15;
  }
}

/**
 * Hypercorrection: a confident-and-wrong answer earns the heaviest ink, a
 * hesitant or already-correct one stays light. Returns a 0..1 ink-weight.
 */
export function correctionEmphasis(confidence: number, label: EvaluationLabel): number {
  return clamp01(labelWrongness(label) * (0.4 + 0.6 * clamp01(confidence)));
}

export function checklistFromExpectedTerms(
  expectedTerms: string[],
  transcript: string,
): ChecklistItem[] {
  const haystack = transcript.toLowerCase();
  return expectedTerms.map((term) => ({
    label: term,
    status: haystack.includes(term.toLowerCase()) ? "done" : "missing",
  }));
}

function connectionPlaceholderPrompt(
  status: VivaAgentConnectionStatus,
  gracefullyEnded: boolean,
): string {
  switch (status) {
    case "connecting":
      return "Connecting to your examiner…";
    case "error":
      return "The connection was interrupted.";
    case "closed":
      // A graceful end always arrives as a recap (handled earlier) or carries a
      // terminal reason. A close with neither — most often the examiner was
      // never reachable (unclean 1006) — is an interruption, not a finished
      // session; don't dress an infra failure up as completed study.
      return gracefullyEnded ? "This session has ended." : "The connection was interrupted.";
    default:
      return "Your examiner is preparing the first question…";
  }
}

const EMPTY_QUESTION: Omit<Question, "prompt" | "status"> = {
  checklist: [],
  correctionBody: "",
  explanation: "",
  sourceRef: "",
  sourceSubtitle: "",
  excerpt: "",
  sourceFooter: "",
  highlights: [],
};

export function projectSessionQuestion(
  derived: VivaAgentDerivedState,
  status: VivaAgentConnectionStatus,
  now: Date,
): Question {
  if (derived.recap) return recapClosingQuestion(derived.recap);

  const agentQuestion = derived.question;
  if (!agentQuestion) {
    // Connecting / idle / open-without-a-question is a warming-up placeholder;
    // error and closed are terminal copy, not a pending question.
    const terminal = status === "error" || status === "closed";
    const pending = !terminal;
    const gracefullyEnded = Boolean(derived.terminalReason);
    return {
      ...EMPTY_QUESTION,
      prompt: connectionPlaceholderPrompt(status, gracefullyEnded),
      status: "",
      pending,
      terminal,
    };
  }

  const evaluation = derived.evaluation;
  const source = evaluation?.source ?? agentQuestion.source;
  const transcript = derived.finalTranscript ?? derived.transcript;

  return {
    prompt: agentQuestion.prompt,
    checklist: checklistFromExpectedTerms(agentQuestion.expectedTerms, transcript),
    correctionBody: evaluation?.conciseFeedback ?? "",
    explanation: evaluation ? source.excerpt : agentQuestion.source.excerpt,
    sourceRef: source.label,
    sourceSubtitle: source.retrievalReason ?? "",
    excerpt: source.excerpt,
    sourceFooter: source.label,
    status: evaluation ? conceptStatusVerdict(evaluation.conceptStatus, now) : "",
    highlights: agentQuestion.expectedTerms,
    correctionFamily: evaluation ? correctionFamily(evaluation.label) : undefined,
    correctionEmphasis: evaluation
      ? correctionEmphasis(evaluation.confidenceScore, evaluation.label)
      : undefined,
    retryPrompt: evaluation?.retryPrompt || undefined,
  };
}

function recapClosingQuestion(recap: NonNullable<VivaAgentDerivedState["recap"]>): Question {
  const sourceMoment = recap.sourceMoments[0];
  const highlights = [
    ...new Set([
      ...recap.strongConcepts,
      ...recap.shakyConcepts,
      ...recap.missedConcepts,
      ...recap.reviewLater,
    ]),
  ];

  return {
    ...EMPTY_QUESTION,
    prompt: recapHeadlinePrompt(recap.headline),
    explanation: recap.summary,
    sourceRef: sourceMoment?.source.label ?? "",
    sourceSubtitle: sourceMoment ? "Source moment" : "",
    excerpt: sourceMoment?.text ?? "",
    sourceFooter: sourceMoment?.source.label ?? "",
    status: "Closing fold ready",
    highlights,
  };
}

function recapHeadlinePrompt(headline: string): string {
  const normalized = headline.replace(/\s+/g, " ").trim();
  const comma = normalized.indexOf(",");
  if (comma > 0 && comma < normalized.length - 1) {
    return `${normalized.slice(0, comma + 1)}\n${normalized.slice(comma + 1).trimStart()}`;
  }
  return normalized || "Session recap ready.";
}

export function projectSourceFolio(
  derived: VivaAgentDerivedState,
  now: Date,
): SourceFolioProjection {
  const source = latestBoundedSource(derived);
  const regionNavigation =
    "Document span only; exact page and bounding-box navigation is unverified.";

  if (!source?.excerpt.trim()) {
    return {
      caveat: "No bounded source_reference has arrived for this correction.",
      challengeLabel: "Challenge unavailable source",
      conceptStatus: "Source status unavailable",
      confidenceLabel: "Source unavailable",
      regionNavigation,
      source: {
        confidence: "low",
        excerpt: "",
        label: "Source unavailable",
      },
      state: "unavailable",
    };
  }

  const boundedSource = { ...source, excerpt: boundedSourceExcerpt(source.excerpt) };
  const state = sourceFolioState(boundedSource);
  return {
    caveat: sourceFolioCaveat(boundedSource, state),
    challengeLabel: "Challenge citation",
    conceptStatus: projectedFolioConceptStatus(derived, now),
    confidenceLabel: sourceConfidenceLabel(boundedSource.confidence),
    regionNavigation,
    source: boundedSource,
    state,
  };
}

function latestBoundedSource(derived: VivaAgentDerivedState): SourceReference | undefined {
  return derived.currentSource ?? derived.evaluation?.source ?? derived.question?.source;
}

function sourceFolioState(source: SourceReference): SourceFolioState {
  if (!source.excerpt.trim()) return "unavailable";
  if (sourceReasonLooksConflicting(source.retrievalReason)) {
    return source.confidence === "low" ? "low_confidence" : "conflicting";
  }
  if (source.confidence === "low") return "low_confidence";
  return "present";
}

function sourceReasonLooksConflicting(reason?: string): boolean {
  return Boolean(reason && /conflict|contradict|disagree|discrepanc/i.test(reason));
}

function sourceConfidenceLabel(confidence: SourceReference["confidence"]): string {
  switch (confidence) {
    case "high":
      return "High confidence";
    case "medium":
      return "Medium confidence";
    case "low":
      return "Low confidence";
  }
}

function sourceFolioCaveat(source: SourceReference, state: SourceFolioState): string {
  switch (state) {
    case "conflicting":
      return `Conflicting source material: ${source.retrievalReason || "the bounded span needs review."}`;
    case "low_confidence":
      return `Low-confidence retrieval: ${source.retrievalReason || "verify this bounded span before treating it as decisive."}`;
    case "unavailable":
      return "No bounded source_reference has arrived for this correction.";
    case "present":
      return source.retrievalReason
        ? `Source citation is bounded to this span: ${source.retrievalReason}`
        : "Source citation is bounded to this server-owned span.";
  }
}

function projectedFolioConceptStatus(derived: VivaAgentDerivedState, now: Date): string {
  const status = derived.currentConceptStatus ?? derived.evaluation?.conceptStatus;
  return status ? conceptStatusVerdict(status, now) : "Awaiting concept status";
}

function boundedSourceExcerpt(excerpt: string): string {
  const normalized = excerpt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 720) return normalized;
  return `${normalized.slice(0, 717).trimEnd()}...`;
}

export function projectTrace(
  derived: VivaAgentDerivedState,
  status: VivaAgentConnectionStatus,
  now: Date,
): TraceProjection {
  const hasAgentQuestion = Boolean(derived.question);
  const state = derived.recap ? "recap" : projectSessionState(derived.phase, hasAgentQuestion);
  return {
    state,
    question: projectSessionQuestion(derived, status, now),
    highlightedTokens: projectHighlightedTokens(state, derived),
    hasAgentQuestion,
  };
}
