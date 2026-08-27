import { type NextRequest, NextResponse } from "next/server";
import {
  attachVivaLibraryControlTokensToLibrarySnapshot,
  attachVivaSessionBootstrapTokensToLibrarySnapshot,
  consumeVivaLibraryDeleteCapability,
  isVivaCanonicalMutatingRequest,
  isVivaLibraryControlToken,
  parseBoundedJson,
  readBoundedBody,
  type VivaLibraryControlScope,
  vivaAgentScopedCredential,
  vivaBoundedBodyRejection,
  vivaCanonicalWebOrigin,
  vivaSessionSecurityStore,
  vivaWebApiResponseHeaders,
  WEB_API_BODY_LIMITS,
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
  if (!vivaCanonicalWebOrigin()) {
    return libraryConfigUnavailableResponse(request.method, path);
  }
  const upstream = new URL(
    `${trimTrailingSlash(agentBaseUrl)}/${path.map(encodeURIComponent).join("/")}`,
  );
  upstream.search = request.nextUrl.search;

  const unsupportedControlScope = guardUnsupportedControlScope(request.method, path);
  if (unsupportedControlScope) return unsupportedControlScope;

  // The destructive sequence is fixed and fail-closed: canonical origin, route/query allowlist,
  // a selectable shared store, then (inside the authorization step) constant-time capability
  // verification, one-time consumption, and only then the scoped delete credential.
  const controlTarget = libraryControlRouteTarget(request.method, path);
  const originGuard = guardDestructiveRequestOrigin(request, controlTarget);
  if (originGuard) return originGuard;
  const controlGuard = guardAllowedLibraryControlRoute(request, controlTarget);
  if (controlGuard) return controlGuard;
  const storeGuard = guardDestructiveSecurityStore(request, controlTarget);
  if (storeGuard) return storeGuard;

  const ingestion = libraryIngestionContract(request.method, path);
  const ingestionOriginGuard = guardIngestionRequestOrigin(request, ingestion);
  if (ingestionOriginGuard) return ingestionOriginGuard;

  const authorized = await authorizeBrowserLibraryRequest(request, path, controlTarget);
  if (!authorized.ok) return authorized.response;
  const { snapshotFilter } = authorized;
  const headers = vivaLibraryProxyHeaders(request, {
    forwardBrowserCapability: !authorized.consumedCapability,
    scopedCredential: authorized.credential,
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
    let body: string | undefined;
    if (request.method === "POST") {
      const requestBody = await readBoundedLibraryRequestBody(
        request,
        ingestion,
        controller.signal,
      );
      if (!requestBody.ok) {
        if (requestBody.reason === "too_large") {
          return libraryRequestTooLargeResponse(terminalReason);
        }
        // A stalled request body is the route deadline expiring, not a malformed body.
        if (requestBody.reason === "aborted") {
          return terminalReason
            ? libraryPreLoopJsonError(504, "viva_library_pre_loop_timeout", terminalReason)
            : libraryProxyJsonError(504, "viva_library_proxy_timeout");
        }
        return libraryIngestionInvalidResponse();
      }
      body = requestBody.value;
    }
    response = await fetch(upstream, {
      body,
      cache: "no-store",
      headers,
      method: request.method,
      signal: controller.signal,
    });
    if (!response.ok && terminalReason) {
      if (isUpstreamValidationFailure(response.status)) {
        // A browser snapshot never relays an upstream validation body, not even a stripped one.
        if (isBrowserLibrarySnapshotRequest(request.method, path)) {
          await cancelResponseBody(response);
          return libraryPreLoopJsonError(502, "viva_library_pre_loop_unavailable", terminalReason);
        }
        // Every other upstream 400/422 is preserved, but only after bounded reading and stripping.
        const preserved = await browserSafeLibraryResponse(response, path, controller.signal, {
          terminalReason,
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
    return await browserSafeLibraryResponse(response, path, controller.signal, {
      snapshotFilter,
      terminalReason,
    });
  } catch (error) {
    if (vivaBoundedBodyRejection(error) === "too_large") {
      return libraryUpstreamTooLargeResponse(terminalReason);
    }
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

/**
 * The exact accepted field set for each ingestion route. A body is validated against this and
 * then REBUILT field by field, so a browser-supplied identity, status, or authority field can
 * never ride along just because the agent currently ignores it.
 */
type LibraryIngestionContract = {
  optional: readonly string[];
  required: readonly string[];
};

const LIBRARY_INGESTION_CONTRACTS: Record<string, LibraryIngestionContract> = {
  paste: { optional: ["course", "exam_date"], required: ["title", "pasted_text"] },
  retry: { optional: ["content_type"], required: ["file_name", "file_base64"] },
  upload: {
    optional: ["course", "exam_date", "content_type"],
    required: ["title", "file_name", "file_base64"],
  },
};

function libraryIngestionContract(method: string, path: string[]): LibraryIngestionContract | null {
  if (method !== "POST") return null;
  const route = path.join("/");
  if (route === "study-sets/paste") return LIBRARY_INGESTION_CONTRACTS.paste ?? null;
  if (route === "study-sets/files") return LIBRARY_INGESTION_CONTRACTS.upload ?? null;
  if (path.length === 4 && path[0] === "study-sets" && path[2] === "files" && path[3] === "retry") {
    return LIBRARY_INGESTION_CONTRACTS.retry ?? null;
  }
  return null;
}

/**
 * Ingestion POSTs are mutating routes, so Task 3 Step 3's same-origin primitive applies here too
 * (A-23.4 routed this decision to Task 5). Without it the BFF would rewrite an attacker's
 * cross-origin request into a same-origin outbound `Origin` for the agent. Refusal reuses the
 * ingestion route's single coarse body, exactly as the destructive routes reuse one body for
 * "malformed, expired, wrong origin/scope, replay"; no new public vocabulary is invented.
 */
function guardIngestionRequestOrigin(
  request: NextRequest,
  ingestion: LibraryIngestionContract | null,
): NextResponse | null {
  if (!ingestion) return null;
  return isVivaCanonicalMutatingRequest(request) ? null : libraryIngestionInvalidResponse();
}

async function readBoundedLibraryRequestBody(
  request: NextRequest,
  ingestion: LibraryIngestionContract | null,
  signal: AbortSignal,
): Promise<
  { ok: true; value: string } | { ok: false; reason: "aborted" | "invalid" | "too_large" }
> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request.body, {
      contentLength: request.headers.get("content-length"),
      limit: WEB_API_BODY_LIMITS.libraryRequest,
      signal,
    });
  } catch (error) {
    return { ok: false, reason: vivaBoundedBodyRejection(error) ?? "invalid" };
  }
  if (!ingestion) return { ok: true, value: new TextDecoder().decode(bytes) };

  const parsed = parseBoundedJson(bytes);
  if (!parsed.ok) return { ok: false, reason: "invalid" };
  const rebuilt = reconstructIngestionBody(parsed.value, ingestion);
  return rebuilt ? { ok: true, value: JSON.stringify(rebuilt) } : { ok: false, reason: "invalid" };
}

function reconstructIngestionBody(
  value: unknown,
  contract: LibraryIngestionContract,
): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const allowed = new Set([...contract.required, ...contract.optional]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) return null;
  }
  const rebuilt: Record<string, string> = {};
  for (const key of contract.required) {
    const field = source[key];
    if (typeof field !== "string" || field.length === 0) return null;
    rebuilt[key] = field;
  }
  for (const key of contract.optional) {
    if (!(key in source)) continue;
    const field = source[key];
    if (typeof field !== "string" || field.length === 0) return null;
    rebuilt[key] = field;
  }
  return rebuilt;
}

function libraryIngestionInvalidResponse(): NextResponse {
  return libraryAccessDeniedJsonError(400, "viva_library_request_invalid");
}

function libraryRequestTooLargeResponse(terminalReason: string | null): NextResponse {
  return terminalReason
    ? libraryPreLoopJsonError(413, "viva_request_body_too_large", terminalReason)
    : libraryProxyJsonError(413, "viva_request_body_too_large");
}

function libraryUpstreamTooLargeResponse(terminalReason: string | null): NextResponse {
  return terminalReason
    ? libraryPreLoopJsonError(502, "viva_upstream_response_too_large", terminalReason)
    : libraryProxyJsonError(502, "viva_upstream_response_too_large");
}

/**
 * Missing/weak canonical origin or scoped service credential: one route-specific `*_unavailable`
 * 503 that never names the environment variable, its value, or the upstream URL.
 */
function libraryConfigUnavailableResponse(method: string, path: string[]): NextResponse {
  if (isBrowserLibrarySnapshotRequest(method, path)) {
    return libraryPreLoopJsonError(
      503,
      "viva_library_auth_unavailable",
      "pre_loop_ingestion_unavailable",
    );
  }
  if (method === "DELETE" && libraryControlRouteTarget(method, path)) {
    return vivaLibraryProxyJsonError(503, "viva_library_control_unavailable");
  }
  return vivaLibraryProxyJsonError(503, "viva_library_proxy_unavailable");
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

function vivaLibraryProxyTimeoutMs(path: string[], method: string): number {
  const maxTimeout =
    libraryPreLoopTerminalReason(path, method) === "pre_loop_upload_unavailable"
      ? DEFAULT_LIBRARY_UPLOAD_PROXY_TIMEOUT_MS
      : DEFAULT_LIBRARY_PROXY_TIMEOUT_MS;
  const value = Number.parseInt(process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(value) && value > 0) return Math.min(value, maxTimeout);
  return maxTimeout;
}

function vivaAgentServerHttpBaseUrl(): string | null {
  return process.env.VIVA_AGENT_HTTP_URL?.trim() || null;
}

/**
 * Route-owned response headers only. The optional extras are this route's own allowlist —
 * the validated upstream content type and nothing else — never a cloned upstream header.
 */
function noStoreHeaders(extra: Record<string, string> = {}): Headers {
  return vivaWebApiResponseHeaders(extra);
}

function vivaLibraryProxyJsonError(status: number, error: string): NextResponse<{ error: string }> {
  return NextResponse.json({ error }, { headers: noStoreHeaders(), status });
}

function vivaLibraryProxyHeaders(
  request: NextRequest,
  options: { forwardBrowserCapability?: boolean; scopedCredential?: string } = {},
): Headers {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (options.scopedCredential) {
    headers.set("authorization", `Bearer ${options.scopedCredential}`);
  } else if (authorization) {
    headers.set("authorization", authorization);
  }
  const controlToken = request.headers.get("x-viva-library-control-token");
  if (controlToken && options.forwardBrowserCapability !== false) {
    headers.set("x-viva-library-control-token", controlToken);
  }
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const origin = vivaLibraryProxyOrigin();
  if (origin) headers.set("origin", origin);
  return headers;
}

/**
 * The proxy's outbound origin is the configured canonical web origin and nothing else. An
 * `Origin`, `Host`, `Forwarded`, or `X-Forwarded-Proto` header can never move it.
 */
function vivaLibraryProxyOrigin(): string | null {
  return vivaCanonicalWebOrigin();
}

async function authorizeBrowserLibraryRequest(
  request: NextRequest,
  path: string[],
  controlTarget: LibraryControlRouteTarget | null,
): Promise<
  | {
      consumedCapability?: boolean;
      credential?: string;
      ok: true;
      snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
    }
  | { ok: false; response: NextResponse }
> {
  const browserSnapshotRequest =
    request.method === "GET" && path.join("/") === "study-sets/library";
  const controlToken = request.headers.get("x-viva-library-control-token")?.trim() || null;
  // One predicate decides that a request is destructive, and it depends on the METHOD and TARGET
  // only. Deciding it from the capability instead would let an unusable capability (absent, wrong
  // prefix, unverifiable) escape the destructive branch and be proxied upstream as an ordinary
  // DELETE, taking the browser-supplied capability header with it.
  const destructiveControlRequest =
    request.method === "DELETE" && Boolean(controlTarget?.studySetId);
  if (!browserSnapshotRequest && !destructiveControlRequest) {
    return { ok: true };
  }
  if (destructiveControlRequest && !isVivaLibraryControlToken(controlToken)) {
    // Not even shaped like a capability this deployment could have minted, so it fails HMAC
    // verification by construction. Absent and malformed share the one coarse 403 the error table
    // pins for every capability rejection, and neither reaches the store or the agent.
    return {
      ok: false,
      response: vivaLibraryProxyJsonError(403, "viva_library_control_capability_required"),
    };
  }
  if (destructiveControlRequest) {
    // Verify and SPEND the capability before any delete authority is resolved, so an unspendable
    // capability can never reach the agent and a spent one can never be replayed.
    const userId = request.nextUrl.searchParams.get("user_id")?.trim() || "";
    const consumption = await consumeVivaLibraryDeleteCapability({
      scope: controlTarget?.scope ?? "study_set_delete",
      studySetId: controlTarget?.studySetId ?? "",
      capability: controlToken ?? "",
      userId,
      voiceSessionId: controlTarget?.voiceSessionId ?? null,
    });
    if (!consumption.ok) {
      return {
        ok: false,
        response:
          consumption.reason === "unavailable"
            ? libraryControlStoreUnavailableResponse()
            : vivaLibraryProxyJsonError(403, "viva_library_control_capability_required"),
      };
    }
    const scopedDelete = vivaAgentScopedCredential("library_delete");
    if (!scopedDelete) {
      return { ok: false, response: libraryConfigUnavailableResponse(request.method, path) };
    }
    return { consumedCapability: true, credential: scopedDelete, ok: true };
  }
  const scopedRead = vivaAgentScopedCredential("library_read");
  if (!scopedRead) {
    return {
      ok: false,
      response: libraryConfigUnavailableResponse(request.method, path),
    };
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
  return { credential: scopedRead, ok: true, snapshotFilter: { allowedStudySetIds, userId } };
}

type LibraryControlRouteTarget = {
  scope: VivaLibraryControlScope | null;
  studySetId: string | null;
  voiceSessionId: string | null;
};

/**
 * D-04 is recorded as `CONFIRM_DELETE`: this deployment has confirmation plus permanent delete and
 * no undo. The `POST /{study_set_id}/restore` shape is therefore not a route here, and the catch-all
 * refuses it explicitly rather than relaying it upstream as an ordinary proxied POST.
 *
 * This is a path-shape match only — it mints and consumes nothing — so the D-04 Branch A absence
 * proof still finds no restore-capability code in this file.
 */
function guardUnsupportedControlScope(method: string, path: string[]): NextResponse | null {
  const restoreShape = method === "POST" && path.length === 2 && path[1] === "restore";
  return restoreShape
    ? libraryAccessDeniedJsonError(403, "viva_library_control_scope_not_allowed")
    : null;
}

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

/**
 * Destructive routes must be exactly same-origin. A missing or foreign `Origin`, or a
 * cross-site fetch, returns the same coarse capability error as a forged capability.
 *
 * SCOPE — an open question this lane routed to the coordinator rather than deciding alone.
 * Task 3 Step 3 words the rule as "mutating routes require an exact `Origin` match", but this
 * guard runs only on destructive DELETE. Paste/file/retry POST is deliberately excluded: Task 3
 * Step 4 makes it "separately authorized by its ingestion contract", the plan's public error
 * table defines a 403 shape only for start/refresh and destructive DELETE, and this lane may not
 * invent new public error vocabulary. Those POSTs are also handed no read, mint, or delete
 * authority by authorizeBrowserLibraryRequest, so nothing is silently widened.
 *
 * The POST path is therefore an OWNED follow-up, not an unowned gap. Task 5 is the next task in
 * this plan that reworks these routes, and it must either apply the same same-origin primitive
 * there or record why the ingestion contract already closes it.
 */
function guardDestructiveRequestOrigin(
  request: NextRequest,
  controlTarget: LibraryControlRouteTarget | null,
): NextResponse | null {
  if (request.method !== "DELETE" || !controlTarget) return null;
  if (isVivaCanonicalMutatingRequest(request)) return null;
  return vivaLibraryProxyJsonError(403, "viva_library_control_capability_required");
}

/**
 * A destructive delete is a one-time capability consumption, and the shared store is what makes
 * "one time" true across instances. If no shared store can be selected, the route refuses before
 * it contacts the agent rather than performing an unbounded, unrevocable delete.
 */
function guardDestructiveSecurityStore(
  request: NextRequest,
  controlTarget: LibraryControlRouteTarget | null,
): NextResponse | null {
  if (request.method !== "DELETE" || !controlTarget?.studySetId) return null;
  if (vivaSessionSecurityStore().ok) return null;
  return libraryControlStoreUnavailableResponse();
}

/**
 * An unavailable or ambiguous destructive store. The capability may or may not have been consumed,
 * so the route refuses without contacting the agent and without hinting at a retry.
 */
function libraryControlStoreUnavailableResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "viva_library_control_unavailable",
      failure_class: "pre_loop_unavailable",
      stage: "pre_loop",
    },
    { headers: noStoreHeaders(), status: 503 },
  );
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

/**
 * The ONE bounded response builder every upstream response goes through.
 *
 * Order matters and is fixed: bounded read -> parse -> recursive credential strip -> snapshot
 * allowlist filtering -> BFF capability minting. The strip pass never runs after minting, because
 * the BFF's own freshly minted capabilities are the intended browser-safe outputs.
 *
 * Headers are rebuilt from a route-owned allowlist — the upstream content type plus this route's
 * own cache/security headers — so no upstream cookie, auth, or cache header is ever cloned onto a
 * browser-facing response. An overage cancels the upstream stream and raises, and the caller maps
 * it to the recorded 502.
 */
async function browserSafeLibraryResponse(
  response: Response,
  path: string[],
  signal: AbortSignal,
  options: {
    snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
    terminalReason?: string | null;
  },
): Promise<NextResponse> {
  const contentType = response.headers.get("content-type");
  const bytes = await readBoundedBody(response.body, {
    contentLength: response.headers.get("content-length"),
    limit: WEB_API_BODY_LIMITS.libraryResponse,
    signal,
  });
  const built = browserSafeLibraryResponseBody(bytes, path, contentType, options);
  if (!built.ok) {
    // A JSON-expected route never relays ambiguous bytes; it returns the route's sanitized 502.
    return options.terminalReason
      ? libraryPreLoopJsonError(502, "viva_library_pre_loop_unavailable", options.terminalReason)
      : libraryProxyJsonError(502, "viva_library_proxy_unavailable");
  }
  const responseHeaders = noStoreHeaders(contentType ? { "content-type": contentType } : {});
  return new NextResponse(
    typeof built.body === "string" ? built.body : new Uint8Array(built.body),
    { headers: responseHeaders, status: response.status },
  );
}

function browserSafeLibraryResponseBody(
  bytes: Uint8Array,
  path: string[],
  contentType: string | null,
  options: {
    snapshotFilter?: { allowedStudySetIds: Set<string>; userId: string };
  },
): { ok: true; body: Uint8Array | string } | { ok: false } {
  // An explicitly binary/export route keeps bounded byte pass-through.
  if (isLibraryBytePassThroughRoute(path)) return { ok: true, body: bytes };
  // A bodiless response (204, or a bare 4xx with no payload) has nothing to sanitize.
  if (bytes.byteLength === 0) return { ok: true, body: bytes };
  if (!contentType?.toLowerCase().includes("application/json")) return { ok: false };

  const parsed = parseBoundedJson(bytes);
  if (!parsed.ok) return { ok: false };
  const stripped = stripAgentOriginatedCredentials(parsed.value);
  if (path.join("/") !== "study-sets/library" || !options.snapshotFilter) {
    return { ok: true, body: JSON.stringify(stripped) };
  }

  const filter = options.snapshotFilter;
  const filtered = filterBearerBackedLibrarySnapshot(stripped, filter);
  const withBootstrapTokens = attachVivaSessionBootstrapTokensToLibrarySnapshot(filtered, {
    allowedStudySetIds: filter.allowedStudySetIds,
    userId: filter.userId,
  });
  const withControlTokens = attachVivaLibraryControlTokensToLibrarySnapshot(withBootstrapTokens, {
    allowedStudySetIds: filter.allowedStudySetIds,
    userId: filter.userId,
  });
  return { ok: true, body: JSON.stringify(withControlTokens) };
}

/** Only an explicitly binary/export route relays upstream bytes unparsed. */
function isLibraryBytePassThroughRoute(path: string[]): boolean {
  return path.join("/") === "study-sets/export";
}

/**
 * Recursive, order-sensitive credential removal for every proxied JSON body.
 *
 * Keys are compared case-insensitively against the closed credential set plus any `_token`
 * suffix, so an upstream `session_bootstrap_token`, `same_origin_control_token`, or `Access_Token`
 * is removed no matter how it is cased or nested. String VALUES are inspected one leaf at a time —
 * never with a token-shaped regex over serialized JSON — and any string carrying a bearer
 * credential or a Viva credential prefix is replaced whole.
 */
const AGENT_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "api_key",
  "authorization",
  "credential",
  "password",
  "private_key",
  "secret",
  "token",
]);
/**
 * Value markers, lowercase, matched against a lowercased string LEAF — never as a token-shaped
 * regex over serialized JSON. These are the only credential shapes the agent can hand back:
 * the HTTP authorization scheme below, and Viva's four credential prefixes.
 */
const AGENT_CREDENTIAL_VALUE_MARKERS = [
  "bearer ",
  "viva1.",
  "viva-bootstrap1.",
  "viva-control1.",
  "viva-refresh1.",
] as const;
const AGENT_CREDENTIAL_REDACTION = "[redacted]";

function stripAgentOriginatedCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAgentOriginatedCredentials);
  if (typeof value === "string") return redactedAgentCredentialString(value);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isAgentCredentialKey(key)) continue;
    output[key] = stripAgentOriginatedCredentials(child);
  }
  return output;
}

function isAgentCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return AGENT_CREDENTIAL_KEYS.has(normalized) || normalized.endsWith("_token");
}

function redactedAgentCredentialString(value: string): string {
  const normalized = value.toLowerCase();
  return AGENT_CREDENTIAL_VALUE_MARKERS.some((marker) => normalized.includes(marker))
    ? AGENT_CREDENTIAL_REDACTION
    : value;
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
