import { createHash, createHmac } from "node:crypto";
import {
  HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
  HOSTED_LIVE_MONITOR_STATE_PROBE_KEY,
  HOSTED_LIVE_MONITOR_STATE_SCHEMA,
} from "./hosted-e2e-matrix.mjs";

export {
  HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
  HOSTED_LIVE_MONITOR_STATE_PROBE_KEY,
  HOSTED_LIVE_MONITOR_STATE_SCHEMA,
};

const STATE_FIELDS = Object.freeze([
  "schema",
  "date_utc",
  "runs_today",
  "tokens_today",
  "cost_usd_today",
  "consecutive_failures",
  "last_failure_at",
  "last_run_at",
  "quarantined_until",
  "active_reservation",
  "last_applied_run_id",
]);
const STATE_FIELD_SET = new Set(STATE_FIELDS);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const PROBE_STALE_ETAG = '"viva-cas-probe-deliberately-stale"';
// RELEASE-018/025: bounded retry for a single conditional S3 request,
// distinct from `reserveLiveMonitorRun`/`finalizeLiveMonitorRun`'s own outer
// CAS retry loop (which re-reads a fresh etag after an observed 412
// conflict). This inner layer only retries a *transport-shaped* failure --
// a thrown fetch error, or HTTP 408/429/5xx -- while replaying the exact
// same conditional header, so a transient network blip never gets confused
// with a real optimistic-concurrency conflict.
const DEFAULT_MAX_TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_BACKOFF_BASE_MS = 20;

/**
 * BAC-527: one run-independent, schema-versioned durable object that owns the
 * scheduled live-monitor authority. No learner/provider payload or secret is
 * ever stored here.
 */
export function zeroLiveMonitorState(dateUtc) {
  return {
    schema: HOSTED_LIVE_MONITOR_STATE_SCHEMA,
    date_utc: dateUtc,
    runs_today: 0,
    tokens_today: 0,
    cost_usd_today: 0,
    consecutive_failures: 0,
    last_failure_at: null,
    last_run_at: null,
    quarantined_until: null,
    active_reservation: null,
    last_applied_run_id: null,
  };
}

function isValidLiveMonitorState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  for (const key of Object.keys(value)) {
    if (!STATE_FIELD_SET.has(key)) return false;
  }
  if (value.schema !== HOSTED_LIVE_MONITOR_STATE_SCHEMA) return false;
  if (typeof value.date_utc !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date_utc))
    return false;
  if (!isNonNegativeSafeInteger(value.runs_today)) return false;
  if (!isNonNegativeSafeInteger(value.tokens_today)) return false;
  if (
    typeof value.cost_usd_today !== "number" ||
    !Number.isFinite(value.cost_usd_today) ||
    value.cost_usd_today < 0
  ) {
    return false;
  }
  if (!isNonNegativeSafeInteger(value.consecutive_failures)) return false;
  if (!isNullableString(value.last_failure_at)) return false;
  if (!isNullableString(value.last_run_at)) return false;
  if (!isNullableString(value.quarantined_until)) return false;
  if (!isNullableString(value.last_applied_run_id)) return false;
  if (value.active_reservation !== null) {
    if (typeof value.active_reservation !== "object" || Array.isArray(value.active_reservation)) {
      return false;
    }
    if (typeof value.active_reservation.run_id !== "string") return false;
    if (!isNullableString(value.active_reservation.reserved_at ?? null)) return false;
  }
  return true;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

/**
 * Probe conditional-write support against a dedicated key, never the live
 * state object: a PUT with a deliberately stale If-Match must be rejected
 * with a precondition failure. A store that accepts the stale precondition,
 * or errors on the header entirely, cannot be trusted for CAS reservation.
 */
