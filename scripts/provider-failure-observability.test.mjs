import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import fixture from "./fixtures/provider-failure-dashboard-samples.json" with { type: "json" };
import {
  assertProviderFailureObservabilityEvidence,
  learnerLoopFailureClasses,
  PROVIDER_FAILURE_ALERTS,
  PROVIDER_FAILURE_DASHBOARD_GROUPS,
  PROVIDER_FAILURE_LOG_QUERIES,
  providerFailureObservabilityEvidence,
} from "./provider-failure-observability.mjs";
import {
  RELEASE_LEARNER_LOOP_CONTRACT,
  validatedLearnerLoopForRelease,
} from "./release-contract-validation.mjs";
import {
  REQUIRED_ROLLBACK_TRIGGER_IDS,
  ROLLBACK_TRIGGER_THRESHOLDS,
} from "./rollback-drain-criteria.mjs";

const providerFailureQueriesById = () =>
  new Map(PROVIDER_FAILURE_LOG_QUERIES.map((entry) => [entry.id, entry]));

test("provider failure observability defines reusable sanitized log queries", () => {
  const queriesById = providerFailureQueriesById();

  for (const id of [
    "provider_429",
    "provider_auth_failure",
    "provider_timeout",
    "cost_budget",
    "malformed_stream",
    "network_disconnect",
    "durability_degraded",
    "tool_executor_failure",
    "token_refresh_failure",
    "startup_unavailable",
    "recap_failure",
    "pending_evaluation",
    "provider_cancellation",
    "deploy_drain",
    "watchdog_expiry",
    "stuck_checking",
    "live_monitor_failure",
    "rollback_observed",
    "release_gate_stale_evidence",
  ]) {
    assert(queriesById.has(id), `missing query ${id}`);
  }

  assert.match(queriesById.get("provider_429").railway_query, /gemini_http_429/);
  assert.match(
    queriesById.get("provider_auth_failure").railway_query,
    /artifact:"viva\.live_provider_smoke\.v1"/,
  );
  assert.match(queriesById.get("provider_auth_failure").railway_query, /configuration_error/);
  assert.match(queriesById.get("cost_budget").railway_query, /failure_class:"cost_budget"/);
  assert.match(
    queriesById.get("watchdog_expiry").railway_query,
    /failure_class:"local_rate_limit"/,
  );
  assert.match(queriesById.get("watchdog_expiry").railway_query, /failure_class:"session_cap"/);
  assert.match(
    queriesById.get("startup_unavailable").railway_query,
    /failure_class:"pre_loop_unavailable"/,
  );
  assert.match(
    queriesById.get("startup_unavailable").railway_query,
    /terminal_reason:"study_store_unavailable"/,
  );
  assert.match(
    queriesById.get("startup_unavailable").railway_query,
    /failure_class:"session_bootstrap_unavailable"/,
  );
  assert.match(
    queriesById.get("startup_unavailable").railway_query,
    /viva_session_identity_allowlist_unavailable/,
  );
  assert.match(
    queriesById.get("tool_executor_failure").railway_query,
    /failure_class:"tool_executor_failure"/,
  );
  assert.match(
    queriesById.get("live_monitor_failure").railway_query,
    /monitor\.live_monitor_consecutive_failures/,
  );
  assert.match(queriesById.get("live_monitor_failure").railway_query, /configuration_error/);
  assert.match(
    queriesById.get("rollback_observed").railway_query,
    /artifact:"viva\.release_evidence\.v1"/,
  );
  assert.match(
    queriesById.get("rollback_observed").railway_query,
    /rollback_drain\.production_release_gate\.reason/,
  );
  assert.doesNotMatch(queriesById.get("rollback_observed").railway_query, /rollback_drain\.schema/);
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /service:"web" event:"viva_session_route_failure"/,
  );
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /service:"agent-service" event:"provider_failure_observed"/,
  );
  assert.match(queriesById.get("token_refresh_failure").railway_query, /route:"refresh"/);
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /signal:"session_auth_rejected"/,
  );
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /token_refresh_outcome:"failed"/,
  );
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /token_refresh_outcome:"blocked"/,
  );
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /failure_class:"rate_limit"/,
  );
  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /error:"session_mint_rate_limited"/,
  );
  assert.doesNotMatch(
    queriesById.get("token_refresh_failure").railway_query,
    /failure_class:"auth_material_failure"/,
  );
  assert.match(
    queriesById.get("startup_unavailable").railway_query,
    /service:"web" event:"viva_session_route_failure"/,
  );
  assert.match(queriesById.get("startup_unavailable").railway_query, /route:"start"/);
  assert.doesNotMatch(queriesById.get("startup_unavailable").railway_query, /route:"refresh"/);
  assert.match(queriesById.get("stuck_checking").railway_query, /monitor\.stuck_checking_sessions/);
  assert.match(queriesById.get("release_gate_stale_evidence").railway_query, /generated_at/);
  assert.doesNotMatch(queriesById.get("release_gate_stale_evidence").railway_query, /<now-24h/);
  assert.match(
    queriesById.get("release_gate_stale_evidence").railway_query,
    /release_gate\.browser_skip_shortcut/,
  );
  assert.doesNotMatch(
    queriesById.get("release_gate_stale_evidence").railway_query,
    /production_release_gate\.evidence_age_seconds/,
  );
  assert.doesNotMatch(
    queriesById.get("release_gate_stale_evidence").railway_query,
    /\sOR evidence_age_seconds/,
  );
  for (const query of PROVIDER_FAILURE_LOG_QUERIES) {
    assert.equal(query.sanitized_query_only, true);
    assert.match(query.id, /^[a-z0-9_]+$/);
    assert(query.evidence_fields.length > 0);
  }
});

