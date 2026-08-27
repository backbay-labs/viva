import {
  type AgentAnswerEvaluation,
  type AgentAudioFrame,
  type AgentAudioTurnAcceptedFrame,
  type AgentBrainReadiness,
  type AgentConceptStatus,
  type AgentSessionConfig,
  type AgentStoreReadiness,
  type AgentStudyQuestion,
  type AgentStudySessionPhase,
  type AgentStudySessionRecap,
  type AgentStudySourceReference,
  type AgentTerminalSessionReason,
  type AuthenticatedStudyProjectionV1,
  audioChunkClientFrame,
  audioEndClientFrame,
  type ManuscriptIntent,
  type PasteIngestionResponse,
  parseVivaServerFrame,
  type StudySet,
  sessionConfigFrame,
  studySetFromPasteIngestionResponse,
  VIVA_AUDIO_MAX_CHUNK_BYTES,
  VIVA_AUDIO_MAX_TURN_BYTES,
  VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
  VIVA_VOICE_PROTOCOL_VERSION,
  type VivaCancelClientFrame,
  type VivaClientFrame,
  type VivaReadyFrame,
  type VivaServerEvent,
  type VivaServerFrame,
  type VivaStopClientFrame,
  validateAuthenticatedStudyProjectionV1,
} from "@viva/core";
import { pcm16LeBytesToBase64 } from "./viva-audio-capture";
import type { VivaLibraryExport, VivaLibrarySnapshot } from "./viva-library";
import { isRedactedVivaLogValue, redactForVivaLog } from "./viva-redaction";

/**
 * Retention high-water mark for the browser send queue. Once the socket has this
 * many bytes buffered, further chunks stay in the bounded turn ledger instead of
 * being serialized; it deliberately equals the unchanged 64 KiB text-frame cap.
 */
export const VIVA_AUDIO_SEND_BUFFER_HIGH_WATER_BYTES = VIVA_VOICE_MAX_TEXT_FRAME_BYTES;

export type VivaAgentClientOptions = {
  url?: string;
  token?: string;
  WebSocketImpl?: typeof WebSocket;
};

export type VivaPasteStudySetInput = {
  userId: string;
  title: string;
  course: string | null;
  examDate?: string;
  pastedText: string;
  sessionId?: string;
};

export type VivaPasteStudySetOptions = {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type VivaLibrarySnapshotOptions = {
  apiBaseUrl?: string;
  bearerToken?: string;
  cache?: RequestCache;
  controlToken?: string;
  fetchImpl?: typeof fetch;
  userId?: string;
};

export type VivaAgentStoreReadinessEndpoint = AgentStoreReadiness & {
  writes?: {
    sessions: number;
    answer_attempts: number;
    concept_statuses: number;
    review_items: number;
    recaps: number;
  };
};

export type VivaAgentReadyEndpoint = {
  ready: boolean;
  brain: AgentBrainReadiness;
  store: VivaAgentStoreReadinessEndpoint;
};

export type VivaAgentBrainHealthEndpoint = {
  provider: string;
  brain: AgentBrainReadiness;
  store: VivaAgentStoreReadinessEndpoint;
  status: string;
  usage?: {
    events?: number;
  };
};

export type VivaAgentReadinessProbe =
  | { status: "api_missing" }
  | { status: "checking"; apiBaseUrl: string }
  | { status: "offline"; apiBaseUrl: string; error: string }
  | {
      status: "observed";
      apiBaseUrl: string;
      healthHttpStatus: number;
      health: VivaAgentBrainHealthEndpoint;
      readyHttpStatus: number;
      ready: VivaAgentReadyEndpoint;
    };

export type VivaAgentConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export type VivaAgentCloseDiagnostics = {
  code: number;
  reason: string;
  wasClean: boolean;
};

export type VivaAgentGenerationReason =
  | "session_bootstrap"
  | "socket_retry"
  | "token_refresh"
  | "bfcache_restore"
  | "back_forward_restore";

export type VivaAgentGeneration = {
  id: string;
  reason: VivaAgentGenerationReason;
  sequence: number;
};

export type VivaAgentPendingSubmission = {
  generationId: string;
  kind: "audio" | "text";
};

export type VivaAgentAudioOutput = {
  responseId: string;
  frame: AgentAudioFrame;
};

export type VivaClientSendError = Readonly<{
  code: "socket_closed" | "audio_turn_limit" | "audio_queue_limit";
  message: string;
}>;

export type VivaAudioSendResult =
  | Readonly<{
      status: "sent";
      acceptedThroughSequence: number;
    }>
  | Readonly<{
      status: "pending";
      acceptedThroughSequence: number | null;
      retainedFromSequence: number;
    }>
  | Readonly<{
      status: "socket_closed";
      acceptedThroughSequence: number | null;
      retainedFromSequence: number;
      retryable: true;
      error: VivaClientSendError;
    }>;

export type VivaAudioChunkInput = Readonly<{
  turnId: string;
  sequence: number;
  pcm16Bytes: Uint8Array;
}>;

export type VivaAudioTurnAcceptance = Readonly<{
  turnId: string;
  finalSequence: number;
}>;

/**
 * `VivaAudioSendResult` describes transport outcomes only — `sent`, `pending`, or
 * a retryable `socket_closed`. A violated turn invariant is not a transport
 * outcome: a second turn id, a malformed or oversized chunk, a noncontiguous
 * sequence, or a turn past 2,160,000 retained bytes must fail closed *before*
 * anything is copied into the ledger or serialized, so it is raised rather than
 * returned. The exact `VivaClientSendError.code` the plan names is carried on
 * `error`, and the message never contains PCM, base64, or transcript material.
 */
export class VivaAudioSendRejectedError extends Error {
  readonly error: VivaClientSendError;

  constructor(error: VivaClientSendError) {
    super(`${error.code}: ${error.message}`);
    this.name = "VivaAudioSendRejectedError";
    this.error = error;
  }
}

export function isVivaAudioSendRejectedError(value: unknown): value is VivaAudioSendRejectedError {
  return value instanceof VivaAudioSendRejectedError;
}

export type VivaAgentManuscriptIntent = {
  responseId: string;
  intent: ManuscriptIntent;
};

export type VivaAgentConceptStatusEvent = {
  responseId: string;
  conceptId: string;
  status: AgentConceptStatus;
};

export type VivaAgentSessionState = {
  status: VivaAgentConnectionStatus;
  close?: VivaAgentCloseDiagnostics;
  generation?: VivaAgentGeneration;
  pendingSubmission?: VivaAgentPendingSubmission;
  /**
   * Set only when the server acknowledged the exact in-flight audio turn of the
   * active generation. It releases the browser ledger; it is NOT a provider
   * success signal, so `pendingSubmission` survives it.
   */
  acceptedAudioTurn?: VivaAudioTurnAcceptance;
  ready?: VivaReadyFrame;
  phase: AgentStudySessionPhase;
  terminalReason?: AgentTerminalSessionReason;
  activeResponseId?: string;
  question?: AgentStudyQuestion;
  transcript: string;
  finalTranscript?: string;
  transcriptConfidence?: number;
  evaluation?: AgentAnswerEvaluation;
  currentSource?: AgentStudySourceReference;
  sources: AgentStudySourceReference[];
  currentConceptStatus?: AgentConceptStatus;
  conceptStatuses: Record<string, AgentConceptStatus>;
  /**
   * Every graded concept status in arrival order, keyed by the response that
   * produced it. The v2 recap's `source_moments` name only a `response_id` and a
   * `source_id`, so this is the server's OWN link between a cited source and the
   * status the same turn was graded at — without it, a recap source moment could
   * only be labelled by guessing.
   */
  conceptStatusEvents: VivaAgentConceptStatusEvent[];
  manuscriptIntents: VivaAgentManuscriptIntent[];
  recap?: AgentStudySessionRecap;
  audio: VivaAgentAudioOutput[];
  cancelledResponseIds: string[];
  errors: string[];
  staleEvents: number;
};

export type VivaAgentSessionControllerOptions = VivaAgentClientOptions & {
  generationIdFactory?: (input: { reason: VivaAgentGenerationReason; sequence: number }) => string;
  session: AgentSessionConfig;
  sessionToken?: string | null;
  initialState?: VivaAgentSessionState;
  /**
   * Delay for the cancellable background queue pump that drains retained audio
   * once `bufferedAmount` falls. `retryPendingAudio()` stays the deterministic
   * path for tests and for Plan 10's reconnect work.
   */
  audioQueuePumpIntervalMs?: number;
};

export type VivaAgentSessionController = {
  connect: (reason?: VivaAgentGenerationReason) => WebSocket;
  close: () => void;
  refreshSession: (input?: {
    reason?: VivaAgentGenerationReason;
    session?: AgentSessionConfig;
    sessionToken?: string | null;
  }) => WebSocket;
  reset: () => void;
  sendText: (text: string) => boolean;
  sendAudioChunk: (input: VivaAudioChunkInput) => VivaAudioSendResult;
  endAudioTurn: (input: Readonly<{ turnId: string; finalSequence: number }>) => VivaAudioSendResult;
  cancelAudioTurn: (turnId: string) => void;
  retryPendingAudio: () => VivaAudioSendResult;
  acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) => void;
  cancel: () => void;
  stop: () => void;
  getState: () => VivaAgentSessionState;
  subscribe: (listener: (state: VivaAgentSessionState) => void) => () => void;
};

