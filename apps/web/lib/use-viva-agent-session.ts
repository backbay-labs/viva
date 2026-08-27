"use client";

import type {
  AgentAnswerEvaluation,
  AgentEvaluationLabel,
  AgentSessionConfig,
  AgentStudyQuestion,
  AgentStudySessionRecap,
  AgentStudySourceReference,
  AgentTerminalSessionReason,
  AnswerEvaluation,
  AuthenticatedStudyProjectionV1,
  ConceptStatus,
  CorrectionKind,
  EvaluationLabel,
  ManuscriptIntent,
  SessionQuestion,
  SessionRecap,
  SourceReference,
  VivaClientTurnIntent,
  VivaVoiceTermination,
} from "@viva/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createVivaAgentSessionController,
  initialVivaAgentSessionState,
  type VivaAgentAudioOutput,
  type VivaAgentClientOptions,
  type VivaAgentCloseDiagnostics,
  type VivaAgentConceptStatusEvent,
  type VivaAgentDeferredTurn,
  type VivaAgentDiagnostic,
  type VivaAgentGenerationReason,
  type VivaAgentRecapState,
  type VivaAgentRetainedAudioTurn,
  type VivaAgentSessionController,
  type VivaAgentSessionState,
  type VivaAgentStructuredError,
  type VivaAudioChunkInput,
  type VivaAudioSendResult,
} from "./viva-agent-client";

export type VivaAgentAudioCommands = {
  sendAudioChunk: (input: VivaAudioChunkInput) => VivaAudioSendResult;
  endAudioTurn: (input: Readonly<{ turnId: string; finalSequence: number }>) => VivaAudioSendResult;
  cancelAudioTurn: (turnId: string) => void;
  retryPendingAudio: () => VivaAudioSendResult;
  getRetainedAudioTurn: () => VivaAgentRetainedAudioTurn | null;
};

/* --------------------------------------------------------------------- *
 * D-07 Branch A (`retain-token-only`) browser credential vault.
 *
 * `agent/fixtures/voice-protocol/v5/auth-decision.json` records
 * `branch:"retain-token-only"`, so this module owns exactly one authoritative
 * credential pair in MODULE MEMORY: never the URL, never history state, never
 * `sessionStorage`/`localStorage`, never a cookie, never the DOM, never a log
 * line, never a serialized error. A page reload legitimately loses it — that is
 * the point of an in-memory vault, and a reload without one falls back to a
 * nonrenewable direct entry rather than to a persisted secret.
 * -------------------------------------------------------------------- */

/** The one bound on the session-entry renewal fetch, headers *and* body. */
export const VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS = 6_000;

export type ResolvedBrowserSessionIdentity = Readonly<{
  userId: string;
  studySetId: string;
  sessionId: string;
}>;

export type BrowserSessionCredential =
  | Readonly<{
      mode: "retain-token-only";
      identity: ResolvedBrowserSessionIdentity;
      accessToken: string;
      refreshToken: string | null;
      refreshExpiresAt: number | null;
      sessionAbsoluteExpiresAt: number | null;
      revision: number;
    }>
  | Readonly<{
      mode: "require-service-auth";
      identity: ResolvedBrowserSessionIdentity;
      accessToken: string;
      revision: number;
    }>;

export type RenewBrowserSessionCredentialResult =
  | { status: "renewed"; credential: BrowserSessionCredential }
  | {
      status: "retained";
      credential: BrowserSessionCredential;
      reason: "not_renewable" | "timeout" | "unavailable";
    }
  | { status: "terminal"; reason: "auth_terminal" | "invalid_response" };

/**
 * `POST /api/viva-session/refresh`'s D-07 Branch A success body.
 *
 * PLAN DEVIATION (recorded, not silently adopted): Plan 10 Task 2 types the two
 * instants `number`. The merged Plan 11 route (`VivaSessionRouteOutcome` in
 * `apps/web/app/api/viva-session/shared.ts`) serializes them as canonical
 * second-precision RFC3339 UTC strings, and A-25 pins the node-10 client
 * obligation to "parse `refresh_expires_at`/`session_absolute_expires_at` as
 * RFC3339". The wire type therefore reads `string`; the parsed epoch
 * milliseconds are what `BrowserSessionCredential` carries, so the plan's
 * `number` credential fields are unchanged.
 */
