import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
  HOSTED_LIVE_MONITOR_STATE_PROBE_KEY,
  HOSTED_LIVE_MONITOR_STATE_SCHEMA,
} from "./hosted-e2e-matrix.mjs";
import {
  attemptLiveMonitorStateWrite,
  decideLiveMonitorRun,
  finalizeLiveMonitorRun,
  loadLiveMonitorState,
  probeConditionalWriteSupport,
  reserveLiveMonitorRun,
  zeroLiveMonitorState,
} from "./hosted-monitor-state.mjs";

const STORE = Object.freeze({
  accessKeyId: "redacted-key-id",
  bucket: "viva-monitor-evidence",
  endpoint: "https://storage.example.com",
  region: "auto",
  secretAccessKey: "redacted-secret-key",
});

const LIVE_POLICY = Object.freeze({
  min_cadence_seconds: 6 * 60 * 60,
  max_runs_per_day: 2,
  max_tokens_per_run: 4096,
  max_tokens_per_day: 8192,
  max_cost_usd_per_run: 0.1,
  max_cost_usd_per_day: 0.5,
});

const QUARANTINE_POLICY = Object.freeze({
  consecutive_failures: 2,
  observation_window_seconds: 60 * 60,
  cooldown_seconds: 6 * 60 * 60,
});

test("zeroLiveMonitorState carries exactly the run-independent state fields and no learner/provider payload", () => {
  const zero = zeroLiveMonitorState("2026-06-23");

  assert.equal(zero.schema, HOSTED_LIVE_MONITOR_STATE_SCHEMA);
  assert.equal(zero.date_utc, "2026-06-23");
  assert.equal(zero.runs_today, 0);
  assert.equal(zero.tokens_today, 0);
  assert.equal(zero.cost_usd_today, 0);
  assert.equal(zero.consecutive_failures, 0);
  assert.equal(zero.last_failure_at, null);
  assert.equal(zero.last_run_at, null);
  assert.equal(zero.quarantined_until, null);
  assert.equal(zero.active_reservation, null);
  assert.equal(zero.last_applied_run_id, null);
  assert.deepEqual(
    Object.keys(zero).sort(),
    [
      "active_reservation",
      "consecutive_failures",
      "cost_usd_today",
      "date_utc",
      "last_applied_run_id",
      "last_failure_at",
      "last_run_at",
      "quarantined_until",
      "runs_today",
      "schema",
      "tokens_today",
    ].sort(),
  );
});