const bundledVivaAgentWsUrl = process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL;
const bundledVivaAgentHttpUrl = process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL;
const bundledVivaApiUrl = process.env.NEXT_PUBLIC_VIVA_API_URL;
const bundledVivaStaticExport = process.env.VIVA_STATIC_EXPORT;
const bundledNextPublicVivaStaticExport = process.env.NEXT_PUBLIC_VIVA_STATIC_EXPORT;
const defaultVivaAgentWsUrl = "ws://127.0.0.1:4318/ws";

export function vivaAgentWsUrl(env?: Record<string, string | undefined>): string {
  const explicitEnv = env !== undefined;
  const resolvedEnv = env ?? envRecord();
  return (
    resolvedEnv.NEXT_PUBLIC_VIVA_AGENT_WS_URL ??
    (explicitEnv ? undefined : bundledVivaAgentWsUrl) ??
    defaultVivaAgentWsUrl
  );
}

export function vivaApiBaseUrl(env?: Record<string, string | undefined>): string | undefined {
  const explicitEnv = env !== undefined;
  const resolvedEnv = env ?? envRecord();
  const explicit =
    resolvedEnv.NEXT_PUBLIC_VIVA_API_URL ?? (explicitEnv ? undefined : bundledVivaApiUrl);
  if (explicit?.trim()) return trimTrailingSlash(explicit.trim());

  const wsUrl =
    resolvedEnv.NEXT_PUBLIC_VIVA_AGENT_WS_URL ?? (explicitEnv ? undefined : bundledVivaAgentWsUrl);
  if (!wsUrl?.trim()) return undefined;
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/ws\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return undefined;
  }
}

export function vivaAgentHttpBaseUrl(env?: Record<string, string | undefined>): string | undefined {
  const explicitEnv = env !== undefined;
  const resolvedEnv = env ?? envRecord();
  const explicitAgentHttp =
    resolvedEnv.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL ??
    (explicitEnv ? undefined : bundledVivaAgentHttpUrl);
  if (explicitAgentHttp?.trim()) return trimTrailingSlash(explicitAgentHttp.trim());

  try {
    const url = new URL(vivaAgentWsUrl(env));
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/ws\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return undefined;
  }
}