export type VivaSessionCredentialRotationResponse = Readonly<{
  failure_class: null;
  refresh_expires_at: string;
  refresh_token: string;
  session: { session_id: string; study_set_id: string; user_id: string };
  session_absolute_expires_at: string;
  session_token: string;
  token_refresh_outcome: "issued" | "refreshed";
}>;

export type RenewBrowserSessionCredential = (input: {
  credential: BrowserSessionCredential;
  reason: "session_entry" | "auth_expired" | "transport_reconnect" | "browser_restore";
  signal: AbortSignal;
}) => Promise<RenewBrowserSessionCredentialResult>;

/**
 * The vault input shape Plan 13's already-merged same-origin start path composes
 * around (`BrowserSessionCredentialVault` in `apps/web/lib/viva-library.ts`,
 * which this lane may not edit). Restating the member names here rather than
 * importing the type keeps this module free of a landing-surface dependency
 * while still being assignable to that seam — proven by the vault test.
 */
export type BrowserSessionCredentialVaultInput = Readonly<{
  mode: "retain-token-only";
  refresh_expires_at: string | null;
  refresh_token: string | null;
  session_absolute_expires_at: string | null;
  session_id: string;
  session_token: string;
  study_set_id: string;
  user_id: string;
}>;

let vaultCredential: BrowserSessionCredential | null = null;
let vaultRevision = 0;

/** The current authoritative credential, or `null` when the vault is empty. */
export function readBrowserSessionCredential(): BrowserSessionCredential | null {
  return vaultCredential;
}

/**
 * Atomically replaces the whole credential — access token, rotating refresh
 * credential, and both expiries move together or not at all, so no caller can
 * ever observe one half of a rotated pair.
 *
 * Accepts either an already-shaped `BrowserSessionCredential` or the
 * `FRONTEND-011` start-response shape Plan 13's landing surface hands the vault
 * seam, so `browserSessionCredentialVault` below satisfies that seam directly.
 * `null` clears the vault.
 */
export function replaceBrowserSessionCredential(
  next: BrowserSessionCredential | BrowserSessionCredentialVaultInput | null,
): void {
  if (next === null) {
    vaultCredential = null;
    return;
  }
  vaultRevision += 1;
  vaultCredential =
    "identity" in next
      ? { ...next, revision: vaultRevision }
      : {
          accessToken: next.session_token,
          identity: {
            sessionId: next.session_id,
            studySetId: next.study_set_id,
            userId: next.user_id,
          },
          mode: "retain-token-only",
          refreshExpiresAt: epochMsFromRfc3339(next.refresh_expires_at),
          refreshToken: next.refresh_token,
          revision: vaultRevision,
          sessionAbsoluteExpiresAt: epochMsFromRfc3339(next.session_absolute_expires_at),
        };
}

/**
 * The real `FRONTEND-011` vault Plan 13's `startServerSession` seam takes, in
 * place of `pendingBrowserSessionCredentialVault`'s inert stand-in. Every
 * successful same-origin start hands the COMPLETE start response through this,
 * strictly before client navigation.
 */
export const browserSessionCredentialVault: Readonly<{
  replaceBrowserSessionCredential: (input: BrowserSessionCredentialVaultInput) => void;
}> = { replaceBrowserSessionCredential };

/** Clears the vault. Used by terminal auth and by mounted-test isolation. */
export function clearBrowserSessionCredential(): void {
  vaultCredential = null;
}

