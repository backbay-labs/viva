import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

export type VivaSessionRouteFailureClass = {
  error: string;
  failure_class: string;
  stage?: "pre_loop" | "session";
  terminal_reason?: string;
  token_refresh_outcome: string;
};

type VivaSessionRouteName = "refresh" | "start";
type VivaSessionRouteAction = "refresh" | "resume" | "start";
type VivaSessionRouteLogContext = {
  action?: VivaSessionRouteAction | null;
  route: VivaSessionRouteName;
};

type VivaSessionRouteLogOptions = {
  action?: VivaSessionRouteAction | null;
  logError?: string;
  logFailureClass?: string;
  logTokenRefreshOutcome?: string;
  route?: VivaSessionRouteName;
};

export type VivaSessionRouteFailureLog = Omit<VivaSessionRouteFailureClass, "stage"> & {
  action: VivaSessionRouteAction | null;
  deploy_sha: string | null;
  event: "viva_session_route_failure";
  route: VivaSessionRouteName | null;
  service: "web";
  stage: string;
  status: number;
};

export type VivaSessionRouteOutcome = {
  failure_class: null;
  session: {
    session_id: string;
    study_set_id: string;
    user_id: string;
  };
  session_token: string;
  token_refresh_outcome: string;
};

export type VivaSessionAuthFailureCode =
  | "expired"
  | "replayed"
  | "malformed"
  | "invalid_signature"
  | "identity_mismatch"
  | "access_denied";

export type VivaSessionAuthClientClass = "recoverable" | "terminal";

type VivaSessionAuthFailureProfile = {
  clientClass: VivaSessionAuthClientClass;
  evidenceFields: readonly ["failure_class", "stage", "token_refresh_outcome"];
  learnerCopyCause: "auth_failed";
  operatorCode: VivaSessionAuthFailureCode;
  retryEligible: boolean;
  stage: "session";
};

type SessionRequestPayload = {
  session_id?: unknown;
  session_bootstrap_token?: unknown;
  session_token?: unknown;
  study_set_id?: unknown;
  user_id?: unknown;
};

export type FailureControlScenario =
  | "provider_rate_limited"
  | "provider_auth_failed"
  | "provider_timeout"
  | "silent_stall"
  | "provider_malformed_stream"
  | "provider_network_disconnect"
  | "sonic_tts_timeout"
  | "recap_timeout"
  | "invalid_token"
  | "expired_token"
  | "replayed_token"
  | "malformed_token"
  | "slow_stale_socket_close"
  | "double_submit_race"
  | "mic_denied"
  | "typed_fallback";

export type SessionTokenClaims = {
  user_id: string;
  study_set_id: string;
  session_id: string;
  issued_at: number;
  not_before: number;
  expires_at: number;
  nonce: string;
  failure_control?: {
    scenario: FailureControlScenario;
    run_id: string;
    expires_at: number;
    nonce: string;
    signature: string;
  };
};

/**
 * Closed rejection set shared with Plan 05's `agent/fixtures/session-token/v1/vectors.json`
 * (manifest ID `VOICE-TOKEN-V1-VECTORS`). The fixture's exact rejection string wins at every
 * precedence boundary; Node never normalizes a fixture value.
 *
 * PLAN AMENDMENT (recorded, not silently adopted): Plan 11 Task 2 Step 1 pins this union at ten
 * values and omits `malformed_shape`. Two of the fixture's nineteen read-only cases —
 * `VOICE-TOKEN-REJECT-SEGMENT-SHAPE` and `VOICE-TOKEN-REJECT-WRONG-PREFIX` — carry exactly that
 * rejection, and Plan 05 (`2026-08-23-voice-wire-auth-contract.md` line 720) lists it first among
 * the closed rejection strings, with line 722 pinning it to a segment-count or prefix violation.
 * Under Plan 11's own rule that the Plan 05 vector rejection wins at every precedence boundary,
 * the union carries an eleventh value rather than the read-only fixture being edited or a fixture
 * value normalized in Node. The fixture is untouched. This needs a coordinator amendment row
 * before merge; it is not a lane-authored widening of the contract.
 */
export type VivaSessionAccessTokenRejection =
  | "binding_mismatch"
  | "duplicate_claim"
  | "expired"
  | "invalid_signature"
  | "invalid_time_order"
  | "malformed_json"
  | "malformed_shape"
  | "missing_claim"
  | "noncanonical_base64url"
  | "not_yet_valid"
  | "unknown_claim";

export type VivaSessionAccessTokenVerification =
  | { ok: true; claims: SessionTokenClaims }
  | { ok: false; reason: VivaSessionAccessTokenRejection };

export type SessionTokenBinding = {
  user_id: string;
  study_set_id: string;
  session_id: string;
};

type SessionAccessTokenVerificationDetail =
  | { ok: true; claims: SessionTokenClaims }
  | {
      ok: false;
      claims: SessionTokenClaims | null;
      reason: VivaSessionAccessTokenRejection;
    };

type SessionBootstrapTokenClaims = {
  expires_at: number;
  nonce: string;
  origin: string;
  purpose: "viva_session_bootstrap";
  session_id: string | null;
  study_set_id: string;
  user_id: string;
};

export type VivaLibraryControlScope = "session_history_delete" | "study_set_delete";

type LibraryControlTokenClaims = {
  expires_at: number;
  nonce: string;
  origin: string;
  purpose: "viva_library_control";
  scope: VivaLibraryControlScope;
  study_set_id: string;
  user_id: string;
  voice_session_id: string | null;
};

type CanonicalWebOrigin = { origin: string };

/**
 * Exactly one scoped agent credential per browser-facing capability. The legacy broad bearer
 * is migration input only and can never stand in for one of these on public traffic.
 */
export type AgentCredentialScope = "library_read" | "session_mint" | "library_delete";

const AGENT_SCOPE_ENV = {
  library_read: "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
  session_mint: "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
  library_delete: "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
} as const;

type VivaLibraryAction =
  | {
      available: true;
      session_id?: string | null;
      session_token?: string | null;
      same_origin_control_token?: string | null;
      control_token?: string | null;
    }
  | {
      available: false;
      unavailable_reason?: string;
    };

type VivaLibraryStudySet = {
  actions?: {
    delete?: VivaLibraryAction;
    resume?: VivaLibraryAction;
    start?: VivaLibraryAction;
  };
  concept_count?: number;
  id?: string;
  ingestion_status?: "pending" | "processing" | "ready" | "failed" | "retry";
  question_count?: number;
  user_id?: string;
};

