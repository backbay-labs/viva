import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AuthenticatedStudyIdentity,
  type AuthenticatedStudyProjectionV1,
  validateAuthenticatedStudyProjectionV1ForIdentity,
} from "@viva/core";
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

/**
 * The D-07 Branch A success shape.
 *
 * The two instants are canonical second-precision RFC3339 UTC strings rather than the plan's
 * literal `number`: Plan 13's already-merged browser vault seam
 * (`browserSessionCredentialVaultInputFromStartResponse` in `apps/web/lib/viva-library.ts`, which
 * this lane may not edit) types them `string` and calls `.trim()` on them, so a number would throw
 * in the browser. The arithmetic the plan pins is unchanged; only its serialization differs, and
 * the deviation is recorded in the lane report.
 */
export type VivaSessionRouteOutcome = {
  failure_class: null;
  refresh_expires_at: string;
  refresh_token: string;
  session: {
    session_id: string;
    study_set_id: string;
    user_id: string;
  };
  session_absolute_expires_at: string;
  session_token: string;
  token_refresh_outcome: "issued" | "refreshed";
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
  refresh_token?: unknown;
  session_id?: unknown;
  session_bootstrap_token?: unknown;
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

export type VivaSessionProjectionFailureClass = {
  error: string;
  failure_class: string;
  stage: "pre_loop";
};

/**
 * The projection route's auth terminal. It is the same coarse body the session routes return, but
 * the projection route never refreshes anything, so an *expired* access token is terminal here
 * too: the browser has to go and refresh before it can read again.
 */
type VivaSessionProjectionAuthFailureClass = {
  error: "session_auth_terminal";
  failure_class: "session_auth_failure";
  stage: "session";
  token_refresh_outcome: "terminal";
};

/**
 * Operator-only projection log. Coarse code plus deployment SHA and nothing else — never an env
 * name, credential, upstream URL, upstream body, user id, study-set id, or voice-session id.
 */
export type VivaSessionProjectionFailureLog = {
  deploy_sha: string | null;
  error: string;
  event: "viva_session_projection_failure";
  failure_class: string;
  route: "projection";
  service: "web";
  stage: "pre_loop" | "session";
  status: number;
};

type SessionIdentity = {
  userId: string;
  studySetId: string;
  sessionId: string;
};

/**
 * The web-owned shared security-state contract. Every browser-facing security decision that must
 * survive a horizontally scaled deployment goes through exactly these four methods: refresh
 * reservation, refresh rotation, the single destructive-capability transaction primitive, and
 * bounded admission. No method is optional and there is no fifth method — a process-local map
 * beside this interface would silently reintroduce the per-instance gap it exists to close.
 */
export interface SessionSecurityStore {
  consumeRefresh(input: {
    credentialHash: string;
    identity: SessionIdentity;
    nowSeconds: number;
    reservationTtlSeconds: 10;
  }): Promise<
    | { ok: true; absoluteExpiresAt: number; rotationId: string }
    | {
        ok: false;
        reason: "expired" | "identity_mismatch" | "replayed" | "revoked" | "unavailable";
      }
  >;

  rotateRefresh(
    input:
      | {
          mode: "issue";
          identity: SessionIdentity;
          credentialHash: string;
          refreshExpiresAt: number;
          absoluteExpiresAt: number;
        }
      | {
          mode: "rotate";
          identity: SessionIdentity;
          rotationId: string;
          credentialHash: string;
          refreshExpiresAt: number;
          absoluteExpiresAt: number;
        },
  ): Promise<{ ok: true } | { ok: false; reason: "conflict" | "unavailable" }>;

  revokeSession(
    input:
      | {
          operation: "consume_delete_and_revoke";
          capabilityHash: string;
          capabilityExpiresAt: number;
          nowSeconds: number;
          purpose: "session_history_delete" | "study_set_delete";
          scope:
            | { kind: "session"; identity: SessionIdentity }
            | { kind: "study_set"; userId: string; studySetId: string };
        }
      | {
          operation: "register_restore";
          capabilityHash: string;
          capabilityExpiresAt: number;
          nowSeconds: number;
          purpose: "library_restore";
          scope: { kind: "restore"; userId: string; studySetId: string; deletionId: string };
        }
      | {
          operation: "consume_restore";
          capabilityHash: string;
          capabilityExpiresAt: number;
          nowSeconds: number;
          purpose: "library_restore";
          scope: { kind: "restore"; userId: string; studySetId: string; deletionId: string };
        },
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "conflict" | "expired" | "replayed" | "scope_mismatch" | "unavailable" }
  >;

  incrementRateLimit(input: {
    keys: readonly [string, string];
    limit: number;
    nowMs: number;
    windowMs: 60_000;
  }): Promise<
    | { ok: true; remaining: number; resetAtMs: number }
    | { ok: false; reason: "limited" | "unavailable"; resetAtMs?: number }
  >;
}

export type SessionSecurityStoreSelection =
  | { ok: true; store: SessionSecurityStore }
  | { ok: false; reason: "unavailable" };

type SessionSecurityStoreOperation =
  | "consume_refresh"
  | "rotate_refresh"
  | "revoke_session"
  | "increment_rate_limit";

type MemoryRateLimitRecord = {
  count: number;
  resetAtMs: number;
};

/**
 * One bounded refresh record. `consumed` is the replay tombstone the plan requires the store to
 * retain until absolute expiry, and `revoked` is the terminal state a destructive delete (or the
 * reuse of a consumed tombstone) drives every record for an identity into.
 */
type MemoryRefreshRecord = {
  absoluteExpiresAt: number;
  consumed: boolean;
  identity: SessionIdentity;
  refreshExpiresAt: number;
  reservation: { expiresAtSeconds: number; rotationId: string } | null;
  revoked: boolean;
};

/** A spent destructive capability, keyed by SHA-256 hash and kept until the capability expires. */
type MemoryCapabilityTombstone = {
  expiresAt: number;
};

type TrustedClientAdmission = { ok: true; value: string } | { ok: false; reason: "untrusted" };

type AdmissionLimitRange = {
  fallback: number;
  max: number;
  min: number;
  name: string;
};

type SessionAccessTokenRouteVerification =
  | { ok: true; claims: SessionTokenClaims; expired: boolean }
  | { ok: false; reason: VivaSessionAccessTokenRejection | "unavailable" };

/**
 * The binding a ROUTE asks the verifier to enforce.
 *
 * `user_id: null` is legal only for a route that does not receive a user id from the caller at
 * all — today that is the projection read, whose query names a study set and a voice session and
 * nothing else. The claim is then bound by the configured identity allowlist immediately after
 * verification, so the identity is still checked; it is checked against configuration rather than
 * against a caller-supplied value. The exported {@link SessionTokenBinding} keeps `user_id:
 * string`, so no caller outside this module can reach the nullable form.
 */
type SessionAccessTokenExpectedBinding = {
  user_id: string | null;
  study_set_id: string;
  session_id: string;
};

type ProjectionAccessTokenVerification =
  | { ok: true; claims: SessionTokenClaims }
  | {
      ok: false;
      reason: VivaSessionAccessTokenRejection | "access_denied" | "unavailable";
    };

type ProjectionQuery = { studySetId: string; voiceSessionId: string };

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
/**
 * D-07 Branch A refresh-credential constants. These are NOT operator-extensible in this patch: a
 * deployment cannot lengthen the absolute session lifetime or the credential TTL through env.
 */
const REFRESH_CREDENTIAL_BYTES = 32;
const REFRESH_CREDENTIAL_TTL_SECONDS = 15 * 60;
const SESSION_ABSOLUTE_LIFETIME_SECONDS = 6 * 60 * 60;
const REFRESH_RESERVATION_TTL_SECONDS = 10;
const REFRESH_CREDENTIAL_PREFIX = "viva-refresh1";
/** 32 bytes as canonical unpadded base64url is exactly 43 characters. */
const REFRESH_CREDENTIAL_ENCODED_LENGTH = 43;
const REFRESH_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "refresh_token",
  "session_id",
  "study_set_id",
  "user_id",
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

const SESSION_SECURITY_STORE_PATH = "/v1/session-security";
const SESSION_SECURITY_STORE_TIMEOUT_MS = 2_000;
const SESSION_SECURITY_STORE_UNAVAILABLE = { ok: false, reason: "unavailable" } as const;
const SESSION_SECURITY_STORE_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "operation",
  "request_id",
  "result",
  "schema_version",
]);
/**
 * Bounded in-memory record capacity. Expired records are pruned in insertion order (which is
 * expiry order for a fixed window), and a full map returns unavailable rather than evicting an
 * active record: dropping a live bucket would hand an attacker a free admission slot.
 */
