import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/provider-failure-dashboard-samples.json" with { type: "json" };
import {
  PROVIDER_FAILURE_ALERTS,
  PROVIDER_FAILURE_DASHBOARD_GROUPS,
  PROVIDER_FAILURE_LOG_QUERIES,
  assertProviderFailureObservabilityEvidence,
  learnerLoopFailureClasses,
  providerFailureObservabilityEvidence,
} from "./provider-failure-observability.mjs";
import {
  REQUIRED_ROLLBACK_TRIGGER_IDS,
  ROLLBACK_TRIGGER_THRESHOLDS,
} from "./rollback-drain-criteria.mjs";

test("provider failure observability defines reusable sanitized log queries", () => {
  const queriesById = new Map(PROVIDER_FAILURE_LOG_QUERIES.map((entry) => [entry.id, entry]));

  for (const id of [
    "provider_429",
    "provider_auth_failure",
    "provider_timeout",
    "malformed_stream",
    "network_disconnect",
    "token_refresh_failure",
    "recap_failure",
    "deploy_drain",
    "watchdog_expiry",
    "stuck_checking",
    "release_gate_stale_evidence",
  ]) {
    assert(queriesById.has(id), `missing query ${id}`);
  }

  assert.match(queriesById.get("provider_429").railway_query, /gemini_http_429/);
  for (const query of PROVIDER_FAILURE_LOG_QUERIES) {
    assert.equal(query.sanitized_query_only, true);
    assert.match(query.id, /^[a-z0-9_]+$/);
    assert(query.evidence_fields.length > 0);
  }
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
  assert(evidence.dashboard.required_artifact_links.some((link) => link.id === "rollback_criteria"));
  assert(evidence.dashboard.required_artifact_links.every((link) => link.sanitized === true));
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
  }

  assert(PROVIDER_FAILURE_ALERTS.some((alert) => alert.id === "bac525_release_gate_stale_evidence"));
});

test("coverage matrix accounts for every BAC-510 failure class", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const coverageByFailureClass = new Map(
    evidence.coverage.map((entry) => [entry.failure_class, entry]),
  );
  const alertIds = new Set(evidence.alerts.map((entry) => entry.id));

  for (const failureClass of learnerLoopFailureClasses()) {
    const coverage = coverageByFailureClass.get(failureClass);
    assert(coverage, `missing coverage for ${failureClass}`);
    if (coverage.alert_id) {
      assert(alertIds.has(coverage.alert_id), `unknown alert for ${failureClass}`);
    } else {
      assert.match(coverage.no_operator_alert_reason, /recoverable|dashboard-only|not an operator/i);
    }
  }
});

test("dashboard fixture keeps Railway 429 evidence sanitized and grouped", () => {
  const evidence = providerFailureObservabilityEvidence({ fixture });
  const railway429 = evidence.fixture.events.find((event) => event.id === "railway_gemini_http_429");

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
    /forbidden marker: answer_text/,
  );
});