type VivaLibrarySnapshot = {
  sessions?: unknown[];
  study_sets?: VivaLibraryStudySet[];
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type SessionAccessTokenRouteVerification =
  | { ok: true; claims: SessionTokenClaims; expired: boolean }
  | { ok: false; reason: VivaSessionAccessTokenRejection | "unavailable" };

const RATE_LIMIT_WINDOW_MS = 60_000;
const SESSION_ACCESS_TOKEN_PREFIX = "viva1";
const SESSION_ACCESS_TOKEN_MAX_BYTES = 4_096;
const SESSION_ACCESS_TOKEN_SIGNATURE_BYTES = 32;
const SESSION_ACCESS_TOKEN_MAX_CLAIM_DEPTH = 8;
const WEB_SECRET_MIN_BYTES = 32;
const WEB_OPAQUE_CREDENTIAL_MAX_BYTES = 512;
const CAPABILITY_TOKEN_MAX_BYTES = 4_096;
const SESSION_BOOTSTRAP_CLAIM_KEYS: ReadonlySet<string> = new Set([
  "expires_at",
  "nonce",
  "origin",
  "purpose",
  "session_id",
  "study_set_id",
  "user_id",
]);
const LIBRARY_CONTROL_CLAIM_KEYS: ReadonlySet<string> = new Set([
  "expires_at",
  "nonce",
  "origin",
  "purpose",
  "scope",
  "study_set_id",
  "user_id",
  "voice_session_id",
]);
const SESSION_ACCESS_TOKEN_CLAIM_KEYS = new Set([
  "user_id",
  "study_set_id",
  "session_id",
  "issued_at",
  "not_before",
  "expires_at",
  "nonce",
  "failure_control",
]);
const SESSION_ACCESS_TOKEN_FAILURE_CONTROL_KEYS = new Set([
  "scenario",
  "run_id",
  "expires_at",
  "nonce",
  "signature",
]);
const FAILURE_CONTROL_SCENARIOS = new Set<string>([
  "provider_rate_limited",
  "provider_auth_failed",
  "provider_timeout",
  "silent_stall",
  "provider_malformed_stream",
  "provider_network_disconnect",
  "sonic_tts_timeout",
  "recap_timeout",
  "invalid_token",
  "expired_token",
  "replayed_token",
  "malformed_token",
  "slow_stale_socket_close",
  "double_submit_race",
  "mic_denied",
  "typed_fallback",
]);
const WEB_SECRET_PLACEHOLDER_VALUES = new Set([
  "secret",
  "password",
  "changeme",
  "change-me",
  "placeholder",
  "example",
  "test",
]);
const SESSION_BOOTSTRAP_TOKEN_TTL_SECONDS = 5 * 60;
const SESSION_BOOTSTRAP_TOKEN_PREFIX = "viva-bootstrap1";
const SESSION_BOOTSTRAP_TOKEN_PURPOSE = "viva_session_bootstrap";
const LIBRARY_CONTROL_TOKEN_PREFIX = "viva-control1";
const LIBRARY_CONTROL_TOKEN_PURPOSE = "viva_library_control";
const DEFAULT_SESSION_BOOTSTRAP_TIMEOUT_MS = 10_000;
const PRE_LOOP_INGESTION_TERMINAL_REASON = "pre_loop_ingestion_unavailable";
const PRE_LOOP_SESSION_TERMINAL_REASON = "pre_loop_session_unavailable";
export const VIVA_SESSION_AUTH_FAILURE_PROFILES = {
  access_denied: sessionAuthFailureProfile("access_denied", "terminal", false),
  expired: sessionAuthFailureProfile("expired", "recoverable", true),
  identity_mismatch: sessionAuthFailureProfile("identity_mismatch", "terminal", false),
  invalid_signature: sessionAuthFailureProfile("invalid_signature", "terminal", false),
  malformed: sessionAuthFailureProfile("malformed", "terminal", false),
  replayed: sessionAuthFailureProfile("replayed", "terminal", false),
} as const satisfies Record<VivaSessionAuthFailureCode, VivaSessionAuthFailureProfile>;
const mintRateLimits = new Map<string, RateLimitBucket>();

export async function handleVivaSessionStart(request: NextRequest) {
  const routeContext = { route: "start" } as const;
  const guard = guardSameOrigin(request, routeContext);
  if (guard) return guard;

  const payload = await readSessionPayload(request, routeContext);
  if (!payload.ok) return payload.response;

  const userId = requiredString(payload.value.user_id);
  const studySetId = requiredString(payload.value.study_set_id);
  const sessionId = requiredString(payload.value.session_id);
  const actionName = sessionId ? "resume" : "start";
  const logContext = { action: actionName, route: "start" } as const;
  if (!userId || !studySetId) {
    return sessionJsonError(400, "invalid_session_request", "invalid", logContext);
  }
  const access = guardAllowedIdentity(userId, studySetId, logContext);
  if (access) return access;
  const bootstrap = guardSessionBootstrapCapability({
    ...logContext,
    sessionId: sessionId ?? null,
    studySetId,
    token: requiredString(payload.value.session_bootstrap_token),
    userId,
  });
  if (bootstrap) return bootstrap;
  const limit = guardMintRateLimit(request, userId, studySetId, logContext);
  if (limit) return limit;

  const minted = await mintSessionFromLibrary({
    actionName,
    route: "start",
    sessionId: sessionId ?? undefined,
    studySetId,
    userId,
  });
  if (!minted.ok) return minted.response;
  return sessionJson(
    {
      failure_class: null,
      session: minted.value.session,
      session_token: minted.value.session_token,
      token_refresh_outcome: "issued",
    },
    200,
  );
}

export async function handleVivaSessionRefresh(request: NextRequest) {
  const logContext = { action: "refresh", route: "refresh" } as const;
  const guard = guardSameOrigin(request, logContext);
  if (guard) return guard;

  const payload = await readSessionPayload(request, logContext);
  if (!payload.ok) return payload.response;

  const userId = requiredString(payload.value.user_id);
  const studySetId = requiredString(payload.value.study_set_id);
  const sessionId = requiredString(payload.value.session_id);
  const sessionToken = requiredString(payload.value.session_token);
  if (!userId || !studySetId || !sessionId || !sessionToken) {
    return sessionJsonError(400, "invalid_session_request", "invalid", logContext);
  }

  const access = guardAllowedIdentity(userId, studySetId, logContext);
  if (access) return access;

  const verification = verifySessionAccessTokenForRoute({
    allowExpired: true,
    expectedBinding: { session_id: sessionId, study_set_id: studySetId, user_id: userId },
    token: sessionToken,
  });
  if (!verification.ok) {
    if (verification.reason === "unavailable") {
      return sessionJsonError(503, "viva_session_refresh_unavailable", "failed", logContext);
    }
    return sessionAuthTerminalJsonError(
      authFailureCodeForAccessTokenRejection(verification.reason),
      logContext,
    );
  }

  const limit = guardMintRateLimit(request, userId, studySetId, logContext);
  if (limit) return limit;

  const minted = await mintSessionFromLibrary({
    actionName: "resume",
    route: "refresh",
    sessionId,
    studySetId,
    userId,
  });
  if (!minted.ok) return minted.response;
  const tokenRefreshOutcome = verification.expired ? "expired_refreshed" : "refreshed";
  return sessionJson(
    {
      failure_class: null,
      session: minted.value.session,
      session_token: minted.value.session_token,
      token_refresh_outcome: tokenRefreshOutcome,
    },
    200,
  );
}

export function resetVivaSessionMintRateLimitsForTests() {
  mintRateLimits.clear();
}

export function signVivaSessionBootstrapToken(input: {
  sessionId?: string | null;
  studySetId: string;
  userId: string;
}): string | null {
  const secret = sessionBootstrapSecret();
  const canonical = canonicalWebOrigin();
  if (!secret || !canonical.ok) return null;
  const claims: SessionBootstrapTokenClaims = {
    expires_at: Math.floor(Date.now() / 1000) + SESSION_BOOTSTRAP_TOKEN_TTL_SECONDS,
    nonce: randomUUID(),
    origin: canonical.value.origin,
    purpose: SESSION_BOOTSTRAP_TOKEN_PURPOSE,
    session_id: input.sessionId?.trim() || null,
    study_set_id: input.studySetId,
    user_id: input.userId,
  };
  return signCapabilityToken(SESSION_BOOTSTRAP_TOKEN_PREFIX, claims, secret);
}

export function signVivaLibraryControlToken(input: {
  scope: VivaLibraryControlScope;
  studySetId: string;
  userId: string;
  voiceSessionId?: string | null;
}): string | null {
  const secret = sessionBootstrapSecret();
  const canonical = canonicalWebOrigin();
  if (!secret || !canonical.ok) return null;
  const claims: LibraryControlTokenClaims = {
    expires_at: Math.floor(Date.now() / 1000) + SESSION_BOOTSTRAP_TOKEN_TTL_SECONDS,
    nonce: randomUUID(),
    origin: canonical.value.origin,
    purpose: LIBRARY_CONTROL_TOKEN_PURPOSE,
    scope: input.scope,
    study_set_id: input.studySetId,
    user_id: input.userId,
    voice_session_id: input.voiceSessionId?.trim() || null,
  };
  return signCapabilityToken(LIBRARY_CONTROL_TOKEN_PREFIX, claims, secret);
}

/** Capabilities are always signed with the active key; the previous key is verify-only. */
function signCapabilityToken(prefix: string, claims: object, secret: string): string {
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `${prefix}.${claimsPart}`;
  const signature = createHmac("sha256", utf8Bytes(secret)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function isVivaLibraryControlToken(token: string | null | undefined): boolean {
  return token?.startsWith(`${LIBRARY_CONTROL_TOKEN_PREFIX}.`) ?? false;
}

export function verifyVivaLibraryControlToken(input: {
  scope: VivaLibraryControlScope;
  studySetId: string;
  token: string;
  userId: string;
  voiceSessionId?: string | null;
}): "invalid" | "missing_secret" | "valid" {
  if (!bootstrapCapabilityVerificationKeys() || !canonicalWebOrigin().ok) return "missing_secret";
  const claims = verifyLibraryControlTokenClaims(input.token);
  if (
    !claims ||
    claims.scope !== input.scope ||
    claims.user_id !== input.userId ||
    claims.study_set_id !== input.studySetId ||
    claims.voice_session_id !== (input.voiceSessionId?.trim() || null)
  ) {
    return "invalid";
  }
  return "valid";
}

export function attachVivaSessionBootstrapTokensToLibrarySnapshot(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    userId: string;
  },
): unknown {
  if (!isRecord(value)) return value;
  const studySets = Array.isArray(value.study_sets)
    ? value.study_sets.map((studySet) =>
        attachVivaSessionBootstrapTokensToStudySet(studySet, options),
      )
    : value.study_sets;
  return { ...value, study_sets: studySets };
}

export function attachVivaLibraryControlTokensToLibrarySnapshot(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    userId: string;
  },
): unknown {
  if (!isRecord(value)) return value;
  const studySets = Array.isArray(value.study_sets)
    ? value.study_sets.map((studySet) =>
        attachVivaLibraryControlTokenToStudySetDelete(studySet, options),
      )
    : value.study_sets;
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map((session) =>
        attachVivaLibraryControlTokenToSessionDelete(session, options),
      )
    : value.sessions;
  return { ...value, sessions, study_sets: studySets };
}

function guardSameOrigin(
  request: NextRequest,
  logContext: VivaSessionRouteLogContext,
): NextResponse | null {
  const canonical = canonicalWebOrigin();
  if (!canonical.ok) return sessionConfigUnavailableResponse(logContext);
  const expectedOrigin = canonical.value.origin;
  const origin = request.headers.get("origin")?.trim();
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!origin || origin !== expectedOrigin) {
    return sessionJsonError(403, "cross_origin_session_request", "blocked", {
      ...logContext,
      failure_class: "access_denied",
    });
  }
  if (fetchSite && fetchSite !== "same-origin") {
    return sessionJsonError(403, "cross_origin_session_request", "blocked", {
      ...logContext,
      failure_class: "access_denied",
    });
  }
  return null;
}