export async function fetchVivaAgentReadinessProbe({
  apiBaseUrl = vivaAgentHttpBaseUrl(),
  fetchImpl = fetch,
}: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<VivaAgentReadinessProbe> {
  if (!apiBaseUrl) return { status: "api_missing" };
  const base = trimTrailingSlash(apiBaseUrl);
  try {
    const [healthResponse, readyResponse] = await Promise.all([
      fetchImpl(`${base}/health/brain`),
      fetchImpl(`${base}/ready`),
    ]);
    const [health, ready] = await Promise.all([
      healthResponse.json() as Promise<VivaAgentBrainHealthEndpoint>,
      readyResponse.json() as Promise<VivaAgentReadyEndpoint>,
    ]);
    if (!isVivaAgentBrainHealthEndpoint(health)) {
      throw new Error("invalid /health/brain readiness payload");
    }
    if (!isVivaAgentReadyEndpoint(ready)) {
      throw new Error("invalid /ready readiness payload");
    }
    return {
      apiBaseUrl: base,
      health,
      healthHttpStatus: healthResponse.status,
      ready,
      readyHttpStatus: readyResponse.status,
      status: "observed",
    };
  } catch (error) {
    return {
      apiBaseUrl: base,
      error: error instanceof Error ? error.message : String(error),
      status: "offline",
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isAgentBrainReadiness(value: unknown): value is AgentBrainReadiness {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    isBoolean(value.configured) &&
    isBoolean(value.selectable) &&
    isBoolean(value.live_runtime)
  );
}

function isVivaAgentStoreReadinessEndpoint(
  value: unknown,
): value is VivaAgentStoreReadinessEndpoint {
  return (
    isRecord(value) &&
    typeof value.backend === "string" &&
    isBoolean(value.available) &&
    isBoolean(value.durable) &&
    isBoolean(value.nonce_replay_protection) &&
    isBoolean(value.raw_audio_persistence) &&
    isBoolean(value.transcript_persistence) &&
    isBoolean(value.uuid_schema_translation)
  );
}

function isVivaAgentReadyEndpoint(value: unknown): value is VivaAgentReadyEndpoint {
  return (
    isRecord(value) &&
    isBoolean(value.ready) &&
    isAgentBrainReadiness(value.brain) &&
    isVivaAgentStoreReadinessEndpoint(value.store)
  );
}

function isVivaAgentBrainHealthEndpoint(value: unknown): value is VivaAgentBrainHealthEndpoint {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.status === "string" &&
    isAgentBrainReadiness(value.brain) &&
    isVivaAgentStoreReadinessEndpoint(value.store)
  );
}

export function vivaAgentProtocols(token?: string): string[] {
  if (!token) return ["viva-voice"];
  return ["viva-voice", `bearer.${base64Url(token)}`];
}

export function connectVivaAgent(options: VivaAgentClientOptions = {}): WebSocket {
  const WebSocketCtor = options.WebSocketImpl ?? WebSocket;
  return new WebSocketCtor(options.url ?? vivaAgentWsUrl(), vivaAgentProtocols(options.token));
}

export async function pasteStudySetToVivaApi(
  input: VivaPasteStudySetInput,
  options: VivaPasteStudySetOptions = {},
): Promise<StudySet> {
  const apiBaseUrl = options.apiBaseUrl ?? vivaApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("Viva API URL is unavailable");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${trimTrailingSlash(apiBaseUrl)}/study-sets/paste`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: input.userId,
      title: input.title,
      course: input.course,
      ...(input.examDate ? { exam_date: input.examDate } : {}),
      pasted_text: input.pastedText,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Viva paste ingestion failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as PasteIngestionResponse;
  return studySetFromPasteIngestionResponse(body, { examDate: input.examDate });
}

export async function fetchVivaLibrarySnapshot(
  options: VivaLibrarySnapshotOptions = {},
): Promise<VivaLibrarySnapshot> {
  const apiBaseUrl = vivaLibraryApiBaseUrl(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(`${trimTrailingSlash(apiBaseUrl)}/study-sets/library`);
  if (options.userId?.trim()) {
    url.searchParams.set("user_id", options.userId.trim());
  }
  const response = await fetchImpl(url.toString(), {
    cache: options.cache,
    headers: vivaLibraryAuthHeaders(options),
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Viva library snapshot failed with HTTP ${response.status}`);
  }
  return (await response.json()) as VivaLibrarySnapshot;
}

export async function exportVivaLibraryData(
  options: VivaLibrarySnapshotOptions = {},
): Promise<VivaLibraryExport> {
  const apiBaseUrl = vivaLibraryApiBaseUrl(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(`${trimTrailingSlash(apiBaseUrl)}/study-sets/export`);
  if (options.userId?.trim()) {
    url.searchParams.set("user_id", options.userId.trim());
  }
  const response = await fetchImpl(url.toString(), {
    headers: vivaLibraryAuthHeaders(options),
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Viva library export failed with HTTP ${response.status}`);
  }
  return (await response.json()) as VivaLibraryExport;
}

export async function deleteVivaStudySet(
  studySetId: string,
  options: VivaLibrarySnapshotOptions = {},
): Promise<unknown> {
  const apiBaseUrl = vivaLibraryApiBaseUrl(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(
    `${trimTrailingSlash(apiBaseUrl)}/study-sets/${encodeURIComponent(studySetId)}`,
  );
  if (options.userId?.trim()) {
    url.searchParams.set("user_id", options.userId.trim());
  }
  const response = await fetchImpl(url.toString(), {
    headers: vivaLibraryAuthHeaders(options),
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Viva study set delete failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function deleteVivaSessionHistory(
  studySetId: string,
  voiceSessionId: string,
  options: VivaLibrarySnapshotOptions = {},
): Promise<unknown> {
  const apiBaseUrl = vivaLibraryApiBaseUrl(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(
    `${trimTrailingSlash(apiBaseUrl)}/study-sets/${encodeURIComponent(
      studySetId,
    )}/sessions/${encodeURIComponent(voiceSessionId)}`,
  );
  if (options.userId?.trim()) {
    url.searchParams.set("user_id", options.userId.trim());
  }
  const response = await fetchImpl(url.toString(), {
    headers: vivaLibraryAuthHeaders(options),
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Viva session history delete failed with HTTP ${response.status}`);
  }
  return response.json();
}

/* --------------------------------------------------------------------- *
 * `WEBSESSION-DATA-01` — the authenticated study projection client.
 *
 * This is the ONLY study/session read model the live session renders. There is
 * no library-metadata fallback and no seed overlay: a missing, invalid,
 * mismatched, or unavailable projection is a sanitized pre-loop failure.
 * -------------------------------------------------------------------- */

export type AuthenticatedStudyProjectionRequest = Readonly<{
  studySetId: string;
  voiceSessionId: string;
  accessToken: string;
  signal: AbortSignal;
}>;

export type AuthenticatedStudyProjectionFailureCause =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "invalid_projection"
  | "unavailable";

export type AuthenticatedStudyProjectionResult =
  | { status: "ready"; projection: AuthenticatedStudyProjectionV1 }
  | {
      status: "failed";
      cause: AuthenticatedStudyProjectionFailureCause;
      retryAfterSeconds?: number;
    };

/** The browser's own per-attempt deadline, matching Plan 11's BFF deadline. */
export const VIVA_STUDY_PROJECTION_TIMEOUT_MS = 8_000;

type ProjectionAttemptOutcome = {
  result: AuthenticatedStudyProjectionResult;
  retryable: boolean;
};

/**
 * Fetches and validates the authenticated study projection.
 *
 * The request carries the signed access token in `authorization` and NOTHING in
 * the URL: a credential in a query string is a credential in every proxy log and
 * `Referer` header. `Sec-Fetch-Site` is deliberately NOT set — it is a forbidden
 * header name, so a script that tried would have it dropped; the browser's own
 * same-origin fetch metadata is what satisfies Plan 11's `same-origin` guard, and
 * that is exactly why this must stay a same-origin relative URL.
 *
 * Exactly one retry, and only after a 502 or a 504, each with its own fresh
 * 8,000 ms deadline. 400/401/404/429 are answers, not outages, and the 503 the
 * BFF emits when the shared `SessionSecurityStore` is unavailable is a stop —
 * retrying it would only spend more admission budget, and there is no agent
 * fallback to fall through to.
 */
export async function fetchAuthenticatedStudyProjection(
  input: AuthenticatedStudyProjectionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthenticatedStudyProjectionResult> {
  let attempt = await attemptAuthenticatedStudyProjection(input, fetchImpl);
  if (attempt.retryable && !input.signal.aborted) {
    attempt = await attemptAuthenticatedStudyProjection(input, fetchImpl);
  }
  return attempt.result;
}

async function attemptAuthenticatedStudyProjection(
  input: AuthenticatedStudyProjectionRequest,
  fetchImpl: typeof fetch,
): Promise<ProjectionAttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, VIVA_STUDY_PROJECTION_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  if (input.signal.aborted) forwardAbort();
  input.signal.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetchImpl(
      `/api/viva-session/projection?${new URLSearchParams({
        study_set_id: input.studySetId,
        voice_session_id: input.voiceSessionId,
      })}`,
      {
        cache: "no-store",
        headers: { authorization: `Bearer ${input.accessToken}` },
        method: "GET",
        signal: controller.signal,
      },
    );
    if (timedOut) return projectionFailure("timeout");
    if (response.status === 200) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return projectionFailure("invalid_projection");
      }
      try {
        return {
          result: { projection: validateAuthenticatedStudyProjectionV1(body), status: "ready" },
          retryable: false,
        };
      } catch {
        // The validator's message names fields and values from an untrusted
        // upstream body; only the coarse cause is allowed out of this function.
        return projectionFailure("invalid_projection");
      }
    }
    return projectionStatusFailure(response);
  } catch {
    return projectionFailure(timedOut ? "timeout" : "unavailable");
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", forwardAbort);
  }
}

