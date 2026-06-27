import { type NextRequest, NextResponse } from "next/server";
import {
  attachVivaLibraryControlTokensToLibrarySnapshot,
  attachVivaSessionBootstrapTokensToLibrarySnapshot,
  isVivaLibraryControlToken,
  type VivaLibraryControlScope,
  verifyVivaLibraryControlToken,
} from "../../viva-session/shared";

export const dynamic = "force-dynamic";

type VivaLibraryRouteContext = {
  params: Promise<{ path?: string[] }>;
};

export async function GET(request: NextRequest, context: VivaLibraryRouteContext) {
  return proxyVivaLibraryRequest(request, context);
}

export async function POST(request: NextRequest, context: VivaLibraryRouteContext) {
  return proxyVivaLibraryRequest(request, context);
}

export async function DELETE(request: NextRequest, context: VivaLibraryRouteContext) {
  return proxyVivaLibraryRequest(request, context);
}

export function OPTIONS() {
  return new NextResponse(null, { headers: noStoreHeaders(), status: 204 });
}

const DEFAULT_LIBRARY_PROXY_TIMEOUT_MS = 30_000;
const DEFAULT_LIBRARY_UPLOAD_PROXY_TIMEOUT_MS = 15_000;

async function proxyVivaLibraryRequest(request: NextRequest, context: VivaLibraryRouteContext) {
  const agentBaseUrl = vivaAgentServerHttpBaseUrl();
  if (!agentBaseUrl) {
    return vivaLibraryProxyJsonError(503, "viva_agent_unavailable");
  }
  const { path = [] } = await context.params;
  const upstream = new URL(
    `${trimTrailingSlash(agentBaseUrl)}/${path.map(encodeURIComponent).join("/")}`,
  );
  upstream.search = request.nextUrl.search;

  const controlTarget = libraryControlRouteTarget(request.method, path);
  const controlGuard = guardAllowedLibraryControlRoute(request, controlTarget);
  if (controlGuard) return controlGuard;

  const serverBearer = serverBearerForBrowserLibraryRequest(request, path, controlTarget);
  if (!serverBearer.ok) return serverBearer.response;
  const headers = vivaLibraryProxyHeaders(request, {
    forwardControlToken: !serverBearer.consumedControlToken,
    serverBearerToken: serverBearer.token,
  });
  let response: Response;
  let timedOut = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    vivaLibraryProxyTimeoutMs(path, request.method),
  );
  const terminalReason = libraryPreLoopTerminalReason(path, request.method);
  try {
    const body =
      request.method === "POST"
        ? await requestTextWithAbort(request, controller.signal)
        : undefined;
    response = await fetch(upstream, {
      body,
      cache: "no-store",
      headers,
      method: request.method,
      signal: controller.signal,
    });
    if (!response.ok && terminalReason) {
      if (isUpstreamValidationFailure(response.status)) {
        if (isBrowserLibrarySnapshotRequest(request.method, path)) {
          await cancelResponseBody(response);
          return libraryPreLoopJsonError(502, "viva_library_pre_loop_unavailable", terminalReason);
        }
        const preserved = await browserSafeLibraryResponse(response, path, {
          origin: vivaLibraryProxyOrigin(request),
        });
        if (timedOut) {
          return libraryPreLoopJsonError(504, "viva_library_pre_loop_timeout", terminalReason);
        }
        return preserved;
      }
      await cancelResponseBody(response);
      return libraryPreLoopJsonError(502, "viva_library_pre_loop_unavailable", terminalReason);
    }
    if (timedOut) {
      return terminalReason
        ? libraryPreLoopJsonError(504, "viva_library_pre_loop_timeout", terminalReason)
        : libraryProxyJsonError(504, "viva_library_proxy_timeout");
    }
    if (isBrowserLibrarySnapshotRequest(request.method, path) && !response.ok) {
      return vivaLibraryProxyJsonError(response.status, "viva_library_proxy_unavailable");
    }
    const responseHeaders = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    responseHeaders.set("cache-control", "no-store");
    const responseBody = await browserSafeLibraryResponseBody(response, path, contentType, {
      origin: vivaLibraryProxyOrigin(request),
      snapshotFilter: browserLibrarySnapshotFilter(request, path),
    });
    return new NextResponse(responseBody, {
      headers: responseHeaders,
      status: response.status,
    });
  } catch {
    if (terminalReason) {
      return libraryPreLoopJsonError(
        timedOut ? 504 : 502,
        timedOut ? "viva_library_pre_loop_timeout" : "viva_library_pre_loop_unavailable",
        terminalReason,
      );
    }
    return libraryProxyJsonError(
      timedOut ? 504 : 502,
      timedOut ? "viva_library_proxy_timeout" : "viva_library_proxy_unavailable",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function libraryPreLoopJsonError(
  status: number,
  error: string,
  terminalReason: string,
): NextResponse {
  return NextResponse.json(
    {
      error,
      failure_class: "pre_loop_unavailable",
      stage: "pre_loop",
      terminal_reason: terminalReason,
    },
    { headers: noStoreHeaders(), status },
  );
}

function libraryProxyJsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { headers: noStoreHeaders(), status });
}