function guardAllowedIdentity(
  userId: string,
  studySetId: string,
  logContext: VivaSessionRouteLogContext,
): NextResponse | null {
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) {
    return sessionJsonError(
      503,
      "viva_session_identity_allowlist_unavailable",
      "failed",
      logContext,
    );
  }
  if (!allowedUserIds.has(userId)) {
    return sessionAuthTerminalJsonError("access_denied", logContext);
  }
  if (!allowedStudySetIds.has(studySetId)) {
    return sessionAuthTerminalJsonError("access_denied", logContext);
  }
  return null;
}

function guardSessionBootstrapCapability(input: {
  action?: VivaSessionRouteAction | null;
  route: VivaSessionRouteName;
  sessionId: string | null;
  studySetId: string;
  token: string | null;
  userId: string;
}): NextResponse | null {
  const requirement = sessionBootstrapRequirement();
  if (!requirement.required) return null;
  if (!requirement.secret) {
    return sessionJsonError(503, "viva_session_bootstrap_unavailable", "failed", input);
  }
  if (!input.token) {
    return sessionJsonError(403, "session_bootstrap_capability_required", "blocked", {
      action: input.action,
      failure_class: "access_denied",
      route: input.route,
    });
  }
  const claims = verifySessionBootstrapTokenClaims(input.token);
  if (
    !claims ||
    claims.user_id !== input.userId ||
    claims.study_set_id !== input.studySetId ||
    claims.session_id !== input.sessionId
  ) {
    return sessionJsonError(403, "session_bootstrap_capability_required", "blocked", {
      action: input.action,
      failure_class: "access_denied",
      route: input.route,
    });
  }
  return null;
}

function guardMintRateLimit(
  request: NextRequest,
  userId: string,
  studySetId: string,
  logContext: VivaSessionRouteLogContext,
): NextResponse | null {
  const max = positiveInteger(process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE, 12);
  const now = Date.now();
  const ipKey = `ip\u0000${clientIp(request)}`;
  const identityKey = `identity\u0000${userId}\u0000${studySetId}`;
  const ipBucket = currentRateLimitBucket(ipKey, now);
  const identityBucket = currentRateLimitBucket(identityKey, now);
  if (ipBucket.count >= max || identityBucket.count >= max) {
    return sessionJsonError(429, "session_mint_rate_limited", "blocked", {
      ...logContext,
      failure_class: "rate_limit",
    });
  }
  ipBucket.count += 1;
  identityBucket.count += 1;
  mintRateLimits.set(ipKey, ipBucket);
  mintRateLimits.set(identityKey, identityBucket);
  return null;
}

function currentRateLimitBucket(key: string, now: number): RateLimitBucket {
  const current = mintRateLimits.get(key);
  return current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
}

async function readSessionPayload(
  request: NextRequest,
  logContext: VivaSessionRouteLogContext,
): Promise<
  | { ok: true; value: SessionRequestPayload }
  | { ok: false; response: NextResponse<VivaSessionRouteFailureClass> }
> {
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        response: sessionJsonError(400, "invalid_session_request", "invalid", logContext),
      };
    }
    return { ok: true, value: value as SessionRequestPayload };
  } catch {
    return {
      ok: false,
      response: sessionJsonError(400, "invalid_session_request", "invalid", logContext),
    };
  }
}

async function mintSessionFromLibrary(input: {
  actionName: "resume" | "start";
  route: VivaSessionRouteName;
  sessionId?: string;
  studySetId: string;
  userId: string;
}): Promise<
  | {
      ok: true;
      value: {
        session: VivaSessionRouteOutcome["session"];
        session_token: string;
      };
    }
  | { ok: false; response: NextResponse<VivaSessionRouteFailureClass> }
