import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

export type VivaSessionRouteFailureClass = {
  error: string;
  failure_class: string;
  token_refresh_outcome: string;
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

type SessionRequestPayload = {
  session_id?: unknown;
  session_bootstrap_token?: unknown;
  session_token?: unknown;
  study_set_id?: unknown;
  user_id?: unknown;
};

type SessionTokenClaims = {
  expires_at: number;
  nonce: string;
  session_id: string;
  study_set_id: string;
  user_id: string;
};

type SessionBootstrapTokenClaims = {
  expires_at: number;
  nonce: string;
  origin: string | null;
  purpose: "viva_session_bootstrap";
  session_id: string | null;
  study_set_id: string;
  user_id: string;
};

export type VivaLibraryControlScope = "session_history_delete" | "study_set_delete";

type LibraryControlTokenClaims = {
  expires_at: number;
  nonce: string;
  origin: string | null;
  purpose: "viva_library_control";
  scope: VivaLibraryControlScope;
  study_set_id: string;
  user_id: string;
  voice_session_id: string | null;
};

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
  id?: string;
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

type SessionTokenVerification =
  | { ok: true; expired: boolean; value: SessionTokenClaims }
  | { ok: false; reason: "invalid" | "malformed" | "missing_secret" };

const RATE_LIMIT_WINDOW_MS = 60_000;
const SESSION_BOOTSTRAP_TOKEN_TTL_SECONDS = 5 * 60;
const SESSION_BOOTSTRAP_TOKEN_PREFIX = "viva-bootstrap1";
const SESSION_BOOTSTRAP_TOKEN_PURPOSE = "viva_session_bootstrap";
const LIBRARY_CONTROL_TOKEN_PREFIX = "viva-control1";
const LIBRARY_CONTROL_TOKEN_PURPOSE = "viva_library_control";
const mintRateLimits = new Map<string, RateLimitBucket>();

export async function handleVivaSessionStart(request: NextRequest) {
  const guard = guardSameOrigin(request);
  if (guard) return guard;

  const payload = await readSessionPayload(request);
  if (!payload.ok) return payload.response;

  const userId = requiredString(payload.value.user_id);
  const studySetId = requiredString(payload.value.study_set_id);
  const sessionId = requiredString(payload.value.session_id);
  if (!userId || !studySetId) return sessionJsonError(400, "invalid_session_request", "invalid");
  const access = guardAllowedIdentity(userId, studySetId);
  if (access) return access;
  const bootstrap = guardSessionBootstrapCapability(request, {
    sessionId: sessionId ?? null,
    studySetId,
    token: requiredString(payload.value.session_bootstrap_token),
    userId,
  });
  if (bootstrap) return bootstrap;
  const limit = guardMintRateLimit(request, userId, studySetId);
  if (limit) return limit;

  const minted = await mintSessionFromLibrary({
    actionName: sessionId ? "resume" : "start",
    origin: requestOrigin(request),
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
  const guard = guardSameOrigin(request);
  if (guard) return guard;

  const payload = await readSessionPayload(request);
  if (!payload.ok) return payload.response;

  const userId = requiredString(payload.value.user_id);
  const studySetId = requiredString(payload.value.study_set_id);
  const sessionId = requiredString(payload.value.session_id);
  const sessionToken = requiredString(payload.value.session_token);
  if (!userId || !studySetId || !sessionId || !sessionToken) {
    return sessionJsonError(400, "invalid_session_request", "invalid");
  }

  const access = guardAllowedIdentity(userId, studySetId);
  if (access) return access;

  const claims = verifySessionTokenClaims(sessionToken);
  if (!claims.ok) {
    if (claims.reason === "missing_secret") {
      return sessionJsonError(503, "viva_session_refresh_unavailable", "failed");
    }
    if (claims.reason === "invalid") {
      return sessionJsonError(401, "invalid_session_token", "invalid_rejected", {
        failure_class: "auth_material_failure",
      });
    }
    return sessionJsonError(400, "malformed_session_token", "malformed_rejected", {
      failure_class: "malformed_token",
    });
  }
  if (
    claims.value.user_id !== userId ||
    claims.value.study_set_id !== studySetId ||
    claims.value.session_id !== sessionId
  ) {
    return sessionJsonError(409, "session_identity_mismatch", "identity_mismatch", {
      failure_class: "identity_mismatch",
    });
  }

  const limit = guardMintRateLimit(request, userId, studySetId);
  if (limit) return limit;

  const minted = await mintSessionFromLibrary({
    actionName: "resume",
    origin: requestOrigin(request),
    sessionId,
    studySetId,
    userId,
  });
  if (!minted.ok) return minted.response;
  return sessionJson(
    {
      failure_class: null,
      session: minted.value.session,
      session_token: minted.value.session_token,
      token_refresh_outcome: claims.expired ? "expired_refreshed" : "refreshed",
    },
    200,
  );
}

export function resetVivaSessionMintRateLimitsForTests() {
  mintRateLimits.clear();
}

export function signVivaSessionBootstrapToken(input: {
  origin?: string | null;
  sessionId?: string | null;
  studySetId: string;
  userId: string;
}): string | null {
  const secret = sessionBootstrapSecret();
  if (!secret) return null;
  const claims: SessionBootstrapTokenClaims = {
    expires_at: Math.floor(Date.now() / 1000) + SESSION_BOOTSTRAP_TOKEN_TTL_SECONDS,
    nonce: randomUUID(),
    origin: input.origin?.trim() || null,
    purpose: SESSION_BOOTSTRAP_TOKEN_PURPOSE,
    session_id: input.sessionId?.trim() || null,
    study_set_id: input.studySetId,
    user_id: input.userId,
  };
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `${SESSION_BOOTSTRAP_TOKEN_PREFIX}.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function signVivaLibraryControlToken(input: {
  origin?: string | null;
  scope: VivaLibraryControlScope;
  studySetId: string;
  userId: string;
  voiceSessionId?: string | null;
}): string | null {
  const secret = sessionBootstrapSecret();
  if (!secret) return null;
  const claims: LibraryControlTokenClaims = {
    expires_at: Math.floor(Date.now() / 1000) + SESSION_BOOTSTRAP_TOKEN_TTL_SECONDS,
    nonce: randomUUID(),
    origin: input.origin?.trim() || null,
    purpose: LIBRARY_CONTROL_TOKEN_PURPOSE,
    scope: input.scope,
    study_set_id: input.studySetId,
    user_id: input.userId,
    voice_session_id: input.voiceSessionId?.trim() || null,
  };
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `${LIBRARY_CONTROL_TOKEN_PREFIX}.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function isVivaLibraryControlToken(token: string | null | undefined): boolean {
  return token?.startsWith(`${LIBRARY_CONTROL_TOKEN_PREFIX}.`) ?? false;
}

export function verifyVivaLibraryControlToken(input: {
  origin?: string | null;
  scope: VivaLibraryControlScope;
  studySetId: string;
  token: string;
  userId: string;
  voiceSessionId?: string | null;
}): "invalid" | "missing_secret" | "valid" {
  const secret = sessionBootstrapSecret();
  if (!secret) return "missing_secret";
  const claims = verifyLibraryControlTokenClaims(input.token, secret);
  if (
    !claims ||
    claims.purpose !== LIBRARY_CONTROL_TOKEN_PURPOSE ||
    claims.scope !== input.scope ||
    claims.user_id !== input.userId ||
    claims.study_set_id !== input.studySetId ||
    claims.voice_session_id !== (input.voiceSessionId?.trim() || null) ||
    (claims.origin && claims.origin !== input.origin)
  ) {
    return "invalid";
  }
  return "valid";
}

export function attachVivaSessionBootstrapTokensToLibrarySnapshot(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    origin?: string | null;
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
    origin?: string | null;
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

function guardSameOrigin(request: NextRequest): NextResponse | null {
  const expectedOrigin = requestOrigin(request);
  const origin = request.headers.get("origin")?.trim();
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!origin || origin !== expectedOrigin) {
    return sessionJsonError(403, "cross_origin_session_request", "blocked", {
      failure_class: "access_denied",
    });
  }
  if (fetchSite && fetchSite !== "same-origin") {
    return sessionJsonError(403, "cross_origin_session_request", "blocked", {
      failure_class: "access_denied",
    });
  }
  return null;
}

function guardAllowedIdentity(userId: string, studySetId: string): NextResponse | null {
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) {
    return sessionJsonError(503, "viva_session_identity_allowlist_unavailable", "failed");
  }
  if (!allowedUserIds.has(userId)) {
    return sessionJsonError(403, "session_identity_not_allowed", "blocked", {
      failure_class: "access_denied",
    });
  }
  if (!allowedStudySetIds.has(studySetId)) {
    return sessionJsonError(403, "session_identity_not_allowed", "blocked", {
      failure_class: "access_denied",
    });
  }
  return null;
}

function guardSessionBootstrapCapability(
  request: NextRequest,
  input: {
    sessionId: string | null;
    studySetId: string;
    token: string | null;
    userId: string;
  },
): NextResponse | null {
  const requirement = sessionBootstrapRequirement();
  if (!requirement.required) return null;
  if (!requirement.secret) {
    return sessionJsonError(503, "viva_session_bootstrap_unavailable", "failed");
  }
  if (!input.token) {
    return sessionJsonError(403, "session_bootstrap_capability_required", "blocked", {
      failure_class: "access_denied",
    });
  }
  const claims = verifySessionBootstrapTokenClaims(input.token, requirement.secret);
  if (
    !claims ||
    claims.purpose !== SESSION_BOOTSTRAP_TOKEN_PURPOSE ||
    claims.user_id !== input.userId ||
    claims.study_set_id !== input.studySetId ||
    claims.session_id !== input.sessionId ||
    (claims.origin && claims.origin !== requestOrigin(request))
  ) {
    return sessionJsonError(403, "session_bootstrap_capability_required", "blocked", {
      failure_class: "access_denied",
    });
  }
  return null;
}

function guardMintRateLimit(
  request: NextRequest,
  userId: string,
  studySetId: string,
): NextResponse | null {
  const max = positiveInteger(process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE, 12);
  const now = Date.now();
  const ipKey = `ip\u0000${clientIp(request)}`;
  const identityKey = `identity\u0000${userId}\u0000${studySetId}`;
  const ipBucket = currentRateLimitBucket(ipKey, now);
  const identityBucket = currentRateLimitBucket(identityKey, now);
  if (ipBucket.count >= max || identityBucket.count >= max) {
    return sessionJsonError(429, "session_mint_rate_limited", "blocked", {
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
): Promise<
  | { ok: true; value: SessionRequestPayload }
  | { ok: false; response: NextResponse<VivaSessionRouteFailureClass> }
> {
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, response: sessionJsonError(400, "invalid_session_request", "invalid") };
    }
    return { ok: true, value: value as SessionRequestPayload };
  } catch {
    return { ok: false, response: sessionJsonError(400, "invalid_session_request", "invalid") };
  }
}

async function mintSessionFromLibrary(input: {
  actionName: "resume" | "start";
  origin: string;
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
  const bearerToken = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  if (!agentBaseUrl || !bearerToken) {
    return {
      ok: false,
      response: sessionJsonError(503, "viva_session_agent_unavailable", "failed"),
    };
  }

  const upstream = agentLibraryUrl(agentBaseUrl, input.userId);
  if (!upstream) {
    return {
      ok: false,
      response: sessionJsonError(503, "viva_session_agent_unavailable", "failed"),
    };
  }
  let response: Response;
  try {
    response = await fetch(upstream, {
      cache: "no-store",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        origin: input.origin,
      },
      method: "GET",
    });
  } catch {
    return {
      ok: false,
      response: sessionJsonError(502, "viva_session_agent_unavailable", "failed"),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      response: sessionJsonError(502, "viva_session_agent_unavailable", "failed"),
    };
  }

  const snapshot = await readJson(response);
  const studySet = snapshot.study_sets?.find(
    (entry) => entry.id === input.studySetId && entry.user_id === input.userId,
  );
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
      response: sessionJsonError(409, "session_mint_unavailable", "unavailable", {
        failure_class: "session_unavailable",
      }),
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

async function readJson(response: Response): Promise<VivaLibrarySnapshot> {
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object") return {};
    return value as VivaLibrarySnapshot;
  } catch {
    return {};
  }
}

function verifySessionTokenClaims(token: string): SessionTokenVerification {
  const secret = process.env.VIVA_VOICE_SESSION_TOKEN_SECRET?.trim();
  if (!secret) return { ok: false, reason: "missing_secret" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "viva1") return { ok: false, reason: "malformed" };
  const claimsPart = parts[1] ?? "";
  const signaturePart = parts[2] ?? "";
  const signedPayload = `viva1.${claimsPart}`;
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signaturePart, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expectedSignature = createHmac("sha256", secret).update(signedPayload).digest();
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const raw = Buffer.from(claimsPart, "base64url").toString("utf8");
    const claims = JSON.parse(raw) as unknown;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      return { ok: false, reason: "malformed" };
    }
    const record = claims as Record<string, unknown>;
    const parsed = {
      expires_at: numberClaim(record.expires_at),
      nonce: requiredString(record.nonce),
      session_id: requiredString(record.session_id),
      study_set_id: requiredString(record.study_set_id),
      user_id: requiredString(record.user_id),
    };
    if (
      parsed.expires_at === null ||
      !parsed.nonce ||
      !parsed.session_id ||
      !parsed.study_set_id ||
      !parsed.user_id
    ) {
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      expired: parsed.expires_at <= Math.floor(Date.now() / 1000),
      value: {
        expires_at: parsed.expires_at,
        nonce: parsed.nonce,
        session_id: parsed.session_id,
        study_set_id: parsed.study_set_id,
        user_id: parsed.user_id,
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
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
  options: { failure_class?: string } = {},
): NextResponse<VivaSessionRouteFailureClass> {
  return NextResponse.json(
    {
      error,
      failure_class: options.failure_class ?? "session_bootstrap_failed",
      token_refresh_outcome: tokenRefreshOutcome,
    },
    {
      headers: { "cache-control": "no-store" },
      status,
    },
  );
}

function requestOrigin(request: NextRequest): string {
  return request.nextUrl?.origin ?? new URL(request.url).origin;
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
  const bearerToken = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  if (!agentBaseUrl || !bearerToken) {
    return { required: false, secret: null };
  }
  return { required: true, secret: sessionBootstrapSecret() };
}

function sessionBootstrapSecret(): string | null {
  return (
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET?.trim() ||
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET?.trim() ||
    null
  );
}

function verifySessionBootstrapTokenClaims(
  token: string,
  secret: string,
): SessionBootstrapTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_BOOTSTRAP_TOKEN_PREFIX) return null;
  const claimsPart = parts[1] ?? "";
  const signaturePart = parts[2] ?? "";
  const signedPayload = `${SESSION_BOOTSTRAP_TOKEN_PREFIX}.${claimsPart}`;
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signaturePart, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = createHmac("sha256", secret).update(signedPayload).digest();
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }
  try {
    const record = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as unknown;
    if (!isRecord(record)) return null;
    const expiresAt = numberClaim(record.expires_at);
    const nonce = requiredString(record.nonce);
    const purpose = record.purpose === SESSION_BOOTSTRAP_TOKEN_PURPOSE ? record.purpose : null;
    const studySetId = requiredString(record.study_set_id);
    const userId = requiredString(record.user_id);
    const sessionId =
      record.session_id === null || record.session_id === undefined
        ? null
        : requiredString(record.session_id);
    const origin =
      record.origin === null || record.origin === undefined ? null : requiredString(record.origin);
    if (
      expiresAt === null ||
      expiresAt <= Math.floor(Date.now() / 1000) ||
      !nonce ||
      !purpose ||
      !studySetId ||
      !userId ||
      (record.session_id !== null && record.session_id !== undefined && !sessionId) ||
      (record.origin !== null && record.origin !== undefined && !origin)
    ) {
      return null;
    }
    return {
      expires_at: expiresAt,
      nonce,
      origin,
      purpose,
      session_id: sessionId,
      study_set_id: studySetId,
      user_id: userId,
    };
  } catch {
    return null;
  }
}

function verifyLibraryControlTokenClaims(
  token: string,
  secret: string,
): LibraryControlTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== LIBRARY_CONTROL_TOKEN_PREFIX) return null;
  const claimsPart = parts[1] ?? "";
  const signaturePart = parts[2] ?? "";
  const signedPayload = `${LIBRARY_CONTROL_TOKEN_PREFIX}.${claimsPart}`;
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signaturePart, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = createHmac("sha256", secret).update(signedPayload).digest();
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }
  try {
    const record = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as unknown;
    if (!isRecord(record)) return null;
    const expiresAt = numberClaim(record.expires_at);
    const nonce = requiredString(record.nonce);
    const purpose = record.purpose === LIBRARY_CONTROL_TOKEN_PURPOSE ? record.purpose : null;
    const scope =
      record.scope === "session_history_delete" || record.scope === "study_set_delete"
        ? record.scope
        : null;
    const studySetId = requiredString(record.study_set_id);
    const userId = requiredString(record.user_id);
    const voiceSessionId =
      record.voice_session_id === null || record.voice_session_id === undefined
        ? null
        : requiredString(record.voice_session_id);
    const origin =
      record.origin === null || record.origin === undefined ? null : requiredString(record.origin);
    if (
      expiresAt === null ||
      expiresAt <= Math.floor(Date.now() / 1000) ||
      !nonce ||
      !purpose ||
      !scope ||
      !studySetId ||
      !userId ||
      (record.voice_session_id !== null &&
        record.voice_session_id !== undefined &&
        !voiceSessionId) ||
      (record.origin !== null && record.origin !== undefined && !origin)
    ) {
      return null;
    }
    return {
      expires_at: expiresAt,
      nonce,
      origin,
      purpose,
      scope,
      study_set_id: studySetId,
      user_id: userId,
      voice_session_id: voiceSessionId,
    };
  } catch {
    return null;
  }
}

function attachVivaSessionBootstrapTokensToStudySet(
  value: unknown,
  options: {
    allowedStudySetIds?: ReadonlySet<string> | null;
    origin?: string | null;
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
        origin: options.origin,
        sessionId: sessionIdFromAction(value.actions.resume),
        studySetId: id,
        userId: options.userId,
      }),
      start: attachVivaSessionBootstrapTokenToAction(value.actions.start, {
        origin: options.origin,
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
    origin?: string | null;
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
        origin: options.origin,
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
    origin?: string | null;
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
    origin: options.origin,
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
    origin?: string | null;
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
    origin?: string | null;
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

function numberClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