const MEMORY_SECURITY_STORE_MAX_RECORDS = 10_000;
/** NUL, so no identifier value can span two fields of an admission key. */
const ADMISSION_KEY_SEPARATOR = String.fromCharCode(0);
const LOOPBACK_ADMISSION_BUCKET = "loopback";
const TRUSTED_PROXY_MAX_HOPS = 5;
const MINT_ADMISSION_LIMIT: AdmissionLimitRange = {
  fallback: 12,
  max: 120,
  min: 1,
  name: "VIVA_SESSION_MINT_MAX_PER_MINUTE",
};
const PROJECTION_ADMISSION_LIMIT: AdmissionLimitRange = {
  fallback: 60,
  max: 600,
  min: 1,
  name: "VIVA_SESSION_PROJECTION_MAX_PER_MINUTE",
};
/** Not operator-extensible: a deployment cannot lengthen the projection read's deadline. */
const PROJECTION_UPSTREAM_TIMEOUT_MS = 8_000;
const PROJECTION_QUERY_KEYS: ReadonlySet<string> = new Set(["study_set_id", "voice_session_id"]);
/** The only `retry-after` window a 429 from the agent may state, in whole delta-seconds. */
const PROJECTION_UPSTREAM_RETRY_AFTER_MIN_SECONDS = 1;
const PROJECTION_UPSTREAM_RETRY_AFTER_MAX_SECONDS = 60;
/**
 * The projection route's recursive upstream-credential DETECTOR shares its closed key set and its
 * closed value-marker list with the library proxy's recursive STRIPPER
 * (`apps/web/app/api/viva-library/[[...path]]/route.ts`). The two differ only in what they do with
 * a hit: the proxy relays a stripped body, while a projection is a validated read model, so any
 * credential at all means the upstream contract is broken and nothing is relayed.
 *
 * They are two declarations because Task 9's file list does not include the library route, so the
 * constants cannot be hoisted into one home from this task. `viva-session-api.test.ts` reads both
 * source files and fails if the two lists ever drift apart; consolidating them into a single
 * exported set is recorded as a coordinator follow-up.
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
const AGENT_CREDENTIAL_VALUE_MARKERS = [
  "bearer ",
  "viva1.",
  "viva-bootstrap1.",
  "viva-control1.",
  "viva-refresh1.",
] as const;
/** One process-wide map, shared by every adapter this module hands out. */
const memorySecurityStoreRateLimits = new Map<string, MemoryRateLimitRecord>();
/** Refresh records, keyed by the SHA-256 of the credential; the raw value never reaches here. */
const memorySecurityStoreRefreshRecords = new Map<string, MemoryRefreshRecord>();
/** Spent destructive capabilities, keyed by the SHA-256 of the capability token. */
const memorySecurityStoreCapabilityTombstones = new Map<string, MemoryCapabilityTombstone>();

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
  // A deployment with no usable access-token verification key cannot check what the agent hands
  // back, so it refuses before it spends an admission slot or contacts the agent at all.
  if (!sessionAccessTokenVerificationKeys()) return sessionConfigUnavailableResponse(logContext);
  const limit = await guardSessionMintAdmission(request, userId, studySetId, logContext);
  if (limit) return limit;

  const minted = await mintSessionFromLibrary({
    actionName,
    route: "start",
    sessionId: sessionId ?? undefined,
    studySetId,
    userId,
  });
  if (!minted.ok) return minted.response;
  const identity: SessionIdentity = {
    sessionId: minted.value.session.session_id,
    studySetId: minted.value.session.study_set_id,
    userId: minted.value.session.user_id,
  };
  const verified = verifyAgentIssuedAccessToken(minted.value, identity, logContext);
  if (!verified.ok) return verified.response;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const absoluteExpiresAt = nowSeconds + SESSION_ABSOLUTE_LIFETIME_SECONDS;
  const refreshExpiresAt = Math.min(nowSeconds + REFRESH_CREDENTIAL_TTL_SECONDS, absoluteExpiresAt);
  const credential = generateRefreshCredential();
  const selection = vivaSessionSecurityStore();
  if (!selection.ok) return sessionAdmissionUnavailableResponse(logContext);
  const issued = await selection.store.rotateRefresh({
    absoluteExpiresAt,
    credentialHash: capabilityDigest(credential),
    identity,
    mode: "issue",
    refreshExpiresAt,
  });
  // Both credentials are discarded unless the store durably owns the new refresh record.
  if (!issued.ok) return sessionAdmissionUnavailableResponse(logContext);
  return sessionJson(
    {
      failure_class: null,
      refresh_expires_at: rfc3339UtcInstant(refreshExpiresAt),
      refresh_token: credential,
      session: minted.value.session,
      session_absolute_expires_at: rfc3339UtcInstant(absoluteExpiresAt),
      session_token: minted.value.session_token,
      token_refresh_outcome: "issued",
    },
    200,
  );
}

/**
 * D-07 Branch A refresh: a separate, opaque, one-time, rotating credential.
 *
 * An access token — however correctly signed, however old — is never refresh authority. The
 * browser sends exactly four fields; anything else is a 400 that reaches neither the shared store
 * nor the agent. Every credential rejection returns one coarse terminal body with a distinct
 * operator code, and credentials are returned only after the store has committed the rotation.
 */
export async function handleVivaSessionRefresh(request: NextRequest) {
  const logContext = { action: "refresh", route: "refresh" } as const;
  const guard = guardSameOrigin(request, logContext);
  if (guard) return guard;

  const payload = await readSessionPayload(request, logContext);
  if (!payload.ok) return payload.response;

  const fields = exactRefreshRequestFields(payload.value);
  if (!fields) {
    return sessionJsonError(400, "invalid_session_request", "invalid", logContext);
  }

  const access = guardAllowedIdentity(fields.userId, fields.studySetId, logContext);
  if (access) return access;
  if (!sessionAccessTokenVerificationKeys()) {
    return sessionJsonError(503, "viva_session_refresh_unavailable", "failed", logContext);
  }

  const limit = await guardSessionMintAdmission(
    request,
    fields.userId,
    fields.studySetId,
    logContext,
  );
  if (limit) return limit;

  if (!isRefreshCredentialShape(fields.credential)) {
    return refreshTerminalJsonError("malformed", logContext);
  }
  const selection = vivaSessionSecurityStore();
  if (!selection.ok) return sessionAdmissionUnavailableResponse(logContext);

  const identity: SessionIdentity = {
    sessionId: fields.sessionId,
    studySetId: fields.studySetId,
    userId: fields.userId,
  };
  const reservation = await selection.store.consumeRefresh({
    credentialHash: capabilityDigest(fields.credential),
    identity,
    nowSeconds: Math.floor(Date.now() / 1000),
    reservationTtlSeconds: REFRESH_RESERVATION_TTL_SECONDS,
  });
  if (!reservation.ok) {
    if (reservation.reason === "unavailable") {
      return sessionAdmissionUnavailableResponse(logContext);
    }
    return refreshTerminalJsonError(reservation.reason, logContext);
  }

  const minted = await mintSessionFromLibrary({
    actionName: "resume",
    route: "refresh",
    sessionId: fields.sessionId,
    studySetId: fields.studySetId,
    userId: fields.userId,
  });
  // A transport failure returns no credential at all; the reservation lapses at its own TTL.
  if (!minted.ok) return minted.response;
  const verified = verifyAgentIssuedAccessToken(minted.value, identity, logContext);
  if (!verified.ok) return verified.response;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const absoluteExpiresAt = reservation.absoluteExpiresAt;
  const refreshExpiresAt = Math.min(nowSeconds + REFRESH_CREDENTIAL_TTL_SECONDS, absoluteExpiresAt);
  const credential = generateRefreshCredential();
  const rotated = await selection.store.rotateRefresh({
    absoluteExpiresAt,
    credentialHash: capabilityDigest(credential),
    identity,
    mode: "rotate",
    refreshExpiresAt,
    rotationId: reservation.rotationId,
  });
  if (!rotated.ok) return sessionAdmissionUnavailableResponse(logContext);
  return sessionJson(
    {
      failure_class: null,
      refresh_expires_at: rfc3339UtcInstant(refreshExpiresAt),
      refresh_token: credential,
      session: minted.value.session,
      session_absolute_expires_at: rfc3339UtcInstant(absoluteExpiresAt),
      session_token: minted.value.session_token,
      token_refresh_outcome: "refreshed",
    },
    200,
  );
}

/**
 * The exact D-07 Branch A refresh payload. Any missing, empty, or additional field — including a
 * stale access credential a client might still send — is `invalid_session_request` before the shared
 * store or the agent is touched.
 */
function exactRefreshRequestFields(value: SessionRequestPayload): {
  credential: string;
  sessionId: string;
  studySetId: string;
  userId: string;
} | null {
  const keys = Object.keys(value);
  if (keys.length !== REFRESH_REQUEST_KEYS.size) return null;
  if (keys.some((key) => !REFRESH_REQUEST_KEYS.has(key))) return null;
  const record = value as Record<string, unknown>;
  const credential = requiredString(record.refresh_token);
  const sessionId = requiredString(record.session_id);
  const studySetId = requiredString(record.study_set_id);
  const userId = requiredString(record.user_id);
  if (!credential || !sessionId || !studySetId || !userId) return null;
  return { credential, sessionId, studySetId, userId };
}

/** `viva-refresh1.` plus exactly 43 canonical unpadded base64url characters (32 random bytes). */
function isRefreshCredentialShape(value: string): boolean {
  const segments = value.split(".");
  if (segments.length !== 2 || segments[0] !== REFRESH_CREDENTIAL_PREFIX) return false;
  const encoded = segments[1] ?? "";
  if (encoded.length !== REFRESH_CREDENTIAL_ENCODED_LENGTH) return false;
  const decoded = decodeCanonicalBase64Url(encoded);
  return decoded !== null && decoded.length === REFRESH_CREDENTIAL_BYTES;
}