test("token refresh query only counts blocked refreshes when rate limited", () => {
  const railwayQuery = providerFailureQueriesById().get("token_refresh_failure").railway_query;

  assert.equal((railwayQuery.match(/token_refresh_outcome:"blocked"/g) ?? []).length, 1);
  assert.match(
    railwayQuery,
    /\(token_refresh_outcome:"blocked" \(failure_class:"rate_limit" OR error:"session_mint_rate_limited"\)\)/,
  );
  assert.doesNotMatch(
    railwayQuery,
    /token_refresh_outcome:"failed" OR token_refresh_outcome:"blocked"/,
  );
});

test("startup query matches web start-route failures by emitted failure class", () => {
  const railwayQuery = providerFailureQueriesById().get("startup_unavailable").railway_query;

  assert.match(
    railwayQuery,
    /service:"web" event:"viva_session_route_failure" route:"start" \([^)]*failure_class:"pre_loop_unavailable"[^)]*failure_class:"session_bootstrap_unavailable"/,
  );
});

test("durability query observes live-smoke readiness store artifacts", () => {
  const durabilityQuery = providerFailureQueriesById().get("durability_degraded");

  assert.match(durabilityQuery.railway_query, /artifact:"viva\.live_provider_smoke\.v1"/);
  assert.match(durabilityQuery.railway_query, /terminal_reason:"readiness_store_unavailable"/);
  for (const field of [
    "terminal_reason",
    "failure.terminal_reason",
    "failure_stage",
    "readiness.store.available",
    "readiness.store.durable",
    "readiness.store.nonce_replay_protection",
  ]) {
    assert(durabilityQuery.evidence_fields.includes(field), `missing evidence field ${field}`);
  }
});