export async function probeConditionalWriteSupport({
  store,
  fetchImpl = fetch,
  deadlineMs,
  nowMsImpl,
  sleepImpl,
  jitterImpl,
  maxTransportAttempts,
} = {}) {
  let response;
  try {
    response = await signedS3Request({
      store,
      method: "PUT",
      key: HOSTED_LIVE_MONITOR_STATE_PROBE_KEY,
      body: Buffer.from("viva hosted-monitor conditional-write probe\n"),
      extraHeaders: { "if-match": PROBE_STALE_ETAG },
      fetchImpl,
      deadlineMs,
      nowMsImpl,
      sleepImpl,
      jitterImpl,
      maxTransportAttempts,
    });
  } catch {
    return { supported: false, reason: "probe_request_failed" };
  }
  if (response.status === 412) return { supported: true };
  return { supported: false, reason: `probe_unexpected_status_${response.status}` };
}

/**
 * Read the durable state object. A first-ever 404 initializes schema-valid
 * zero state exactly once with If-None-Match: *. Malformed state, an
 * authentication/read failure, or a conflicting initialization all fail
 * closed as `state_unavailable` (reason distinguishes the cause) instead of
 * silently assuming zero.
 */
export async function loadLiveMonitorState({
  store,
  fetchImpl = fetch,
  deadlineMs,
  nowIso = new Date().toISOString(),
  nowMsImpl,
  sleepImpl,
  jitterImpl,
  maxTransportAttempts,
} = {}) {
  const transportOptions = { deadlineMs, jitterImpl, maxTransportAttempts, nowMsImpl, sleepImpl };
  let response;
  try {
    response = await signedS3Request({
      store,
      method: "GET",
      key: HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
      fetchImpl,
      ...transportOptions,
    });
  } catch {
    return { ok: false, reason: "state_read_failed" };
  }
  if (response.status === 200) {
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return { ok: false, reason: "invalid_state_schema" };
    }
    if (!isValidLiveMonitorState(parsed)) {
      return { ok: false, reason: "invalid_state_schema" };
    }
    return { ok: true, state: parsed, etag: response.etag, created: false };
  }
  if (response.status === 404) {
    const zero = zeroLiveMonitorState(nowIso.slice(0, 10));
    const created = await attemptLiveMonitorStateWrite({
      store,
      fetchImpl,
      state: zero,
      etag: null,
      ...transportOptions,
    });
    if (created.ok) {
      return { ok: true, state: zero, etag: created.etag, created: true };
    }
    return { ok: false, reason: "conflicting_initialization" };
  }
  return { ok: false, reason: "state_read_failed" };
}

/**
 * Attempt a single conditional write. `etag === null` means "must not
 * already exist" (If-None-Match: *); otherwise the write is conditioned on
 * `If-Match: etag`. The caller is responsible for retrying on conflict after
 * a fresh read — this primitive never retries.
 */
export async function attemptLiveMonitorStateWrite({
  store,
  fetchImpl = fetch,
  state,
  etag,
  deadlineMs,
  nowMsImpl,
  sleepImpl,
  jitterImpl,
  maxTransportAttempts,
} = {}) {
  const body = Buffer.from(`${JSON.stringify(state)}\n`);
  // The same conditional header is replayed on every retried attempt inside
  // `signedS3Request` -- a transient transport failure must never cause this
  // write to silently fall back to an unconditional/differently-conditioned
  // request.
  const extraHeaders = etag === null ? { "if-none-match": "*" } : { "if-match": etag };
  let response;
  try {
    response = await signedS3Request({
      store,
      method: "PUT",
      key: HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
      body,
      extraHeaders,
      fetchImpl,
      deadlineMs,
      jitterImpl,
      maxTransportAttempts,
      nowMsImpl,
      sleepImpl,
    });
  } catch {
    return { ok: false, reason: "state_write_failed" };
  }
  if (response.status === 200 || response.status === 201) {
    return { ok: true, etag: response.etag };
  }
  if (response.status === 412) {
    return { ok: false, conflict: true };
  }
  return { ok: false, reason: "state_write_failed" };
}