function generateRefreshCredential(): string {
  return `${REFRESH_CREDENTIAL_PREFIX}.${randomBytes(REFRESH_CREDENTIAL_BYTES).toString("base64url")}`;
}

/**
 * One coarse public terminal for every refresh-credential rejection, with a distinct operator code
 * per cause. `identity_mismatch` and the structural mapper keep their own BAC-510 call sites: the
 * release observability gate asserts both shapes at this terminal.
 */
function refreshTerminalJsonError(
  reason: "expired" | "identity_mismatch" | "malformed" | "replayed" | "revoked",
  logContext: VivaSessionRouteLogContext,
): NextResponse<VivaSessionRouteFailureClass> {
  if (reason === "identity_mismatch") {
    return sessionAuthTerminalJsonError("identity_mismatch", logContext);
  }
  if (reason === "replayed") {
    return sessionAuthTerminalJsonError("replayed", logContext);
  }
  if (reason === "malformed") {
    // A credential that fails its prefix/canonical-length shape is the same class of structural
    // rejection the shared access-token mapper exists for, so both share one operator vocabulary.
    // Kept on ONE line on purpose: the BAC-510 release observability gate in
    // `scripts/provider-failure-observability.test.mjs` asserts this exact adjacency.
    const structural: VivaSessionAccessTokenRejection = "malformed_json";
    return sessionAuthTerminalJsonError(authFailureCodeForTokenReason(structural), logContext);
  }
  return sessionJsonError(401, "session_auth_terminal", "terminal", {
    ...logContext,
    failure_class: "session_auth_failure",
    logError: "invalid_session_refresh_credential",
    logTokenRefreshOutcome: reason === "expired" ? "expired_rejected" : "revoked_rejected",
  });
}

/**
 * The agent's access token is never handed to a browser unverified. Strict Plan 05 verification
 * plus an exact identity/session binding must both hold; anything else is an upstream contract
 * violation and returns the route's sanitized 502 with no token, nonce, or reason in the body.
 */
function verifyAgentIssuedAccessToken(
  minted: { session_token: string },
  identity: SessionIdentity,
  logContext: VivaSessionRouteLogContext,
): { ok: true } | { ok: false; response: NextResponse<VivaSessionRouteFailureClass> } {
  const verification = verifySessionAccessTokenForRoute({
    allowExpired: false,
    expectedBinding: {
      session_id: identity.sessionId,
      study_set_id: identity.studySetId,
      user_id: identity.userId,
    },
    token: minted.session_token,
  });
  if (verification.ok) return { ok: true };
  return {
    ok: false,
    response: sessionPreLoopJsonError(
      verification.reason === "unavailable" ? 503 : 502,
      "viva_session_agent_unavailable",
      "failed",
      "session_bootstrap_unavailable",
      PRE_LOOP_SESSION_TERMINAL_REASON,
      logContext,
    ),
  };
}