test("reviewed BAC-525 queries name emitted log and evidence surfaces", () => {
  const queriesById = providerFailureQueriesById();

  for (const id of [
    "provider_429",
    "provider_auth_failure",
    "provider_timeout",
    "cost_budget",
    "malformed_stream",
    "network_disconnect",
    "durability_degraded",
    "tool_executor_failure",
    "recap_failure",
    "pending_evaluation",
    "provider_cancellation",
    "deploy_drain",
    "watchdog_expiry",
    "startup_unavailable",
  ]) {
    assert.match(
      queriesById.get(id).railway_query,
      /event:"provider_failure_observed"/,
      `${id} must query the agent structured terminal emitter`,
    );
  }

  assert.match(
    queriesById.get("token_refresh_failure").railway_query,
    /event:"viva_session_route_failure"/,
  );
  assert(
    queriesById.get("token_refresh_failure").evidence_fields.includes("route"),
    "token refresh failure query must expose the route discriminator",
  );
  assert(
    queriesById.get("startup_unavailable").evidence_fields.includes("route"),
    "startup unavailable query must expose the route discriminator",
  );
  assert(
    queriesById.get("token_refresh_failure").evidence_fields.includes("action"),
    "token refresh failure query must expose the action discriminator",
  );
  assert(
    queriesById.get("token_refresh_failure").evidence_fields.includes("terminal_reason"),
    "token refresh failure query must expose websocket terminal reasons",
  );
  assert(
    queriesById.get("token_refresh_failure").evidence_fields.includes("signal"),
    "token refresh failure query must expose websocket auth signals",
  );
  assert.match(
    queriesById.get("stuck_checking").railway_query,
    /artifact:"viva.live_provider_smoke.v1"/,
  );
  assert.match(
    queriesById.get("live_monitor_failure").railway_query,
    /artifact:"viva.live_provider_smoke.v1"/,
  );
  assert(
    queriesById.get("live_monitor_failure").evidence_fields.includes("monitor.terminal_reason"),
    "live monitor failure query must expose monitor terminal reasons",
  );
  assert.match(
    queriesById.get("rollback_observed").railway_query,
    /artifact:"viva.release_evidence.v1"/,
  );
  assert.match(
    queriesById.get("rollback_observed").railway_query,
    /artifact:"viva.rollback_release_gate.v1"/,
  );
  assert(
    queriesById
      .get("rollback_observed")
      .evidence_fields.includes("rollback_drain.owner_decision.decision"),
    "rollback observed query must expose release-evidence owner decisions",
  );
  assert(queriesById.get("release_gate_stale_evidence").evidence_fields.includes("generated_at"));
  assert(
    queriesById
      .get("release_gate_stale_evidence")
      .evidence_fields.includes("release_gate.browser_skip_shortcut"),
  );
});

test("provider failure dashboard groups by every required operator dimension", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });

  assert.equal(evidence.schema, "viva.provider_failure_observability.v1");
  assert.deepEqual(evidence.dashboard.group_by, [...PROVIDER_FAILURE_DASHBOARD_GROUPS]);
  for (const group of [
    "failure_class",
    "stage",
    "provider",
    "model",
    "deploy_sha",
    "latency_bucket",
    "usage_bucket",
    "cost_bucket",
    "terminal_reason",
  ]) {
    assert(evidence.dashboard.group_by.includes(group), `missing dashboard group ${group}`);
  }
  assert(
    evidence.dashboard.required_artifact_links.some((link) => link.id === "rollback_criteria"),
  );
  assert.equal(
    evidence.dashboard.required_artifact_links.find((link) => link.id === "rollback_criteria").path,
    "rollback_drain.criteria",
  );
  assert(evidence.dashboard.required_artifact_links.every((link) => link.sanitized === true));
});

test("provider failure dashboard links the actual release evidence artifact path", () => {
  const evidence = providerFailureObservabilityEvidence({
    fixture,
    releaseEvidencePath: "artifacts/custom-release/evidence.json",
  });

  assert.equal(
    evidence.dashboard.required_artifact_links.find((link) => link.id === "hosted_release_evidence")
      .path,
    "artifacts/custom-release/evidence.json",
  );
});