/**
 * Pure decision: given the currently-read durable state, decide whether the
 * live leg should run and, if so, produce the reserved next-state object
 * that charges the maximum per-run token/cost caps before any provider work
 * begins. Never performs I/O.
 */
export function decideLiveMonitorRun({ state, nowIso, runId, livePolicy, quarantinePolicy }) {
  const now = new Date(nowIso);
  const today = nowIso.slice(0, 10);
  const dateRolled = state.date_utc !== today;
  const runsToday = dateRolled ? 0 : state.runs_today;
  const tokensToday = dateRolled ? 0 : state.tokens_today;
  const costToday = dateRolled ? 0 : state.cost_usd_today;
  const failureInfo = effectiveFailureState(state, now, quarantinePolicy);

  const common = {
    consecutive_failures: failureInfo.consecutiveFailures,
    last_failure_at: failureInfo.lastFailureAt,
    prior_failure_stale: failureInfo.stale,
    seconds_since_last_failure: failureInfo.secondsSinceLastFailure,
    cost_usd_today: costToday,
    tokens_today: tokensToday,
    runs_today: runsToday,
    max_cost_usd_per_day: livePolicy.max_cost_usd_per_day,
    max_tokens_per_day: livePolicy.max_tokens_per_day,
    max_runs_per_day: livePolicy.max_runs_per_day,
    state_schema: HOSTED_LIVE_MONITOR_STATE_SCHEMA,
  };

  if (!Number.isFinite(state.cost_usd_today) || state.cost_usd_today < 0) {
    return { enabled: true, should_run: false, skip_reason: "state_unavailable", ...common };
  }
  if (state.active_reservation?.run_id === runId) {
    return {
      enabled: true,
      should_run: true,
      reused_reservation: true,
      reservedState: state,
      ...common,
    };
  }
  if (state.last_applied_run_id === runId) {
    return { enabled: true, should_run: false, skip_reason: "already_applied", ...common };
  }
  // Quarantine is derived from the single authoritative source
  // (consecutive_failures + last_failure_at, already staleness-adjusted
  // above), not trusted from a separately-stored `quarantined_until` — that
  // field is finalize's own observability snapshot and could otherwise
  // drift out of sync with the counters that actually gate scheduling.
  const failureCountQuarantinedUntil =
    failureInfo.consecutiveFailures >= quarantinePolicy.consecutive_failures &&
    failureInfo.lastFailureAt
      ? new Date(
          new Date(failureInfo.lastFailureAt).getTime() + quarantinePolicy.cooldown_seconds * 1000,
        )
      : null;
  if (failureCountQuarantinedUntil && failureCountQuarantinedUntil.getTime() > now.getTime()) {
    return {
      enabled: true,
      should_run: false,
      skip_reason: "self_quarantined",
      quarantine_source: "failure_count",
      quarantined_until: failureCountQuarantinedUntil.toISOString(),
      quarantine_cooldown_seconds: quarantinePolicy.cooldown_seconds,
      ...common,
    };
  }
  if (runsToday >= livePolicy.max_runs_per_day) {
    return { enabled: true, should_run: false, skip_reason: "daily_budget_exhausted", ...common };
  }
  if (tokensToday >= livePolicy.max_tokens_per_day) {
    return {
      enabled: true,
      should_run: false,
      skip_reason: "daily_token_budget_exhausted",
      ...common,
    };
  }
  if (tokensToday + livePolicy.max_tokens_per_run > livePolicy.max_tokens_per_day) {
    return {
      enabled: true,
      should_run: false,
      skip_reason: "daily_token_budget_remaining_too_low",
      max_tokens_per_run: livePolicy.max_tokens_per_run,
      token_budget_remaining: Math.max(0, livePolicy.max_tokens_per_day - tokensToday),
      ...common,
    };
  }
  if (costToday >= livePolicy.max_cost_usd_per_day) {
    return {
      enabled: true,
      should_run: false,
      skip_reason: "daily_cost_budget_exhausted",
      ...common,
    };
  }
  if (roundUsd(costToday + livePolicy.max_cost_usd_per_run) > livePolicy.max_cost_usd_per_day) {
    return {
      enabled: true,
      should_run: false,
      skip_reason: "daily_cost_budget_remaining_too_low",
      max_cost_usd_per_run: livePolicy.max_cost_usd_per_run,
      cost_budget_remaining_usd: roundUsd(Math.max(0, livePolicy.max_cost_usd_per_day - costToday)),
      ...common,
    };
  }
  if (state.last_run_at) {
    // Cadence is wall-clock elapsed time since the last run; it must not be
    // bypassed just because the UTC date happened to roll over between two
    // runs a few minutes apart.
    const elapsedSeconds = Math.max(
      0,
      Math.floor((now.getTime() - new Date(state.last_run_at).getTime()) / 1000),
    );
    if (elapsedSeconds < livePolicy.min_cadence_seconds) {
      return {
        enabled: true,
        should_run: false,
        skip_reason: "cadence_wait",
        min_cadence_seconds: livePolicy.min_cadence_seconds,
        seconds_since_last_run: elapsedSeconds,
        last_run_at: state.last_run_at,
        ...common,
      };
    }
  }

  const reservedCostToday = roundUsd(costToday + livePolicy.max_cost_usd_per_run);
  const reservedState = {
    ...state,
    schema: HOSTED_LIVE_MONITOR_STATE_SCHEMA,
    date_utc: today,
    runs_today: runsToday + 1,
    tokens_today: tokensToday + livePolicy.max_tokens_per_run,
    cost_usd_today: reservedCostToday,
    last_run_at: nowIso,
    active_reservation: { run_id: runId, reserved_at: nowIso },
  };
  return {
    enabled: true,
    should_run: true,
    reservedState,
    reserved_cost_usd: livePolicy.max_cost_usd_per_run,
    remaining_cost_usd: roundUsd(Math.max(0, livePolicy.max_cost_usd_per_day - reservedCostToday)),
    ...common,
    cost_usd_today: reservedCostToday,
    tokens_today: reservedState.tokens_today,
    runs_today: reservedState.runs_today,
  };
}