> {
  const agentBaseUrl = serverAgentBaseUrl();
  const bearerToken = vivaAgentScopedCredential("session_mint");
  const canonical = canonicalWebOrigin();
  const canonicalOrigin = canonical.ok ? canonical.value.origin : null;
  const logContext = { action: input.actionName, route: input.route } as const;
  if (!agentBaseUrl || !bearerToken || !canonicalOrigin) {
    return {
      ok: false,
      response: sessionPreLoopJsonError(
        503,
        "viva_session_agent_unavailable",
        "failed",
        "session_bootstrap_unavailable",
        PRE_LOOP_SESSION_TERMINAL_REASON,
        logContext,
      ),
    };
  }

  const upstream = agentLibraryUrl(agentBaseUrl, input.userId);
  if (!upstream) {
    return {
      ok: false,
      response: sessionPreLoopJsonError(
        503,
        "viva_session_agent_unavailable",
        "failed",
        "session_bootstrap_unavailable",
        PRE_LOOP_SESSION_TERMINAL_REASON,
        logContext,
      ),
    };
  }
  let timedOut = false;
  let snapshot: VivaLibrarySnapshot;
  const timeout = sessionBootstrapTimeoutMs();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  try {
    const response = await fetch(upstream, {
      cache: "no-store",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        origin: canonicalOrigin,
      },
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        response: sessionPreLoopJsonError(
          502,
          "viva_session_agent_unavailable",
          "failed",
          "session_bootstrap_unavailable",
          PRE_LOOP_SESSION_TERMINAL_REASON,
          logContext,
        ),
      };
    }
    snapshot = await readJson(response);
    if (timedOut) {
      return {
        ok: false,
        response: sessionPreLoopJsonError(
          504,
          "viva_session_agent_timeout",
          "failed",
          "session_bootstrap_unavailable",
          PRE_LOOP_SESSION_TERMINAL_REASON,
          logContext,
        ),
      };
    }
  } catch {
    return {
      ok: false,
      response: sessionPreLoopJsonError(
        timedOut ? 504 : 502,
        timedOut ? "viva_session_agent_timeout" : "viva_session_agent_unavailable",
        "failed",
        "session_bootstrap_unavailable",
        PRE_LOOP_SESSION_TERMINAL_REASON,
        logContext,
      ),
    };
  } finally {
    clearTimeout(timeoutId);
  }

  const studySet = snapshot.study_sets?.find(
    (entry) => entry.id === input.studySetId && entry.user_id === input.userId,
  );
  const preLoopStudySetError = studySet
    ? preLoopStudySetUnavailableResponse(studySet, logContext)
    : null;
  if (preLoopStudySetError) {
    return {
      ok: false,
      response: preLoopStudySetError,
    };
  }
  const action = studySet?.actions?.[input.actionName];
  if (
    !studySet ||
    !action?.available ||
    !action.session_id ||
    !action.session_token ||
    (input.sessionId && action.session_id !== input.sessionId)
  ) {
    return {
      ok: false,
      response: sessionPreLoopJsonError(
        409,
        "session_mint_unavailable",
        "unavailable",
        "session_bootstrap_unavailable",
        PRE_LOOP_SESSION_TERMINAL_REASON,
        logContext,
      ),
    };
  }
  return {
    ok: true,
    value: {
      session: {
        session_id: action.session_id,
        study_set_id: input.studySetId,
        user_id: input.userId,
      },
      session_token: action.session_token,
    },
  };
}

function preLoopStudySetUnavailableResponse(
  studySet: VivaLibraryStudySet,
  logContext: VivaSessionRouteLogContext,
): NextResponse<VivaSessionRouteFailureClass> | null {
  if (studySet.ingestion_status === "failed") {
    return sessionPreLoopJsonError(
      409,
      "study_set_ingestion_failed",
      "blocked",
      "pre_loop_unavailable",
      PRE_LOOP_INGESTION_TERMINAL_REASON,
      logContext,
    );
  }
  if (
    studySet.ingestion_status === "pending" ||
    studySet.ingestion_status === "processing" ||
    studySet.ingestion_status === "retry"
  ) {
    return sessionPreLoopJsonError(
      409,
      `study_set_ingestion_${studySet.ingestion_status}`,
      "blocked",
      "pre_loop_unavailable",
      PRE_LOOP_INGESTION_TERMINAL_REASON,
      logContext,
    );
  }
  if (
    studySet.ingestion_status === "ready" &&
    (nonPositiveCount(studySet.concept_count) || nonPositiveCount(studySet.question_count))
  ) {
    return sessionPreLoopJsonError(
      409,
      "study_set_empty",
      "blocked",
      "pre_loop_unavailable",
      PRE_LOOP_INGESTION_TERMINAL_REASON,
      logContext,
    );
  }
  return null;
}

function nonPositiveCount(value: number | undefined): boolean {
  return typeof value === "number" && value <= 0;
}

async function readJson(response: Response): Promise<VivaLibrarySnapshot> {
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object") return {};
    return value as VivaLibrarySnapshot;
  } catch {
    return {};
  }
}

/**
 * Strict session access-token verification pinned to Plan 05's shared vectors.
 *
 * Ordered exactly as Plan 05 pins it: bounded size, `viva1.<claims>.<signature>` framing,
 * canonical unpadded base64url on both segments, constant-time 32-byte HMAC, fatal UTF-8
 * decode, duplicate-key scan before `JSON.parse`, exact claim shapes, time ordering and
 * window, then identity binding. Returns a closed result; it never throws.
 */
export function verifyVivaSessionAccessToken(input: {
  token: string;
  secretBytes: Uint8Array;
  now: number;
  expectedBinding: SessionTokenBinding;
  clockSkewSeconds: number;
}): VivaSessionAccessTokenVerification {
  const detail = verifySessionAccessTokenDetailed(input);
  return detail.ok ? { ok: true, claims: detail.claims } : { ok: false, reason: detail.reason };
}