test("loadLiveMonitorState initializes schema-valid zero state exactly once on a first-ever 404 with If-None-Match: *", async () => {
  const { fetchImpl, calls } = fakeStore();

  const result = await loadLiveMonitorState({
    store: STORE,
    fetchImpl,
    nowIso: "2026-06-23T19:20:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.state.schema, HOSTED_LIVE_MONITOR_STATE_SCHEMA);
  assert.equal(result.state.date_utc, "2026-06-23");
  assert.equal(result.state.runs_today, 0);
  assert.equal(typeof result.etag, "string");

  const puts = calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY);
  assert.equal(puts[0].headers["if-none-match"], "*");
  assert.equal("if-match" in puts[0].headers, false);
});

test("loadLiveMonitorState treats a racing first initialization as state_unavailable rather than guessing", async () => {
  let getCalls = 0;
  const fetchImpl = async (_url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") {
      getCalls += 1;
      return fakeResponse(404, null, "");
    }
    if (method === "PUT") {
      return fakeResponse(412, '"someone-else-already-created-it"', "");
    }
    throw new Error(`unexpected method ${method}`);
  };

  const result = await loadLiveMonitorState({
    store: STORE,
    fetchImpl,
    nowIso: "2026-06-23T19:20:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflicting_initialization");
  assert.equal(getCalls, 1);
});

test("loadLiveMonitorState fails closed on malformed JSON instead of silently assuming zero", async () => {
  const fetchImpl = async () => fakeResponse(200, '"seed-etag"', "not json{{{");

  const result = await loadLiveMonitorState({ store: STORE, fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_state_schema");
});

test("loadLiveMonitorState fails closed on a schema-violating or secret-carrying object instead of silently assuming zero", async () => {
  const wrongSchema = { ...zeroLiveMonitorState("2026-06-23"), schema: "wrong.schema.v1" };
  const withSecret = { ...zeroLiveMonitorState("2026-06-23"), cartesia_api_key: "leaked" };
  const negativeCost = { ...zeroLiveMonitorState("2026-06-23"), cost_usd_today: -0.01 };
  const nonFiniteCost = {
    ...zeroLiveMonitorState("2026-06-23"),
    cost_usd_today: Number.POSITIVE_INFINITY,
  };

  for (const badState of [wrongSchema, withSecret, negativeCost, nonFiniteCost]) {
    const fetchImpl = async () => fakeResponse(200, '"seed-etag"', JSON.stringify(badState));
    const result = await loadLiveMonitorState({ store: STORE, fetchImpl });
    assert.equal(result.ok, false, JSON.stringify(badState));
    assert.equal(result.reason, "invalid_state_schema");
  }
});

test("loadLiveMonitorState fails closed on authentication or read failure instead of silently assuming zero", async () => {
  const authFailure = await loadLiveMonitorState({
    store: STORE,
    fetchImpl: async () => fakeResponse(403, null, "forbidden"),
  });
  assert.equal(authFailure.ok, false);
  assert.equal(authFailure.reason, "state_read_failed");

  const networkFailure = await loadLiveMonitorState({
    store: STORE,
    fetchImpl: async () => {
      throw new Error("network unreachable");
    },
  });
  assert.equal(networkFailure.ok, false);
  assert.equal(networkFailure.reason, "state_read_failed");
});

test("decideLiveMonitorRun blocks a run only once the reservation would exceed the daily cost cap", () => {
  const atBoundary = zeroLiveMonitorState("2026-06-23");
  atBoundary.cost_usd_today = 0.25;

  const allowed = decideLiveMonitorRun({
    state: atBoundary,
    nowIso: "2026-06-23T19:20:00.000Z",
    runId: "run-a",
    livePolicy: { ...LIVE_POLICY, max_cost_usd_per_run: 0.25 },
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(allowed.should_run, true);
  assert.equal(allowed.reservedState.cost_usd_today, 0.5);
  assert.equal(allowed.cost_usd_today, 0.5);
  assert.equal(allowed.max_cost_usd_per_day, 0.5);

  const denied = decideLiveMonitorRun({
    state: atBoundary,
    nowIso: "2026-06-23T19:20:00.000Z",
    runId: "run-a",
    livePolicy: { ...LIVE_POLICY, max_cost_usd_per_run: 0.251 },
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(denied.should_run, false);
  assert.equal(denied.skip_reason, "daily_cost_budget_remaining_too_low");
  assert.equal(denied.cost_usd_today, 0.25);
});

test("decideLiveMonitorRun blocks a run once cost_usd_today has already reached the daily cap", () => {
  const exhausted = zeroLiveMonitorState("2026-06-23");
  exhausted.cost_usd_today = 0.5;

  const decision = decideLiveMonitorRun({
    state: exhausted,
    nowIso: "2026-06-23T19:20:00.000Z",
    runId: "run-a",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(decision.should_run, false);
  assert.equal(decision.skip_reason, "daily_cost_budget_exhausted");
});

test("decideLiveMonitorRun rejects a non-finite or negative durable cost_usd_today rather than scheduling", () => {
  for (const badCost of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
    const state = { ...zeroLiveMonitorState("2026-06-23"), cost_usd_today: badCost };
    const decision = decideLiveMonitorRun({
      state,
      nowIso: "2026-06-23T19:20:00.000Z",
      runId: "run-a",
      livePolicy: LIVE_POLICY,
      quarantinePolicy: QUARANTINE_POLICY,
    });
    assert.equal(decision.should_run, false, String(badCost));
    assert.equal(decision.skip_reason, "state_unavailable");
  }
});

test("decideLiveMonitorRun resets stale failure state outside the observation window", () => {
  const state = {
    ...zeroLiveMonitorState("2026-06-23"),
    consecutive_failures: 1,
    last_failure_at: "2026-06-23T17:00:00.000Z",
  };

  const decision = decideLiveMonitorRun({
    state,
    nowIso: "2026-06-23T19:20:00.000Z",
    runId: "run-a",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(decision.consecutive_failures, 0);
  assert.equal(decision.prior_failure_stale, true);
  assert.equal(decision.should_run, true);
});

test("decideLiveMonitorRun honors the persisted minimum cadence between runs", () => {
  const state = { ...zeroLiveMonitorState("2026-06-23"), last_run_at: "2026-06-23T18:20:00.000Z" };

  const decision = decideLiveMonitorRun({
    state,
    nowIso: "2026-06-23T19:20:00.000Z",
    runId: "run-a",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(decision.should_run, false);
  assert.equal(decision.skip_reason, "cadence_wait");
});

test("reserveLiveMonitorRun charges the maximum per-run cost and token caps before scheduling", async () => {
  const { fetchImpl } = fakeStore();

  const first = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-1",
    nowIso: "2026-06-23T02:00:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(first.decision.should_run, true);
  assert.equal(first.decision.cost_usd_today, 0.1);
  assert.equal(first.decision.tokens_today, 4096);
  assert.equal(first.decision.runs_today, 1);
  assert.equal(typeof first.decision.etag_hash, "string");
  assert.notEqual(first.decision.etag_hash, first.etag);

  const second = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-2",
    nowIso: "2026-06-23T09:00:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(second.decision.should_run, true);
  assert.equal(second.decision.cost_usd_today, 0.2);
  assert.equal(second.decision.tokens_today, 8192);
  assert.equal(second.decision.runs_today, 2);
});

test("reserveLiveMonitorRun is idempotent when the exact same run ID retries an existing reservation", async () => {
  const { fetchImpl, calls } = fakeStore();

  const first = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-1",
    nowIso: "2026-06-23T19:20:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(first.decision.should_run, true);
  const stateWritesAfterFirst = calls.filter(
    (call) => call.method === "PUT" && call.key === HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
  ).length;

  const retry = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-1",
    nowIso: "2026-06-23T19:21:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(retry.decision.should_run, true);
  assert.equal(retry.decision.cost_usd_today, 0.1, "retrying run-1 must not double-charge");
  assert.equal(retry.decision.runs_today, 1, "retrying run-1 must not double-increment");
  const stateWritesAfterRetry = calls.filter(
    (call) => call.method === "PUT" && call.key === HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
  ).length;
  assert.equal(
    stateWritesAfterRetry,
    stateWritesAfterFirst,
    "an idempotent retry must not write the state object again",
  );
});

test("reserveLiveMonitorRun refuses to re-reserve a run ID that was already finalized", async () => {
  const { fetchImpl } = fakeStore({
    seed: {
      [HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY]: {
        ...zeroLiveMonitorState("2026-06-23"),
        last_applied_run_id: "run-1",
      },
    },
  });

  const result = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-1",
    nowIso: "2026-06-23T19:21:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(result.decision.should_run, false);
  assert.equal(result.decision.skip_reason, "already_applied");
});

test("a stale-ETag reservation conflict is rejected at the primitive level so two concurrent runs cannot both pass the daily cap", async () => {
  const { fetchImpl } = fakeStore({
    seed: {
      [HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY]: {
        ...zeroLiveMonitorState("2026-06-23"),
        cost_usd_today: 0.4,
      },
    },
  });
  const nowIso = "2026-06-23T19:20:00.000Z";
  const staleRead = await loadLiveMonitorState({ store: STORE, fetchImpl, nowIso });
  assert.equal(staleRead.ok, true);

  const decisionA = decideLiveMonitorRun({
    state: staleRead.state,
    nowIso,
    runId: "run-a",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(decisionA.should_run, true);
  const writeA = await attemptLiveMonitorStateWrite({
    store: STORE,
    fetchImpl,
    state: decisionA.reservedState,
    etag: staleRead.etag,
  });
  assert.equal(writeA.ok, true);

  const decisionB = decideLiveMonitorRun({
    state: staleRead.state,
    nowIso,
    runId: "run-b",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(
    decisionB.should_run,
    true,
    "the stale snapshot still looks like budget is available",
  );
  const writeB = await attemptLiveMonitorStateWrite({
    store: STORE,
    fetchImpl,
    state: decisionB.reservedState,
    etag: staleRead.etag,
  });
  assert.equal(writeB.ok, false);
  assert.equal(writeB.conflict, true);

  const reReadB = await loadLiveMonitorState({ store: STORE, fetchImpl, nowIso });
  const retryDecisionB = decideLiveMonitorRun({
    state: reReadB.state,
    nowIso,
    runId: "run-b",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(retryDecisionB.should_run, false);
  assert.equal(retryDecisionB.skip_reason, "daily_cost_budget_exhausted");
});

test("probeConditionalWriteSupport passes only when a stale If-Match is rejected with a precondition failure", async () => {
  const { fetchImpl } = fakeStore();
  const passing = await probeConditionalWriteSupport({ store: STORE, fetchImpl });
  assert.equal(passing.supported, true);
});

test("probeConditionalWriteSupport fails closed when the store accepts a stale precondition", async () => {
  const permissiveFetch = async () => fakeResponse(200, '"whatever"', "");
  const result = await probeConditionalWriteSupport({ store: STORE, fetchImpl: permissiveFetch });
  assert.equal(result.supported, false);
});

test("probeConditionalWriteSupport fails closed when the store errors on the conditional header", async () => {
  const erroringFetch = async () => fakeResponse(400, null, "unsupported header");
  const result = await probeConditionalWriteSupport({ store: STORE, fetchImpl: erroringFetch });
  assert.equal(result.supported, false);
});

test("reserveLiveMonitorRun fails the live leg closed when the conditional-write probe fails", async () => {
  const permissiveFetch = async (_url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") return fakeResponse(404, null, "");
    return fakeResponse(200, '"always-accepted"', "");
  };

  const result = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl: permissiveFetch,
    runId: "run-1",
    nowIso: "2026-06-23T19:20:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(result.decision.should_run, false);
  assert.equal(result.decision.skip_reason, "state_unavailable");
});

test("finalizeLiveMonitorRun increments consecutive failures, quarantines, and is idempotent per run ID", async () => {
  const { fetchImpl } = fakeStore({
    seed: {
      [HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY]: {
        ...zeroLiveMonitorState("2026-06-23"),
        consecutive_failures: 1,
        last_failure_at: "2026-06-23T19:00:00.000Z",
        active_reservation: { run_id: "run-2", reserved_at: "2026-06-23T19:20:00.000Z" },
      },
    },
  });

  const finalized = await finalizeLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-2",
    failed: true,
    nowIso: "2026-06-23T19:21:00.000Z",
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(finalized.finalized, true);
  assert.equal(finalized.state.consecutive_failures, 2);
  assert.equal(finalized.state.quarantined_until, "2026-06-24T01:21:00.000Z");
  assert.equal(finalized.state.active_reservation, null);
  assert.equal(finalized.state.last_applied_run_id, "run-2");

  const retry = await finalizeLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-2",
    failed: true,
    nowIso: "2026-06-23T19:22:00.000Z",
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(retry.finalized, true);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.state.consecutive_failures, 2, "a retried finalize must not double-increment");
});

test("finalizeLiveMonitorRun resets consecutive failures and clears quarantine on success", async () => {
  const { fetchImpl } = fakeStore({
    seed: {
      [HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY]: {
        ...zeroLiveMonitorState("2026-06-23"),
        consecutive_failures: 1,
        last_failure_at: "2026-06-23T19:00:00.000Z",
        quarantined_until: null,
      },
    },
  });

  const finalized = await finalizeLiveMonitorRun({
    store: STORE,
    fetchImpl,
    runId: "run-3",
    failed: false,
    nowIso: "2026-06-23T19:21:00.000Z",
    quarantinePolicy: QUARANTINE_POLICY,
  });

  assert.equal(finalized.state.consecutive_failures, 0);
  assert.equal(finalized.state.quarantined_until, null);
});

test("finalizeLiveMonitorRun surfaces publish_failed when durable state cannot be read or written", async () => {
  const readFailure = await finalizeLiveMonitorRun({
    store: STORE,
    fetchImpl: async () => fakeResponse(403, null, "forbidden"),
    runId: "run-4",
    failed: true,
    nowIso: "2026-06-23T19:21:00.000Z",
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(readFailure.finalized, false);
  assert.equal(readFailure.failure_class, "publish_failed");

  const writeFailure = await finalizeLiveMonitorRun({
    store: STORE,
    fetchImpl: async (_url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET") return fakeResponse(404, null, "");
      if (init.headers?.["if-none-match"]) return fakeResponse(200, '"created"', "");
      return fakeResponse(500, null, "internal error");
    },
    runId: "run-4",
    failed: true,
    nowIso: "2026-06-23T19:21:00.000Z",
    quarantinePolicy: QUARANTINE_POLICY,
  });
  assert.equal(writeFailure.finalized, false);
  assert.equal(writeFailure.failure_class, "publish_failed");
});

test("loadLiveMonitorState retries a transient network error then succeeds", async () => {
  const seeded = fakeStore({
    seed: { [HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY]: zeroLiveMonitorState("2026-06-23") },
  });
  let calls = 0;
  const fetchImpl = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error("network unreachable");
    return seeded.fetchImpl(...args);
  };
  const result = await loadLiveMonitorState({
    store: STORE,
    fetchImpl,
    nowIso: "2026-06-23T19:20:00.000Z",
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, false, "the seeded object must be read, not re-initialized");
  assert.equal(calls, 2, "must retry exactly once after the transient network error");
});

test("attemptLiveMonitorStateWrite retries HTTP 503 then succeeds, preserving the same conditional header across attempts", async () => {
  const calls = [];
  let attempts = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    attempts += 1;
    const headers = lowercaseHeaders(init.headers ?? {});
    calls.push({ headers, method: init.method ?? "GET" });
    if (attempts === 1) return fakeResponse(503, null, "unavailable");
    return fakeResponse(200, '"etag-after-retry"', "");
  };

  const result = await attemptLiveMonitorStateWrite({
    store: STORE,
    fetchImpl,
    state: zeroLiveMonitorState("2026-06-23"),
    etag: '"etag-0"',
    sleepImpl: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["if-match"], '"etag-0"');
  assert.equal(calls[1].headers["if-match"], '"etag-0"', "a retried write must reuse the same conditional header, not a freshly re-read etag");
});

test("hosted monitor state requests honor bounded retry under HTTP 429 without exceeding the overall deadline", async () => {
  const start = 1_000_000;
  let now = start;
  const deadlineMs = start + 10_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    now += 5;
    return fakeResponse(429, null, "slow down");
  };
  const sleepCalls = [];

  const result = await loadLiveMonitorState({
    store: STORE,
    fetchImpl,
    deadlineMs,
    jitterImpl: () => 0,
    nowMsImpl: () => now,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
      now += ms;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_read_failed");
  assert.equal(calls, 3, "at most three transport attempts");
  assert.equal(sleepCalls.length, 2);
  assert.ok(now <= deadlineMs, "the simulated clock never runs past the state request deadline");
});

test("hosted monitor state requests never retry a non-retryable 4xx and make exactly one attempt", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse(400, null, "bad request");
  };
  const result = await loadLiveMonitorState({
    store: STORE,
    fetchImpl,
    sleepImpl: async () => {
      throw new Error("must not back off before a non-retryable 4xx");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1, "a non-retryable 4xx must not be retried");
});

test("hosted monitor state request backoff refuses to start when the remaining deadline cannot cover it", async () => {
  const start = 1_000_000;
  let now = start;
  const deadlineMs = start + 25;
  const fetchImpl = async () => {
    now += 24;
    return fakeResponse(503, null, "unavailable");
  };
  const sleepCalls = [];

  const result = await loadLiveMonitorState({
    store: STORE,
    fetchImpl,
    deadlineMs,
    jitterImpl: () => 0,
    nowMsImpl: () => now,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(sleepCalls.length, 0, "backoff must never start once it cannot fit before the deadline");
});

test("reserving state surfaces CAS-conflict exhaustion separately from a persistent transport/status failure", async () => {
  const keyFromUrl = (rawUrl) => decodeURIComponent(new URL(rawUrl).pathname.replace(/^\//, ""));

  const alwaysConflicting = async (rawUrl, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") {
      return fakeResponse(200, '"current-etag"', JSON.stringify(zeroLiveMonitorState("2026-06-23")));
    }
    if (keyFromUrl(rawUrl) === HOSTED_LIVE_MONITOR_STATE_PROBE_KEY) {
      return fakeResponse(412, '"probe-etag"', "");
    }
    return fakeResponse(412, '"someone-elses-etag"', "");
  };
  const conflictExhausted = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl: alwaysConflicting,
    runId: "run-conflict",
    nowIso: "2026-06-23T19:20:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
    sleepImpl: async () => {},
  });
  assert.equal(conflictExhausted.decision.should_run, false);
  assert.equal(conflictExhausted.decision.skip_reason, "state_unavailable");
  assert.equal(conflictExhausted.decision.state_unavailable_reason, "reservation_conflict_exhausted");

  const alwaysFailingWrite = async (rawUrl, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") {
      return fakeResponse(200, '"current-etag"', JSON.stringify(zeroLiveMonitorState("2026-06-23")));
    }
    if (keyFromUrl(rawUrl) === HOSTED_LIVE_MONITOR_STATE_PROBE_KEY) {
      return fakeResponse(412, '"probe-etag"', "");
    }
    return fakeResponse(500, null, "internal error");
  };
  const writeFailed = await reserveLiveMonitorRun({
    store: STORE,
    fetchImpl: alwaysFailingWrite,
    runId: "run-transport",
    nowIso: "2026-06-23T19:20:00.000Z",
    livePolicy: LIVE_POLICY,
    quarantinePolicy: QUARANTINE_POLICY,
    sleepImpl: async () => {},
  });
  assert.equal(writeFailed.decision.should_run, false);
  assert.equal(writeFailed.decision.skip_reason, "state_unavailable");
  assert.equal(writeFailed.decision.state_unavailable_reason, "reservation_write_failed");

  assert.notEqual(
    conflictExhausted.decision.state_unavailable_reason,
    writeFailed.decision.state_unavailable_reason,
    "CAS exhaustion and a persistent transport/status failure must surface as distinct reasons",
  );
});

function fakeStore({ seed = {}, ignoreConditionalHeaders = false } = {}) {
  const objects = new Map();
  for (const [key, value] of Object.entries(seed)) {
    objects.set(key, { etag: `"seed-${key.length}-${objects.size}"`, body: JSON.stringify(value) });
  }
  const calls = [];
  let counter = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const method = init.method ?? "GET";
    const headers = lowercaseHeaders(init.headers ?? {});
    calls.push({ key, method, headers });
    const existing = objects.get(key);
    if (method === "GET") {
      if (!existing) return fakeResponse(404, null, "");
      return fakeResponse(200, existing.etag, existing.body);
    }
    if (method === "PUT") {
      if (!ignoreConditionalHeaders) {
        const ifNoneMatch = headers["if-none-match"];
        const ifMatch = headers["if-match"];
        if (ifNoneMatch !== undefined) {
          if (existing) return fakeResponse(412, existing.etag, "");
        } else if (ifMatch !== undefined) {
          if (!existing || existing.etag !== ifMatch) {
            return fakeResponse(412, existing?.etag ?? null, "");
          }
        }
      }
      counter += 1;
      const etag = `"etag-${counter}"`;
      objects.set(key, { etag, body: bodyToString(init.body) });
      return fakeResponse(200, etag, "");
    }
    throw new Error(`fake store: unsupported method ${method}`);
  };
  return { fetchImpl, objects, calls };
}

// ROW 475/QLT-06: under Node 24 an unref'd abort timer let the event loop
// consider itself idle before this correctness-critical CAS-request deadline
// fired, silently cancelling requests. The fix (never unref'd) is comment-
// only until pinned by a test.
test("ROW 475/QLT-06: the CAS request's abort timer is never unref'd between its declaration and its cleanup", () => {
  const source = readFileSync(new URL("./hosted-monitor-state.mjs", import.meta.url), "utf8");
  const declIndex = source.indexOf('const timer = setTimeout(() => controller.abort(), timeoutMs);');
  assert.notEqual(declIndex, -1, "expected timer declaration not found");
  const clearIndex = source.indexOf("clearTimeout(timer)", declIndex);
  assert.notEqual(clearIndex, -1, "expected clearTimeout(timer) not found after declaration");
  assert.doesNotMatch(source.slice(declIndex, clearIndex), /timer\.unref\(\)/);
});

function fakeResponse(status, etag, text) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
    text: async () => text,
  };
}

function lowercaseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function bodyToString(body) {
  if (body === undefined || body === null) return "";
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return String(body);
}