/**
 * Orchestrate probe + load + decide + reserve, retrying only an observed
 * precondition conflict after re-reading. A read/auth/schema failure, or an
 * exhausted retry budget, prevents the live child (`state_unavailable`).
 * Idempotent: retrying the exact same run ID never double-charges.
 */
export async function reserveLiveMonitorRun({
  store,
  fetchImpl = fetch,
  runId,
  nowIso = new Date().toISOString(),
  livePolicy,
  quarantinePolicy,
  deadlineMs,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  nowMsImpl,
  sleepImpl,
  jitterImpl,
  maxTransportAttempts,
} = {}) {
  const transportOptions = { deadlineMs, jitterImpl, maxTransportAttempts, nowMsImpl, sleepImpl };
  const probe = await probeConditionalWriteSupport({ store, fetchImpl, ...transportOptions });
  if (!probe.supported) {
    return {
      decision: unavailableDecision(probe.reason ?? "probe_failed"),
      etag: null,
    };
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const loaded = await loadLiveMonitorState({ store, fetchImpl, nowIso, ...transportOptions });
    if (!loaded.ok) {
      return { decision: unavailableDecision(loaded.reason), etag: null };
    }
    const decision = decideLiveMonitorRun({
      state: loaded.state,
      nowIso,
      runId,
      livePolicy,
      quarantinePolicy,
    });
    if (!decision.should_run) {
      return { decision, etag: loaded.etag, state: loaded.state };
    }
    if (decision.reused_reservation) {
      return {
        decision: { ...decision, etag_hash: etagHash(loaded.etag) },
        etag: loaded.etag,
        state: loaded.state,
      };
    }
    const written = await attemptLiveMonitorStateWrite({
      store,
      fetchImpl,
      state: decision.reservedState,
      etag: loaded.etag,
      ...transportOptions,
    });
    if (written.ok) {
      return {
        decision: { ...decision, etag_hash: etagHash(written.etag) },
        etag: written.etag,
        state: decision.reservedState,
      };
    }
    if (!written.conflict) {
      return { decision: unavailableDecision("reservation_write_failed"), etag: null };
    }
    // Precondition conflict: another invocation mutated the object. Re-read and retry.
  }
  return { decision: unavailableDecision("reservation_conflict_exhausted"), etag: null };
}