function verifySessionAccessTokenDetailed(input: {
  token: string;
  secretBytes: Uint8Array;
  now: number;
  expectedBinding: SessionTokenBinding;
  clockSkewSeconds: number;
}): SessionAccessTokenVerificationDetail {
  const rejected = (
    reason: VivaSessionAccessTokenRejection,
    claims: SessionTokenClaims | null = null,
  ): SessionAccessTokenVerificationDetail => ({ claims, ok: false, reason });

  if (Buffer.byteLength(input.token, "utf8") > SESSION_ACCESS_TOKEN_MAX_BYTES) {
    return rejected("malformed_json");
  }

  const segments = input.token.split(".");
  if (segments.length !== 3 || segments[0] !== SESSION_ACCESS_TOKEN_PREFIX) {
    return rejected("malformed_shape");
  }
  const claimsSegment = segments[1] ?? "";
  const signatureSegment = segments[2] ?? "";

  const claimsBytes = decodeCanonicalBase64Url(claimsSegment);
  if (!claimsBytes) return rejected("noncanonical_base64url");
  const signatureBytes = decodeCanonicalBase64Url(signatureSegment);
  if (!signatureBytes) return rejected("noncanonical_base64url");

  if (signatureBytes.length !== SESSION_ACCESS_TOKEN_SIGNATURE_BYTES) {
    return rejected("invalid_signature");
  }
  const expectedSignature = createHmac("sha256", input.secretBytes)
    .update(`${SESSION_ACCESS_TOKEN_PREFIX}.${claimsSegment}`)
    .digest();
  if (
    expectedSignature.length !== signatureBytes.length ||
    !timingSafeEqual(signatureBytes, expectedSignature)
  ) {
    return rejected("invalid_signature");
  }

  let claimsText: string;
  try {
    claimsText = new TextDecoder("utf-8", { fatal: true }).decode(claimsBytes);
  } catch {
    return rejected("malformed_json");
  }

  const scan = scanJsonForDuplicateObjectKeys(claimsText);
  if (!scan.ok) return rejected(scan.reason);

  let parsed: unknown;
  try {
    parsed = JSON.parse(claimsText) as unknown;
  } catch {
    return rejected("malformed_json");
  }
  if (!isRecord(parsed)) return rejected("malformed_json");

  for (const key of Object.keys(parsed)) {
    if (!SESSION_ACCESS_TOKEN_CLAIM_KEYS.has(key)) return rejected("unknown_claim");
  }

  const userId = nonEmptyClaimString(parsed.user_id);
  const studySetId = nonEmptyClaimString(parsed.study_set_id);
  const sessionId = nonEmptyClaimString(parsed.session_id);
  const nonce = nonEmptyClaimString(parsed.nonce);
  const issuedAt = safeUnixTimestampClaim(parsed.issued_at);
  const notBefore = safeUnixTimestampClaim(parsed.not_before);
  const expiresAt = safeUnixTimestampClaim(parsed.expires_at);
  if (
    userId === null ||
    studySetId === null ||
    sessionId === null ||
    nonce === null ||
    issuedAt === null ||
    notBefore === null ||
    expiresAt === null
  ) {
    return rejected("missing_claim");
  }

  let failureControl: SessionTokenClaims["failure_control"];
  if (parsed.failure_control !== undefined) {
    const control = parsed.failure_control;
    if (!isRecord(control)) return rejected("missing_claim");
    for (const key of Object.keys(control)) {
      if (!SESSION_ACCESS_TOKEN_FAILURE_CONTROL_KEYS.has(key)) return rejected("unknown_claim");
    }
    const scenario = nonEmptyClaimString(control.scenario);
    const runId = nonEmptyClaimString(control.run_id);
    const controlNonce = nonEmptyClaimString(control.nonce);
    const controlSignature = nonEmptyClaimString(control.signature);
    const controlExpiresAt = safeUnixTimestampClaim(control.expires_at);
    if (
      scenario === null ||
      !FAILURE_CONTROL_SCENARIOS.has(scenario) ||
      runId === null ||
      controlNonce === null ||
      controlSignature === null ||
      controlExpiresAt === null
    ) {
      return rejected("missing_claim");
    }
    failureControl = {
      expires_at: controlExpiresAt,
      nonce: controlNonce,
      run_id: runId,
      scenario: scenario as FailureControlScenario,
      signature: controlSignature,
    };
  }

  const claims: SessionTokenClaims = {
    expires_at: expiresAt,
    issued_at: issuedAt,
    nonce,
    not_before: notBefore,
    session_id: sessionId,
    study_set_id: studySetId,
    user_id: userId,
    ...(failureControl ? { failure_control: failureControl } : {}),
  };

  if (issuedAt > notBefore || notBefore > expiresAt) {
    return rejected("invalid_time_order", claims);
  }
  const skew = Number.isSafeInteger(input.clockSkewSeconds)
    ? Math.max(0, input.clockSkewSeconds)
    : 0;
  if (input.now + skew < notBefore) return rejected("not_yet_valid", claims);
  if (input.now - skew >= expiresAt) return rejected("expired", claims);

  if (
    userId !== input.expectedBinding.user_id ||
    studySetId !== input.expectedBinding.study_set_id ||
    sessionId !== input.expectedBinding.session_id
  ) {
    return rejected("binding_mismatch", claims);
  }

  return { claims, ok: true };
}

/**
 * Canonical unpadded base64url: the segment must use only the URL alphabet and must be the
 * exact re-encoding of the bytes it decodes to. Padding and trailing-bit variants are rejected.
 */
function decodeCanonicalBase64Url(segment: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  if (segment.length % 4 === 1) return null;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : null;
}

/**
 * String/escape/nesting-aware JSON scanner. It records object keys and reports a duplicate
 * before `JSON.parse` ever runs; a structural defect is reported as malformed JSON.
 */
function scanJsonForDuplicateObjectKeys(
  text: string,
): { ok: true } | { ok: false; reason: "duplicate_claim" | "malformed_json" } {
  let index = 0;
  let duplicateFound = false;

  const skipWhitespace = () => {
    while (index < text.length) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        index += 1;
        continue;
      }
      return;
    }
  };

  const readString = (): string | null => {
    if (text[index] !== '"') return null;
    index += 1;
    let value = "";
    while (index < text.length) {
      const char = text[index] as string;
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === "\\") {
        const escaped = text[index + 1];
        if (escaped === undefined) return null;
        if (escaped === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
          continue;
        }
        const mapped = JSON_SIMPLE_ESCAPES[escaped];
        if (mapped === undefined) return null;
        value += mapped;
        index += 2;
        continue;
      }
      if (char < " ") return null;
      value += char;
      index += 1;
    }
    return null;
  };

  const readValue = (depth: number): boolean => {
    if (depth > SESSION_ACCESS_TOKEN_MAX_CLAIM_DEPTH) return false;
    skipWhitespace();
    const char = text[index];
    if (char === undefined) return false;
    if (char === '"') return readString() !== null;
    if (char === "{") {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return true;
      }
      while (true) {
        skipWhitespace();
        const key = readString();
        if (key === null) return false;
        if (keys.has(key)) duplicateFound = true;
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") return false;
        index += 1;
        if (!readValue(depth + 1)) return false;
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return true;
        }
        return false;
      }
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return true;
      }
      while (true) {
        if (!readValue(depth + 1)) return false;
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return true;
        }
        return false;
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return true;
      }
    }
    const number = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (number && number[0].length > 0) {
      index += number[0].length;
      return true;
    }
    return false;
  };

  if (!readValue(0)) return { ok: false, reason: "malformed_json" };
  skipWhitespace();
  if (index !== text.length) return { ok: false, reason: "malformed_json" };
  return duplicateFound ? { ok: false, reason: "duplicate_claim" } : { ok: true };
}

const JSON_SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function nonEmptyClaimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeUnixTimestampClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Web-owned credential strength gate. Never logs the value, a prefix, its length, or the
 * environment variable name; callers map a failure onto the coarse public error table.
 */
export type VivaWebSecretValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "placeholder" | "repeated_byte" | "too_long" | "too_short" };

export function validateVivaWebSecret(
  value: string | undefined,
  options: { maxBytes?: number } = {},
): VivaWebSecretValidation {
  const raw = value?.trim();
  if (!raw) return { ok: false, reason: "missing" };
  if (WEB_SECRET_PLACEHOLDER_VALUES.has(raw.toLowerCase())) {
    return { ok: false, reason: "placeholder" };
  }
  if (/<[^>]*>/.test(raw)) return { ok: false, reason: "placeholder" };
  const bytes = Buffer.from(raw, "utf8");
  const first = bytes[0];
  if (first !== undefined && bytes.every((byte) => byte === first)) {
    return { ok: false, reason: "repeated_byte" };
  }
  if (bytes.length < WEB_SECRET_MIN_BYTES) return { ok: false, reason: "too_short" };
  if (options.maxBytes !== undefined && bytes.length > options.maxBytes) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, value: raw };
}

/**
 * Web-owned credential validation. Task 2 Step 3 names four families for this validator: the
 * active and previous HMAC keys, the three scoped agent bearers, and the shared security-store
 * credential `VIVA_SESSION_SECURITY_STORE_REST_TOKEN`.
 *
 * The first three are validated here today. The fourth is DEFERRED TO TASK 4, which introduces
 * the shared `SessionSecurityStore` adapter that is its only reader: validating it before that
 * reader exists would be inert configuration that no route can act on. Task 4 must call this
 * function for it with `maxBytes: WEB_OPAQUE_CREDENTIAL_MAX_BYTES`, exactly as the scoped
 * bearers do. Recorded here rather than only in the lane report so the obligation cannot be
 * silently dropped when Task 4 dispatches.
 */