test("release check exposes stale-evidence inputs without storing write-time age", async () => {
  // RELEASE-005/006/009/010/011: buildReleaseGateEvidence/releaseDeploySha
  // are now scripts/release-check-core.mjs's own extracted, independently
  // behavior-tested primitives (see scripts/release-check.test.mjs and
  // scripts/release-check-core.mjs's own docblocks) -- release-check.mjs
  // itself keeps only the wiring: which inputs it passes to the call.
  const releaseCheck = await readFile("scripts/release-check.mjs", "utf8");
  const releaseCheckCore = await readFile("scripts/release-check-core.mjs", "utf8");

  assert.match(releaseCheck, /release_gate: buildReleaseGateEvidence/);
  assert.match(
    releaseCheck,
    /const browserSkipShortcut = process\.env\.VIVA_RELEASE_CHECK_SKIP_BROWSER === "1"/,
  );
  assert.match(
    releaseCheck,
    /buildReleaseGateEvidence\(\{\s*browserResult,\s*browserSkipShortcut,\s*env: process\.env,\s*generatedAt,?\s*\}\)/,
  );
  assert.match(releaseCheckCore, /browserSkipShortcut \|\| browserResult\?\.skipped === true/);
  assert.match(releaseCheckCore, /deploy_sha: releaseDeploySha\(env\)/);
  for (const name of [
    "RAILWAY_GIT_COMMIT_SHA",
    "VERCEL_GIT_COMMIT_SHA",
    "GITHUB_SHA",
    "SOURCE_VERSION",
  ]) {
    assert.match(releaseCheckCore, new RegExp(name));
  }
  assert.match(releaseCheckCore, /max_age_seconds/);
  assert.doesNotMatch(releaseCheck, /evidence_age_seconds/);
  assert.doesNotMatch(releaseCheckCore, /evidence_age_seconds/);
  assert.match(releaseCheckCore, /browser_skip_shortcut/);
});