/**
 * Apply the observed run outcome under CAS. Idempotent on
 * `last_applied_run_id`: a retried finalize for the same run ID never
 * double-increments the failure count. A finalization failure is
 * classified `publish_failed` and must not yield a committed manifest.
 */
export async function finalizeLiveMonitorRun({
  store,
  fetchImpl = fetch,
  runId,
  failed,
  nowIso = new Date().toISOString(),
  quarantinePolicy,
  deadlineMs,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  nowMsImpl,
  sleepImpl,
  jitterImpl,
  maxTransportAttempts,
} = {}) {
  const transportOptions = { deadlineMs, jitterImpl, maxTransportAttempts, nowMsImpl, sleepImpl };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const loaded = await loadLiveMonitorState({ store, fetchImpl, nowIso, ...transportOptions });
    if (!loaded.ok) {
      return { finalized: false, failure_class: "publish_failed", reason: loaded.reason };
    }
    if (loaded.state.last_applied_run_id === runId) {
      return { finalized: true, alreadyApplied: true, state: loaded.state, etag: loaded.etag };
    }
    const now = new Date(nowIso);
    const failureInfo = effectiveFailureState(loaded.state, now, quarantinePolicy);
    const consecutiveFailures = failed ? failureInfo.consecutiveFailures + 1 : 0;
    const quarantinedUntil =
      failed && consecutiveFailures >= quarantinePolicy.consecutive_failures
        ? new Date(now.getTime() + quarantinePolicy.cooldown_seconds * 1000).toISOString()
        : null;
    const nextState = {
      ...loaded.state,
      schema: HOSTED_LIVE_MONITOR_STATE_SCHEMA,
      consecutive_failures: consecutiveFailures,
      last_failure_at: failed ? nowIso : null,
      quarantined_until: quarantinedUntil,
      active_reservation: null,
      last_applied_run_id: runId,
    };
    const written = await attemptLiveMonitorStateWrite({
      store,
      fetchImpl,
      state: nextState,
      etag: loaded.etag,
      ...transportOptions,
    });
    if (written.ok) {
      return { finalized: true, state: nextState, etag: written.etag };
    }
    if (!written.conflict) {
      return { finalized: false, failure_class: "publish_failed", reason: "finalize_write_failed" };
    }
    // Precondition conflict: re-read and retry.
  }
  return {
    finalized: false,
    failure_class: "publish_failed",
    reason: "finalize_conflict_exhausted",
  };
}

function unavailableDecision(reason) {
  return {
    enabled: true,
    should_run: false,
    skip_reason: "state_unavailable",
    state_unavailable_reason: reason,
    state_schema: HOSTED_LIVE_MONITOR_STATE_SCHEMA,
  };
}

function effectiveFailureState(state, now, quarantinePolicy) {
  if (
    !state.last_failure_at ||
    !Number.isSafeInteger(state.consecutive_failures) ||
    state.consecutive_failures <= 0
  ) {
    return {
      consecutiveFailures: 0,
      lastFailureAt: state.last_failure_at ?? null,
      stale: false,
      secondsSinceLastFailure: null,
    };
  }
  const lastFailureAt = new Date(state.last_failure_at);
  const secondsSinceLastFailure = Math.max(
    0,
    Math.floor((now.getTime() - lastFailureAt.getTime()) / 1000),
  );
  const stale = secondsSinceLastFailure > quarantinePolicy.observation_window_seconds;
  return {
    consecutiveFailures: stale ? 0 : state.consecutive_failures,
    lastFailureAt: state.last_failure_at,
    stale,
    secondsSinceLastFailure,
  };
}