function libraryAccessDeniedJsonError(status: number, error: string): NextResponse {
  return NextResponse.json(
    {
      error,
      failure_class: "access_denied",
      stage: "pre_loop",
    },
    { headers: noStoreHeaders(), status },
  );
}

function isUpstreamValidationFailure(status: number): boolean {
  return status === 400 || status === 422;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only; the caller is already returning sanitized failure evidence.
  }
}

function libraryPreLoopTerminalReason(path: string[], method: string): string | null {
  const route = path.join("/");
  if (
    method === "POST" &&
    (route === "study-sets/files" ||
      (path.length === 4 && path[0] === "study-sets" && path[2] === "files" && path[3] === "retry"))
  ) {
    return "pre_loop_upload_unavailable";
  }
  if (
    (method === "GET" && route === "study-sets/library") ||
    (method === "POST" && route === "study-sets/paste")
  ) {
    return "pre_loop_ingestion_unavailable";
  }
  return null;
}

function isBrowserLibrarySnapshotRequest(method: string, path: string[]): boolean {
  return method === "GET" && path.join("/") === "study-sets/library";
}

function browserLibrarySnapshotFilter(
  request: NextRequest,
  path: string[],
): { allowedStudySetIds: Set<string>; userId: string } | undefined {
  if (!isBrowserLibrarySnapshotRequest(request.method, path)) return undefined;
  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!userId || !allowedStudySetIds) return undefined;
  return { allowedStudySetIds, userId };
}

function vivaLibraryProxyTimeoutMs(path: string[], method: string): number {
  const maxTimeout =
    libraryPreLoopTerminalReason(path, method) === "pre_loop_upload_unavailable"
      ? DEFAULT_LIBRARY_UPLOAD_PROXY_TIMEOUT_MS
      : DEFAULT_LIBRARY_PROXY_TIMEOUT_MS;
  const value = Number.parseInt(process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(value) && value > 0) return Math.min(value, maxTimeout);
  return maxTimeout;
}