function validatedSecret(name: string, options: { maxBytes?: number } = {}): string | null {
  const validation = validateVivaWebSecret(process.env[name], options);
  return validation.ok ? validation.value : null;
}

/**
 * The single canonical web-origin authority. Nothing in this lane derives an origin from an
 * `Origin`, `Host`, `Forwarded`, or `X-Forwarded-Proto` header, so no request header can move
 * the origin a capability is bound to.
 */
function canonicalWebOrigin():
  | { ok: true; value: CanonicalWebOrigin }
  | { ok: false; reason: "missing" | "invalid" | "insecure_public" } {
  const raw = process.env.VIVA_WEB_CANONICAL_ORIGIN?.trim();
  if (!raw) return { ok: false, reason: "missing" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalid" };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: "invalid" };
  }
  if (url.origin === "null" || url.origin !== raw) return { ok: false, reason: "invalid" };
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return { ok: false, reason: "insecure_public" };
  }
  return { ok: true, value: { origin: url.origin } };
}

/** Canonical origin for route handlers outside this module; null when unconfigured or weak. */
export function vivaCanonicalWebOrigin(): string | null {
  const canonical = canonicalWebOrigin();
  return canonical.ok ? canonical.value.origin : null;
}

/** Mutating browser routes require an exact canonical `Origin` and a same-origin fetch site. */
export function isVivaCanonicalMutatingRequest(request: NextRequest): boolean {
  const canonical = canonicalWebOrigin();
  if (!canonical.ok) return false;
  const origin = request.headers.get("origin")?.trim();
  if (!origin || origin !== canonical.value.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  return !fetchSite || fetchSite === "same-origin";
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  const parsed = octets.slice(1).map((value) => Number.parseInt(value, 10));
  return parsed.every((value) => value >= 0 && value <= 255) && parsed[0] === 127;
}

function isLoopbackAgentUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Least-privilege service credential selection. A scoped bearer is required; the legacy broad
 * bearer is accepted only behind the explicit migration escape hatch AND a loopback agent URL.
 *
 * A scoped credential that is configured but weak fails closed. Only an entirely absent scoped
 * credential reaches the migration escape hatch, so a misconfigured deployment can never widen
 * its own authority from least-privilege back to the legacy migration credential by degrading.
 */
export function vivaAgentScopedCredential(scope: AgentCredentialScope): string | null {
  const scoped = validateVivaWebSecret(process.env[AGENT_SCOPE_ENV[scope]], {
    maxBytes: WEB_OPAQUE_CREDENTIAL_MAX_BYTES,
  });
  if (scoped.ok) return scoped.value;
  if (scoped.reason !== "missing") return null;
  return legacyAgentRestBearer();
}

function legacyAgentRestBearer(): string | null {
  if (process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER?.trim() !== "1") return null;
  if (!isLoopbackAgentUrl(serverAgentBaseUrl())) return null;
  const raw = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  if (!raw) return null;
  return Buffer.byteLength(raw, "utf8") <= WEB_OPAQUE_CREDENTIAL_MAX_BYTES ? raw : null;
}

/**
 * Active plus verify-only previous HMAC keys, converted to UTF-8 bytes exactly once after
 * validation. An explicitly present but weak previous key fails configuration rather than
 * silently falling back to the active key alone.
 */
function sessionAccessTokenVerificationKeys(): Uint8Array[] | null {
  return rotatingHmacKeys(
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET",
  );
}

function rotatingHmacKeys(activeName: string, previousName: string): Uint8Array[] | null {
  const active = validatedSecret(activeName);
  if (!active) return null;
  const keys = [utf8Bytes(active)];
  const previousRaw = process.env[previousName]?.trim();
  if (previousRaw) {
    const previous = validateVivaWebSecret(previousRaw);
    if (!previous.ok) return null;
    keys.push(utf8Bytes(previous.value));
  }
  return keys;
}

function utf8Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf8"));
}

/**
 * Route wrapper: loads active/previous env secrets and calls the pure verifier with
 * `clockSkewSeconds: 0`. Only a signature failure retries the previous verification key.
 */
function verifySessionAccessTokenForRoute(input: {
  token: string;
  expectedBinding: SessionTokenBinding;
  allowExpired: boolean;
}): SessionAccessTokenRouteVerification {
  const keys = sessionAccessTokenVerificationKeys();
  if (!keys) return { ok: false, reason: "unavailable" };
  const now = Math.floor(Date.now() / 1000);
  let last: SessionAccessTokenVerificationDetail | null = null;
  for (const secretBytes of keys) {
    const detail = verifySessionAccessTokenDetailed({
      clockSkewSeconds: 0,
      expectedBinding: input.expectedBinding,
      now,
      secretBytes,
      token: input.token,
    });
    if (detail.ok) return { claims: detail.claims, expired: false, ok: true };
    last = detail;
    if (detail.reason !== "invalid_signature") break;
  }
  if (!last || last.ok) return { ok: false, reason: "unavailable" };
  if (input.allowExpired && last.reason === "expired" && last.claims) {
    // Binding is enforced after the time window, so an expired token still has to prove
    // its identity here before the route treats expiry as recoverable.
    if (
      last.claims.user_id !== input.expectedBinding.user_id ||
      last.claims.study_set_id !== input.expectedBinding.study_set_id ||
      last.claims.session_id !== input.expectedBinding.session_id
    ) {
      return { ok: false, reason: "binding_mismatch" };
    }
    return { claims: last.claims, expired: true, ok: true };
  }
  return { ok: false, reason: last.reason };
}

function sessionAuthFailureProfile(
  operatorCode: VivaSessionAuthFailureCode,
  clientClass: VivaSessionAuthClientClass,
  retryEligible: boolean,
): VivaSessionAuthFailureProfile {
  return {
    clientClass,
    evidenceFields: ["failure_class", "stage", "token_refresh_outcome"],
    learnerCopyCause: "auth_failed",
    operatorCode,
    retryEligible,
    stage: "session",
  };
}

function authFailureCodeForAccessTokenRejection(
  reason: VivaSessionAccessTokenRejection,
): Exclude<VivaSessionAuthFailureCode, "expired"> {
  switch (reason) {
    case "binding_mismatch":
      return "identity_mismatch";
    case "invalid_signature":
      return "invalid_signature";
    default:
      return "malformed";
  }
}

function sessionAuthTerminalJsonError(
  operatorCode: Exclude<VivaSessionAuthFailureCode, "expired">,
  logContext?: VivaSessionRouteLogContext,
): NextResponse<VivaSessionRouteFailureClass> {
  const profile = VIVA_SESSION_AUTH_FAILURE_PROFILES[operatorCode];
  if (profile.clientClass !== "terminal") {
    return sessionJsonError(503, "viva_session_refresh_unavailable", "failed", logContext);
  }
  return sessionJsonError(401, "session_auth_terminal", "terminal", {
    ...logContext,
    failure_class: "session_auth_failure",
    logError: terminalAuthLogError(operatorCode),
    logFailureClass: "session_auth_failure",
    logTokenRefreshOutcome: terminalAuthLogTokenRefreshOutcome(operatorCode),
  });
}

/**
 * Route-specific 503 for a missing/weak canonical origin or scoped service credential.
 * Never names the environment variable or reflects its value.
 */