function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

function etagHash(etag) {
  if (!etag) return null;
  return createHash("sha256").update(String(etag)).digest("hex").slice(0, 16);
}

function remainingStateMs(deadlineMs, nowMs = Date.now()) {
  if (deadlineMs === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const remaining = Math.floor(deadlineMs - nowMs);
  if (!Number.isFinite(deadlineMs) || remaining <= 0) {
    throw new Error("hosted monitor state request timed out");
  }
  return remaining;
}

/**
 * RELEASE-018/025: retries only a classified-retryable transport failure --
 * a thrown fetch error, or HTTP 408/429/5xx -- replaying the exact same
 * method/key/body/conditional headers each attempt (never re-deriving them),
 * recomputing SigV4 fresh per attempt so `x-amz-date`/the signature never go
 * stale, and bounding every attempt plus its backoff by the same overall
 * `deadlineMs`. Any other status (2xx, 404, 412, other 4xx) returns
 * immediately on the first attempt; the caller alone interprets it.
 */
async function signedS3Request({
  store,
  method,
  key,
  body = null,
  extraHeaders = {},
  fetchImpl = fetch,
  deadlineMs,
  nowMsImpl = Date.now,
  sleepImpl = defaultTransportSleep,
  jitterImpl = defaultTransportJitter,
  maxTransportAttempts = DEFAULT_MAX_TRANSPORT_ATTEMPTS,
}) {
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  for (let attempt = 1; attempt <= maxTransportAttempts; attempt += 1) {
    const timeoutMs = remainingStateMs(deadlineMs, nowMsImpl());
    const endpoint = new URL(store.endpoint);
    endpoint.hostname = `${store.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const headers = {
      ...lowercaseKeys(extraHeaders),
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${headers[name]}`)
      .join("\n");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      method,
      endpoint.pathname,
      "",
      `${canonicalHeaders}\n`,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${store.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest)),
    ].join("\n");
    const signature = hmacHex(
      signingKey(store.secretAccessKey, dateStamp, store.region),
      stringToSign,
    );
    const controller = new AbortController();
    // Deliberately not unref'd: this timer is the only thing that aborts a
    // hung request, and an unref'd timer can let Node's event loop consider
    // itself idle and move on before the correctness-critical abort fires.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let transportError = null;
    try {
      response = await fetchImpl(endpoint, {
        method,
        headers: {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 Credential=${store.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body: method === "GET" || method === "HEAD" ? undefined : payload,
        signal: controller.signal,
      });
    } catch (error) {
      transportError = error;
    } finally {
      clearTimeout(timer);
    }
    const isLastAttempt = attempt === maxTransportAttempts;
    if (!transportError) {
      if (!isRetryableTransportStatus(response.status) || isLastAttempt) {
        return toStateResult(response, attempt);
      }
    } else if (isLastAttempt) {
      throw transportError;
    }
    // Bounded backoff before the next attempt; never sleep past the
    // deadline, and never start a backoff the remaining budget cannot cover.
    const remaining = remainingStateMs(deadlineMs, nowMsImpl());
    const backoffMs = Math.min(
      TRANSPORT_BACKOFF_BASE_MS * 2 ** (attempt - 1) + jitterImpl(),
      remaining - 1,
    );
    if (backoffMs <= 0) {
      if (transportError) throw transportError;
      return toStateResult(response, attempt);
    }
    await sleepImpl(backoffMs);
  }
}

async function toStateResult(response, attempts) {
  const text = typeof response.text === "function" ? await response.text() : "";
  const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
  return { status: response.status, etag, text, attempts };
}

function isRetryableTransportStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function defaultTransportSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultTransportJitter() {
  return Math.floor(Math.random() * 10);
}

function lowercaseKeys(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret, dateStamp, region) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}