async function requestTextWithAbort(request: NextRequest, signal: AbortSignal): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let abortHandler: (() => void) | undefined;
  const abortError = new Error("viva_library_proxy_timeout");
  const abort = new Promise<never>((_, reject) => {
    abortHandler = () => {
      void reader.cancel().catch(() => undefined);
      reject(abortError);
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    while (true) {
      if (signal.aborted) throw abortError;
      const chunk = await Promise.race([reader.read(), abort]);
      if (signal.aborted) throw abortError;
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
    reader.releaseLock();
  }
}

function vivaAgentServerHttpBaseUrl(): string | null {
  return process.env.VIVA_AGENT_HTTP_URL?.trim() || null;
}

function noStoreHeaders(headers: HeadersInit = {}): Headers {
  const output = new Headers(headers);
  output.set("cache-control", "no-store");
  return output;
}

function vivaLibraryProxyJsonError(status: number, error: string): NextResponse<{ error: string }> {
  return NextResponse.json({ error }, { headers: noStoreHeaders(), status });
}

function vivaLibraryProxyHeaders(
  request: NextRequest,
  options: { forwardControlToken?: boolean; serverBearerToken?: string } = {},
): Headers {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (options.serverBearerToken) {
    headers.set("authorization", `Bearer ${options.serverBearerToken}`);
  } else if (authorization) {
    headers.set("authorization", authorization);
  }
  const controlToken = request.headers.get("x-viva-library-control-token");
  if (controlToken && options.forwardControlToken !== false) {
    headers.set("x-viva-library-control-token", controlToken);
  }
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const origin = vivaLibraryProxyOrigin(request);
  if (origin) headers.set("origin", origin);
  return headers;
}

function vivaLibraryProxyOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const host = request.headers.get("host");
  if (host) {
    const protocol =
      request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.slice(0, -1);
    return `${protocol}://${host}`;
  }
  return request.nextUrl.origin;
}

function serverBearerForBrowserLibraryRequest(
  request: NextRequest,
  path: string[],
  controlTarget: LibraryControlRouteTarget | null,
):
  | {
      consumedControlToken?: boolean;
      ok: true;
      snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
      token?: string;
    }
  | { ok: false; response: NextResponse } {
  const browserSnapshotRequest =
    request.method === "GET" && path.join("/") === "study-sets/library";
  const controlToken = request.headers.get("x-viva-library-control-token")?.trim() || null;
  const sameOriginControlRequest =
    request.method === "DELETE" &&
    Boolean(controlTarget?.studySetId) &&
    isVivaLibraryControlToken(controlToken);
  const missingControlCapabilityRequest =
    request.method === "DELETE" && Boolean(controlTarget?.studySetId) && !controlToken;
  if (!browserSnapshotRequest && !sameOriginControlRequest && !missingControlCapabilityRequest) {
    return { ok: true };
  }
  if (missingControlCapabilityRequest) {
    return {
      ok: false,
      response: vivaLibraryProxyJsonError(403, "viva_library_control_capability_required"),
    };
  }
  const token = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      response: libraryPreLoopJsonError(
        503,
        "viva_library_auth_unavailable",
        "pre_loop_ingestion_unavailable",
      ),
    };
  }
  if (sameOriginControlRequest) {
    const userId = request.nextUrl.searchParams.get("user_id")?.trim() || "";
    const verification = verifyVivaLibraryControlToken({
      origin: vivaLibraryProxyOrigin(request),
      scope: controlTarget?.scope ?? "study_set_delete",
      studySetId: controlTarget?.studySetId ?? "",
      token: controlToken ?? "",
      userId,
      voiceSessionId: controlTarget?.voiceSessionId ?? null,
    });
    if (verification === "missing_secret") {
      return {
        ok: false,
        response: vivaLibraryProxyJsonError(503, "viva_library_control_unavailable"),
      };
    }
    if (verification !== "valid") {
      return {
        ok: false,
        response: vivaLibraryProxyJsonError(403, "viva_library_control_capability_required"),
      };
    }
    return { consumedControlToken: true, ok: true, token };
  }

  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  if (!userId) {
    return {
      ok: false,
      response: libraryPreLoopJsonError(
        400,
        "viva_library_user_required",
        "pre_loop_ingestion_unavailable",
      ),
    };
  }
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) {
    return {
      ok: false,
      response: libraryPreLoopJsonError(
        503,
        "viva_library_identity_allowlist_unavailable",
        "pre_loop_ingestion_unavailable",
      ),
    };
  }
  if (!allowedUserIds.has(userId)) {
    return {
      ok: false,
      response: libraryAccessDeniedJsonError(403, "viva_library_identity_not_allowed"),
    };
  }
  return { ok: true, snapshotFilter: { allowedStudySetIds, userId }, token };
}

type LibraryControlRouteTarget = {
  scope: VivaLibraryControlScope | null;
  studySetId: string | null;
  voiceSessionId: string | null;
};

function guardAllowedLibraryControlRoute(
  request: NextRequest,
  controlTarget: LibraryControlRouteTarget | null,
): NextResponse | null {
  if (!controlTarget) return null;

  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) {
    return vivaLibraryProxyJsonError(503, "viva_library_identity_allowlist_unavailable");
  }
  if (!userId || !allowedUserIds.has(userId)) {
    return vivaLibraryProxyJsonError(403, "viva_library_identity_not_allowed");
  }
  if (!controlTarget.studySetId) {
    return vivaLibraryProxyJsonError(403, "viva_library_control_scope_not_allowed");
  }
  if (!allowedStudySetIds.has(controlTarget.studySetId)) {
    return vivaLibraryProxyJsonError(403, "viva_library_control_scope_not_allowed");
  }
  return null;
}