function sessionConfigUnavailableResponse(
  logContext: VivaSessionRouteLogContext,
): NextResponse<VivaSessionRouteFailureClass> {
  if (logContext.route === "refresh") {
    return sessionJsonError(503, "viva_session_refresh_unavailable", "failed", logContext);
  }
  return sessionPreLoopJsonError(
    503,
    "viva_session_agent_unavailable",
    "failed",
    "session_bootstrap_unavailable",
    PRE_LOOP_SESSION_TERMINAL_REASON,
    logContext,
  );
}

function sessionPreLoopJsonError(
  status: number,
  error: string,
  tokenRefreshOutcome: string,
  failureClass: string,
  terminalReason: string,
  logContext: VivaSessionRouteLogContext | null = null,
): NextResponse<VivaSessionRouteFailureClass> {
  return sessionJsonError(status, error, tokenRefreshOutcome, {
    ...(logContext ?? {}),
    failure_class: failureClass,
    stage: "pre_loop",
    terminal_reason: terminalReason,
  });
}

function sessionJson(
  body: VivaSessionRouteOutcome,
  status: number,
): NextResponse<VivaSessionRouteOutcome> {
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function sessionJsonError(
  status: number,
  error: string,
  tokenRefreshOutcome: string,
  options: {
    action?: VivaSessionRouteAction | null;
    failure_class?: string;
    logError?: string;
    logFailureClass?: string;
    logTokenRefreshOutcome?: string;
    route?: VivaSessionRouteName;
    stage?: "pre_loop" | "session";
    terminal_reason?: string;
  } = {},
): NextResponse<VivaSessionRouteFailureClass> {
  const body = {
    error,
    failure_class: options.failure_class ?? "session_bootstrap_failed",
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.terminal_reason ? { terminal_reason: options.terminal_reason } : {}),
    token_refresh_outcome: tokenRefreshOutcome,
  };
  emitVivaSessionRouteFailureLog(
    {
      error: options.logError ?? body.error,
      failure_class: options.logFailureClass ?? body.failure_class,
      token_refresh_outcome: options.logTokenRefreshOutcome ?? body.token_refresh_outcome,
    },
    status,
    options,
  );
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

export function vivaSessionRouteFailureLogPayload(
  body: VivaSessionRouteFailureClass,
  status: number,
  context: { action?: VivaSessionRouteAction | null; route?: VivaSessionRouteName } = {},
): VivaSessionRouteFailureLog {
  return {
    ...body,
    action: context.action ?? null,
    deploy_sha: deploymentSha(),
    event: "viva_session_route_failure",
    route: context.route ?? null,
    service: "web",
    stage: body.stage ?? sessionFailureStage(body.failure_class),
    status,
  };
}

function emitVivaSessionRouteFailureLog(
  body: VivaSessionRouteFailureClass,
  status: number,
  context: VivaSessionRouteLogOptions,
) {
  const payload = vivaSessionRouteFailureLogPayload(body, status, context);
  console.warn(JSON.stringify(payload));
}

function terminalAuthLogError(operatorCode: Exclude<VivaSessionAuthFailureCode, "expired">) {
  return operatorCode === "identity_mismatch"
    ? "invalid_session_identity"
    : "invalid_session_token";
}

function terminalAuthLogTokenRefreshOutcome(
  operatorCode: Exclude<VivaSessionAuthFailureCode, "expired">,
) {
  switch (operatorCode) {
    case "identity_mismatch":
      return "identity_mismatch";
    case "invalid_signature":
      return "invalid_rejected";
    case "malformed":
      return "malformed_rejected";
    case "replayed":
      return "replayed_rejected";
    case "access_denied":
      return "access_denied";
  }
}

function sessionFailureStage(failureClass: string): string {
  if (
    failureClass === "session_auth_terminal" ||
    failureClass === "session_auth_failure" ||
    failureClass === "auth_material_failure" ||
    failureClass === "identity_mismatch" ||
    failureClass === "malformed_token"
  ) {
    return "session_auth";
  }
  if (failureClass === "access_denied") return "access";
  if (failureClass === "rate_limit") return "admission";
  return "session_bootstrap";
}

function deploymentSha(): string | null {
  for (const name of [
    "VERCEL_GIT_COMMIT_SHA",
    "RAILWAY_GIT_COMMIT_SHA",
    "GITHUB_SHA",
    "SOURCE_VERSION",
  ]) {
    const value = process.env[name]?.trim();
    if (value) return value.slice(0, 64);
  }
  return null;
}

function clientIp(request: NextRequest): string {
  const metadataIp = (request as { ip?: unknown }).ip;
  if (typeof metadataIp === "string" && metadataIp.trim()) return metadataIp.trim();
  const trustedPlatformIp =
    request.headers.get("x-vercel-forwarded-for")?.split(",").at(-1)?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("true-client-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim();
  if (trustedPlatformIp) return trustedPlatformIp;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return forwarded || "unknown";
}

function serverAgentBaseUrl(): string | null {
  const value = process.env.VIVA_AGENT_HTTP_URL?.trim();
  return value || null;
}

function sessionBootstrapRequirement(): { required: boolean; secret: string | null } {
  const agentBaseUrl = serverAgentBaseUrl();
  const mintCredential = vivaAgentScopedCredential("session_mint");
  if (!agentBaseUrl || !mintCredential) {
    return { required: false, secret: null };
  }
  return { required: true, secret: sessionBootstrapSecret() };
}

/**
 * Bootstrap/control capability signing key. It has its own active/previous pair and never
 * borrows the session access-token key: one key, one purpose.
 */
function sessionBootstrapSecret(): string | null {
  return validatedSecret("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET");
}

/**
 * Bootstrap/control capability verification keys: active plus verify-only previous. Signing
 * always uses the active key (see `signCapabilityToken`).
 */
function bootstrapCapabilityVerificationKeys(): Uint8Array[] | null {
  return rotatingHmacKeys(
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET",
  );
}

/**
 * Shared strict capability decoding. Reuses the Task 2 bounded canonical segment decoder and
 * duplicate-key scanner, then enforces the exact top-level key set for the capability kind.
 * Every structural, signature, or key-set failure returns null so callers can map them onto a
 * single coarse public error.
 */
function verifySignedCapabilityClaims(input: {
  token: string;
  prefix: string;
  allowedKeys: ReadonlySet<string>;
}): Record<string, unknown> | null {
  if (Buffer.byteLength(input.token, "utf8") > CAPABILITY_TOKEN_MAX_BYTES) return null;
  const segments = input.token.split(".");
  if (segments.length !== 3 || segments[0] !== input.prefix) return null;
  const claimsSegment = segments[1] ?? "";
  const signatureSegment = segments[2] ?? "";
  const claimsBytes = decodeCanonicalBase64Url(claimsSegment);
  const signatureBytes = decodeCanonicalBase64Url(signatureSegment);
  if (!claimsBytes || !signatureBytes) return null;
  if (signatureBytes.length !== SESSION_ACCESS_TOKEN_SIGNATURE_BYTES) return null;

  const keys = bootstrapCapabilityVerificationKeys();
  if (!keys) return null;
  const signedPayload = `${input.prefix}.${claimsSegment}`;
  const matched = keys.some((secretBytes) => {
    const expected = createHmac("sha256", secretBytes).update(signedPayload).digest();
    return expected.length === signatureBytes.length && timingSafeEqual(signatureBytes, expected);
  });
  if (!matched) return null;

  let claimsText: string;
  try {
    claimsText = new TextDecoder("utf-8", { fatal: true }).decode(claimsBytes);
  } catch {
    return null;
  }
  if (!scanJsonForDuplicateObjectKeys(claimsText).ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimsText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const actual = Object.keys(parsed);
  if (actual.length !== input.allowedKeys.size) return null;
  if (actual.some((key) => !input.allowedKeys.has(key))) return null;
  return parsed;
}

function verifySessionBootstrapTokenClaims(token: string): SessionBootstrapTokenClaims | null {
  const record = verifySignedCapabilityClaims({
    allowedKeys: SESSION_BOOTSTRAP_CLAIM_KEYS,
    prefix: SESSION_BOOTSTRAP_TOKEN_PREFIX,
    token,
  });
  if (!record) return null;
  const canonical = canonicalWebOrigin();
  if (!canonical.ok) return null;
  const expiresAt = safeUnixTimestampClaim(record.expires_at);
  const nonce = nonEmptyClaimString(record.nonce);
  const origin = nonEmptyClaimString(record.origin);
  const studySetId = nonEmptyClaimString(record.study_set_id);
  const userId = nonEmptyClaimString(record.user_id);
  const sessionId = record.session_id === null ? null : nonEmptyClaimString(record.session_id);
  if (
    expiresAt === null ||
    expiresAt <= Math.floor(Date.now() / 1000) ||
    nonce === null ||
    origin === null ||
    origin !== canonical.value.origin ||
    record.purpose !== SESSION_BOOTSTRAP_TOKEN_PURPOSE ||
    studySetId === null ||
    userId === null ||
    (record.session_id !== null && sessionId === null)
  ) {
    return null;
  }
  return {
    expires_at: expiresAt,
    nonce,
    origin,
    purpose: SESSION_BOOTSTRAP_TOKEN_PURPOSE,
    session_id: sessionId,
    study_set_id: studySetId,
    user_id: userId,
  };
}

function verifyLibraryControlTokenClaims(token: string): LibraryControlTokenClaims | null {
  const record = verifySignedCapabilityClaims({
    allowedKeys: LIBRARY_CONTROL_CLAIM_KEYS,
    prefix: LIBRARY_CONTROL_TOKEN_PREFIX,
    token,
  });
  if (!record) return null;
  const canonical = canonicalWebOrigin();
  if (!canonical.ok) return null;
  const expiresAt = safeUnixTimestampClaim(record.expires_at);
  const nonce = nonEmptyClaimString(record.nonce);
  const origin = nonEmptyClaimString(record.origin);
  const studySetId = nonEmptyClaimString(record.study_set_id);
  const userId = nonEmptyClaimString(record.user_id);
  const scope =
    record.scope === "session_history_delete" || record.scope === "study_set_delete"
      ? record.scope
      : null;
  const voiceSessionId =
    record.voice_session_id === null ? null : nonEmptyClaimString(record.voice_session_id);
  if (
    expiresAt === null ||
    expiresAt <= Math.floor(Date.now() / 1000) ||
    nonce === null ||
    origin === null ||
    origin !== canonical.value.origin ||
    record.purpose !== LIBRARY_CONTROL_TOKEN_PURPOSE ||
    scope === null ||
    studySetId === null ||
    userId === null ||
    (record.voice_session_id !== null && voiceSessionId === null)
  ) {
    return null;
  }
  // `voice_session_id` is null only for study-set deletion; session history deletion must
  // name the session it is allowed to remove.
  if (scope === "study_set_delete" ? voiceSessionId !== null : voiceSessionId === null) {
    return null;
  }
  return {
    expires_at: expiresAt,
    nonce,
    origin,
    purpose: LIBRARY_CONTROL_TOKEN_PURPOSE,
    scope,
    study_set_id: studySetId,
    user_id: userId,
    voice_session_id: voiceSessionId,
  };
}

function attachVivaSessionBootstrapTokensToStudySet(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    userId: string;
  },
): unknown {
  if (!isRecord(value)) return value;
  const id = requiredString(value.id);
  const userId = requiredString(value.user_id);
  if (
    !id ||
    userId !== options.userId ||
    (options.allowedStudySetIds && !options.allowedStudySetIds.has(id)) ||
    !isRecord(value.actions)
  ) {
    return value;
  }
  return {
    ...value,
    actions: {
      ...value.actions,
      resume: attachVivaSessionBootstrapTokenToAction(value.actions.resume, {
        sessionId: sessionIdFromAction(value.actions.resume),
        studySetId: id,
        userId: options.userId,
      }),
      start: attachVivaSessionBootstrapTokenToAction(value.actions.start, {
        sessionId: null,
        studySetId: id,
        userId: options.userId,
      }),
    },
  };
}

function attachVivaLibraryControlTokenToStudySetDelete(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    userId: string;
  },
): unknown {
  if (!isRecord(value)) return value;
  const id = requiredString(value.id);
  const userId = requiredString(value.user_id);
  if (
    !id ||
    userId !== options.userId ||
    (options.allowedStudySetIds && !options.allowedStudySetIds.has(id)) ||
    !isRecord(value.actions)
  ) {
    return value;
  }
  return {
    ...value,
    actions: {
      ...value.actions,
      delete: attachVivaLibraryControlTokenToAction(value.actions.delete, {
        scope: "study_set_delete",
        studySetId: id,
        userId: options.userId,
        voiceSessionId: null,
      }),
    },
  };
}

function attachVivaLibraryControlTokenToSessionDelete(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    userId: string;
  },
): unknown {
  if (!isRecord(value)) return value;
  const studySetId = requiredString(value.study_set_id);
  const userId = requiredString(value.user_id);
  const voiceSessionId = requiredString(value.voice_session_id);
  if (
    !studySetId ||
    !voiceSessionId ||
    userId !== options.userId ||
    (options.allowedStudySetIds && !options.allowedStudySetIds.has(studySetId))
  ) {
    return value;
  }
  const token = signVivaLibraryControlToken({
    scope: "session_history_delete",
    studySetId,
    userId: options.userId,
    voiceSessionId,
  });
  if (!token) return value;
  const actions = isRecord(value.actions) ? value.actions : {};
  return {
    ...value,
    actions: {
      ...actions,
      delete: {
        available: true,
        same_origin_control_token: token,
      },
    },
  };
}

