import { type NextRequest, NextResponse } from "next/server";

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

  const headers = vivaLibraryProxyHeaders(request);
  const response = await fetch(upstream, {
    body: request.method === "POST" ? await request.text() : undefined,
    cache: "no-store",
    headers,
    method: request.method,
  });
  const responseHeaders = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  const responseBody = await browserSafeLibraryResponseBody(response, path, contentType);
  return new NextResponse(responseBody, {
    headers: responseHeaders,
    status: response.status,
  });
}

function vivaAgentServerHttpBaseUrl(): string | null {
  return (
    process.env.VIVA_AGENT_HTTP_URL?.trim() ||
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL?.trim() ||
    "http://127.0.0.1:4318"
  );
}

function vivaLibraryProxyHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
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

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function browserSafeLibraryResponseBody(
  response: Response,
  path: string[],
  contentType: string | null,
): Promise<ArrayBuffer | string> {
  if (
    response.ok &&
    path.join("/") === "study-sets/library" &&
    contentType?.toLowerCase().includes("application/json")
  ) {
    try {
      const value = await response.json();
      return JSON.stringify(stripLibrarySessionTokens(value));
    } catch {
      return "{}";
    }
  }
  return response.arrayBuffer();
}

function stripLibrarySessionTokens(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  const studySets = Array.isArray(snapshot.study_sets)
    ? snapshot.study_sets.map(stripStudySetSessionTokens)
    : snapshot.study_sets;
  return { ...snapshot, study_sets: studySets };
}

function stripStudySetSessionTokens(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const studySet = value as Record<string, unknown>;
  const actions =
    studySet.actions && typeof studySet.actions === "object" && !Array.isArray(studySet.actions)
      ? stripSessionActionTokens(studySet.actions as Record<string, unknown>)
      : studySet.actions;
  return { ...studySet, actions };
}

function stripSessionActionTokens(actions: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actions,
    resume: stripSessionActionToken(actions.resume),
    start: stripSessionActionToken(actions.start),
  };
}

function stripSessionActionToken(action: unknown): unknown {
  if (!action || typeof action !== "object" || Array.isArray(action)) return action;
  const { session_token: _sessionToken, ...rest } = action as Record<string, unknown>;
  return rest;
}