/** Canonical second-precision RFC3339 UTC, exactly what Plan 11's route emits. */
const RFC3339_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function epochMsFromRfc3339(value: string | null): number | null {
  if (value === null || !RFC3339_UTC_SECONDS.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredRfc3339(value: unknown): number | null {
  if (typeof value !== "string" || !RFC3339_UTC_SECONDS.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const ROTATION_RESPONSE_KEYS = [
  "failure_class",
  "refresh_expires_at",
  "refresh_token",
  "session",
  "session_absolute_expires_at",
  "session_token",
  "token_refresh_outcome",
] as const;

const ROTATION_SESSION_KEYS = ["session_id", "study_set_id", "user_id"] as const;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const present = Object.keys(record);
  if (present.length !== keys.length) return null;
  return present.every((key) => keys.includes(key)) ? record : null;
}

/**
 * Reconstructs the rotation response field by field, or returns `null`.
 *
 * A missing, extra, wrong-typed, non-RFC3339, or identity-mismatched field
 * rejects the WHOLE response: retaining one half of a rotated credential pair is
 * exactly the stale-credential defect this task exists to close.
 */
export function browserSessionCredentialFromRotation(
  body: unknown,
  identity: ResolvedBrowserSessionIdentity,
): BrowserSessionCredential | null {
  const record = exactKeys(body, ROTATION_RESPONSE_KEYS);
  if (!record || record.failure_class !== null) return null;
  if (record.token_refresh_outcome !== "issued" && record.token_refresh_outcome !== "refreshed") {
    return null;
  }
  const accessToken = nonEmptyString(record.session_token);
  const refreshToken = nonEmptyString(record.refresh_token);
  const refreshExpiresAt = requiredRfc3339(record.refresh_expires_at);
  const sessionAbsoluteExpiresAt = requiredRfc3339(record.session_absolute_expires_at);
  if (!accessToken || !refreshToken || refreshExpiresAt === null) return null;
  if (sessionAbsoluteExpiresAt === null) return null;

  const session = exactKeys(record.session, ROTATION_SESSION_KEYS);
  if (!session) return null;
  if (
    session.session_id !== identity.sessionId ||
    session.study_set_id !== identity.studySetId ||
    session.user_id !== identity.userId
  ) {
    return null;
  }

  return {
    accessToken,
    identity,
    mode: "retain-token-only",
    refreshExpiresAt,
    refreshToken,
    revision: 0,
    sessionAbsoluteExpiresAt,
  };
}

/**
 * One bounded D-07 Branch A rotation.
 *
 * The POST body is exactly `{refresh_token, session_id, study_set_id, user_id}`
 * (A-25's node-10 client obligation and the merged route's own
 * `exactRefreshRequestFields` allowlist). The access token is never renewal
 * authority and never appears in the body; neither credential ever reaches the
 * URL, history, or storage.
 *
 * The deadline covers headers *and* body: one child `AbortController` is armed
 * for `timeoutMs`, an outer `signal` is forwarded into it, and both the timer
 * and the outer listener are released in `finally` so an unmount before the
 * deadline leaves nothing pending.
 */
export async function refreshBrowserSessionToken(
  credential: Extract<BrowserSessionCredential, { mode: "retain-token-only" }>,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RenewBrowserSessionCredentialResult> {
  const refreshToken = credential.refreshToken;
  if (!refreshToken) return { credential, reason: "not_renewable", status: "retained" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) forwardAbort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetchImpl("/api/viva-session/refresh", {
      body: JSON.stringify({
        refresh_token: refreshToken,
        session_id: credential.identity.sessionId,
        study_set_id: credential.identity.studySetId,
        user_id: credential.identity.userId,
      }),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    if (timedOut) return { credential, reason: "timeout", status: "retained" };
    if (response.status === 401 || response.status === 403) {
      clearBrowserSessionCredential();
      return { reason: "auth_terminal", status: "terminal" };
    }
    if (!response.ok) return { credential, reason: "unavailable", status: "retained" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      clearBrowserSessionCredential();
      return { reason: "invalid_response", status: "terminal" };
    }
    if (timedOut) return { credential, reason: "timeout", status: "retained" };

    const rotated = browserSessionCredentialFromRotation(body, credential.identity);
    if (!rotated) {
      // A partial or malformed rotation is never half-applied: the vault is
      // cleared rather than left holding a consumed refresh credential beside a
      // token the server may already have rotated away.
      clearBrowserSessionCredential();
      return { reason: "invalid_response", status: "terminal" };
    }
    replaceBrowserSessionCredential(rotated);
    const committed = readBrowserSessionCredential();
    return { credential: committed ?? rotated, status: "renewed" };
  } catch {
    // No fetch text, JSON message, or exception string ever reaches UI state.
    return timedOut
      ? { credential, reason: "timeout", status: "retained" }
      : { credential, reason: "unavailable", status: "retained" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * The page's default renewal seam. A credential with no rotating refresh
 * credential — a legacy URL-token direct entry, or the unselected D-07 Branch B
 * shape — is `not_renewable` rather than being renewed through some other
 * authority.
 */
export const renewBrowserSessionCredential: RenewBrowserSessionCredential = async (input) => {
  const credential = input.credential;
  if (credential.mode !== "retain-token-only" || !credential.refreshToken) {
    return { credential, reason: "not_renewable", status: "retained" };
  }
  return refreshBrowserSessionToken(credential, { signal: input.signal });
};

const VIVA_AGENT_DISCONNECTED_SEND_ERROR = {
  code: "socket_closed",
  message: "Viva agent session is not connected",
} as const;

function disconnectedAudioSendResult(retainedFromSequence: number): VivaAudioSendResult {
  return {
    acceptedThroughSequence: null,
    error: VIVA_AGENT_DISCONNECTED_SEND_ERROR,
    retainedFromSequence,
    retryable: true,
    status: "socket_closed",
  };
}

/**
 * The hook's audio surface, extracted as a pure factory over the controller seam
 * so it is provable without mounting a component (`bun:test` has no DOM at this
 * base). Each method delegates and returns the controller's discriminated
 * `VivaAudioSendResult` unchanged; with no mounted controller the caller gets a
 * retryable `socket_closed` rather than a silently dropped chunk.
 *
 * Fail-closed rejections are the one case a result cannot carry: the locked
 * `VivaAudioSendResult` union has no variant for `audio_turn_limit` or
 * `audio_queue_limit`, so the controller raises `VivaAudioSendRejectedError` for
 * those and this surface deliberately lets it propagate rather than inventing a
 * status. Callers that can hit them — a second concurrent `turnId`, an oversized
 * chunk, a sequence gap, or a turn over 2,160,000 raw bytes — must catch it
 * (`isVivaAudioSendRejectedError`), exactly as `createLiveAudioTurnDriver` does
 * through its `onSendRejected` hook.
 */
export function createVivaAgentAudioCommands(
  getController: () => VivaAgentSessionController | null,
): VivaAgentAudioCommands {
  return {
    cancelAudioTurn: (turnId) => getController()?.cancelAudioTurn(turnId),
    endAudioTurn: (input) => getController()?.endAudioTurn(input) ?? disconnectedAudioSendResult(0),
    getRetainedAudioTurn: () => getController()?.getRetainedAudioTurn() ?? null,
    retryPendingAudio: () => getController()?.retryPendingAudio() ?? disconnectedAudioSendResult(0),
    sendAudioChunk: (input) =>
      getController()?.sendAudioChunk(input) ?? disconnectedAudioSendResult(0),
  };
}

export type VivaAgentDerivedState = {
  phase: VivaAgentSessionState["phase"];
  generationId?: string;
  terminalReason?: AgentTerminalSessionReason;
  close?: VivaAgentCloseDiagnostics;
  question?: SessionQuestion;
  transcript: string;
  finalTranscript?: string;
  transcriptConfidence?: number;
  evaluation?: AnswerEvaluation;
  currentSource?: SourceReference;
  currentConceptStatus?: ConceptStatus;
  conceptStatuses: Record<string, ConceptStatus>;
  sources: SourceReference[];
  manuscriptIntents: ManuscriptIntent[];
  recap?: SessionRecap;
  /**
   * `WEBSESSION-PROTOCOL-01`: the typed protocol surface, forwarded unchanged.
   * There is deliberately no `errors: string[]` here — a free-form array is
   * exactly the member arbitrary provider payload used to travel through.
   */
  recapState?: VivaAgentRecapState;
  deferredTurn?: VivaAgentDeferredTurn;
  diagnostics: VivaAgentDiagnostic[];
  structuredErrors: VivaAgentStructuredError[];
  lastServerError?: VivaAgentSessionState["lastServerError"];
  termination?: VivaVoiceTermination;
  canSubmitAnswer: boolean;
};

/**
 * `WEBSESSION-DATA-01`: the hook is handed the ALREADY-signed session config the
 * authenticated projection produced. It takes no `StudySet`, no `mode`, and no
 * route ids, because none of those may be reassembled in the browser into
 * something the server did not state.
 */
export type UseVivaAgentSessionOptions = VivaAgentClientOptions & {
  controllerFactory?: typeof createVivaAgentSessionController;
  /**
   * `null` until the authenticated projection has produced one. No controller
   * exists before then: a controller built from a placeholder config could open
   * a socket describing a study set the server never authorized.
   */
  session: AgentSessionConfig | null;
  sessionToken?: string | null;
};

export function useVivaAgentSession(options: UseVivaAgentSessionOptions) {
  const session = options.session;
  const controllerRef = useRef<VivaAgentSessionController | null>(null);
  // The factory lives in a ref, not in the connect effect's dependency list: a
  // StrictMode double-mount would otherwise re-run the effect for a factory
  // identity change and leave two live controllers racing one socket.
  const controllerFactoryRef = useRef(
    options.controllerFactory ?? createVivaAgentSessionController,
  );
  controllerFactoryRef.current = options.controllerFactory ?? createVivaAgentSessionController;
  const [agentState, setAgentState] = useState<VivaAgentSessionState>(initialVivaAgentSessionState);

  useEffect(() => {
    controllerRef.current?.close();
    controllerRef.current = null;
    if (!session) {
      setAgentState(initialVivaAgentSessionState());
      return;
    }
    const controller = controllerFactoryRef.current({
      WebSocketImpl: options.WebSocketImpl,
      session,
      sessionToken: options.sessionToken,
      token: options.token,
      url: options.url,
    });
    controllerRef.current = controller;
    setAgentState(controller.getState());
    const unsubscribe = controller.subscribe(setAgentState);
    return () => {
      unsubscribe();
      controller.close();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [options.WebSocketImpl, options.sessionToken, options.token, options.url, session]);

  const derived = useMemo(() => deriveVivaAgentUiState(agentState), [agentState]);
  const audio = useMemo(() => createVivaAgentAudioCommands(() => controllerRef.current), []);

  return {
    acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) =>
      controllerRef.current?.acknowledgeAudio(consumed),
    agentState,
    cancel: () => controllerRef.current?.cancel(),
    close: () => controllerRef.current?.close(),
    connect: (reason?: VivaAgentGenerationReason) => controllerRef.current?.connect(reason),
    derived,
    refreshSession: (input?: {
      reason?: VivaAgentGenerationReason;
      sessionToken?: string | null;
    }) => controllerRef.current?.refreshSession(input),
    reset: () => controllerRef.current?.reset(),
    cancelAudioTurn: audio.cancelAudioTurn,
    endAudioTurn: audio.endAudioTurn,
    getRetainedAudioTurn: audio.getRetainedAudioTurn,
    retryPendingAudio: audio.retryPendingAudio,
    sendAudioChunk: audio.sendAudioChunk,
    sendText: (text: string) => controllerRef.current?.sendText(text) ?? false,
    sendTurnIntent: (input: Readonly<{ turnId: string; intent: VivaClientTurnIntent }>) =>
      controllerRef.current?.sendTurnIntent(input) ?? {
        error: { code: "socket_closed", message: "Viva agent session is not connected" },
        retryable: true,
        status: "socket_closed",
        turnId: input.turnId,
      },
    status: agentState.status,
    stop: () => controllerRef.current?.stop(),
  };
}

/**
 * The authenticated projection, mapped straight into the signed session config.
 *
 * Every member comes from the server projection; only `user_id` is supplied by
 * the caller, from the verified route identity the projection was fetched for.
 * `initial_goal` is deliberately absent: the merged v5 `AgentSessionConfig`
 * carries no such member (A-25's node-10 client obligation), so the session's
 * goal is display state, never wire authority.
 */
export function studyProjectionToAgentSessionConfig(
  projection: AuthenticatedStudyProjectionV1,
  userId: string,
): AgentSessionConfig {
  return {
    active_concepts: projection.concepts.map(({ id }) => id),
    mode: projection.session.mode,
    session_id: projection.session.id,
    source_context: [],
    study_set_id: projection.studySet.id,
    user_id: userId,
  };
}

export function deriveVivaAgentUiState(state: VivaAgentSessionState): VivaAgentDerivedState {
  const question = state.question ? agentQuestionToSessionQuestion(state.question) : undefined;
  return {
    // A recap or a terminal reason closes submission for good: after either, the
    // wire turn an answer would belong to no longer exists.
    canSubmitAnswer:
      state.status === "open" &&
      !state.pendingSubmission &&
      !state.recap &&
      state.terminalReason === undefined,
    close: state.close,
    deferredTurn: state.deferredTurn,
    diagnostics: state.diagnostics,
    evaluation: state.evaluation
      ? agentAnswerEvaluationToUiEvaluation(state.evaluation)
      : undefined,
    currentSource: state.currentSource ? agentSourceToUiSource(state.currentSource) : undefined,
    currentConceptStatus: state.currentConceptStatus,
    conceptStatuses: state.conceptStatuses,
    finalTranscript: state.finalTranscript,
    generationId: state.generation?.id,
    lastServerError: state.lastServerError,
    transcriptConfidence: state.transcriptConfidence,
    manuscriptIntents: state.manuscriptIntents.map((event) => event.intent),
    phase: state.question && state.phase === "ready" ? "listening" : state.phase,
    question,
    recap: state.recap
      ? agentRecapToSessionRecap(state.recap.recap, state.sources, state.conceptStatusEvents)
      : undefined,
    recapState: state.recap,
    sources: state.sources.map(agentSourceToUiSource),
    structuredErrors: state.structuredErrors,
    termination: state.termination,
    terminalReason: state.terminalReason,
    transcript: state.finalTranscript ?? state.transcript,
  };
}

export function agentQuestionToSessionQuestion(question: AgentStudyQuestion): SessionQuestion {
  return {
    expectedTerms: question.expected_terms,
    followUp: question.follow_up,
    id: question.question_id,
    prompt: question.prompt,
    source: agentSourceToUiSource(question.source),
  };
}

export function agentAnswerEvaluationToUiEvaluation(
  evaluation: AgentAnswerEvaluation,
): AnswerEvaluation {
  const label = toEvaluationLabel(evaluation.label);
  return {
    conciseFeedback: evaluation.concise_feedback,
    confidenceScore: evaluation.confidence_score,
    conceptStatus: evaluation.concept_status,
    correctionKind: correctionKindForLabel(label),
    label,
    retryPrompt: evaluation.retry_prompt,
    source: agentSourceToUiSource(evaluation.source),
  };
}

/**
 * Maps the merged v2 recap (`viva.study_session_recap.v2`) into the shared UI
 * recap shape, without inventing anything the server did not send.
 *
 * Two deliberate absences:
 * - `plan` is empty. v1's three-row "Now / Tomorrow / Next" timeline was
 *   fabricated in the browser from status buckets; the v2 recap publishes a real
 *   `review_schedule` instead, which the margin renders from the projection.
 * - a source moment is DROPPED rather than labelled with a guessed status. A v2
 *   moment names a `response_id` and a `source_id` only, so its status is the
 *   status the same response was actually graded at; when the session's own
 *   event trail does not name exactly one, there is no honest label to render.
 */
export function agentRecapToSessionRecap(
  recap: AgentStudySessionRecap,
  sources: readonly AgentStudySourceReference[] = [],
  conceptStatusEvents: readonly VivaAgentConceptStatusEvent[] = [],
): SessionRecap {
  const sourceById = new Map(sources.map((source) => [source.source_id, source]));
  const labelsWithStatus = (status: ConceptStatus) =>
    recap.concepts.filter((concept) => concept.status === status).map((concept) => concept.label);

  return {
    durationLabel: "Agent session",
    headline: recap.headline,
    missedConcepts: labelsWithStatus("missed"),
    nextAction: recap.next_action,
    plan: [],
    reviewLater: labelsWithStatus("review"),
    shakyConcepts: labelsWithStatus("shaky"),
    sourceMoments: recap.source_moments.flatMap((moment) => {
      const source = sourceById.get(moment.source_id);
      const graded = conceptStatusEvents.filter((event) => event.responseId === moment.response_id);
      const status = graded.length === 1 ? graded[0]?.status : undefined;
      if (!source || !status) return [];
      return [{ source: agentSourceToUiSource(source), status, text: source.excerpt }];
    }),
    strongConcepts: labelsWithStatus("strong"),
    summary: recap.summary,
  };
}

export function agentSourceToUiSource(source: AgentStudySourceReference): SourceReference {
  return {
    confidence: source.confidence,
    documentId: source.document_id,
    excerpt: source.excerpt,
    label: formatAgentSourceLabel(source),
    retrievalReason: source.retrieval_reason,
    sourceId: source.source_id,
    span: source.span,
  };
}

function formatAgentSourceLabel(source: AgentStudySourceReference): string {
  const document = source.document_id.replace(/^lec-(\d+)$/i, "Lecture $1").replace(/-/g, " ");
  const span = source.span
    .replace(/^slide:(\d+)$/i, "Slide $1")
    .replace(/:/g, " ")
    .replace(/-/g, " ");
  return `${titleCase(document)} · ${titleCase(span)}`;
}

function toEvaluationLabel(label: AgentEvaluationLabel): EvaluationLabel {
  return label;
}

function correctionKindForLabel(label: EvaluationLabel): CorrectionKind {
  if (label === "strong") return "correct but incomplete";
  if (label === "mostly correct") return "correct but incomplete";
  if (label === "partially correct" || label === "vague") return "correct but imprecise";
  if (label === "insufficient evidence") return "course-specific discrepancy";
  return "wrong";
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