function projectionFailure(
  cause: AuthenticatedStudyProjectionFailureCause,
  options: { retryable?: boolean; retryAfterSeconds?: number } = {},
): ProjectionAttemptOutcome {
  return {
    result:
      options.retryAfterSeconds === undefined
        ? { cause, status: "failed" }
        : { cause, retryAfterSeconds: options.retryAfterSeconds, status: "failed" },
    retryable: options.retryable === true,
  };
}

function projectionStatusFailure(response: Response): ProjectionAttemptOutcome {
  switch (response.status) {
    case 400:
      return projectionFailure("invalid_request");
    case 401:
    case 403:
      return projectionFailure("unauthorized");
    case 404:
      return projectionFailure("not_found");
    case 429:
      return projectionFailure("rate_limited", {
        retryAfterSeconds: projectionRetryAfterSeconds(response.headers.get("retry-after")),
      });
    case 502:
      return projectionFailure("unavailable", { retryable: true });
    case 504:
      return projectionFailure("timeout", { retryable: true });
    default:
      return projectionFailure("unavailable");
  }
}

/** Whole delta-seconds only; a date-form or non-numeric hint is no hint at all. */
function projectionRetryAfterSeconds(value: string | null): number | undefined {
  const raw = value?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function vivaLibraryApiBaseUrl(options: VivaLibrarySnapshotOptions): string {
  const apiBaseUrl =
    options.apiBaseUrl ??
    browserVivaLibraryProxyBaseUrl() ??
    vivaApiBaseUrl() ??
    configuredVivaAgentHttpBaseUrl() ??
    vivaAgentHttpBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("Viva API URL is unavailable");
  }
  return apiBaseUrl;
}

function configuredVivaAgentHttpBaseUrl(): string | undefined {
  const explicitAgentHttp = envRecord().NEXT_PUBLIC_VIVA_AGENT_HTTP_URL ?? bundledVivaAgentHttpUrl;
  return explicitAgentHttp?.trim() ? trimTrailingSlash(explicitAgentHttp.trim()) : undefined;
}

export function vivaStaticExportEnabled(env?: Record<string, string | undefined>): boolean {
  const explicitEnv = env !== undefined;
  const resolvedEnv = env ?? envRecord();
  const publicFlag =
    resolvedEnv.NEXT_PUBLIC_VIVA_STATIC_EXPORT ??
    (explicitEnv ? undefined : bundledNextPublicVivaStaticExport);
  const serverFlag =
    resolvedEnv.VIVA_STATIC_EXPORT ?? (explicitEnv ? undefined : bundledVivaStaticExport);
  return publicFlag === "1" || serverFlag === "1";
}

function browserVivaLibraryProxyBaseUrl(): string | undefined {
  if (vivaStaticExportEnabled() || typeof window === "undefined") return undefined;
  return `${window.location.origin}/api/viva-library`;
}