test("runtime emitters expose BAC-510 startup and refresh auth failure classes", async () => {
  // Node 08 decomposed ws.rs into ws/ modules; the emitters live in the
  // module tree, so the scan covers the root file plus every ws/ source.
  const wsModuleDir = "agent/crates/agent-service/src/ws";
  const wsModuleFiles = (await readdir(wsModuleDir)).filter((name) => name.endsWith(".rs"));
  const agentWs = (
    await Promise.all([
      readFile("agent/crates/agent-service/src/ws.rs", "utf8"),
      ...wsModuleFiles.map((name) => readFile(`${wsModuleDir}/${name}`, "utf8")),
    ])
  ).join("\n");
  const webSessionRoute = await readFile("apps/web/app/api/viva-session/shared.ts", "utf8");

  assert.match(agentWs, /failure_class: "pre_loop_unavailable"/);
  assert.match(agentWs, /failure_class: "session_bootstrap_unavailable"/);
  assert.match(agentWs, /failure_class: "session_auth_failure"/);
  assert.match(agentWs, /event = "provider_failure_observed"/);
  assert.match(webSessionRoute, /sessionAuthTerminalJsonError\(authFailureCodeForTokenReason/);
  assert.match(webSessionRoute, /sessionAuthTerminalJsonError\("identity_mismatch"/);
  assert.match(webSessionRoute, /failure_class: "session_auth_failure"/);
});

test("provider alerts reuse BAC-527 rollback thresholds without copying numbers", () => {
  const alertsByThreshold = new Map(
    PROVIDER_FAILURE_ALERTS.filter((alert) => alert.source_threshold_id).map((alert) => [
      alert.source_threshold_id,
      alert,
    ]),
  );

  for (const thresholdId of REQUIRED_ROLLBACK_TRIGGER_IDS) {
    const threshold = ROLLBACK_TRIGGER_THRESHOLDS.find((entry) => entry.id === thresholdId);
    const alert = alertsByThreshold.get(thresholdId);
    assert(alert, `missing alert for ${thresholdId}`);
    assert.equal(alert.id, threshold.shared_alert_id);
    assert.equal(alert.metric, threshold.metric);
    assert.equal(alert.operator, threshold.operator);
    assert.equal(alert.value, threshold.value);
    assert.equal(alert.window_seconds, threshold.window_seconds);
    assert.equal(alert.sustained_seconds, threshold.sustained_seconds);
    assert.equal(alert.minimum_sample_metric, threshold.minimum_sample_metric);
    assert.equal(alert.minimum_sample_value, threshold.minimum_sample_value);
    assert.equal(alert.minimum_failure_metric, threshold.minimum_failure_metric);
    assert.equal(alert.minimum_failure_value, threshold.minimum_failure_value);
    assert.equal(typeof alert.query_id, "string");
  }

  assert(
    PROVIDER_FAILURE_ALERTS.some((alert) => alert.id === "bac525_release_gate_stale_evidence"),
  );
  assert(PROVIDER_FAILURE_ALERTS.some((alert) => alert.id === "bac525_cost_budget_exhausted"));
});

test("coverage matrix accounts for every BAC-510 failure class with query-backed alerts", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const coverageByFailureClass = new Map(
    evidence.coverage.map((entry) => [entry.failure_class, entry]),
  );
  const alertsById = new Map(evidence.alerts.map((entry) => [entry.id, entry]));
  const queriesById = new Map(evidence.log_queries.map((entry) => [entry.id, entry]));

  for (const failureClass of learnerLoopFailureClasses()) {
    const coverage = coverageByFailureClass.get(failureClass);
    assert(coverage, `missing coverage for ${failureClass}`);
    if (coverage.alert_id) {
      const alert = alertsById.get(coverage.alert_id);
      assert(alert, `unknown alert for ${failureClass}`);
      assert(alert.query_id, `alert for ${failureClass} missing query`);
      const query = queriesById.get(alert.query_id);
      assert(query, `unknown query for ${failureClass}`);
      assert(
        query.failure_class === failureClass ||
          query.railway_query.includes(`failure_class:"${failureClass}"`) ||
          query.railway_query.includes(
            `terminal_reason:"${failureClass === "local_rate_limit" ? "rate_limit" : failureClass}"`,
          ) ||
          (failureClass === "slow_client" &&
            query.railway_query.includes('terminal_reason:"slow_client"')) ||
          (failureClass === "turn_cap" &&
            query.railway_query.includes('terminal_reason:"turn_cap"')) ||
          (failureClass === "session_cap" &&
            query.railway_query.includes('terminal_reason:"session_cap"')),
        `query ${query.id} does not cover ${failureClass}`,
      );
    } else if (coverage.query_id) {
      const query = queriesById.get(coverage.query_id);
      assert(query, `unknown no-alert query for ${failureClass}`);
      assert(
        query.failure_class === failureClass ||
          query.railway_query.includes(`failure_class:"${failureClass}"`),
        `no-alert query ${query.id} does not cover ${failureClass}`,
      );
    } else {
      assert.match(
        coverage.no_operator_alert_reason,
        /recoverable|dashboard-only|not an operator/i,
      );
    }
  }
});

test("coverage validation rejects alerts whose query text cannot observe the failure", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const unsafe = {
    ...evidence,
    log_queries: evidence.log_queries.map((query) =>
      query.id === "cost_budget"
        ? {
            ...query,
            railway_query: 'service:"agent-service" cost_budget_exhausted:true',
          }
        : query,
    ),
  };

  assert.throws(
    () => assertProviderFailureObservabilityEvidence(unsafe),
    /query cost_budget does not cover cost_budget/,
  );
});

test("dashboard-only coverage must be backed by a concrete log query", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const unsafe = {
    ...evidence,
    coverage: evidence.coverage.map((entry) => {
      if (entry.failure_class !== "pre_loop_unavailable") return entry;
      const { query_id: _queryId, ...withoutQuery } = entry;
      return withoutQuery;
    }),
  };

  assert.throws(
    () => assertProviderFailureObservabilityEvidence(unsafe),
    /coverage for pre_loop_unavailable claims dashboard coverage without a query/,
  );
});

