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
  return new NextResponse(null, { status: 204 });
}

async function proxyVivaLibraryRequest(request: NextRequest, context: VivaLibraryRouteContext) {
  const agentBaseUrl = vivaAgentServerHttpBaseUrl();
  if (!agentBaseUrl) {
    return NextResponse.json({ error: "viva_agent_unavailable" }, { status: 503 });
  }
  const { path = [] } = await context.params;
  const upstream = new URL(
    `${trimTrailingSlash(agentBaseUrl)}/${path.map(encodeURIComponent).join("/")}`,
  );
  upstream.search = request.nextUrl.search;

  const serverBearer = serverBearerForBrowserLibrarySnapshot(request, path);
  if (!serverBearer.ok) return serverBearer.response;
  const headers = vivaLibraryProxyHeaders(request, {
    serverBearerToken: serverBearer.token,
  });
  const response = await fetch(upstream, {
    body: request.method === "POST" ? await request.text() : undefined,
    cache: "no-store",
    headers,
    method: request.method,
  });
  const responseHeaders = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
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
      response: NextResponse.json({ error: "viva_library_auth_unavailable" }, { status: 503 }),
    };
  }

  const userId = request.nextUrl.searchParams.get("user_id")?.trim();
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "viva_library_user_required" }, { status: 400 }),
    };
  }
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "viva_library_identity_allowlist_unavailable" },
        { status: 503 },
      ),
    };
  }
  if (!allowedUserIds.has(userId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "viva_library_identity_not_allowed" }, { status: 403 }),
    };
  }
  return { ok: true, snapshotFilter: { allowedStudySetIds, userId }, token };
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
      return JSON.stringify(stripLibraryTokenFields(withBootstrapTokens));
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
    sessions: Array.isArray(snapshot.sessions)
      ? snapshot.sessions.filter((session) => librarySessionAllowed(session, filter))
      : snapshot.sessions,
    study_sets: Array.isArray(snapshot.study_sets)
      ? snapshot.study_sets.filter((studySet) => libraryStudySetAllowed(studySet, filter))
      : snapshot.study_sets,
    user_id: filter.userId,
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

function stripLibraryTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLibraryTokenFields);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "session_token" || key === "control_token") continue;
    output[key] = stripLibraryTokenFields(child);
  }
  return output;
}