function libraryControlRouteTarget(
  method: string,
  path: string[],
): LibraryControlRouteTarget | null {
  if (method === "GET" && path.join("/") === "study-sets/export") {
    return { scope: null, studySetId: null, voiceSessionId: null };
  }
  if (
    method === "DELETE" &&
    path.length === 2 &&
    path[0] === "study-sets" &&
    typeof path[1] === "string"
  ) {
    return { scope: "study_set_delete", studySetId: path[1], voiceSessionId: null };
  }
  if (
    method === "DELETE" &&
    path.length === 4 &&
    path[0] === "study-sets" &&
    typeof path[1] === "string" &&
    path[2] === "sessions" &&
    typeof path[3] === "string"
  ) {
    return { scope: "session_history_delete", studySetId: path[1], voiceSessionId: path[3] };
  }
  return null;
}

function configuredAllowlist(envName: string): Set<string> | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function browserSafeLibraryResponseBody(
  response: Response,
  path: string[],
  contentType: string | null,
  options: {
    origin: string | null;
    snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
  },
): Promise<ArrayBuffer | string> {
  if (
    response.ok &&
    path.join("/") === "study-sets/library" &&
    contentType?.toLowerCase().includes("application/json")
  ) {
    try {
      const value = await response.json();
      const filtered = options.snapshotFilter
        ? filterBearerBackedLibrarySnapshot(value, options.snapshotFilter)
        : value;
      const withBootstrapTokens = options.snapshotFilter
        ? attachVivaSessionBootstrapTokensToLibrarySnapshot(filtered, {
            allowedStudySetIds: options.snapshotFilter.allowedStudySetIds,
            origin: options.origin,
            userId: options.snapshotFilter.userId,
          })
        : filtered;
      const withControlTokens = options.snapshotFilter
        ? attachVivaLibraryControlTokensToLibrarySnapshot(withBootstrapTokens, {
            allowedStudySetIds: options.snapshotFilter.allowedStudySetIds,
            origin: options.origin,
            userId: options.snapshotFilter.userId,
          })
        : withBootstrapTokens;
      return JSON.stringify(stripBrowserLibraryCapabilityTokens(withControlTokens));
    } catch {
      return "{}";
    }
  }
  return response.arrayBuffer();
}

async function browserSafeLibraryResponse(
  response: Response,
  path: string[],
  options: {
    origin: string | null;
    snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
  },
): Promise<NextResponse> {
  const responseHeaders = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  responseHeaders.set("cache-control", "no-store");
  const responseBody = await browserSafeLibraryResponseBody(response, path, contentType, options);
  return new NextResponse(responseBody, {
    headers: responseHeaders,
    status: response.status,
  });
}

function filterBearerBackedLibrarySnapshot(
  value: unknown,
  filter: { allowedStudySetIds: Set<string>; userId: string },
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  return {
    ...snapshot,
    privacy: filterBearerBackedPrivacy(snapshot.privacy),
    sessions: Array.isArray(snapshot.sessions)
      ? snapshot.sessions.filter((session) => librarySessionAllowed(session, filter))
      : snapshot.sessions,
    study_sets: Array.isArray(snapshot.study_sets)
      ? snapshot.study_sets.filter((studySet) => libraryStudySetAllowed(studySet, filter))
      : snapshot.study_sets,
    user_id: filter.userId,
  };
}

function filterBearerBackedPrivacy(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...(value as Record<string, unknown>),
    export: {
      available: false,
      unavailable_reason: "allowlist_filtered_export_unavailable",
    },
  };
}

function libraryStudySetAllowed(
  value: unknown,
  filter: { allowedStudySetIds: Set<string>; userId: string },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const studySet = value as Record<string, unknown>;
  return (
    studySet.user_id === filter.userId &&
    typeof studySet.id === "string" &&
    filter.allowedStudySetIds.has(studySet.id)
  );
}

function librarySessionAllowed(
  value: unknown,
  filter: { allowedStudySetIds: Set<string>; userId: string },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    session.user_id === filter.userId &&
    typeof session.study_set_id === "string" &&
    filter.allowedStudySetIds.has(session.study_set_id)
  );
}

function stripBrowserLibraryCapabilityTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBrowserLibraryCapabilityTokens);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "control_token" || key === "session_token") continue;
    output[key] = stripBrowserLibraryCapabilityTokens(child);
  }
  return output;
}
