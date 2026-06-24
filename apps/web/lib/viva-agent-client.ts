import {
  type AgentAnswerEvaluation,
  type AgentAudioFrame,
  type AgentBrainReadiness,
  type AgentConceptStatus,
  type AgentSessionConfig,
  type AgentStoreReadiness,
  type AgentStudyQuestion,
  type AgentStudySessionPhase,
  type AgentStudySessionRecap,
  type AgentStudySourceReference,
  type AgentTerminalSessionReason,
  audioClientFrame,
  type ManuscriptIntent,
  type PasteIngestionResponse,
  parseVivaServerFrame,
  type StudySet,
  sessionConfigFrame,
  studySetFromPasteIngestionResponse,
  VIVA_VOICE_PROTOCOL_VERSION,
  type VivaClientFrame,
  type VivaReadyFrame,
  type VivaServerEvent,
  type VivaServerFrame,
} from "@viva/core";
import type { VivaLibraryExport, VivaLibrarySnapshot } from "./viva-library";

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

export type VivaAgentAudioOutput = {
  responseId: string;
  frame: AgentAudioFrame;
};

export type VivaAgentManuscriptIntent = {
  responseId: string;
  intent: ManuscriptIntent;
};

export type VivaAgentSessionState = {
  status: VivaAgentConnectionStatus;
  close?: VivaAgentCloseDiagnostics;
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
  manuscriptIntents: VivaAgentManuscriptIntent[];
  recap?: AgentStudySessionRecap;
  audio: VivaAgentAudioOutput[];
  cancelledResponseIds: string[];
  errors: string[];
  staleEvents: number;
};

export type VivaAgentSessionControllerOptions = VivaAgentClientOptions & {
  session: AgentSessionConfig;
  sessionToken?: string | null;
  initialState?: VivaAgentSessionState;
};

export type VivaAgentSessionController = {
  connect: () => WebSocket;
  close: () => void;
  reset: () => void;
  sendText: (text: string) => void;
  sendAudio: (pcm16Base64: string) => void;
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

function browserVivaLibraryProxyBaseUrl(): string | undefined {
  if (bundledVivaStaticExport === "1" || typeof window === "undefined") return undefined;
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
  if (frame.type === "error") {
    return {
      ...state,
      status: "error",
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
    event.type !== "recap_ready" &&
    state.activeResponseId &&
    state.activeResponseId !== responseId
  ) {
    return { ...state, staleEvents: state.staleEvents + 1 };
  }

  switch (event.type) {
    case "session_phase":
      if (state.recap && event.phase !== "recap") return state;
      if (event.terminal_reason && event.phase === "recap" && !state.recap) {
        return {
          ...state,
          phase: event.phase,
          terminalReason: event.terminal_reason,
        };
      }
      return {
        ...state,
        phase: event.phase,
        terminalReason: event.terminal_reason ?? state.terminalReason,
      };
    case "question_started":
      return {
        ...state,
        activeResponseId: event.response_id,
        question: event.question,
        transcript: "",
        terminalReason: undefined,
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
      return { ...state, evaluation: event.evaluation };
    case "source_reference":
      return { ...state, currentSource: event.source, sources: [...state.sources, event.source] };
    case "concept_status":
      return {
        ...state,
        currentConceptStatus: event.status,
        conceptStatuses: { ...state.conceptStatuses, [event.concept_id]: event.status },
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
      return { ...state, phase: "recap", recap: event.recap };
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
        errors: [...state.errors, sanitizeAgentError(event.message)],
      };
    default:
      return state;
  }
}

function sanitizeAgentError(message: string): string {
  if (!message) return "agent error";
  if (
    /pcm16_base64|answer_text|transcript|prompt|source_context|pasted_text|session_token|viva1\.|bearer|cartesia_api_key|gemini_api_key|secret|raw answer|source excerpt/i.test(
      message,
    )
  ) {
    return "sanitized provider error";
  }
  return message.replace(/\s+/g, " ").slice(0, 160);
}

export function createVivaAgentSessionController(
  options: VivaAgentSessionControllerOptions,
): VivaAgentSessionController {
  let socket: WebSocket | undefined;
  let state = options.initialState ?? initialVivaAgentSessionState();
  const listeners = new Set<(next: VivaAgentSessionState) => void>();

  function setState(next: VivaAgentSessionState) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function sendFrame(frame: VivaClientFrame) {
    if (socket?.readyState !== 1) {
      setState({ ...state, status: "error", errors: [...state.errors, "WebSocket is not open"] });
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  return {
    connect() {
      socket?.close();
      const nextSocket = connectVivaAgent(options);
      socket = nextSocket;
      setState({ ...initialVivaAgentSessionState(), status: "connecting" });
      setSocketHandler(nextSocket, "open", () => {
        if (socket !== nextSocket) return;
        sendFrame(sessionConfigFrame(options.session, options.sessionToken));
      });
      setSocketHandler(nextSocket, "message", (event) => {
        if (socket !== nextSocket) return;
        if (typeof event.data !== "string") return;
        try {
          setState(vivaAgentReducer(state, parseVivaAgentMessage(event.data)));
        } catch (error) {
          setState({
            ...state,
            status: "error",
            errors: [...state.errors, error instanceof Error ? error.message : String(error)],
          });
        }
      });
      setSocketHandler(nextSocket, "close", (event) => {
        if (socket !== nextSocket) return;
        setState({ ...state, status: "closed", close: closeDiagnosticsForEvent(event) });
      });
      setSocketHandler(nextSocket, "error", () => {
        if (socket !== nextSocket) return;
        setState({ ...state, status: "error", errors: [...state.errors, "WebSocket error"] });
      });
      return nextSocket;
    },
    close() {
      socket?.close();
      socket = undefined;
      setState({ ...initialVivaAgentSessionState(), status: "closed" });
    },
    reset() {
      setState(initialVivaAgentSessionState());
    },
    sendText(text: string) {
      sendFrame({ type: "text", version: VIVA_VOICE_PROTOCOL_VERSION, text });
    },
    sendAudio(pcm16Base64: string) {
      sendFrame(audioClientFrame(pcm16Base64));
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
  "invalid session identity",
  "invalid session token",
  "provider source authority rejected",
  "session config required",
  "study set access denied",
  "text frame too large",
  "untrusted tool_result",
]);

function safeCloseReasonForDisplay(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
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