function attachVivaLibraryControlTokenToAction(
  value: unknown,
  input: {
    scope: VivaLibraryControlScope;
    studySetId: string;
    userId: string;
    voiceSessionId: string | null;
  },
): unknown {
  if (!isRecord(value) || value.available !== true) return value;
  const token = signVivaLibraryControlToken(input);
  return token ? { ...value, same_origin_control_token: token } : value;
}

function attachVivaSessionBootstrapTokenToAction(
  value: unknown,
  input: {
    sessionId: string | null;
    studySetId: string;
    userId: string;
  },
): unknown {
  if (!isRecord(value) || value.available !== true) return value;
  const token = signVivaSessionBootstrapToken(input);
  return token ? { ...value, session_bootstrap_token: token } : value;
}

function sessionIdFromAction(value: unknown): string | null {
  return isRecord(value) ? requiredString(value.session_id) : null;
}

function agentLibraryUrl(agentBaseUrl: string, userId: string): URL | null {
  try {
    const url = new URL(`${trimTrailingSlash(agentBaseUrl)}/study-sets/library`);
    url.searchParams.set("user_id", userId);
    return url;
  } catch {
    return null;
  }
}

function sessionBootstrapTimeoutMs(): number {
  return Math.min(
    positiveInteger(
      process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS,
      DEFAULT_SESSION_BOOTSTRAP_TIMEOUT_MS,
    ),
    DEFAULT_SESSION_BOOTSTRAP_TIMEOUT_MS,
  );
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

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