/** Canonical second-precision RFC3339 UTC, the shape Plan 13's browser vault seam consumes. */
function rfc3339UtcInstant(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * `WEBAPI-010` — the authenticated study projection BFF.
 *
 * The order below is the whole security property and is fixed: nothing that costs an admission
 * slot, a credential, or an upstream call happens before the request has proved it is a
 * same-origin read, states exactly the two allowed query parameters, and carries a strictly
 * verified Plan 05 access token bound to that query.
 *
 * 1. canonical safe-read origin / fetch context
 * 2. the exact two-parameter query allowlist
 * 3. the exact credential-header grammar
 * 4. strict Plan 05 verification, bound to the query, identity bound to the allowlist
 * 5. atomic shared IP+session admission
 * 6. the scoped read credential
 * 7. the Plan 08 endpoint with the exact two auth headers and an eight-second deadline
 * 8. bounded read and strict decode/parse
 * 9. the recursive upstream-credential detector
 * 10. Plan 04's validator, bound to the verified identity
 */
export async function handleVivaSessionProjection(
  request: NextRequest,
): Promise<NextResponse<AuthenticatedStudyProjectionV1 | VivaSessionProjectionFailure>> {
  const canonical = canonicalWebOrigin();
  if (!canonical.ok) return projectionUnavailableResponse();
  const crossOrigin = guardProjectionFetchContext(request, canonical.value.origin);
  if (crossOrigin) return crossOrigin;

  const query = exactProjectionQuery(request.nextUrl);
  if (!query) {
    return projectionJson(400, "viva_session_projection_request_invalid", "projection_unavailable");
  }

  const presented = projectionBearerCredential(request.headers.get("authorization"));
  if (!presented) return projectionAuthTerminalResponse("malformed");

  const verified = verifyProjectionAccessToken(presented, query);
  if (!verified.ok) {
    if (verified.reason === "unavailable") return projectionUnavailableResponse();
    return projectionAuthTerminalResponse(projectionAuthFailureCode(verified.reason));
  }

  const identity = {
    sessionId: query.voiceSessionId,
    studySetId: query.studySetId,
    userId: verified.claims.user_id,
  };
  const admission = await guardVivaSessionProjectionAdmission(request, identity);
  if (admission) return admission;

  const agentBaseUrl = serverAgentBaseUrl();
  const scopedRead = vivaAgentScopedCredential("library_read");
  const upstream = agentBaseUrl ? agentStudyProjectionUrl(agentBaseUrl, query) : null;
  if (!scopedRead || !upstream) return projectionUnavailableResponse();

  return fetchAuthenticatedStudyProjection({
    sessionCredential: presented,
    canonicalOrigin: canonical.value.origin,
    clientSignal: clientAbortSignal(request),
    identity: { sessionId: query.voiceSessionId, studySetId: query.studySetId },
    scopedCredential: scopedRead,
    upstream,
  });
}

type VivaSessionProjectionFailure =
  | VivaSessionProjectionFailureClass
  | VivaSessionProjectionAuthFailureClass;

/**
 * Steps 7-10. The deadline stays armed across the fetch, the bounded read, the parse, the
 * credential scan, and Plan 04's validation, so a slow upstream cannot buy time in any of them.
 */
async function fetchAuthenticatedStudyProjection(input: {
  sessionCredential: string;
  canonicalOrigin: string;
  clientSignal: AbortSignal | null;
  identity: AuthenticatedStudyIdentity;
  scopedCredential: string;
  upstream: URL;
}): Promise<NextResponse<AuthenticatedStudyProjectionV1 | VivaSessionProjectionFailure>> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROJECTION_UPSTREAM_TIMEOUT_MS);
  const abortForClient = () => controller.abort();
  input.clientSignal?.addEventListener("abort", abortForClient, { once: true });
  // A caller that has already gone away gets no response body at all, only a cancelled upstream.
  const refuseLateBody = () => {
    if (!timedOut && input.clientSignal?.aborted) throw input.clientSignal.reason;
  };

  try {
    const response = await fetch(input.upstream, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.scopedCredential}`,
        origin: input.canonicalOrigin,
        "x-viva-session-token": input.sessionCredential,
      },
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!timedOut && input.clientSignal?.aborted) {
      await cancelStreamQuietly(response.body);
      throw input.clientSignal.reason;
    }
    if (timedOut) {
      await cancelStreamQuietly(response.body);
      return projectionTimeoutResponse();
    }
    if (response.status !== 200) {
      await cancelStreamQuietly(response.body);
      return projectionUpstreamStatusResponse(response);
    }

    const bytes = await readBoundedBody(response.body, {
      contentLength: response.headers.get("content-length"),
      limit: WEB_API_BODY_LIMITS.projectionResponse,
      signal: controller.signal,
    });
    refuseLateBody();
    if (timedOut) return projectionTimeoutResponse();

    const parsed = parseBoundedJson(bytes);
    if (!parsed.ok) return projectionUpstreamUnavailableResponse();
    if (containsAgentOriginatedCredential(parsed.value)) {
      // The candidate is dropped unread rather than partially sanitized: a projection that was
      // ever going to carry a credential is not a projection this BFF can repair.
      return projectionJson(502, "viva_session_projection_unavailable", "projection_unavailable", {
        logError: "projection_upstream_credential_violation",
      });
    }

    let projection: AuthenticatedStudyProjectionV1;
    try {
      projection = validateAuthenticatedStudyProjectionV1ForIdentity(parsed.value, input.identity);
    } catch {
      // Field-specific validator messages are internal; only the coarse 502 is public.
      return projectionUpstreamUnavailableResponse();
    }
    refuseLateBody();
    if (timedOut) return projectionTimeoutResponse();
    return NextResponse.json(projection, { headers: vivaWebApiResponseHeaders(), status: 200 });
  } catch (error) {
    if (!timedOut && input.clientSignal?.aborted) throw error;
    return timedOut ? projectionTimeoutResponse() : projectionUpstreamUnavailableResponse();
  } finally {
    clearTimeout(timeoutId);
    input.clientSignal?.removeEventListener("abort", abortForClient);
  }
}

/**
 * A safe read still has to prove it came from the canonical web origin. A same-origin `GET` sends
 * no `Origin` header at all, so the fetch metadata carries the proof and an `Origin`, when the
 * browser does send one, must agree with it. A request with no fetch metadata is refused rather
 * than trusted.
 */
function guardProjectionFetchContext(
  request: NextRequest,
  canonicalOrigin: string,
): NextResponse<VivaSessionProjectionFailureClass> | null {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite !== "same-origin") {
    return projectionJson(403, "cross_origin_session_request", "access_denied");
  }
  const origin = request.headers.get("origin")?.trim();
  if (origin && origin !== canonicalOrigin) {
    return projectionJson(403, "cross_origin_session_request", "access_denied");
  }
  return null;
}

/** Exactly `study_set_id` and `voice_session_id`, once each, both nonempty. Nothing else. */
function exactProjectionQuery(url: URL): ProjectionQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!PROJECTION_QUERY_KEYS.has(key)) return null;
  }
  for (const key of PROJECTION_QUERY_KEYS) {
    if (params.getAll(key).length !== 1) return null;
  }
  const studySetId = params.get("study_set_id")?.trim() ?? "";
  const voiceSessionId = params.get("voice_session_id")?.trim() ?? "";
  if (!studySetId || !voiceSessionId) return null;
  return { studySetId, voiceSessionId };
}

/**
 * The exact credential-header grammar the plan pins, and no other.
 *
 * `Headers.get` joins repeated header values with a comma, so a comma is how a second value
 * announces itself; the token itself is printable ASCII with no spaces. The scheme is matched
 * case-sensitively on purpose: the only client is web-owned code that sends this exact spelling,
 * and a narrower grammar is one less thing to parse on an unauthenticated edge.
 */
function projectionBearerCredential(value: string | null): string | null {
  if (value === null || value.includes(",")) return null;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Strict Plan 05 verification for a route whose caller never states a user id.
 *
 * The study set and the voice session are bound to the QUERY before any claim is believed, and the
 * verified `user_id` is then bound to the configured allowlist. An unconfigured allowlist is a
 * configuration failure, never an open door.
 */
function verifyProjectionAccessToken(
  credential: string,
  query: ProjectionQuery,
): ProjectionAccessTokenVerification {
  const allowedUserIds = configuredAllowlist("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  if (!allowedUserIds || !allowedStudySetIds) return { ok: false, reason: "unavailable" };

  const verified = verifySessionAccessTokenForRoute({
    allowExpired: false,
    expectedBinding: {
      session_id: query.voiceSessionId,
      study_set_id: query.studySetId,
      user_id: null,
    },
    token: credential,
  });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  if (!allowedUserIds.has(verified.claims.user_id)) return { ok: false, reason: "access_denied" };
  if (!allowedStudySetIds.has(verified.claims.study_set_id)) {
    return { ok: false, reason: "access_denied" };
  }
  return { claims: verified.claims, ok: true };
}

/**
 * Every rejection collapses into the one coarse 401 for the caller; only the operator code
 * differs, and it is the same closed vocabulary the session routes already emit.
 */
function projectionAuthFailureCode(
  reason: VivaSessionAccessTokenRejection | "access_denied",
): VivaSessionAuthFailureCode {
  switch (reason) {
    case "access_denied":
      return "access_denied";
    case "binding_mismatch":
      return "identity_mismatch";
    case "expired":
      return "expired";
    case "invalid_signature":
      return "invalid_signature";
    default:
      return "malformed";
  }
}

function agentStudyProjectionUrl(agentBaseUrl: string, query: ProjectionQuery): URL | null {
  try {
    const url = new URL(
      `${trimTrailingSlash(agentBaseUrl)}/v1/study-sets/${encodeURIComponent(
        query.studySetId,
      )}/projection`,
    );
    url.searchParams.set("voice_session_id", query.voiceSessionId);
    return url;
  } catch {
    return null;
  }
}

/** Present on a real `NextRequest`; absent on the plain fixtures the route suites construct. */
function clientAbortSignal(request: NextRequest): AbortSignal | null {
  const signal: unknown = (request as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : null;
}

/**
 * Recursive, order-sensitive detection of any agent-originated credential in a projection body.
 * Keys are matched case-insensitively against the closed set plus any `_token` suffix; string
 * LEAVES are matched against the closed value-marker list, never with a token-shaped regex over
 * serialized JSON.
 */
function containsAgentOriginatedCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAgentOriginatedCredential);
  if (typeof value === "string") return isAgentCredentialString(value);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (isAgentCredentialKey(key)) return true;
    if (containsAgentOriginatedCredential(child)) return true;
  }
  return false;
}

function isAgentCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return AGENT_CREDENTIAL_KEYS.has(normalized) || normalized.endsWith("_token");
}

function isAgentCredentialString(value: string): boolean {
  const normalized = value.toLowerCase();
  return AGENT_CREDENTIAL_VALUE_MARKERS.some((marker) => normalized.includes(marker));
}

function projectionUpstreamStatusResponse(
  response: Response,
): NextResponse<VivaSessionProjectionFailure> {
  if (response.status === 401 || response.status === 403) {
    return projectionAuthTerminalResponse("access_denied");
  }
  if (response.status === 404) {
    return projectionJson(404, "viva_session_projection_not_found", "projection_unavailable");
  }
  if (response.status === 429) {
    const retryAfterSeconds = boundedUpstreamRetryAfterSeconds(response.headers.get("retry-after"));
    if (retryAfterSeconds === null) return projectionUpstreamUnavailableResponse();
    return projectionJson(429, "session_projection_rate_limited", "rate_limit", {
      retryAfterSeconds,
    });
  }
  return projectionUpstreamUnavailableResponse();
}

/**
 * Only whole delta-seconds inside the one-minute window survive. A missing, non-decimal, date-form,
 * zero, or oversized value is an upstream contract violation, not a hint to pass along.
 */
function boundedUpstreamRetryAfterSeconds(value: string | null): number | null {
  const raw = value?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const seconds = Number.parseInt(raw, 10);
  return seconds >= PROJECTION_UPSTREAM_RETRY_AFTER_MIN_SECONDS &&
    seconds <= PROJECTION_UPSTREAM_RETRY_AFTER_MAX_SECONDS
    ? seconds
    : null;
}

function projectionTimeoutResponse(): NextResponse<VivaSessionProjectionFailureClass> {
  return projectionJson(504, "viva_session_projection_timeout", "projection_unavailable");
}

function projectionUpstreamUnavailableResponse(): NextResponse<VivaSessionProjectionFailureClass> {
  return projectionJson(502, "viva_session_projection_unavailable", "projection_unavailable");
}

/**
 * One coarse 401 for every auth rejection. The operator code is carried in the log alone, and it
 * keeps `expired` distinct: the projection route cannot refresh, so expiry is terminal here even
 * though the session routes classify it as recoverable, and an operator has to be able to tell an
 * expiring browser apart from a forged one.
 */
function projectionAuthTerminalResponse(
  operatorCode: VivaSessionAuthFailureCode,
): NextResponse<VivaSessionProjectionAuthFailureClass> {
  emitVivaSessionProjectionFailureLog({
    error: `projection_auth_${operatorCode}`,
    failure_class: "session_auth_failure",
    stage: "session",
    status: 401,
  });
  return NextResponse.json(
    {
      error: "session_auth_terminal" as const,
      failure_class: "session_auth_failure" as const,
      stage: "session" as const,
      token_refresh_outcome: "terminal" as const,
    },
    { headers: vivaWebApiResponseHeaders(), status: 401 },
  );
}

/** Clears every bounded in-memory record this module owns: admission, refresh, and tombstones. */
export function resetVivaSessionSecurityStoreForTests() {
  memorySecurityStoreRateLimits.clear();
  memorySecurityStoreRefreshRecords.clear();
  memorySecurityStoreCapabilityTombstones.clear();
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

export type VivaLibraryControlTokenVerification =
  | { outcome: "valid"; claims: LibraryControlTokenClaims }
  | { outcome: "invalid" }
  | { outcome: "missing_secret" };

export function verifyVivaLibraryControlToken(input: {
  capability: string;
  scope: VivaLibraryControlScope;
  studySetId: string;
  userId: string;
  voiceSessionId?: string | null;
}): VivaLibraryControlTokenVerification {
  if (!bootstrapCapabilityVerificationKeys() || !canonicalWebOrigin().ok) {
    return { outcome: "missing_secret" };
  }
  const claims = verifyLibraryControlTokenClaims(input.capability);
  if (
    !claims ||
    claims.scope !== input.scope ||
    claims.user_id !== input.userId ||
    claims.study_set_id !== input.studySetId ||
    claims.voice_session_id !== (input.voiceSessionId?.trim() || null)
  ) {
    return { outcome: "invalid" };
  }
  return { claims, outcome: "valid" };
}

export type VivaLibraryDeleteCapabilityConsumption =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unavailable" };

/**
 * The one-time destructive capability transaction (`WEBAPI-009`).
 *
 * Verification and consumption live together here so a route can never verify a capability and
 * then forget to spend it. The capability is hashed with SHA-256 before the adapter sees it; the
 * raw signed token never crosses the store boundary. The consume also revokes every refresh record
 * in the capability's scope, and it happens BEFORE the upstream DELETE: a failed upstream leaves
 * credentials revoked, which is the safe direction, and the next library snapshot can mint a fresh
 * delete capability. There is no distributed rollback.
 *
 * Every non-`unavailable` store rejection — expired, replayed, scope mismatch, conflict — collapses
 * into the single `invalid` reason so the route can return one coarse 403 for all of them.
 */
export async function consumeVivaLibraryDeleteCapability(input: {
  capability: string;
  scope: VivaLibraryControlScope;
  studySetId: string;
  userId: string;
  voiceSessionId?: string | null;
}): Promise<VivaLibraryDeleteCapabilityConsumption> {
  const verification = verifyVivaLibraryControlToken(input);
  if (verification.outcome === "missing_secret") return { ok: false, reason: "unavailable" };
  if (verification.outcome === "invalid") return { ok: false, reason: "invalid" };
  const selection = vivaSessionSecurityStore();
  if (!selection.ok) return { ok: false, reason: "unavailable" };

  const claims = verification.claims;
  const voiceSessionId = claims.voice_session_id;
  const outcome = await selection.store.revokeSession({
    capabilityExpiresAt: claims.expires_at,
    capabilityHash: capabilityDigest(input.capability),
    nowSeconds: Math.floor(Date.now() / 1000),
    operation: "consume_delete_and_revoke",
    purpose: claims.scope,
    scope:
      claims.scope === "session_history_delete" && voiceSessionId
        ? {
            identity: {
              sessionId: voiceSessionId,
              studySetId: claims.study_set_id,
              userId: claims.user_id,
            },
            kind: "session",
          }
        : { kind: "study_set", studySetId: claims.study_set_id, userId: claims.user_id },
  });
  if (outcome.ok) return { ok: true };
  return { ok: false, reason: outcome.reason === "unavailable" ? "unavailable" : "invalid" };
}

/** Capabilities reach the shared store only as a SHA-256 digest, never as the signed value. */
function capabilityDigest(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
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

/**
 * Bounded shared mint admission.
 *
 * Two distinct 503 shapes, and the difference is deliberate:
 *
 * - A configured admission limit that is present but outside its recorded range is a rejected
 *   *configuration* value, so it takes the route's generic configuration-unavailable error.
 * - A missing shared store, an unusable store, or an underivable trusted client identity all mean
 *   the same thing — no bounded admission decision can be reached for this request at all — so
 *   they take the shared-admission-unavailable error.
 *
 * Neither shape names an environment variable, a bucket key, or an upstream URL.
 */
async function guardSessionMintAdmission(
  request: NextRequest,
  userId: string,
  studySetId: string,
  logContext: VivaSessionRouteLogContext,
): Promise<NextResponse<VivaSessionRouteFailureClass> | null> {
  const limit = validatedAdmissionLimit(MINT_ADMISSION_LIMIT);
  if (limit === null) return sessionConfigUnavailableResponse(logContext);
  const client = trustedClientAdmissionBucket(request);
  if (!client.ok) return sessionAdmissionUnavailableResponse(logContext);
  const selection = vivaSessionSecurityStore();
  if (!selection.ok) return sessionAdmissionUnavailableResponse(logContext);

  const nowMs = Date.now();
  const outcome = await selection.store.incrementRateLimit({
    keys: [
      admissionKeyHash(["mint", "ip", client.value]),
      admissionKeyHash(["mint", "identity", userId, studySetId]),
    ],
    limit,
    nowMs,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (outcome.ok) return null;
  if (outcome.reason === "unavailable") return sessionAdmissionUnavailableResponse(logContext);
  return sessionJsonError(429, "session_mint_rate_limited", "blocked", {
    ...logContext,
    failure_class: "rate_limit",
    retryAfterSeconds: admissionRetryAfterSeconds(outcome.resetAtMs, nowMs),
  });
}

/**
 * Bounded shared projection admission, keyed by voice session rather than by study set so a
 * projection flood can never consume mint capacity (or the reverse). Task 9's route calls this
 * after it has verified the browser session credential and derived identity from the claims.
 */
export async function guardVivaSessionProjectionAdmission(
  request: NextRequest,
  identity: SessionIdentity,
): Promise<NextResponse<VivaSessionProjectionFailureClass> | null> {
  const limit = validatedAdmissionLimit(PROJECTION_ADMISSION_LIMIT);
  if (limit === null) return projectionUnavailableResponse();
  const client = trustedClientAdmissionBucket(request);
  if (!client.ok) return projectionUnavailableResponse();
  const selection = vivaSessionSecurityStore();
  if (!selection.ok) return projectionUnavailableResponse();

  const nowMs = Date.now();
  const outcome = await selection.store.incrementRateLimit({
    keys: [
      admissionKeyHash(["projection", "ip", client.value]),
      admissionKeyHash([
        "projection",
        "session",
        identity.userId,
        identity.studySetId,
        identity.sessionId,
      ]),
    ],
    limit,
    nowMs,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (outcome.ok) return null;
  if (outcome.reason === "unavailable") return projectionUnavailableResponse();
  return projectionJson(429, "session_projection_rate_limited", "rate_limit", {
    retryAfterSeconds: admissionRetryAfterSeconds(outcome.resetAtMs, nowMs),
  });
}

function projectionUnavailableResponse(): NextResponse<VivaSessionProjectionFailureClass> {
  return projectionJson(503, "viva_session_projection_unavailable", "projection_unavailable");
}

/**
 * The one pre-loop response builder for the whole projection surface: the admission guard and the
 * route share it, so every projection failure carries the same header set and the same operator
 * log. `logError` overrides only the OPERATOR code; the public body stays coarse.
 */
function projectionJson(
  status: number,
  error: string,
  failureClass: string,
  options: { logError?: string; retryAfterSeconds?: number } = {},
): NextResponse<VivaSessionProjectionFailureClass> {
  const headers = vivaWebApiResponseHeaders(
    options.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(options.retryAfterSeconds) },
  );
  emitVivaSessionProjectionFailureLog({
    error: options.logError ?? error,
    failure_class: failureClass,
    stage: "pre_loop",
    status,
  });
  return NextResponse.json(
    { error, failure_class: failureClass, stage: "pre_loop" as const },
    { headers, status },
  );
}

function emitVivaSessionProjectionFailureLog(input: {
  error: string;
  failure_class: string;
  stage: "pre_loop" | "session";
  status: number;
}): void {
  const payload: VivaSessionProjectionFailureLog = {
    deploy_sha: deploymentSha(),
    error: input.error,
    event: "viva_session_projection_failure",
    failure_class: input.failure_class,
    route: "projection",
    service: "web",
    stage: input.stage,
    status: input.status,
  };
  console.warn(JSON.stringify(payload));
}

/** Whole seconds only, never below one, and never derived from a raw bucket key. */
function admissionRetryAfterSeconds(resetAtMs: number | undefined, nowMs: number): number {
  const reset =
    resetAtMs !== undefined && Number.isSafeInteger(resetAtMs)
      ? resetAtMs
      : nowMs + RATE_LIMIT_WINDOW_MS;
  return Math.max(1, Math.ceil((reset - nowMs) / 1_000));
}

/**
 * `sha256(part0 SEP part1 SEP ...)` over the NUL separator, so no caller-supplied identifier can
 * impersonate another bucket by embedding the separator. PII-bearing parts never leave this
 * function unhashed, which is what lets an identity key travel to the shared store.
 */
function admissionKeyHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(ADMISSION_KEY_SEPARATOR), "utf8").digest("hex");
}

/**
 * A present-but-out-of-range admission limit fails configuration instead of silently falling back
 * to the default: a deployment that meant to raise its ceiling must not be quietly narrowed.
 */
function validatedAdmissionLimit(range: AdmissionLimitRange): number | null {
  const raw = process.env[range.name]?.trim();
  if (raw === undefined || raw === "") return range.fallback;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= range.min && value <= range.max ? value : null;
}

/**
 * Trusted client identity for admission bucketing.
 *
 * Next's App Router hands a route handler no trusted peer socket address, so public direct-origin
 * mode is unsupported: a public deployment must declare its hop count and terminate every request
 * through that topology. No platform header (`x-real-ip`, `true-client-ip`, Cloudflare, Vercel) is
 * ever auto-trusted, because any of them is caller-settable without the declared topology.
 */
function trustedClientAdmissionBucket(request: NextRequest): TrustedClientAdmission {
  const raw = process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS?.trim();
  const loopbackOnlyDeployment = inMemorySessionSecurityStoreAllowed();
  if (raw === undefined || raw === "" || raw === "0") {
    return loopbackOnlyDeployment
      ? { ok: true, value: LOOPBACK_ADMISSION_BUCKET }
      : { ok: false, reason: "untrusted" };
  }
  if (!/^[0-9]+$/.test(raw)) return { ok: false, reason: "untrusted" };
  const hops = Number.parseInt(raw, 10);
  if (hops < 1 || hops > TRUSTED_PROXY_MAX_HOPS) return { ok: false, reason: "untrusted" };

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded === null) return { ok: false, reason: "untrusted" };
  const entries = forwarded.split(",").map((entry) => entry.trim());
  if (entries.length < hops) return { ok: false, reason: "untrusted" };
  const normalized: string[] = [];
  for (const entry of entries) {
    const literal = normalizedIpLiteral(entry);
    if (!literal) return { ok: false, reason: "untrusted" };
    normalized.push(literal);
  }
  const selected = normalized.at(-hops);
  return selected ? { ok: true, value: selected } : { ok: false, reason: "untrusted" };
}

/** Accepts an IPv4 dotted quad or a bracketed/plain IPv6 literal, with an optional port. */
function normalizedIpLiteral(entry: string): string | null {
  const unquoted = entry.replace(/^"(.*)"$/, "$1").trim();
  if (!unquoted) return null;
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/.exec(unquoted);
  if (bracketed?.[1]) return isIpv6Literal(bracketed[1]) ? bracketed[1].toLowerCase() : null;
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(unquoted);
  const candidate = ipv4WithPort?.[1] ?? unquoted;
  if (isIpv4Literal(candidate)) return candidate;
  return isIpv6Literal(candidate) ? candidate.toLowerCase() : null;
}

function isIpv4Literal(value: string): boolean {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!octets) return false;
  return octets.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255);
}

function isIpv6Literal(value: string): boolean {
  if (!value.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  if (value.split("::").length > 2) return false;
  const groups = value.split(":");
  return groups.length >= 3 && groups.length <= 8;
}

/**
 * Adapter selection. The bounded in-memory adapter is legal only under `NODE_ENV=test`, or when
 * the canonical web origin and the agent URL are both loopback AND the deployment explicitly
 * asserts a single web instance. Anything else selects the HTTP adapter and fails closed when its
 * two required values are absent; the in-memory adapter is never a fallback after HTTP failure.
 */
export function vivaSessionSecurityStore(): SessionSecurityStoreSelection {
  const memoryAllowed = inMemorySessionSecurityStoreAllowed();
  const mode = process.env.VIVA_SESSION_SECURITY_STORE_MODE?.trim();
  if (mode !== undefined && mode !== "" && mode !== "memory") {
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  if (mode === "memory") {
    return memoryAllowed
      ? { ok: true, store: createMemorySessionSecurityStore() }
      : SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  if (memoryAllowed) return { ok: true, store: createMemorySessionSecurityStore() };
  const rest = createRestSessionSecurityStore();
  return rest ? { ok: true, store: rest } : SESSION_SECURITY_STORE_UNAVAILABLE;
}

/** Test-only inspector for the bounded in-memory record map. */
export function vivaSessionSecurityStoreMemoryRecordCountForTests(): number {
  return memorySecurityStoreRateLimits.size;
}

function inMemorySessionSecurityStoreAllowed(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VIVA_WEB_SINGLE_INSTANCE?.trim() !== "1") return false;
  const canonical = canonicalWebOrigin();
  if (!canonical.ok) return false;
  let originHostname: string;
  try {
    originHostname = new URL(canonical.value.origin).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(originHostname) && isLoopbackAgentUrl(serverAgentBaseUrl());
}

/**
 * Bounded process-local adapter. Every call returns a fresh facade over the one shared map set.
 *
 * Each method body below is synchronous end to end. That is the whole point: JavaScript runs one
 * synchronous block to completion, so "check then insert" inside a single body is the atomic
 * transaction the shared-store contract demands, and two concurrent callers can never both win.
 */
function createMemorySessionSecurityStore(): SessionSecurityStore {
  return {
    consumeRefresh: async (input) => memoryConsumeRefresh(input),
    incrementRateLimit: async (input) => memoryIncrementRateLimit(input),
    revokeSession: async (input) => memoryRevokeSession(input),
    rotateRefresh: async (input) => memoryRotateRefresh(input),
  };
}

function memoryConsumeRefresh(input: {
  credentialHash: string;
  identity: SessionIdentity;
  nowSeconds: number;
  reservationTtlSeconds: 10;
}):
  | { ok: true; absoluteExpiresAt: number; rotationId: string }
  | {
      ok: false;
      reason: "expired" | "identity_mismatch" | "replayed" | "revoked" | "unavailable";
    } {
  // The record is looked up BEFORE any pruning sweep, so a credential used exactly at its horizon
  // reports the precise `expired` operator code instead of collapsing into "unknown hash".
  const record = memorySecurityStoreRefreshRecords.get(input.credentialHash);
  // An unknown hash is a forged or long-expired credential. It reports as a replay so the adapter
  // never separates "never existed" from "already spent" for a caller.
  if (!record) return { ok: false, reason: "replayed" };
  if (!sameSessionIdentity(record.identity, input.identity)) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (record.revoked) return { ok: false, reason: "revoked" };
  if (record.consumed) {
    // Reuse of a consumed tombstone revokes every current record for that session identity
    // through absolute expiry, so the replacement credential the winning rotation issued dies
    // with it and no further rotation can extend the chain.
    revokeMemoryRefreshRecords((identity) => sameSessionIdentity(identity, record.identity));
    return { ok: false, reason: "replayed" };
  }
  if (input.nowSeconds >= record.refreshExpiresAt || input.nowSeconds >= record.absoluteExpiresAt) {
    memorySecurityStoreRefreshRecords.delete(input.credentialHash);
    return { ok: false, reason: "expired" };
  }
  if (record.reservation && input.nowSeconds < record.reservation.expiresAtSeconds) {
    // The losing side of a race is rejected without cancelling the winner's reservation.
    return { ok: false, reason: "replayed" };
  }
  const rotationId = randomUUID();
  record.reservation = {
    expiresAtSeconds: input.nowSeconds + input.reservationTtlSeconds,
    rotationId,
  };
  return { absoluteExpiresAt: record.absoluteExpiresAt, ok: true, rotationId };
}

function memoryRotateRefresh(
  input:
    | {
        mode: "issue";
        identity: SessionIdentity;
        credentialHash: string;
        refreshExpiresAt: number;
        absoluteExpiresAt: number;
      }
    | {
        mode: "rotate";
        identity: SessionIdentity;
        rotationId: string;
        credentialHash: string;
        refreshExpiresAt: number;
        absoluteExpiresAt: number;
      },
): { ok: true } | { ok: false; reason: "conflict" | "unavailable" } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  pruneExpiredMemoryRefreshRecords(nowSeconds);
  if (memorySecurityStoreRefreshRecords.has(input.credentialHash)) {
    return { ok: false, reason: "conflict" };
  }
  if (memorySecurityStoreRefreshRecords.size + 1 > MEMORY_SECURITY_STORE_MAX_RECORDS) {
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  if (input.mode === "rotate") {
    const previous = reservedMemoryRefreshRecord(input.rotationId, nowSeconds);
    if (!previous || !sameSessionIdentity(previous.identity, input.identity)) {
      return { ok: false, reason: "conflict" };
    }
    // The spent hash stays behind as a replay tombstone until its absolute expiry.
    previous.consumed = true;
    previous.reservation = null;
  }
  memorySecurityStoreRefreshRecords.set(input.credentialHash, {
    absoluteExpiresAt: input.absoluteExpiresAt,
    consumed: false,
    identity: { ...input.identity },
    refreshExpiresAt: input.refreshExpiresAt,
    reservation: null,
    revoked: false,
  });
  return { ok: true };
}

function memoryRevokeSession(
  input: Parameters<SessionSecurityStore["revokeSession"]>[0],
):
  | { ok: true }
  | { ok: false; reason: "conflict" | "expired" | "replayed" | "scope_mismatch" | "unavailable" } {
  if (input.operation !== "consume_delete_and_revoke") {
    // D-04 `CONFIRM_DELETE` is the recorded branch, so this deployment neither registers nor
    // consumes a restore capability. The typed union stays so both deployments speak one adapter
    // protocol, but Branch A has no runtime caller and no in-memory implementation; Task 7B owns
    // these two operations if the sponsor ever reselects.
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  if (!Number.isSafeInteger(input.nowSeconds) || !Number.isSafeInteger(input.capabilityExpiresAt)) {
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  pruneExpiredMemoryCapabilityTombstones(input.nowSeconds);
  pruneExpiredMemoryRefreshRecords(input.nowSeconds);
  const scope = input.scope;
  const purposeMatchesScope =
    input.purpose === "session_history_delete"
      ? scope.kind === "session"
      : scope.kind === "study_set";
  if (!purposeMatchesScope) return { ok: false, reason: "scope_mismatch" };
  if (input.nowSeconds >= input.capabilityExpiresAt) return { ok: false, reason: "expired" };
  if (memorySecurityStoreCapabilityTombstones.has(input.capabilityHash)) {
    return { ok: false, reason: "replayed" };
  }
  if (memorySecurityStoreCapabilityTombstones.size + 1 > MEMORY_SECURITY_STORE_MAX_RECORDS) {
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  memorySecurityStoreCapabilityTombstones.set(input.capabilityHash, {
    expiresAt: input.capabilityExpiresAt,
  });
  revokeMemoryRefreshRecords((identity) =>
    scope.kind === "session"
      ? sameSessionIdentity(identity, scope.identity)
      : identity.userId === scope.userId && identity.studySetId === scope.studySetId,
  );
  return { ok: true };
}

function sameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.userId === right.userId &&
    left.studySetId === right.studySetId &&
    left.sessionId === right.sessionId
  );
}

function revokeMemoryRefreshRecords(matches: (identity: SessionIdentity) => boolean): void {
  for (const record of memorySecurityStoreRefreshRecords.values()) {
    if (!matches(record.identity)) continue;
    record.revoked = true;
    record.reservation = null;
  }
}

/** The one live record holding this reservation, or null if it is missing, spent, or timed out. */
function reservedMemoryRefreshRecord(
  rotationId: string,
  nowSeconds: number,
): MemoryRefreshRecord | null {
  for (const record of memorySecurityStoreRefreshRecords.values()) {
    if (record.reservation?.rotationId !== rotationId) continue;
    if (record.consumed || record.revoked) return null;
    return nowSeconds < record.reservation.expiresAtSeconds ? record : null;
  }
  return null;
}

/**
 * Refresh records and capability tombstones are scanned whole rather than pruned from an expired
 * prefix: a rotation carries the original absolute expiry forward and capabilities expire on their
 * own clocks, so insertion order is not expiry order the way it is for a fixed rate-limit window.
 */
function pruneExpiredMemoryRefreshRecords(nowSeconds: number): void {
  for (const [key, record] of memorySecurityStoreRefreshRecords) {
    if (record.absoluteExpiresAt > nowSeconds) continue;
    memorySecurityStoreRefreshRecords.delete(key);
  }
}

function pruneExpiredMemoryCapabilityTombstones(nowSeconds: number): void {
  for (const [key, record] of memorySecurityStoreCapabilityTombstones) {
    if (record.expiresAt > nowSeconds) continue;
    memorySecurityStoreCapabilityTombstones.delete(key);
  }
}

function memoryIncrementRateLimit(input: {
  keys: readonly [string, string];
  limit: number;
  nowMs: number;
  windowMs: 60_000;
}):
  | { ok: true; remaining: number; resetAtMs: number }
  | { ok: false; reason: "limited" | "unavailable"; resetAtMs?: number } {
  pruneExpiredMemoryRateLimitRecords(input.nowMs);
  const resetAtMs = Math.floor(input.nowMs / input.windowMs) * input.windowMs + input.windowMs;
  const keys = [...new Set(input.keys)];

  let newRecords = 0;
  const counts: number[] = [];
  for (const key of keys) {
    const record = memorySecurityStoreRateLimits.get(key);
    const active = record && record.resetAtMs > input.nowMs ? record : null;
    if (!active) newRecords += 1;
    counts.push(active?.count ?? 0);
  }
  if (memorySecurityStoreRateLimits.size + newRecords > MEMORY_SECURITY_STORE_MAX_RECORDS) {
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  }
  if (counts.some((count) => count >= input.limit)) {
    return { ok: false, reason: "limited", resetAtMs };
  }
  // Commit every key or none: one key of a pair is never spent on a rejected admission.
  for (const key of keys) {
    const record = memorySecurityStoreRateLimits.get(key);
    if (record && record.resetAtMs > input.nowMs) {
      record.count += 1;
      continue;
    }
    memorySecurityStoreRateLimits.delete(key);
    memorySecurityStoreRateLimits.set(key, { count: 1, resetAtMs });
  }
  return { ok: true, remaining: Math.max(0, input.limit - Math.max(...counts) - 1), resetAtMs };
}

/**
 * Insertion order is expiry order for a fixed window, so the expired prefix can be dropped without
 * scanning the whole map. A clock that steps backwards only ends the sweep early; it never evicts
 * a live record.
 */
function pruneExpiredMemoryRateLimitRecords(nowMs: number): void {
  for (const [key, record] of memorySecurityStoreRateLimits) {
    if (record.resetAtMs > nowMs) return;
    memorySecurityStoreRateLimits.delete(key);
  }
}

function createRestSessionSecurityStore(): SessionSecurityStore | null {
  const origin = parseCanonicalOrigin(process.env.VIVA_SESSION_SECURITY_STORE_REST_URL);
  if (!origin.ok) return null;
  const credential = validatedSecret("VIVA_SESSION_SECURITY_STORE_REST_TOKEN", {
    maxBytes: WEB_OPAQUE_CREDENTIAL_MAX_BYTES,
  });
  if (!credential) return null;
  const endpoint = `${origin.value.origin}${SESSION_SECURITY_STORE_PATH}`;
  return {
    consumeRefresh: (input) =>
      sessionSecurityStoreCommand(
        endpoint,
        credential,
        "consume_refresh",
        input,
        isConsumeRefreshResult,
      ),
    incrementRateLimit: (input) =>
      sessionSecurityStoreCommand(
        endpoint,
        credential,
        "increment_rate_limit",
        input,
        isIncrementRateLimitResult,
      ),
    revokeSession: (input) =>
      sessionSecurityStoreCommand(
        endpoint,
        credential,
        "revoke_session",
        input,
        isRevokeSessionResult,
      ),
    rotateRefresh: (input) =>
      sessionSecurityStoreCommand(
        endpoint,
        credential,
        "rotate_refresh",
        input,
        isRotateRefreshResult,
      ),
  };
}

/**
 * One state-changing command, never automatically retried. A timeout is an ambiguous commit and
 * fails closed: the caller sees `unavailable` and must obtain fresh authority rather than replay.
 */
async function sessionSecurityStoreCommand<T extends { ok: boolean }>(
  endpoint: string,
  credential: string,
  operation: SessionSecurityStoreOperation,
  input: unknown,
  isResult: (value: unknown) => value is T,
): Promise<T | { ok: false; reason: "unavailable" }> {
  const requestId = randomUUID();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SESSION_SECURITY_STORE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ input, operation, request_id: requestId, schema_version: 1 }),
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await cancelStreamQuietly(response.body);
      return SESSION_SECURITY_STORE_UNAVAILABLE;
    }
    const bytes = await readBoundedStoreResponse(response, controller.signal);
    if (!bytes) return SESSION_SECURITY_STORE_UNAVAILABLE;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return SESSION_SECURITY_STORE_UNAVAILABLE;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return SESSION_SECURITY_STORE_UNAVAILABLE;
    }
    if (!isRecord(parsed)) return SESSION_SECURITY_STORE_UNAVAILABLE;
    const keys = Object.keys(parsed);
    if (
      keys.length !== SESSION_SECURITY_STORE_RESPONSE_KEYS.size ||
      keys.some((key) => !SESSION_SECURITY_STORE_RESPONSE_KEYS.has(key)) ||
      parsed.schema_version !== 1 ||
      parsed.request_id !== requestId ||
      parsed.operation !== operation ||
      !isResult(parsed.result)
    ) {
      return SESSION_SECURITY_STORE_UNAVAILABLE;
    }
    return parsed.result;
  } catch {
    return SESSION_SECURITY_STORE_UNAVAILABLE;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The one byte budget table for every web-owned request and response body.
 *
 * D-04 `CONFIRM_DELETE` is the recorded branch, so the two D-04 Branch B budgets the plan lists
 * (`restoreRequest`, `restoreUpstreamResponse`) are deliberately ABSENT: Task 7B is skipped by the
 * recorded decision matrix, and an unselected branch must leave no artifact behind. Task 7B adds
 * them together with the restore route if the sponsor ever reselects.
 */
export const WEB_API_BODY_LIMITS = {
  libraryRequest: 2 * 1024 * 1024,
  libraryResponse: 2 * 1024 * 1024,
  projectionResponse: 1 * 1024 * 1024,
  securityStoreResponse: 16 * 1024,
  sessionRequest: 16 * 1024,
  sessionUpstreamResponse: 1 * 1024 * 1024,
} as const;

export type VivaBoundedBodyRejection = "aborted" | "too_large";

/** Carries only a coarse reason; no decoder, parser, or upstream text ever reaches a response. */
export class VivaBoundedBodyError extends Error {
  readonly reason: VivaBoundedBodyRejection;

  constructor(reason: VivaBoundedBodyRejection) {
    super(`viva_bounded_body_${reason}`);
    this.name = "VivaBoundedBodyError";
    this.reason = reason;
  }
}

export function vivaBoundedBodyRejection(error: unknown): VivaBoundedBodyRejection | null {
  return error instanceof VivaBoundedBodyError ? error.reason : null;
}

/**
 * The single bounded body reader.
 *
 * An invalid, negative, or already-over-limit declared length rejects BEFORE the reader is
 * acquired, so a hostile `content-length` costs nothing; a lying or absent one cannot beat the
 * streaming byte count. Bytes are counted as `byteLength`, never as string length. The reader is
 * cancelled exactly once on limit, abort, or error, and no chunk is retained afterwards.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  options: { contentLength: string | null; limit: number; signal: AbortSignal },
): Promise<Uint8Array> {
  if (options.contentLength !== null) {
    const declared = Number.parseInt(options.contentLength, 10);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > options.limit) {
      await cancelStreamQuietly(body);
      throw new VivaBoundedBodyError("too_large");
    }
  }
  if (options.signal.aborted) {
    await cancelStreamQuietly(body);
    throw new VivaBoundedBodyError("aborted");
  }
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  let chunks: Uint8Array[] = [];
  let total = 0;
  let rejection: VivaBoundedBodyRejection | null = null;
  // A stalled producer never resolves `read()`, so the abort has to race it rather than being
  // polled between reads; otherwise a hostile client holds the route open past its deadline.
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    if (options.signal.aborted) {
      resolve("aborted");
      return;
    }
    abortHandler = () => resolve("aborted");
    options.signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    while (true) {
      const outcome = await Promise.race([reader.read(), aborted]);
      if (outcome === "aborted") {
        rejection = "aborted";
        break;
      }
      if (outcome.done) break;
      if (!outcome.value) continue;
      total += outcome.value.byteLength;
      if (total > options.limit) {
        rejection = "too_large";
        break;
      }
      chunks.push(outcome.value);
    }
  } catch {
    rejection = options.signal.aborted ? "aborted" : "too_large";
  } finally {
    if (abortHandler) options.signal.removeEventListener("abort", abortHandler);
    if (rejection) await cancelReaderQuietly(reader);
    releaseReaderQuietly(reader);
  }
  if (rejection) {
    chunks = [];
    throw new VivaBoundedBodyError(rejection);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks = [];
  return merged;
}

export type VivaBoundedJsonParse =
  | { ok: true; value: unknown }
  | { ok: false; reason: "duplicate_key" | "malformed" };

/**
 * One fatal UTF-8 decode, one duplicate-key scan before `JSON.parse`, one parse. Callers map the
 * closed reason onto their route's coarse public error; no decoder or parser message escapes.
 */
export function parseBoundedJson(bytes: Uint8Array): VivaBoundedJsonParse {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const scan = scanJsonForDuplicateObjectKeys(text);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason === "duplicate_claim" ? "duplicate_key" : "malformed" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

async function readBoundedStoreResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  try {
    return await readBoundedBody(response.body, {
      contentLength: response.headers.get("content-length"),
      limit: WEB_API_BODY_LIMITS.securityStoreResponse,
      signal,
    });
  } catch {
    return null;
  }
}

function releaseReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Cancelling already released the lock; nothing else to do.
  }
}

async function cancelReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The reader is already closed or errored; nothing else to release.
  }
}

async function cancelStreamQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Best effort only; the caller is already returning the fail-closed outcome.
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isIncrementRateLimitResult(
  value: unknown,
): value is Awaited<ReturnType<SessionSecurityStore["incrementRateLimit"]>> {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasExactKeys(value, ["ok", "remaining", "resetAtMs"]) &&
      Number.isSafeInteger(value.remaining) &&
      (value.remaining as number) >= 0 &&
      Number.isSafeInteger(value.resetAtMs)
    );
  }
  if (value.ok !== false) return false;
  if (value.reason !== "limited" && value.reason !== "unavailable") return false;
  if (hasExactKeys(value, ["ok", "reason"])) return true;
  return (
    hasExactKeys(value, ["ok", "reason", "resetAtMs"]) && Number.isSafeInteger(value.resetAtMs)
  );
}

function isConsumeRefreshResult(
  value: unknown,
): value is Awaited<ReturnType<SessionSecurityStore["consumeRefresh"]>> {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasExactKeys(value, ["ok", "absoluteExpiresAt", "rotationId"]) &&
      Number.isSafeInteger(value.absoluteExpiresAt) &&
      nonEmptyClaimString(value.rotationId) !== null
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    ["expired", "identity_mismatch", "replayed", "revoked", "unavailable"].includes(
      String(value.reason),
    )
  );
}

function isRotateRefreshResult(
  value: unknown,
): value is Awaited<ReturnType<SessionSecurityStore["rotateRefresh"]>> {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok"]);
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    ["conflict", "unavailable"].includes(String(value.reason))
  );
}

function isRevokeSessionResult(
  value: unknown,
): value is Awaited<ReturnType<SessionSecurityStore["revokeSession"]>> {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok"]);
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    ["conflict", "expired", "replayed", "scope_mismatch", "unavailable"].includes(
      String(value.reason),
    )
  );
}

async function readSessionPayload(
  request: NextRequest,
  logContext: VivaSessionRouteLogContext,
): Promise<
  | { ok: true; value: SessionRequestPayload }
  | { ok: false; response: NextResponse<VivaSessionRouteFailureClass> }
> {
  const invalid = () => ({
    ok: false as const,
    response: sessionJsonError(400, "invalid_session_request", "invalid", logContext),
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), sessionBootstrapTimeoutMs());
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request.body, {
      contentLength: request.headers.get("content-length"),
      limit: WEB_API_BODY_LIMITS.sessionRequest,
      signal: controller.signal,
    });
  } catch (error) {
    if (vivaBoundedBodyRejection(error) === "too_large") {
      return {
        ok: false,
        response: sessionPreLoopJsonError(
          413,
          "viva_request_body_too_large",
          "invalid",
          "session_bootstrap_unavailable",
          PRE_LOOP_SESSION_TERMINAL_REASON,
          logContext,
        ),
      };
    }
    return invalid();
  } finally {
    clearTimeout(timeoutId);
  }

  const parsed = parseBoundedJson(bytes);
  if (!parsed.ok || !isRecord(parsed.value)) return invalid();
  return { ok: true, value: parsed.value as SessionRequestPayload };
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
    const upstreamBody = await readBoundedUpstreamSnapshot(response, controller.signal);
    if (!upstreamBody.ok) {
      return {
        ok: false,
        response: sessionPreLoopJsonError(
          502,
          "viva_upstream_response_too_large",
          "failed",
          "session_bootstrap_unavailable",
          PRE_LOOP_SESSION_TERMINAL_REASON,
          logContext,
        ),
      };
    }
    snapshot = upstreamBody.value;
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

/**
 * The upstream library/mint body is read under the same bounded reader as everything else. An
 * overage cancels the stream and is reported to the caller as a distinct outcome, so the route
 * returns the exact 502 the error table names instead of silently degrading to an empty snapshot.
 */
async function readBoundedUpstreamSnapshot(
  response: Response,
  signal: AbortSignal,
): Promise<{ ok: true; value: VivaLibrarySnapshot } | { ok: false }> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(response.body, {
      contentLength: response.headers.get("content-length"),
      limit: WEB_API_BODY_LIMITS.sessionUpstreamResponse,
      signal,
    });
  } catch (error) {
    if (vivaBoundedBodyRejection(error) === "too_large") return { ok: false };
    return { ok: true, value: {} };
  }
  const parsed = parseBoundedJson(bytes);
  if (!parsed.ok || !isRecord(parsed.value)) return { ok: true, value: {} };
  return { ok: true, value: parsed.value as VivaLibrarySnapshot };
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
  expectedBinding: SessionAccessTokenExpectedBinding;
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
    (input.expectedBinding.user_id !== null && userId !== input.expectedBinding.user_id) ||
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
 * All four are validated here now. The fourth was deferred to Task 4, which introduced the shared
 * `SessionSecurityStore` HTTP adapter that is its only reader; `createRestSessionSecurityStore`
 * calls this function for it with `maxBytes: WEB_OPAQUE_CREDENTIAL_MAX_BYTES`, exactly as the
 * scoped bearers do, and a weak value makes the store unselectable rather than unauthenticated.
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
  return parseCanonicalOrigin(process.env.VIVA_WEB_CANONICAL_ORIGIN);
}

/**
 * One canonical-origin grammar, shared by the web origin and the shared security-store URL: the
 * configured value must equal its own parsed origin, carry no credentials/path/query/fragment,
 * and use `https:` unless its host is loopback.
 */
function parseCanonicalOrigin(
  value: string | undefined,
):
  | { ok: true; value: CanonicalWebOrigin }
  | { ok: false; reason: "missing" | "invalid" | "insecure_public" } {
  const raw = value?.trim();
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
  expectedBinding: SessionAccessTokenExpectedBinding;
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
      (input.expectedBinding.user_id !== null &&
        last.claims.user_id !== input.expectedBinding.user_id) ||
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

/**
 * Maps a closed token rejection to the operator auth-failure code BAC-510 observes. The name is
 * pinned by the release observability gate in `scripts/provider-failure-observability.test.mjs`,
 * which asserts this exact call shape at the refresh terminal; keep both in step.
 *
 * `binding_mismatch` is excluded on purpose: BAC-510 wants the identity-binding terminal emitted
 * from its own call site, so routing one through here is a type error rather than a silently
 * lost emitter.
 */
function authFailureCodeForTokenReason(
  reason: Exclude<VivaSessionAccessTokenRejection, "binding_mismatch">,
): Exclude<VivaSessionAuthFailureCode, "expired"> {
  return reason === "invalid_signature" ? "invalid_signature" : "malformed";
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

/**
 * No bounded admission decision could be reached for this request — no shared store, an unusable
 * store, or no trusted client identity. Identical on start and refresh so the shape never tells a
 * caller which half of the admission path refused them.
 */
function sessionAdmissionUnavailableResponse(
  logContext: VivaSessionRouteLogContext,
): NextResponse<VivaSessionRouteFailureClass> {
  return sessionPreLoopJsonError(
    503,
    "viva_session_security_store_unavailable",
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

/**
 * The one web-owned response header set. Built from this allowlist and nothing else: no upstream
 * cache, cookie, or auth header is ever cloned onto a browser-facing response.
 */
export function vivaWebApiResponseHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  });
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function sessionJson(
  body: VivaSessionRouteOutcome,
  status: number,
): NextResponse<VivaSessionRouteOutcome> {
  return NextResponse.json(body, { headers: vivaWebApiResponseHeaders(), status });
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
    retryAfterSeconds?: number;
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
  const headers = vivaWebApiResponseHeaders(
    options.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(options.retryAfterSeconds) },
  );
  return NextResponse.json(body, { headers, status });
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
