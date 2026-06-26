import { type NextRequest, NextResponse } from "next/server";
import { attachVivaSessionBootstrapTokensToLibrarySnapshot } from "../../viva-session/shared";

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

  const controlGuard = guardAllowedLibraryControlRoute(request, path);
  if (controlGuard) return controlGuard;

  const serverBearer = serverBearerForBrowserLibrarySnapshot(request, path);
  if (!serverBearer.ok) return serverBearer.response;
  const headers = vivaLibraryProxyHeaders(request, {
    serverBearerToken: serverBearer.token,
  });
  let response: Response;
  try {
    response = await fetch(upstream, {
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
      headers,
      method: request.method,
    });
  } catch {
    return vivaLibraryProxyJsonError(502, "viva_library_proxy_unavailable");
  }
  if (serverBearer.snapshotFilter && !response.ok) {
    return vivaLibraryProxyJsonError(response.status, "viva_library_proxy_unavailable");
  }
  const responseHeaders = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  responseHeaders.set("cache-control", "no-store");
  const responseBody = await browserSafeLibraryResponseBody(response, path, contentType, {
    origin: vivaLibraryProxyOrigin(request),
    snapshotFilter: serverBearer.snapshotFilter,
  });
  return new NextResponse(responseBody, {
    headers: responseHeaders,
    status: response.status,
  });
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
  options: { serverBearerToken?: string } = {},
): Headers {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (options.serverBearerToken) {
    headers.set("authorization", `Bearer ${options.serverBearerToken}`);
  } else if (authorization) {
    headers.set("authorization", authorization);
  }
  const controlToken = request.headers.get("x-viva-library-control-token");
  if (controlToken) headers.set("x-viva-library-control-token", controlToken);
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

function serverBearerForBrowserLibrarySnapshot(
  request: NextRequest,
  path: string[],
):
  | {
      ok: true;
      snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
      token?: string;
    }
  | { ok: false; response: NextResponse<{ error: string }> } {
  if (request.method !== "GET" || path.join("/") !== "study-sets/library") {
    return { ok: true };
  }
  const token = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      response: vivaLibraryProxyJsonError(503, "viva_library_auth_unavailable"),
    };
  }

  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  if (!userId) {
    return {
      ok: false,
      response: vivaLibraryProxyJsonError(400, "viva_library_user_required"),
    };
  }
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) {
    return {
      ok: false,
      response: vivaLibraryProxyJsonError(503, "viva_library_identity_allowlist_unavailable"),
    };
  }
  if (!allowedUserIds.has(userId)) {
    return {
      ok: false,
      response: vivaLibraryProxyJsonError(403, "viva_library_identity_not_allowed"),
    };
  }
  return { ok: true, snapshotFilter: { allowedStudySetIds, userId }, token };
}

function guardAllowedLibraryControlRoute(
  request: NextRequest,
  path: string[],
): NextResponse | null {
  const controlTarget = libraryControlRouteTarget(request.method, path);
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
): { studySetId: string | null } | null {
  if (method === "GET" && path.join("/") === "study-sets/export") {
    return { studySetId: null };
  }
  if (method === "DELETE" && path[0] === "study-sets" && typeof path[1] === "string") {
    return { studySetId: path[1] };
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
      return JSON.stringify(stripLibrarySessionTokens(withBootstrapTokens));
    } catch {
      return "{}";
    }
  }
  return response.arrayBuffer();
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

function stripLibrarySessionTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLibrarySessionTokens);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "session_token") continue;
    output[key] = stripLibrarySessionTokens(child);
  }
  return output;
}