function vivaLibraryAuthHeaders(options: VivaLibrarySnapshotOptions): HeadersInit | undefined {
  const bearerToken = options.bearerToken?.trim();
  const controlToken = options.controlToken?.trim();
  const headers: Record<string, string> = {};
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  if (controlToken) headers["x-viva-library-control-token"] = controlToken;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function parseVivaAgentMessage(data: string): VivaServerFrame {
  return parseVivaServerFrame(JSON.parse(data));
}

export function agentProtocolVersion(): number {
  return VIVA_VOICE_PROTOCOL_VERSION;
}

export function initialVivaAgentSessionState(): VivaAgentSessionState {
  return {
    status: "idle",
    phase: "ready",
    transcript: "",
    sources: [],
    conceptStatuses: {},
    conceptStatusEvents: [],
    manuscriptIntents: [],
    audio: [],
    cancelledResponseIds: [],
    errors: [],
    staleEvents: 0,
  };
}

export function vivaAgentReducer(
  state: VivaAgentSessionState,
  frame: VivaServerFrame,
): VivaAgentSessionState {
  if (frame.type === "ready") {
    return { ...state, status: "open", ready: frame };
  }
  // Turn acceptance is ledger-aware: only the controller knows which turn and
  // final sequence are actually in flight, so it validates the frame and records
  // `acceptedAudioTurn` itself. The pure reducer stays a no-op rather than
  // trusting an unmatched acknowledgement.
  if (frame.type === "audio_turn_accepted") {
    return state;
  }
  if (frame.type === "error") {
    return {
      ...state,
      status: "error",
      pendingSubmission: undefined,
      errors: [...state.errors, sanitizeAgentError(frame.message)],
    };
  }

  const event = frame.event;
  const responseId = responseIdForEvent(event);
  if (responseId && state.cancelledResponseIds.includes(responseId)) {
    return { ...state, staleEvents: state.staleEvents + 1 };
  }
  if (
    responseId &&
    event.type !== "question_started" &&
    event.type !== "cancellation" &&
    (event.type !== "recap_ready" || state.pendingSubmission) &&
    state.activeResponseId &&
    state.activeResponseId !== responseId
  ) {
    return { ...state, staleEvents: state.staleEvents + 1 };
  }

  switch (event.type) {
    case "session_phase": {
      const pendingSubmission = pendingSubmissionForSessionPhase(
        event.phase,
        state.pendingSubmission,
      );
      if (state.recap && event.phase !== "recap") return state;
      if (event.terminal_reason && event.phase === "recap" && !state.recap) {
        return {
          ...state,
          phase: event.phase,
          pendingSubmission,
          terminalReason: event.terminal_reason,
        };
      }
      return {
        ...state,
        phase: event.phase,
        pendingSubmission,
        terminalReason: event.terminal_reason ?? state.terminalReason,
      };
    }
    case "question_started":
      return {
        ...state,
        activeResponseId: event.response_id,
        question: event.question,
        transcript: "",
        terminalReason: undefined,
        pendingSubmission: undefined,
        acceptedAudioTurn: undefined,
        finalTranscript: undefined,
        transcriptConfidence: undefined,
        evaluation: undefined,
        currentSource: undefined,
        sources: [],
        currentConceptStatus: undefined,
        manuscriptIntents: [],
        recap: undefined,
      };
    case "transcript_delta":
      return { ...state, transcript: state.transcript + event.text };
    case "transcript_final":
      return {
        ...state,
        transcript: event.text,
        finalTranscript: event.text,
        transcriptConfidence: event.confidence ?? undefined,
      };
    case "answer_evaluated":
      return { ...state, evaluation: event.evaluation, pendingSubmission: undefined };
    case "source_reference":
      return { ...state, currentSource: event.source, sources: [...state.sources, event.source] };
    case "concept_status":
      return {
        ...state,
        currentConceptStatus: event.status,
        conceptStatuses: { ...state.conceptStatuses, [event.concept_id]: event.status },
        conceptStatusEvents: [
          ...state.conceptStatusEvents,
          {
            conceptId: event.concept_id,
            responseId: event.response_id,
            status: event.status,
          },
        ],
      };
    case "manuscript_intent":
      return {
        ...state,
        manuscriptIntents: [
          ...state.manuscriptIntents,
          { responseId: event.response_id, intent: event.intent },
        ],
      };
    case "recap_ready":
      return { ...state, phase: "recap", pendingSubmission: undefined, recap: event.recap };
    case "audio_delta":
      return {
        ...state,
        audio: [...state.audio, { responseId: event.response_id, frame: event.frame }],
      };
    case "cancellation": {
      const cancelledResponseId = event.response_id ?? state.activeResponseId;
      const cancellingActive =
        Boolean(cancelledResponseId) && cancelledResponseId === state.activeResponseId;
      const cancelledResponseIds =
        cancelledResponseId && !state.cancelledResponseIds.includes(cancelledResponseId)
          ? [...state.cancelledResponseIds, cancelledResponseId]
          : state.cancelledResponseIds;
      return {
        ...state,
        activeResponseId: cancellingActive ? undefined : state.activeResponseId,
        phase: cancellingActive ? "listening" : state.phase,
        pendingSubmission: cancellingActive ? undefined : state.pendingSubmission,
        manuscriptIntents: cancelledResponseId
          ? state.manuscriptIntents.filter((intent) => intent.responseId !== cancelledResponseId)
          : state.manuscriptIntents,
        audio: cancelledResponseId
          ? state.audio.filter((output) => output.responseId !== cancelledResponseId)
          : state.audio,
        // Discard the cancelled turn's examiner-response artifacts so none bleed
        // into the manuscript: not just `currentSource`, but `evaluation` and
        // `currentConceptStatus` too — the source folio falls back through
        // `currentSource -> evaluation.source -> question.source`, so clearing only
        // the first layer would still surface the cancelled verdict's citation.
        // These are all active-turn-only (gated by the staleness guard) and are
        // exactly what `question_started` resets; `question` + the student's
        // transcript persist (the question is still the one being answered).
        currentSource: cancellingActive ? undefined : state.currentSource,
        sources: cancellingActive ? [] : state.sources,
        evaluation: cancellingActive ? undefined : state.evaluation,
        currentConceptStatus: cancellingActive ? undefined : state.currentConceptStatus,
        cancelledResponseIds,
      };
    }
    case "structured_error":
      return {
        ...state,
        status: "error",
        pendingSubmission: undefined,
        errors: [...state.errors, sanitizeAgentError(event.message)],
      };
    default:
      return state;
  }
}

function pendingSubmissionForSessionPhase(
  phase: AgentStudySessionPhase,
  pendingSubmission: VivaAgentPendingSubmission | undefined,
): VivaAgentPendingSubmission | undefined {
  return phase === "ready" || phase === "listening" || phase === "thinking"
    ? pendingSubmission
    : undefined;
}

function sanitizeAgentError(message: string): string {
  if (!message) return "agent error";
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (legacyAgentAuthReasons.has(normalized)) return "session auth failed";
  const redacted = redactForVivaLog({ message });
  if (isRecord(redacted) && isRedactedVivaLogValue(redacted.message)) {
    return "sanitized provider error";
  }
  return String(isRecord(redacted) ? redacted.message : message)
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function webSocketErrorMessage(token?: string | null): string {
  if (token) return "WebSocket session token preflight failed";
  return "WebSocket error";
}

export function createVivaAgentSessionController(
  options: VivaAgentSessionControllerOptions,
): VivaAgentSessionController {
  let socket: WebSocket | undefined;
  let activeGeneration = options.initialState?.generation;
  let generationSequence = options.initialState?.generation?.sequence ?? 0;
  let currentWebSocketToken = options.token ?? null;
  let currentSession = options.session;
  let currentSessionToken = options.sessionToken ?? null;
  let state = options.initialState ?? initialVivaAgentSessionState();
  const listeners = new Set<(next: VivaAgentSessionState) => void>();
  let audioLedger: AudioTurnLedger | null = null;
  let audioQueuePumpTimer: ReturnType<typeof setTimeout> | null = null;
  const audioQueuePumpIntervalMs = options.audioQueuePumpIntervalMs ?? 20;

  function setState(next: VivaAgentSessionState) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function cancelAudioQueuePump() {
    if (audioQueuePumpTimer === null) return;
    clearTimeout(audioQueuePumpTimer);
    audioQueuePumpTimer = null;
  }

  function scheduleAudioQueuePump() {
    if (audioQueuePumpTimer !== null) return;
    if (audioQueuePumpIntervalMs <= 0 || typeof setTimeout !== "function") return;
    const timer = setTimeout(() => {
      audioQueuePumpTimer = null;
      if (!audioLedger) return;
      try {
        pumpAudioQueue();
      } catch {
        // The ledger already failed closed; a background pump never widens it.
      }
    }, audioQueuePumpIntervalMs);
    audioQueuePumpTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Drains the retained turn in sequence order. `audio_end` can never overtake a
   * retained chunk because the loop only reaches it after every chunk has been
   * serialized. Already serialized chunks stay in the ledger until a matching
   * `audio_turn_accepted`, which is what closes the missing-ack window while
   * staying inside the 2,160,000-byte turn bound.
   */
  function pumpAudioQueue(): VivaAudioSendResult {
    const ledger = audioLedger;
    if (!ledger) {
      throw audioSendRejection("audio_turn_limit", "No active Viva audio input turn");
    }
    cancelAudioQueuePump();

    if (!ledger.generationId || activeGeneration?.id !== ledger.generationId) {
      return audioSocketClosedResult(ledger, "Viva voice generation was replaced");
    }
    const generationId = ledger.generationId;

    while (
      ledger.serializedChunkCount < ledger.chunks.length ||
      (ledger.endRequested && !ledger.endSerialized)
    ) {
      if (socket?.readyState !== 1) {
        return audioSocketClosedResult(ledger, "Viva voice WebSocket is not open");
      }
      if ((socket.bufferedAmount ?? 0) >= VIVA_AUDIO_SEND_BUFFER_HIGH_WATER_BYTES) {
        scheduleAudioQueuePump();
        return {
          acceptedThroughSequence: ledger.lastSerializedSequence,
          retainedFromSequence: retainedFromSequence(ledger),
          status: "pending",
        };
      }
      // Chunks always drain first: `audio_end` can only be serialized once every
      // retained chunk of this turn is on the wire, so it can never overtake one.
      const chunk =
        ledger.serializedChunkCount < ledger.chunks.length
          ? ledger.chunks[ledger.serializedChunkCount]
          : undefined;
      if (chunk) {
        socket.send(
          JSON.stringify(
            audioChunkClientFrame({
              clientGenerationId: generationId,
              pcm16Base64: pcm16LeBytesToBase64(chunk.bytes),
              sequence: chunk.sequence,
              turnId: ledger.turnId,
            }),
          ),
        );
        ledger.serializedChunkCount += 1;
        ledger.lastSerializedSequence = chunk.sequence;
        continue;
      }
      socket.send(
        JSON.stringify(
          audioEndClientFrame({
            clientGenerationId: generationId,
            finalSequence: ledger.finalSequence ?? 0,
            turnId: ledger.turnId,
          }),
        ),
      );
      ledger.endSerialized = true;
      if (!state.pendingSubmission) {
        setState({ ...state, pendingSubmission: { generationId, kind: "audio" } });
      }
    }

    return {
      acceptedThroughSequence: ledger.lastSerializedSequence ?? retainedFromSequence(ledger),
      status: "sent",
    };
  }

  function releaseAudioLedger() {
    cancelAudioQueuePump();
    audioLedger = null;
  }

  function applyAudioTurnAccepted(frame: AgentAudioTurnAcceptedFrame) {
    const ledger = audioLedger;
    const matchesInFlightTurn =
      ledger !== null &&
      ledger.generationId === frame.client_generation_id &&
      activeGeneration?.id === frame.client_generation_id &&
      ledger.turnId === frame.turn_id &&
      ledger.endSerialized &&
      ledger.finalSequence === frame.final_sequence;
    if (!matchesInFlightTurn) {
      setState({ ...state, staleEvents: state.staleEvents + 1 });
      return;
    }
    releaseAudioLedger();
    setState({
      ...state,
      acceptedAudioTurn: { finalSequence: frame.final_sequence, turnId: frame.turn_id },
    });
  }

  function createGeneration(reason: VivaAgentGenerationReason): VivaAgentGeneration {
    const sequence = generationSequence + 1;
    generationSequence = sequence;
    const id =
      options.generationIdFactory?.({ reason, sequence }) ??
      defaultVivaAgentGenerationId({ reason, sequence });
    return { id, reason, sequence };
  }

  function isActiveSocketGeneration(nextSocket: WebSocket, generation: VivaAgentGeneration) {
    return socket === nextSocket && activeGeneration?.id === generation.id;
  }

  function sendFrame(frame: VivaClientFrameDraft): boolean {
    const generationId = activeGeneration?.id;
    if (socket?.readyState !== 1 || !generationId) {
      setState({
        ...state,
        status: "error",
        pendingSubmission: undefined,
        errors: [...state.errors, "WebSocket is not open"],
      });
      return false;
    }
    socket.send(JSON.stringify(withClientGeneration(frame, generationId)));
    return true;
  }

  function sendSubmissionFrame(
    kind: VivaAgentPendingSubmission["kind"],
    frame: VivaClientFrameDraft,
  ): boolean {
    const generationId = activeGeneration?.id;
    if (!generationId || state.pendingSubmission) return false;
    if (sendFrame(frame)) {
      setState({ ...state, pendingSubmission: { generationId, kind } });
      return true;
    }
    return false;
  }

  function openSocket(reason: VivaAgentGenerationReason): WebSocket {
    const previousSocket = socket;
    const generation = createGeneration(reason);
    // A generation replacement never replays the retained turn in Plan 03: the
    // pump is stopped, but the bounded ledger stays available to Plan 10.
    cancelAudioQueuePump();
    activeGeneration = generation;
    previousSocket?.close();
    const nextSocket = connectVivaAgent({
      ...options,
      token: currentWebSocketToken ?? undefined,
    });
    socket = nextSocket;
    setState({ ...initialVivaAgentSessionState(), generation, status: "connecting" });
    setSocketHandler(nextSocket, "open", () => {
      if (!isActiveSocketGeneration(nextSocket, generation)) return;
      const signedCredential = currentSessionToken;
      if (!signedCredential) {
        // `VOICE-AUTH-001`: the signed credential is a REQUIRED member of the
        // canonical first frame. An unauthenticated generation is refused here
        // rather than serialized as `session_token: null` for the server to
        // reject — the browser already knows it has no authority.
        setState({
          ...state,
          errors: [...state.errors, "Viva voice session has no signed credential"],
          pendingSubmission: undefined,
          status: "error",
        });
        return;
      }
      sendFrame(sessionConfigFrame(currentSession, signedCredential, generation.id));
    });
    setSocketHandler(nextSocket, "message", (event) => {
      if (!isActiveSocketGeneration(nextSocket, generation)) return;
      if (typeof event.data !== "string") return;
      try {
        const frame = parseVivaAgentMessage(event.data);
        if (frame.type === "audio_turn_accepted") {
          applyAudioTurnAccepted(frame);
          return;
        }
        setState(vivaAgentReducer(state, frame));
      } catch (error) {
        setState({
          ...state,
          status: "error",
          pendingSubmission: undefined,
          errors: [...state.errors, error instanceof Error ? error.message : String(error)],
        });
      }
    });
    setSocketHandler(nextSocket, "close", (event) => {
      if (!isActiveSocketGeneration(nextSocket, generation)) return;
      setState({
        ...state,
        generation,
        pendingSubmission: undefined,
        status: "closed",
        close: closeDiagnosticsForEvent(event),
      });
    });
    setSocketHandler(nextSocket, "error", () => {
      if (!isActiveSocketGeneration(nextSocket, generation)) return;
      setState({
        ...state,
        pendingSubmission: undefined,
        status: "error",
        errors: [...state.errors, webSocketErrorMessage(currentSessionToken)],
      });
    });
    return nextSocket;
  }

  return {
    connect(reason = "session_bootstrap") {
      return openSocket(reason);
    },
    close() {
      const closingSocket = socket;
      socket = undefined;
      // A close stops the pump but never clears the retained turn.
      cancelAudioQueuePump();
      closingSocket?.close();
      setState({
        ...initialVivaAgentSessionState(),
        generation: activeGeneration,
        status: "closed",
      });
    },
    refreshSession(input = {}) {
      currentSession = input.session ?? currentSession;
      if ("sessionToken" in input) {
        currentSessionToken = input.sessionToken ?? null;
        currentWebSocketToken = input.sessionToken ?? null;
      }
      return openSocket(input.reason ?? "token_refresh");
    },
    reset() {
      setState(initialVivaAgentSessionState());
    },
    sendText(text: string) {
      return sendSubmissionFrame("text", {
        type: "text",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        text,
      });
    },
    sendAudioChunk(input: VivaAudioChunkInput) {
      const bytes = input.pcm16Bytes;
      if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
        throw audioSendRejection(
          "audio_queue_limit",
          "Audio chunk must contain a non-empty even PCM16 byte count",
        );
      }
      if (bytes.byteLength > VIVA_AUDIO_MAX_CHUNK_BYTES) {
        throw audioSendRejection("audio_queue_limit", "Audio chunk exceeds the maximum chunk size");
      }
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
        throw audioSendRejection(
          "audio_turn_limit",
          "Audio chunk sequence must be a non-negative safe integer",
        );
      }
      const turnId = requireAudioTurnId(input.turnId);
      let ledger = audioLedger;
      if (ledger && ledger.turnId !== turnId) {
        throw audioSendRejection(
          "audio_turn_limit",
          "Another Viva audio input turn is still active",
        );
      }
      if (ledger?.endRequested) {
        throw audioSendRejection("audio_turn_limit", "The Viva audio input turn already ended");
      }
      if (ledger && input.sequence !== ledger.nextSequence) {
        throw audioSendRejection("audio_turn_limit", "Audio chunk sequence must be contiguous");
      }
      if (!ledger && input.sequence !== 0) {
        throw audioSendRejection("audio_turn_limit", "A Viva audio input turn must start at 0");
      }
      const retainedBytes = (ledger?.retainedBytes ?? 0) + bytes.byteLength;
      if (!Number.isSafeInteger(retainedBytes) || retainedBytes > VIVA_AUDIO_MAX_TURN_BYTES) {
        throw audioSendRejection(
          "audio_queue_limit",
          "Audio turn exceeds the maximum retained turn size",
        );
      }
      if (!ledger) {
        ledger = createAudioTurnLedger(turnId, activeGeneration?.id ?? null);
        audioLedger = ledger;
      }
      // Copy: the AudioWorklet owns and reuses its sample buffers.
      ledger.chunks.push({ bytes: bytes.slice(), sequence: input.sequence });
      ledger.retainedBytes = retainedBytes;
      ledger.nextSequence = input.sequence + 1;
      return pumpAudioQueue();
    },
    endAudioTurn(input: Readonly<{ turnId: string; finalSequence: number }>) {
      const ledger = audioLedger;
      if (!ledger || ledger.turnId !== input.turnId) {
        throw audioSendRejection("audio_turn_limit", "No matching Viva audio input turn to end");
      }
      if (ledger.chunks.length === 0 || input.finalSequence !== ledger.nextSequence - 1) {
        throw audioSendRejection(
          "audio_turn_limit",
          "audio_end must carry the last accepted chunk sequence",
        );
      }
      ledger.endRequested = true;
      ledger.finalSequence = input.finalSequence;
      return pumpAudioQueue();
    },
    cancelAudioTurn(turnId: string) {
      const ledger = audioLedger;
      // A cancellation for another turn is never permission to discard this one.
      if (!ledger || ledger.turnId !== turnId) return;
      releaseAudioLedger();
      const generationId = activeGeneration?.id;
      if (generationId && generationId === ledger.generationId && socket?.readyState === 1) {
        socket.send(
          JSON.stringify({
            client_generation_id: generationId,
            turn_id: ledger.turnId,
            type: "cancel",
            version: VIVA_VOICE_PROTOCOL_VERSION,
          }),
        );
      }
      if (state.pendingSubmission?.kind === "audio") {
        setState({ ...state, pendingSubmission: undefined });
      }
    },
    retryPendingAudio() {
      return pumpAudioQueue();
    },
    acknowledgeAudio(consumed: readonly VivaAgentAudioOutput[]) {
      // Drop exactly the frames the consumer enqueued to the playback sink — by
      // object identity, NOT a positional count: a cancellation can filter frames
      // out of the middle of the live array between the consumer's snapshot and
      // this call, so a `slice(count)` would over-remove a not-yet-enqueued
      // survivor (the start of the next response). The reducer stores the same
      // frame object refs the consumer reads, so a Set filter is exact. This keeps
      // `audio` a bounded pending-to-play queue, not an ever-growing log (which on
      // the live provider was O(n^2) copies + a leak).
      if (consumed.length === 0 || state.audio.length === 0) return;
      const drop = new Set<VivaAgentAudioOutput>(consumed);
      setState({ ...state, audio: state.audio.filter((output) => !drop.has(output)) });
    },
    cancel() {
      sendFrame({ type: "cancel", version: VIVA_VOICE_PROTOCOL_VERSION });
    },
    stop() {
      sendFrame({ type: "stop", version: VIVA_VOICE_PROTOCOL_VERSION });
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type AudioLedgerChunk = { sequence: number; bytes: Uint8Array };

/**
 * One bounded input turn's raw bytes plus its send-queue bookkeeping. The whole
 * turn — including chunks already serialized into the socket — is retained until
 * the matching `audio_turn_accepted`, never past 2,160,000 raw bytes.
 */
type AudioTurnLedger = {
  generationId: string | null;
  turnId: string;
  chunks: AudioLedgerChunk[];
  retainedBytes: number;
  nextSequence: number;
  serializedChunkCount: number;
  lastSerializedSequence: number | null;
  endRequested: boolean;
  endSerialized: boolean;
  finalSequence: number | null;
};

function createAudioTurnLedger(turnId: string, generationId: string | null): AudioTurnLedger {
  return {
    chunks: [],
    endRequested: false,
    endSerialized: false,
    finalSequence: null,
    generationId,
    lastSerializedSequence: null,
    nextSequence: 0,
    retainedBytes: 0,
    serializedChunkCount: 0,
    turnId,
  };
}

/**
 * The lowest sequence the browser still holds. Nothing is acknowledged until the
 * server accepts the whole turn, so this stays at the turn's first sequence for
 * the turn's lifetime; `acceptedThroughSequence` is the separate serialization
 * high-water mark. Plan 10's replay work is what may later advance this.
 */
function retainedFromSequence(ledger: AudioTurnLedger): number {
  return ledger.chunks[0]?.sequence ?? ledger.nextSequence;
}

function audioSocketClosedResult(ledger: AudioTurnLedger, message: string): VivaAudioSendResult {
  return {
    acceptedThroughSequence: ledger.lastSerializedSequence,
    error: { code: "socket_closed", message },
    retainedFromSequence: retainedFromSequence(ledger),
    retryable: true,
    status: "socket_closed",
  };
}

function audioSendRejection(
  code: VivaClientSendError["code"],
  message: string,
): VivaAudioSendRejectedError {
  return new VivaAudioSendRejectedError({ code, message });
}

function requireAudioTurnId(turnId: string): string {
  if (typeof turnId !== "string" || turnId.trim().length === 0) {
    throw audioSendRejection("audio_turn_limit", "Audio turn id must be a non-empty string");
  }
  return turnId;
}

/**
 * A frame as its call site writes it, before the controller stamps the active
 * generation onto it. `client_generation_id` is never the caller's to choose:
 * only the controller knows which generation is live, and a caller-chosen one
 * could address a generation that has already been replaced.
 */
type VivaClientFrameDraft =
  | VivaClientFrame
  | Omit<VivaCancelClientFrame, "client_generation_id">
  | Omit<VivaStopClientFrame, "client_generation_id">;

function withClientGeneration(frame: VivaClientFrameDraft, generationId: string): VivaClientFrame {
  return { ...frame, client_generation_id: generationId } as VivaClientFrame;
}

function defaultVivaAgentGenerationId(input: {
  reason: VivaAgentGenerationReason;
  sequence: number;
}): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `viva-${input.reason}-${input.sequence}-${random}`;
}

function responseIdForEvent(event: VivaServerEvent): string | undefined {
  switch (event.type) {
    case "question_started":
    case "transcript_delta":
    case "transcript_final":
    case "answer_evaluated":
    case "source_reference":
    case "concept_status":
    case "manuscript_intent":
    case "recap_ready":
    case "audio_delta":
      return event.response_id;
    case "cancellation":
      return event.response_id ?? undefined;
    default:
      return undefined;
  }
}

function closeDiagnosticsForEvent(event: VivaSocketEvent): VivaAgentCloseDiagnostics {
  return {
    code: typeof event.code === "number" ? event.code : 1005,
    reason: safeCloseReasonForDisplay(typeof event.reason === "string" ? event.reason : ""),
    wasClean: typeof event.wasClean === "boolean" ? event.wasClean : false,
  };
}

const safeAgentCloseReasons = new Set([
  "agent input closed",
  "binary frame too large",
  "client stop",
  "first frame timeout",
  "idle timeout",
  "invalid client frame",
  "provider source authority rejected",
  "session config required",
  "session auth failed",
  "text frame too large",
  "untrusted tool_result",
]);
const legacyAgentAuthReasons = new Set([
  "invalid session identity",
  "invalid session token",
  "study set access denied",
]);

function safeCloseReasonForDisplay(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  if (legacyAgentAuthReasons.has(lower)) return "session auth failed";
  return safeAgentCloseReasons.has(lower) ? lower : "[redacted close reason]";
}

type VivaSocketEvent = Event & {
  code?: number;
  data?: unknown;
  reason?: string;
  wasClean?: boolean;
};

function setSocketHandler(
  socket: WebSocket,
  type: "open" | "message" | "close" | "error",
  handler: (event: VivaSocketEvent) => void,
) {
  socket.addEventListener(type, handler as EventListener);
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function envRecord(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