test("shared rollback alerts must keep a query binding", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const liveMonitorAlertId = ROLLBACK_TRIGGER_THRESHOLDS.find(
    (threshold) => threshold.id === "live_monitor_consecutive_failures",
  ).shared_alert_id;
  const unsafe = {
    ...evidence,
    alerts: evidence.alerts.map((alert) => {
      if (alert.id !== liveMonitorAlertId) return alert;
      const { query_id: _queryId, ...withoutQuery } = alert;
      return withoutQuery;
    }),
  };

  assert.throws(
    () => assertProviderFailureObservabilityEvidence(unsafe),
    new RegExp(`alert ${liveMonitorAlertId} is missing query_id`),
  );
});

test("dashboard fixture keeps Railway 429 evidence sanitized and grouped", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const railway429 = evidence.fixture.events.find(
    (event) => event.id === "railway_gemini_http_429",
  );

  assert(railway429);
  assert.equal(railway429.platform, "railway");
  assert.equal(railway429.signal, "gemini_http_429");
  assert.equal(railway429.failure_class, "quota_rate_failure");
  assert.equal(railway429.terminal_reason, "provider_rate_limited");
  for (const group of PROVIDER_FAILURE_DASHBOARD_GROUPS) {
    assert(Object.hasOwn(railway429, group), `fixture event missing ${group}`);
  }
  assert.doesNotThrow(() => assertProviderFailureObservabilityEvidence(evidence));
});

test("provider failure observability rejects forbidden raw payload markers", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const unsafe = {
    ...evidence,
    fixture: {
      ...evidence.fixture,
      events: [
        ...evidence.fixture.events,
        {
          id: "unsafe",
          query_id: "provider_429",
          answer_text: "do not index learner answers",
        },
      ],
    },
  };

  assert.throws(
    () => assertProviderFailureObservabilityEvidence(unsafe),
    /forbidden evidence field: .*answer_text/,
  );

  const bearerSubprotocolLeak = {
    ...evidence,
    fixture: {
      ...evidence.fixture,
      events: [
        ...evidence.fixture.events,
        {
          id: "unsafe_bearer_subprotocol",
          query_id: "provider_429",
          socket_protocol: "bearer.redacted-subprotocol",
        },
      ],
    },
  };

  assert.throws(
    () => assertProviderFailureObservabilityEvidence(bearerSubprotocolLeak),
    /forbidden payload marker: bearer\./,
  );
});

// RELEASE-028: the dashboard's learner-loop-derived rows read the validated
// singleton; an unknown state or evidence field cannot reach an operator panel.
test("provider failure classes are derived from the validated learner-loop contract", () => {
  const contractClasses = new Set(
    RELEASE_LEARNER_LOOP_CONTRACT.states
      .map((state) => state.failure_class)
      .filter((value) => typeof value === "string"),
  );
  const derived = learnerLoopFailureClasses();

  assert.ok(derived.length > 0);
  assert.deepEqual(derived, [...contractClasses].sort());
  assert.equal(Object.isFrozen(RELEASE_LEARNER_LOOP_CONTRACT.states), true);
  assert.throws(() => {
    RELEASE_LEARNER_LOOP_CONTRACT.states[0].failure_class = "rewritten";
  }, TypeError);
});


// RELEASE-028 bypass control: this consumer's own hostile variant. If the
// published validator ever stopped rejecting unknown keys, this test fails
// here rather than letting an unchecked state reach the gate.
test("the observability dashboards refuses a learner-loop variant carrying an unknown nested field", () => {
  const hostile = JSON.parse(JSON.stringify(RELEASE_LEARNER_LOOP_CONTRACT));
  hostile.states[0].viva_hostile_unknown_key = "viva-hostile-sentinel-value-9f2a";

  assert.throws(
    () => validatedLearnerLoopForRelease(hostile),
    (error) => {
      assert.equal(error.code, "learner_loop_contract_invalid");
      assert.equal(
        `${error.message}${error.stack}`.includes("viva-hostile-sentinel-value-9f2a"),
        false,
      );
      return true;
    },
  );
});
