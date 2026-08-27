import {
  type AgentStudySetReadiness,
  type AgentTerminalSessionReason,
  type Concept,
  type ConceptStatus,
  type EvaluationLabel,
  type RuntimeCopyCause,
  type SourceReference,
  VIVA_LEARNER_LOOP_CONTRACT,
  type VivaReadyFrame,
  type VivaServerError,
  type VivaVoiceTermination,
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
  VivaAgentDeferredTurn,
  VivaAgentDiagnostic,
  VivaAgentReadinessProbe,
  VivaAgentReadyEndpoint,
  VivaAgentRecapState,
  VivaAgentReconnectState,
  VivaAgentRetainedAudioTurn,
  VivaAgentStructuredError,
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

export type VoiceTurnPhase =
  | "preparing"
  | "listening"
  | "thinking"
  | "speaking"
  | "feedback"
  | "source"
  | "recap"
  | "recovery";

export type VoiceTurnCaption = {
  kind: "feedback" | "question" | "reprompt";
  label: string;
  text: string;
};

export type VoiceTurnNudge = {
  label: string;
  text: string;
};

export type VoiceTurnTakingState = {
  phase: VoiceTurnPhase;
  label: string;
  headline: string;
  detail: string;
  captions: VoiceTurnCaption[];
  nudge?: VoiceTurnNudge;
  interruptAcknowledged: boolean;
  ariaStatus: string;
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

export type RuntimeCopy = {
  capsuleLabel: string;
  marginaliaTitle: string;
  marginaliaText: string;
  nextActionLabel: string;
  primaryActionIntent: RuntimePrimaryActionIntent;
  primaryActionDisabled: boolean;
  primaryActionLabel: string;
  /**
   * `WEBSESSION-READY-01` Step 3: how many CONSECUTIVE readiness polls have
   * failed to observe the agent, once that run has passed the poll owner's own
   * bound — `null` while it has not. The poll owner counts and bounds; this is
   * the number the readiness status element renders beside the readiness copy.
   */
  readinessBoundedFailures: number | null;
  readinessNotes: RuntimeReadinessNote[];
  statusLabel: string;
  cause: RuntimeCopyCause;
};

export type RuntimePrimaryActionIntent =
  | "disabled"
  | "refresh_session"
  | "retry_agent"
  | "start_session"
  | "submit_turn";

export type RuntimeReadinessNote = {
  label: string;
  state: "blocked" | "checking" | "ready" | "unavailable";
  text: string;
};

export type RuntimeMicState = "available" | "denied" | "unsupported" | "unknown";

/**
 * `WEBSESSION-TERMINAL-01`: how a session ENDED, as a first-class projection
 * input rather than something inferred from transport state deep inside the
 * outcome switch.
 *
 * `completion.recapPersisted` is the page's statement that an authorized,
 * complete `recap_ready` was parsed and retained — Plan 04's `session_completed`
 * state, whose authority is a durable store event. It is what licenses success
 * copy to outrank a terminal phase that lands after the recap: the learner's
 * session finished, and calling it "drained" or "interrupted" would be false.
 */
export type RuntimeCompletionProjectionInputs = {
  recap?: VivaAgentRecapState;
  completion?: { recapPersisted: true };
  termination?: VivaVoiceTermination;
  reconnectState: VivaAgentReconnectState;
};

type RuntimeProjectionContext = RuntimeCompletionProjectionInputs & {
  /**
   * The poll owner's bound, already applied: a count once three consecutive
   * polls have failed to observe the agent, `null` before that. The projection
   * does not own the threshold — the single poll lifecycle does — it owns what
   * a bounded run is allowed to say and where the count is rendered.
   */
  boundedReadinessFailures: number | null;
  readiness: AgentStudySetReadiness;
  readinessProbe?: VivaAgentReadinessProbe;
  ready?: VivaReadyFrame | VivaAgentReadyEndpoint;
  websocketReady: boolean;
  status: VivaAgentConnectionStatus;
  mic: RuntimeMicState;
  close?: VivaAgentCloseDiagnostics;
  retainedAudioTurn?: VivaAgentRetainedAudioTurn | null;
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
  boundedReadinessFailures = null,
  readiness,
  ready,
  status,
  completion,
  deferredTurn,
  diagnostics = [],
  lastServerError,
  mic = "unknown",
  close,
  pendingTypedAnswer = false,
  readinessProbe,
  recap,
  reconnect,
  retainedAudioTurn,
  structuredErrors = [],
  termination,
  terminalReason,
}: {
  boundedReadinessFailures?: number | null;
  readiness: AgentStudySetReadiness;
  ready?: VivaReadyFrame;
  readinessProbe?: VivaAgentReadinessProbe;
  status: VivaAgentConnectionStatus;
  completion?: { recapPersisted: true };
  deferredTurn?: VivaAgentDeferredTurn;
  diagnostics?: readonly VivaAgentDiagnostic[];
  lastServerError?: Pick<VivaServerError, "code" | "retryable">;
  mic?: RuntimeMicState;
  close?: VivaAgentCloseDiagnostics;
  pendingTypedAnswer?: boolean;
  recap?: VivaAgentRecapState;
  reconnect?: VivaAgentReconnectState;
  retainedAudioTurn?: VivaAgentRetainedAudioTurn | null;
  structuredErrors?: readonly VivaAgentStructuredError[];
  termination?: VivaVoiceTermination;
  terminalReason?: AgentTerminalSessionReason;
}): RuntimeCopy {
  const endpointReady = readinessProbe?.status === "observed" ? readinessProbe.ready : undefined;
  const readinessFacts = ready ?? endpointReady;
  const context: RuntimeProjectionContext = {
    boundedReadinessFailures,
    mic,
    close,
    completion,
    readiness,
    readinessProbe,
    ready: readinessFacts,
    recap,
    reconnectState: reconnect ?? { attempts: 0, kind: "idle" },
    retainedAudioTurn,
    status,
    termination,
    terminalReason,
    websocketReady: Boolean(ready) && status === "open",
  };

  // `WEBSESSION-TERMINAL-01`: a session that has SAID ITS LAST WORD outranks
  // every transport, terminal, and recovery fact.
  //
  // A completed session is one the page has seen persisted (`recapPersisted`)
  // AND holds a complete recap for — either half alone is not a completion. A
  // partial recap carries its own terminal reason plus a usable artifact, so it
  // too outranks the bare terminal copy, which would hide that artifact.
  if (completion?.recapPersisted === true && recap?.kind === "complete") {
    return runtimeCopyFromOutcome(completedSessionOutcome(), context);
  }
  if (recap?.kind === "partial") {
    return runtimeCopyFromOutcome(partialRecapOutcome(recap.partialReason), context);
  }

  if (terminalReason) {
    return controlledTerminalCopy(terminalReason, context);
  }

  // Recap copy always outranks recovery copy: a session that has already said
  // its last word is never described as "Reconnecting…".
  if (recap) {
    const recapOutcome = projectVoiceOutcomeCopy({ recap });
    if (recapOutcome) return runtimeCopyFromOutcome(recapOutcome, context);
  }

  // `WEBSESSION-READY-01` Step 3: a readiness run that has passed its bound is
  // stated, not smoothed over. Recovery copy would otherwise answer three
  // straight unobservable polls with "Reopening the session." — a reassuring
  // sentence about a socket that has nothing to reopen — so while the bound
  // holds and no readiness facts exist, the readiness-unavailable copy below is
  // what the learner reads. Nothing above this line yields: a recap, a terminal
  // phase, and a completed session are all still the session's last word.
  //
  // `!readinessFacts` is also what guarantees the ladder keeps the sanitized
  // unavailable NOTE: no readiness facts means no live ready frame, so
  // `probeContradictsLiveReady` cannot suppress the offline probe's own note.
  const boundedReadinessUnavailable = boundedReadinessFailures !== null && !readinessFacts;
  if (!boundedReadinessUnavailable) {
    const recovery = projectRecoveryCopy({ pendingTypedAnswer, reconnect, retainedAudioTurn });
    if (recovery) return runtimeCopyFromOutcome(recovery, context);
  }

  // The ONE typed outcome switch. Auth, protocol, service, and transport copy is
  // derived from Plan 05's codes — never from a regex over diagnostic text, and
  // never from a close-reason string (there is no longer one to read).
  const outcome = projectVoiceOutcomeCopy({
    deferredTurn,
    diagnostics,
    lastServerError,
    recap,
    structuredErrors,
    termination,
  });
  if (outcome && outcome.scope === "session" && outcome.cause !== "turn_deferred") {
    return runtimeCopyFromOutcome(outcome, context);
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
          : "The `/ws` stream closed before provider readiness reached the manuscript.",
        statusLabel: connecting ? "connecting" : "agent offline",
        cause: "agent_offline",
      },
      context,
      retryAgentAction(),
    );
  }

  if (status === "closed" && close && !context.websocketReady && isUnexpectedClose(close)) {
    return runtimeCopy(
      {
        capsuleLabel: "Session interrupted",
        marginaliaTitle: "Session interrupted before the manuscript closed.",
        marginaliaText: `The WebSocket closed with code ${close.code} before the Conductor sent a terminal phase. Retry the agent or share the close code with a developer.`,
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

/**
 * `WEBSESSION-PROTOCOL-01` / `WEBSESSION-RECAP-01` / `WEBSESSION-DEFERRED-01`:
 * the ONE total switch from Plan 05's typed voice outcome onto safe learner copy.
 *
 * Every branch derives its words from a CODE — a `VivaVoiceTermination.kind`, a
 * diagnostic code, a typed server-error code, a recap discriminant, or a
 * deferral's own boolean. Nothing here reads a message, a close-reason string, a
 * socket status, or a provider name, so no peer-authored text can steer copy.
 *
 * `scope` separates a SESSION capsule (which replaces the live runtime capsule)
 * from a TURN affordance (which sits beside it): a deferred turn is not a
 * session outcome, and `turn_deferred` is deliberately a local literal rather
 * than a fabricated `RuntimeCopyCause`.
 */
export type VoiceOutcomeCopy = Readonly<{
  scope: "session" | "turn";
  capsuleLabel: string;
  marginaliaTitle: string;
  marginaliaText: string;
  statusLabel: string;
  cause: RuntimeCopyCause | "turn_deferred";
  action: Readonly<{
    disabled: boolean;
    intent: RuntimePrimaryActionIntent;
    nextActionLabel: string;
    primaryActionLabel?: string;
  }>;
  retryQuestionId?: string;
}>;

function runtimeCopyFromOutcome(
  outcome: VoiceOutcomeCopy,
  context: RuntimeProjectionContext,
): RuntimeCopy {
  return runtimeCopy(
    {
      capsuleLabel: outcome.capsuleLabel,
      cause: outcome.cause as RuntimeCopyCause,
      marginaliaText: outcome.marginaliaText,
      marginaliaTitle: outcome.marginaliaTitle,
      statusLabel: outcome.statusLabel,
    },
    context,
    outcome.action,
  );
}

/**
 * `WEBSESSION-RECOVERY-01` Step 6. Recovery copy is truthful about WHERE the
 * learner's spoken answer is: while a turn is retained it says so, and it never
 * claims the server received a turn the browser has not seen acknowledged.
 */
export function projectRecoveryCopy(input: {
  pendingTypedAnswer?: boolean;
  reconnect?: VivaAgentReconnectState;
  retainedAudioTurn?: VivaAgentRetainedAudioTurn | null;
}): VoiceOutcomeCopy | null {
  const reconnect = input.reconnect;
  if (!reconnect || reconnect.kind === "idle") return null;
  const retained = input.retainedAudioTurn
    ? " Your spoken answer is retained on this device for retry."
    : "";

  if (reconnect.kind === "exhausted") {
    return {
      // Typed content is NEVER auto-resent after an ambiguous close: the answer
      // stays visible and the learner reconnects and retries it deliberately.
      action: {
        disabled: false,
        intent: "retry_agent",
        nextActionLabel: input.pendingTypedAnswer ? "Reconnect and retry answer" : "Reconnect",
      },
      capsuleLabel: "Connection lost",
      cause: "unexpected_close",
      marginaliaText: `Viva could not reopen this session after three attempts.${retained}`,
      marginaliaTitle: "The connection to the Conductor was lost.",
      scope: "session",
      statusLabel: "connection lost",
    };
  }

  // Scheduled, refreshing, and connecting are all one learner-visible state, and
  // the retry control is DISABLED throughout it so a second attempt cannot be
  // stacked on the one already running.
  return {
    action: { disabled: true, intent: "disabled", nextActionLabel: "Reconnecting…" },
    capsuleLabel: "Reconnecting…",
    cause: "session_disconnected",
    marginaliaText: `Viva is reopening this session; nothing was graded from the interrupted turn.${retained}`,
    marginaliaTitle: "Reopening the session.",
    scope: "session",
    statusLabel: "reconnecting",
  };
}

export function projectVoiceOutcomeCopy(input: {
  deferredTurn?: VivaAgentDeferredTurn;
  diagnostics?: readonly VivaAgentDiagnostic[];
  lastServerError?: Pick<VivaServerError, "code" | "retryable">;
  recap?: VivaAgentRecapState;
  structuredErrors?: readonly VivaAgentStructuredError[];
  termination?: VivaVoiceTermination;
}): VoiceOutcomeCopy | null {
  // 1. A recap is the session's own last word and outranks every transport fact.
  if (input.recap?.kind === "complete") return completedSessionOutcome();
  if (input.recap?.kind === "partial") return partialRecapOutcome(input.recap.partialReason);

  // 2. A terminal structured error states its reason; a recoverable one is
  //    deliberately NOT a session outcome and never replaces the live capsule.
  const terminalStructured = (input.structuredErrors ?? [])
    .filter((entry) => entry.terminality === "terminal")
    .at(-1);
  if (terminalStructured?.terminality === "terminal") {
    return terminalOutcome(terminalStructured.terminalReason);
  }

  if (input.termination) return terminationOutcome(input.termination);
  if (input.lastServerError) return serverErrorOutcome(input.lastServerError);

  // 3. A deferral is a turn affordance. Retryability comes from the server's
  //    boolean; the reason string is never read to decide it and never shown.
  if (input.deferredTurn) return deferredTurnOutcome(input.deferredTurn);

  const diagnostic = (input.diagnostics ?? []).at(-1);
  if (diagnostic) return rejectedFrameOutcome();
  return null;
}

function terminationOutcome(termination: VivaVoiceTermination): VoiceOutcomeCopy {
  switch (termination.kind) {
    case "terminal":
      return terminalOutcome(termination.terminalReason);
    case "auth":
      return authOutcome(termination.retryable);
    case "protocol":
    case "service":
      return rejectedFrameOutcome();
    case "normal":
      return cleanCloseOutcome();
    case "transport":
      return interruptedOutcome();
    default: {
      // Adding a `VivaVoiceTermination.kind` without adding copy for it is a
      // compile error, not a silent fall-through to generic wording.
      const exhaustive: never = termination;
      return exhaustive;
    }
  }
}

function serverErrorOutcome(error: Pick<VivaServerError, "code" | "retryable">): VoiceOutcomeCopy {
  if (error.code === "VOICE_AUTH_EXPIRED") return authOutcome(true);
  if (
    error.code === "VOICE_AUTH_INVALID" ||
    error.code === "VOICE_AUTH_IDENTITY_MISMATCH" ||
    error.code === "VOICE_AUTH_REPLAYED"
  ) {
    return authOutcome(false);
  }
  return rejectedFrameOutcome();
}

function completedSessionOutcome(): VoiceOutcomeCopy {
  const state = VIVA_LEARNER_LOOP_CONTRACT.states.find(
    (candidate) => candidate.id === "session_completed",
  );
  if (!state) {
    return {
      action: {
        disabled: false,
        intent: "start_session",
        nextActionLabel: "Start a new session",
      },
      capsuleLabel: "Session complete",
      cause: "recap_success",
      marginaliaText: "Viva saved the recap for this session.",
      marginaliaTitle: "Session recap ready.",
      scope: "session",
      statusLabel: "session complete",
    };
  }
  return {
    action: {
      disabled: state.copy.primary_action_intent === "disabled",
      intent: state.copy.primary_action_intent,
      nextActionLabel: state.copy.next_action_label,
      primaryActionLabel: state.copy.primary_action_label,
    },
    capsuleLabel: state.copy.capsule_label,
    cause: state.runtime_copy_causes[0] ?? "recap_success",
    marginaliaText: state.copy.marginalia_text,
    marginaliaTitle: state.copy.marginalia_title,
    scope: "session",
    statusLabel: state.copy.status_label,
  };
}

/**
 * A partial recap ends the session for the reason the server named AND leaves a
 * usable artifact behind. The terminal reason's approved contract copy is used
 * verbatim; the one added sentence is this lane's own fixed text, never anything
 * the server wrote.
 */
function partialRecapOutcome(reason: AgentTerminalSessionReason): VoiceOutcomeCopy {
  const terminal = terminalOutcome(reason);
  return {
    ...terminal,
    marginaliaText: `${terminal.marginaliaText} The session ended with a usable partial recap you can still review.`,
  };
}

function terminalOutcome(reason: AgentTerminalSessionReason): VoiceOutcomeCopy {
  const state = VIVA_LEARNER_LOOP_CONTRACT.states.find(
    (candidate) => candidate.terminal_reason === reason,
  );
  if (!state) {
    return {
      action: { disabled: false, intent: "retry_agent", nextActionLabel: "Retry agent" },
      capsuleLabel: "Session closed",
      cause: reason as RuntimeCopyCause,
      marginaliaText: "The Conductor emitted a terminal phase for this manuscript.",
      marginaliaTitle: "The session closed.",
      scope: "session",
      statusLabel: reason.replaceAll("_", " "),
    };
  }
  return {
    action: {
      disabled: state.copy.primary_action_intent === "disabled",
      intent: state.copy.primary_action_intent,
      nextActionLabel: state.copy.next_action_label,
      primaryActionLabel: state.copy.primary_action_label,
    },
    capsuleLabel: state.copy.capsule_label,
    cause: state.runtime_copy_causes[0] ?? (reason as RuntimeCopyCause),
    marginaliaText: state.copy.marginalia_text,
    marginaliaTitle: state.copy.marginalia_title,
    scope: "session",
    statusLabel: state.copy.status_label,
  };
}

/**
 * Only `VOICE_AUTH_EXPIRED` is renewable, so only it offers the renewal action.
 * Invalid, identity-mismatched, and replayed credentials are not refreshable and
 * must never present a button that pretends they are.
 */
function authOutcome(renewable: boolean): VoiceOutcomeCopy {
  return {
    action: renewable
      ? { disabled: false, intent: "refresh_session", nextActionLabel: "Refresh session" }
      : { disabled: false, intent: "retry_agent", nextActionLabel: "Retry agent" },
    capsuleLabel: "Auth failed",
    cause: "auth_failed",
    marginaliaText: renewable
      ? "The signed session auth failed for this identity; renew it before the manuscript opens another question."
      : "The signed session auth failed for this identity and cannot be renewed; start the session again.",
    marginaliaTitle: "Agent unavailable: auth failed.",
    scope: "session",
    statusLabel: "Auth failed",
  };
}

function rejectedFrameOutcome(): VoiceOutcomeCopy {
  return {
    action: { disabled: false, intent: "retry_agent", nextActionLabel: "Retry agent" },
    capsuleLabel: "Agent unavailable",
    cause: "agent_offline",
    marginaliaText:
      "The Conductor and the manuscript disagreed about a frame on this session, so the manuscript stopped rather than render an unverified turn.",
    marginaliaTitle: "Agent unavailable: session rejected.",
    scope: "session",
    statusLabel: "session rejected",
  };
}

function cleanCloseOutcome(): VoiceOutcomeCopy {
  return {
    action: { disabled: false, intent: "retry_agent", nextActionLabel: "Retry agent" },
    capsuleLabel: "Session closed",
    cause: "session_disconnected",
    marginaliaText:
      "The Conductor closed this session cleanly without a recap; reconnect to open a new one.",
    marginaliaTitle: "The session closed.",
    scope: "session",
    statusLabel: "session closed",
  };
}

function interruptedOutcome(): VoiceOutcomeCopy {
  return {
    action: { disabled: false, intent: "retry_agent", nextActionLabel: "Retry agent" },
    capsuleLabel: "Session interrupted",
    cause: "unexpected_close",
    marginaliaText:
      "The connection dropped before the Conductor sent a terminal phase. Retry the agent; nothing was graded from the interrupted turn.",
    marginaliaTitle: "Session interrupted before the manuscript closed.",
    scope: "session",
    statusLabel: "unexpected close",
  };
}

function deferredTurnOutcome(deferred: VivaAgentDeferredTurn): VoiceOutcomeCopy {
  return {
    action: deferred.canRetrySameQuestion
      ? { disabled: false, intent: "submit_turn", nextActionLabel: "Retry this question" }
      : { disabled: true, intent: "disabled", nextActionLabel: "Wait for the next question" },
    capsuleLabel: "Turn not graded",
    cause: "turn_deferred",
    marginaliaText: deferred.canRetrySameQuestion
      ? "Viva could not grade that turn, so nothing was recorded against this concept. Answer the same question again when you are ready."
      : "Viva could not grade that turn, so nothing was recorded against this concept. The Conductor will move on.",
    marginaliaTitle: "That turn was not graded.",
    retryQuestionId: deferred.canRetrySameQuestion ? deferred.questionId : undefined,
    scope: "turn",
    statusLabel: "turn not graded",
  };
}

function controlledTerminalCopy(
  reason: AgentTerminalSessionReason,
  context: RuntimeProjectionContext,
): RuntimeCopy {
  const contractState = VIVA_LEARNER_LOOP_CONTRACT.states.find(
    (state) => state.terminal_reason === reason,
  );
  if (!contractState) {
    return runtimeCopy(
      {
        capsuleLabel: "Session closed",
        marginaliaTitle: "The session closed.",
        marginaliaText: "The Conductor emitted a terminal phase for this manuscript.",
        statusLabel: reason.replaceAll("_", " "),
        cause: reason as RuntimeCopyCause,
      },
      context,
      retryAgentAction(),
    );
  }
  const { copy } = contractState;
  const intent = copy.primary_action_intent;
  return runtimeCopy(
    {
      capsuleLabel: copy.capsule_label,
      marginaliaTitle: copy.marginalia_title,
      marginaliaText: copy.marginalia_text,
      statusLabel: copy.status_label,
      cause: contractState.runtime_copy_causes[0] ?? (reason as RuntimeCopyCause),
    },
    context,
    {
      disabled: intent === "disabled",
      intent,
      nextActionLabel: copy.next_action_label,
      primaryActionLabel: copy.primary_action_label,
    },
  );
}

function runtimeCopy(
  copy: Omit<
    RuntimeCopy,
    | "nextActionLabel"
    | "primaryActionDisabled"
    | "primaryActionIntent"
    | "primaryActionLabel"
    | "readinessBoundedFailures"
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
    // The bound describes the READINESS RUN, not the branch that won the copy,
    // so it travels with every projection rather than only the offline one.
    readinessBoundedFailures: context.boundedReadinessFailures,
    readinessNotes: runtimeReadinessNotes(context, copy.cause),
  };
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

  if (context.retainedAudioTurn) {
    // The turn id is a correlation handle, not learner material, and it is
    // deliberately NOT rendered: the note states only that bytes are held here.
    notes.push({
      label: "Retained answer",
      state: "blocked",
      text: "One spoken answer is held on this device until the Conductor accepts it.",
    });
  }

  if (context.close) {
    // Code and cleanliness only. The peer's close-reason string is not part of
    // `VivaAgentCloseDiagnostics` any more, so there is nothing here to leak.
    notes.push({
      label: "Close",
      state: context.close.wasClean ? "blocked" : "unavailable",
      text: `code ${context.close.code}; ${context.close.wasClean ? "clean" : "unclean"}.`,
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

export function conceptStatusVerdict(status: ConceptStatus): string {
  // Interim A-08 bridge: the client-side FSRS interval fabrication was removed
  // with D-01A (packages/core no longer exports it). The authoritative in-session
  // review verdict arrives with Plan 10's node-10 rewrite of this projection.
  return statusLabel(status);
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
      // A graceful end is a clean close (the student or the server closed the
      // socket deliberately — code 1000 / wasClean, or a delivered terminal
      // reason; a finished drill is handled earlier as a recap). A close that is
      // neither — most often the examiner was never reachable (unclean 1006) —
      // is an interruption, not a finished session; don't dress an infra failure
      // up as completed study.
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
  const terminalWithoutRecap = terminalReasonWithoutRecap(derived);
  if (terminalWithoutRecap) {
    return {
      ...EMPTY_QUESTION,
      prompt: "This session has ended.",
      status: "",
      pending: false,
      terminal: true,
    };
  }

  const agentQuestion = derived.question;
  if (!agentQuestion) {
    // Connecting / idle / open-without-a-question is a warming-up placeholder;
    // error and closed are terminal copy, not a pending question.
    const terminal = status === "error" || status === "closed";
    const pending = !terminal;
    // Graceful only on a clean close: a deliberate 1000/wasClean teardown or a
    // server-delivered terminal reason. An `error` status or an unclean close
    // (1006, never reached) is an interruption. The production brain ends a
    // user-initiated stop with a clean close and no terminal reason, so the
    // close cleanliness — not the terminal reason alone — is the real signal.
    const gracefullyEnded =
      status === "closed" && (Boolean(derived.terminalReason) || derived.close?.wasClean === true);
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
    status: evaluation ? conceptStatusVerdict(evaluation.conceptStatus) : "",
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
  return status ? conceptStatusVerdict(status) : "Awaiting concept status";
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
  const terminalWithoutRecap = terminalReasonWithoutRecap(derived);
  const hasAgentQuestion = Boolean(derived.question) && !terminalWithoutRecap;
  const state =
    derived.recap || terminalWithoutRecap
      ? "recap"
      : projectSessionState(derived.phase, hasAgentQuestion);
  return {
    state,
    question: projectSessionQuestion(derived, status, now),
    highlightedTokens: terminalWithoutRecap ? [] : projectHighlightedTokens(state, derived),
    hasAgentQuestion,
  };
}

function terminalReasonWithoutRecap(derived: VivaAgentDerivedState): boolean {
  return Boolean(derived.terminalReason) && !derived.recap;
}

export function projectTurnTakingState(input: {
  hasPendingAudio?: boolean;
  interruptAcknowledged?: boolean;
  playbackSpeaking?: boolean;
  question: Question;
  runtime?: RuntimeCopy;
  state: SessionState;
  textAnswerFallbackActive?: boolean;
}): VoiceTurnTakingState {
  const captions = turnCaptions(input.question);
  const speaking = Boolean(input.hasPendingAudio || input.playbackSpeaking);
  const base = turnBaseState({
    pending: Boolean(input.question.pending),
    recovery: Boolean(input.question.terminal) || runtimeNeedsRecovery(input.runtime),
    runtime: input.runtime,
    speaking,
    state: input.state,
  });
  const interruptAcknowledged = base.phase === "listening" && Boolean(input.interruptAcknowledged);
  const nudge = turnNudge({
    interruptAcknowledged,
    textAnswerFallbackActive: base.phase === "listening" && input.textAnswerFallbackActive,
  });
  const ariaStatus = compactSentences([
    base.label,
    base.headline,
    base.detail,
    nudge ? `${nudge.label}: ${nudge.text}` : undefined,
    captions.length > 0
      ? `Captions available: ${captions.map((caption) => caption.label).join(", ")}`
      : undefined,
  ]);

  return {
    ...base,
    ariaStatus,
    captions,
    interruptAcknowledged,
    nudge,
  };
}

function turnBaseState(input: {
  pending: boolean;
  recovery: boolean;
  runtime?: RuntimeCopy;
  speaking: boolean;
  state: SessionState;
}): Pick<VoiceTurnTakingState, "detail" | "headline" | "label" | "phase"> {
  if (input.recovery) {
    return {
      detail: input.runtime?.nextActionLabel ?? "Recover the session before answering again.",
      headline: input.runtime?.marginaliaTitle ?? "The voice turn is paused.",
      label: input.runtime?.capsuleLabel ?? "Recovery",
      phase: "recovery",
    };
  }

  if (input.pending) {
    return {
      detail: "Waiting for the examiner to open the first turn.",
      headline: "Preparing the question.",
      label: "Preparing",
      phase: "preparing",
    };
  }

  if (input.speaking) {
    return {
      detail: "Feedback audio is playing while the captions stay visible.",
      headline: "Viva is speaking.",
      label: "Speaking",
      phase: "speaking",
    };
  }

  switch (input.state) {
    case "thinking":
      return {
        detail: "Your answer is saved while Viva checks the bounded source.",
        headline: "Checking your answer.",
        label: "Checking",
        phase: "thinking",
      };
    case "correction":
      return {
        detail: "Feedback is ready in the captions and margin.",
        headline: "Review the feedback.",
        label: "Feedback",
        phase: "feedback",
      };
    case "source":
      return {
        detail: "The cited source is open for the next answer.",
        headline: "Use the source reference.",
        label: "Source",
        phase: "source",
      };
    case "recap":
      return {
        detail: "The session recap and review plan are ready.",
        headline: "Session recap ready.",
        label: "Recap",
        phase: "recap",
      };
    case "listening":
      return {
        detail: "Speak now; if nothing is captured, Viva will offer the text answer path.",
        headline: "Listening for your answer.",
        label: "Your turn",
        phase: "listening",
      };
  }
}

function runtimeNeedsRecovery(runtime?: RuntimeCopy): boolean {
  if (!runtime) return false;
  if (runtime.primaryActionDisabled) return true;
  if (
    runtime.primaryActionIntent === "retry_agent" ||
    runtime.primaryActionIntent === "refresh_session"
  ) {
    return true;
  }
  return false;
}

function turnCaptions(question: Question): VoiceTurnCaption[] {
  if (question.pending || question.terminal) return [];
  const captions: VoiceTurnCaption[] = [
    {
      kind: "question",
      label: "Question",
      text: question.prompt,
    },
  ];
  if (question.correctionBody.trim()) {
    captions.push({
      kind: "feedback",
      label: "Feedback",
      text: question.correctionBody,
    });
  }
  if (question.retryPrompt?.trim()) {
    captions.push({
      kind: "reprompt",
      label: "Try again",
      text: question.retryPrompt,
    });
  }
  return captions;
}

function turnNudge(input: {
  interruptAcknowledged: boolean;
  textAnswerFallbackActive?: boolean;
}): VoiceTurnNudge | undefined {
  if (input.interruptAcknowledged) {
    return {
      label: "Interruption acknowledged",
      text: "Viva stopped speaking and is listening again.",
    };
  }
  if (input.textAnswerFallbackActive) {
    return {
      label: "No speech captured",
      text: "Write the answer here or try speaking again.",
    };
  }
  return undefined;
}

function compactSentences(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.replace(/\s+/g, " ").trim())
    .join(" ");
}
