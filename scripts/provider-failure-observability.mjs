import learnerLoopContract from "../packages/core/src/learner-loop-contract.json" with {
  type: "json",
};
import { assertNoForbiddenEvidenceMarkers } from "./redaction-control.mjs";
import {
  REQUIRED_ROLLBACK_TRIGGER_IDS,
  ROLLBACK_TRIGGER_THRESHOLDS,
} from "./rollback-drain-criteria.mjs";

const OBSERVABILITY_SCHEMA = "viva.provider_failure_observability.v1";

export const PROVIDER_FAILURE_DASHBOARD_GROUPS = Object.freeze([
  "failure_class",
  "stage",
  "provider",
  "model",
  "deploy_sha",
  "latency_bucket",
  "usage_bucket",
  "cost_bucket",
  "terminal_reason",
]);

const query = ({
  id,
  title,
  failure_class,
  stage,
  terminal_reason = null,
  railway_query,
  evidence_fields,
}) =>
  Object.freeze({
    id,
    title,
    failure_class,
    stage,
    terminal_reason,
    railway_query,
    evidence_fields: Object.freeze(evidence_fields),
    sanitized_query_only: true,
  });

export const PROVIDER_FAILURE_LOG_QUERIES = Object.freeze([
  query({
    id: "provider_429",
    title: "Gemini quota/rate-limit terminal turns",
    failure_class: "quota_rate_failure",
    stage: "provider",
    terminal_reason: "provider_rate_limited",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (signal:"gemini_http_429" OR terminal_reason:"provider_rate_limited" OR failure_class:"quota_rate_failure")',
    evidence_fields: [
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
      "usage",
      "cost_usd",
      "terminal_reason",
    ],
  }),
  query({
    id: "provider_auth_failure",
    title: "Live provider auth/configuration failures",
    failure_class: "provider_auth_failure",
    stage: "provider_auth",
    terminal_reason: "provider_auth_failed",
    railway_query:
      '(service:"agent-service" event:"provider_failure_observed" (terminal_reason:"provider_auth_failed" OR failure_class:"provider_auth_failure")) OR (artifact:"viva.live_provider_smoke.v1" (failure_class:"provider_auth_failure" OR terminal_reason:"configuration_error" OR terminal_reason:"readiness_not_live_selectable" OR monitor.terminal_reason:"configuration_error" OR monitor.terminal_reason:"readiness_not_live_selectable"))',
    evidence_fields: [
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
      "monitor.terminal_reason",
    ],
  }),
  query({
    id: "provider_timeout",
    title: "Provider and recap timeout terminal turns",
    failure_class: "timeout",
    stage: "websocket",
    terminal_reason: "provider_timeout",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"provider_timeout" OR failure_class:"timeout")',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
    ],
  }),
  query({
    id: "cost_budget",
    title: "Provider cost-budget terminal turns",
    failure_class: "cost_budget",
    stage: "provider",
    terminal_reason: "cost_budget",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"cost_budget" OR failure_class:"cost_budget" OR signal:"cost_budget_exhausted")',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
      "cost_usd",
    ],
  }),
  query({
    id: "malformed_stream",
    title: "Malformed or structured provider stream failures",
    failure_class: "malformed_stream",
    stage: "websocket",
    terminal_reason: "provider_malformed_stream",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"provider_malformed_stream" OR failure_class:"malformed_stream")',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
    ],
  }),
  query({
    id: "network_disconnect",
    title: "Provider transport disconnects",
    failure_class: "network_disconnect",
    stage: "transport",
    terminal_reason: "provider_network_disconnect",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"provider_network_disconnect" OR failure_class:"network_disconnect")',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
    ],
  }),
  query({
    id: "durability_degraded",
    title: "Durable store degraded terminal sessions",
    failure_class: "durability_degraded",
    stage: "store",
    terminal_reason: "durability_degraded",
    railway_query:
      '(service:"agent-service" event:"provider_failure_observed" (terminal_reason:"durability_degraded" OR failure_class:"durability_degraded")) OR (artifact:"viva.live_provider_smoke.v1" (failure_class:"durability_degraded" OR terminal_reason:"durability_degraded" OR terminal_reason:"readiness_store_unavailable" OR failure.failure_class:"durability_degraded" OR failure.terminal_reason:"durability_degraded" OR failure.terminal_reason:"readiness_store_unavailable"))',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "deploy_sha",
      "latency_ms",
      "failure.terminal_reason",
      "failure_stage",
      "readiness.store.available",
      "readiness.store.durable",
      "readiness.store.nonce_replay_protection",
    ],
  }),
  query({
    id: "tool_executor_failure",
    title: "Tool executor terminal failures",
    failure_class: "tool_executor_failure",
    stage: "tools",
    terminal_reason: "tool_executor_failure",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"tool_executor_failure" OR failure_class:"tool_executor_failure")',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
    ],
  }),
  query({
    id: "token_refresh_failure",
    title: "Signed-session token refresh failures",
    failure_class: "session_auth_failure",
    stage: "session_auth",
    railway_query:
      '(service:"web" event:"viva_session_route_failure" route:"refresh" (token_refresh_outcome:"failed" OR (token_refresh_outcome:"blocked" (failure_class:"rate_limit" OR error:"session_mint_rate_limited")) OR failure_class:"session_auth_failure" OR failure_class:"rate_limit" OR error:"viva_session_refresh_unavailable" OR error:"viva_session_agent_unavailable" OR error:"session_mint_unavailable" OR error:"session_mint_rate_limited" OR token_refresh_outcome:"invalid_rejected" OR token_refresh_outcome:"malformed_rejected" OR token_refresh_outcome:"identity_mismatch")) OR (service:"agent-service" event:"provider_failure_observed" failure_class:"session_auth_failure" stage:"session_auth" signal:"session_auth_rejected")',
    evidence_fields: [
      "action",
      "failure_class",
      "stage",
      "deploy_sha",
      "error",
      "model",
      "provider",
      "route",
      "signal",
      "terminal_reason",
      "token_refresh_outcome",
      "latency_ms",
    ],
  }),
  query({
    id: "startup_unavailable",
    title: "Pre-loop and session-bootstrap unavailable gates",
    failure_class: "pre_loop_unavailable",
    stage: "startup",
    railway_query:
      '(service:"agent-service" event:"provider_failure_observed" (failure_class:"pre_loop_unavailable" OR failure_class:"session_bootstrap_unavailable" OR terminal_reason:"study_set_access_denied" OR terminal_reason:"study_store_unavailable" OR terminal_reason:"pre_loop_unavailable" OR terminal_reason:"session_bootstrap_unavailable")) OR (service:"web" event:"viva_session_route_failure" route:"start" (failure_class:"pre_loop_unavailable" OR failure_class:"session_bootstrap_unavailable" OR error:"viva_session_bootstrap_unavailable" OR error:"viva_session_agent_unavailable" OR error:"session_mint_unavailable" OR error:"viva_session_identity_allowlist_unavailable"))',
    evidence_fields: [
      "failure_class",
      "stage",
      "deploy_sha",
      "error",
      "latency_ms",
      "route",
      "terminal_reason",
    ],
  }),
  query({
    id: "recap_failure",
    title: "Partial recap or recap failure terminal turns",
    failure_class: "partial_stage_success",
    stage: "recap",
    terminal_reason: "partial_stage_success",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"partial_stage_success" OR failure_class:"recap_failure" OR signal:"recap_failure")',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "deploy_sha",
      "latency_ms",
      "recap_success",
    ],
  }),
  query({
    id: "pending_evaluation",
    title: "Saved pending-evaluation durable states",
    failure_class: "pending_evaluation",
    stage: "store",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (failure_class:"pending_evaluation" OR terminal_reason:"pending_evaluation")',
    evidence_fields: ["failure_class", "stage", "deploy_sha", "latency_ms", "evaluation_state"],
  }),
  query({
    id: "provider_cancellation",
    title: "Provider cancellation terminal sessions",
    failure_class: "cancellation",
    stage: "provider",
    terminal_reason: "provider_cancelled",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"provider_cancelled" OR failure_class:"cancellation" OR signal:"provider_cancelled")',
    evidence_fields: ["terminal_reason", "failure_class", "stage", "deploy_sha", "latency_ms"],
  }),
  query({
    id: "deploy_drain",
    title: "Deploy drain terminal sessions",
    failure_class: "deploy_drain",
    stage: "deployment",
    terminal_reason: "drained",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"drained" OR failure_class:"deploy_drain")',
    evidence_fields: ["terminal_reason", "failure_class", "stage", "deploy_sha", "latency_ms"],
  }),
  query({
    id: "watchdog_expiry",
    title: "Watchdog and turn-cap terminal sessions",
    failure_class: "turn_cap",
    stage: "session",
    terminal_reason: "turn_cap",
    railway_query:
      'service:"agent-service" event:"provider_failure_observed" (terminal_reason:"turn_cap" OR terminal_reason:"slow_client" OR terminal_reason:"rate_limit" OR terminal_reason:"session_cap" OR failure_class:"turn_cap" OR failure_class:"local_rate_limit" OR failure_class:"session_cap")',
    evidence_fields: ["terminal_reason", "failure_class", "stage", "deploy_sha", "latency_ms"],
  }),
  query({
    id: "stuck_checking",
    title: "Submitted-answer sessions still checking beyond BAC-510 bound",
    failure_class: "stuck_checking",
    stage: "session",
    railway_query:
      'artifact:"viva.live_provider_smoke.v1" (failure_class:"stuck_checking" OR monitor.stuck_checking_sessions:">=1" OR terminal_reason:"recap_timeout")',
    evidence_fields: [
      "failure_class",
      "stage",
      "deploy_sha",
      "latency_ms",
      "monitor.stuck_checking_sessions",
      "terminal_reason",
    ],
  }),
  query({
    id: "live_monitor_failure",
    title: "Consecutive hosted live monitor failures",
    failure_class: "live_monitor_failure",
    stage: "monitor",
    railway_query:
      'artifact:"viva.live_provider_smoke.v1" (failure_class:"live_monitor_failure" OR monitor.live_monitor_consecutive_failures:">=2" OR monitor.signal:"live_monitor_failure" OR monitor.terminal_reason:"configuration_error")',
    evidence_fields: [
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
      "monitor.live_monitor_attempt_count",
      "monitor.live_monitor_consecutive_failures",
      "monitor.terminal_reason",
    ],
  }),
  query({
    id: "rollback_observed",
    title: "Rollback decisions and executions",
    failure_class: "rollback",
    stage: "rollback",
    terminal_reason: "rollback",
    railway_query:
      '(artifact:"viva.release_evidence.v1" (rollback_drain.owner_decision.decision:"rollback" OR rollback_drain.production_release_gate.reason:"production_release_missing_required_rollback_evidence_or_owner_proceed_decision")) OR (artifact:"viva.rollback_release_gate.v1" (owner_decision.decision:"rollback" OR production_release_gate.reason:"production_release_missing_required_rollback_evidence_or_owner_proceed_decision"))',
    evidence_fields: [
      "terminal_reason",
      "failure_class",
      "stage",
      "deploy_sha",
      "latency_ms",
      "rollback_drain.owner_decision.decision",
      "rollback_drain.production_release_gate.reason",
      "production_release_gate.reason",
    ],
  }),
  query({
    id: "release_gate_stale_evidence",
    title: "Production release evidence is stale or browser-skipped",
    failure_class: "release_gate_stale_evidence",
    stage: "release_gate",
    railway_query:
      'artifact:"viva.release_evidence.v1" (failure_class:"release_gate_stale_evidence" OR browser_e2e.skipped:true OR release_gate.browser_skip_shortcut:true OR generated_at:"<now-24h")',
    evidence_fields: [
      "stage",
      "deploy_sha",
      "generated_at",
      "release_gate.browser_skip_shortcut",
    ],
  }),
]);

const ROLLBACK_THRESHOLD_QUERY_IDS = Object.freeze({
  provider_429_rate_percent: "provider_429",
  provider_timeout_rate_percent: "provider_timeout",
  provider_auth_failure_count: "provider_auth_failure",
  stuck_checking_sessions: "stuck_checking",
  recap_failure_rate_percent: "recap_failure",
  token_refresh_failure_rate_percent: "token_refresh_failure",
  live_monitor_consecutive_failures: "live_monitor_failure",
});

const alertFromRollbackThreshold = (threshold) =>
  Object.freeze({
    id: threshold.shared_alert_id,
    source_threshold_id: threshold.id,
    failure_class: threshold.failure_class,
    stage: threshold.stage,
    metric: threshold.metric,
    operator: threshold.operator,
    value: threshold.value,
    unit: threshold.unit,
    window_seconds: threshold.window_seconds,
    sustained_seconds: threshold.sustained_seconds,
    minimum_sample_metric: threshold.minimum_sample_metric,
    minimum_sample_value: threshold.minimum_sample_value,
    minimum_failure_metric: threshold.minimum_failure_metric,
    minimum_failure_value: threshold.minimum_failure_value,
    severity: "rollback_candidate",
    query_id: ROLLBACK_THRESHOLD_QUERY_IDS[threshold.id],
    rollback_threshold_source: "scripts/rollback-drain-criteria.mjs",
  });

const alert = ({
  id,
  failure_class,
  stage,
  metric,
  operator = ">=",
  value,
  unit,
  window_seconds,
  sustained_seconds,
  severity,
  query_id,
}) =>
  Object.freeze({
    id,
    failure_class,
    stage,
    metric,
    operator,
    value,
    unit,
    window_seconds,
    sustained_seconds,
    severity,
    query_id,
    rollback_threshold_source: null,
  });

export const PROVIDER_FAILURE_ALERTS = Object.freeze([
  ...ROLLBACK_TRIGGER_THRESHOLDS.map(alertFromRollbackThreshold),
  alert({
    id: "bac525_release_gate_stale_evidence",
    failure_class: "release_gate_stale_evidence",
    stage: "release_gate",
    metric: "release_evidence_age_seconds",
    operator: ">",
    value: 86_400,
    unit: "seconds",
    window_seconds: 86_400,
    sustained_seconds: 3_600,
    severity: "release_blocking",
    query_id: "release_gate_stale_evidence",
  }),
  alert({
    id: "bac525_cost_budget_exhausted",
    failure_class: "cost_budget",
    stage: "provider",
    metric: "cost_budget_terminal_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "operator_page",
    query_id: "cost_budget",
  }),
  alert({
    id: "bac525_malformed_stream_count",
    failure_class: "malformed_stream",
    stage: "websocket",
    metric: "malformed_stream_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "operator_page",
    query_id: "malformed_stream",
  }),
  alert({
    id: "bac525_network_disconnect_count",
    failure_class: "network_disconnect",
    stage: "transport",
    metric: "network_disconnect_count",
    value: 3,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 300,
    severity: "operator_page",
    query_id: "network_disconnect",
  }),
  alert({
    id: "bac525_durability_degraded_count",
    failure_class: "durability_degraded",
    stage: "store",
    metric: "durability_degraded_terminal_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "release_blocking",
    query_id: "durability_degraded",
  }),
  alert({
    id: "bac525_tool_executor_failure_count",
    failure_class: "tool_executor_failure",
    stage: "tools",
    metric: "tool_executor_failure_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "operator_page",
    query_id: "tool_executor_failure",
  }),
  alert({
    id: "bac525_watchdog_expiry_count",
    failure_class: "turn_cap",
    stage: "session",
    metric: "watchdog_expiry_count",
    value: 1,
    unit: "count",
    window_seconds: 300,
    sustained_seconds: 60,
    severity: "operator_page",
    query_id: "watchdog_expiry",
  }),
  alert({
    id: "bac525_deploy_drain_observed",
    failure_class: "deploy_drain",
    stage: "deployment",
    metric: "deploy_drain_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "release_audit",
    query_id: "deploy_drain",
  }),
  alert({
    id: "bac525_pending_evaluation_count",
    failure_class: "pending_evaluation",
    stage: "store",
    metric: "pending_evaluation_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "operator_page",
    query_id: "pending_evaluation",
  }),
  alert({
    id: "bac525_rollback_observed",
    failure_class: "rollback",
    stage: "rollback",
    metric: "rollback_count",
    value: 1,
    unit: "count",
    window_seconds: 600,
    sustained_seconds: 60,
    severity: "release_blocking",
    query_id: "rollback_observed",
  }),
]);

export const FAILURE_CLASS_COVERAGE = Object.freeze([
  coverage("pre_loop_unavailable", null, {
    query_id: "startup_unavailable",
    requires_query: true,
    no_operator_alert_reason:
      "Pre-loop ingestion is recoverable before a live turn; dashboard query is sufficient unless release evidence marks it stale.",
  }),
  coverage("session_bootstrap_unavailable", null, {
    query_id: "startup_unavailable",
    requires_query: true,
    no_operator_alert_reason:
      "Bootstrap unavailability is dashboard-only because hosted monitor/release-gate stale evidence blocks live traffic before admission.",
  }),
  coverage("pending_evaluation", "bac525_pending_evaluation_count"),
  coverage("partial_stage_success", "bac525_recap_failure_rate_percent"),
  coverage("provider_auth_failure", "bac525_provider_auth_failure_count"),
  coverage("quota_rate_failure", "bac525_provider_429_rate_percent"),
  coverage("cost_budget", "bac525_cost_budget_exhausted"),
  coverage("local_rate_limit", "bac525_watchdog_expiry_count", {
    note: "Local rate limits are grouped with watchdog/turn-cap pressure.",
  }),
  coverage("timeout", "bac525_provider_timeout_rate_percent"),
  coverage("malformed_stream", "bac525_malformed_stream_count"),
  coverage("network_disconnect", "bac525_network_disconnect_count"),
  coverage("durability_degraded", "bac525_durability_degraded_count"),
  coverage("tool_executor_failure", "bac525_tool_executor_failure_count"),
  coverage("slow_client", "bac525_watchdog_expiry_count"),
  coverage("cancellation", null, {
    query_id: "provider_cancellation",
    requires_query: true,
    no_operator_alert_reason:
      "Provider cancellation is normally learner or control initiated; it remains dashboard-only unless it escalates into timeout, recap failure, or network disconnect.",
  }),
  coverage("session_auth_failure", "bac525_token_refresh_failure_rate_percent"),
  coverage("stale_client_session", null, {
    no_operator_alert_reason:
      "Back/Forward stale sessions are client-recoverable generation reconciliation events.",
  }),
  coverage("client_refresh", null, {
    no_operator_alert_reason: "Browser refresh is client-recoverable and not an operator incident.",
  }),
  coverage("tab_restored_from_frozen_state", null, {
    no_operator_alert_reason:
      "BFCache/tab restore is client-recoverable generation reconciliation, not provider failure.",
  }),
  coverage("duplicate_submission", null, {
    no_operator_alert_reason:
      "Double-submit is recoverable because idempotency joins or ignores the duplicate and should not page operators.",
  }),
  coverage("audio_input_unavailable", null, {
    no_operator_alert_reason:
      "Mic unavailable has a typed fallback path and is client-recoverable unless live monitor failures rise.",
  }),
  coverage("deploy_drain", "bac525_deploy_drain_observed"),
  coverage("turn_cap", "bac525_watchdog_expiry_count"),
  coverage("session_cap", "bac525_watchdog_expiry_count"),
  coverage("rollback", "bac525_rollback_observed"),
]);

export function providerFailureObservabilityEvidence({
  fixture = null,
  releaseEvidencePath = "artifacts/release-check/evidence.json",
} = {}) {
  const evidence = {
    schema: OBSERVABILITY_SCHEMA,
    dashboard: {
      title: "Provider Failure Operations",
      group_by: PROVIDER_FAILURE_DASHBOARD_GROUPS,
      required_artifact_links: [
        {
          id: "hosted_release_evidence",
          path: releaseEvidencePath,
          sanitized: true,
        },
        {
          id: "browser_story",
          path: "artifacts/e2e-browser/browser-story.json",
          sanitized: true,
        },
        {
          id: "rollback_criteria",
          path: "rollback_drain.criteria",
          source: "scripts/rollback-drain-criteria.mjs",
          sanitized: true,
        },
      ],
    },
    log_queries: PROVIDER_FAILURE_LOG_QUERIES.map((entry) => cloneJson(entry)),
    alerts: PROVIDER_FAILURE_ALERTS.map((entry) => cloneJson(entry)),
    coverage: FAILURE_CLASS_COVERAGE.map((entry) => cloneJson(entry)),
    fixture: fixture ? cloneJson(fixture) : null,
    redaction: {
      raw_audio_indexed: false,
      transcript_text_indexed: false,
      learner_answer_payloads_indexed: false,
      prompts_indexed: false,
      unrestricted_source_material_indexed: false,
      secrets_indexed: false,
    },
    sanitized: true,
  };
  assertProviderFailureObservabilityEvidence(evidence);
  return evidence;
}

export function assertProviderFailureObservabilityEvidence(evidence) {
  if (evidence.schema !== OBSERVABILITY_SCHEMA) {
    throw new Error("Invalid provider failure observability schema");
  }
  const queriesById = new Map(evidence.log_queries.map((entry) => [entry.id, entry]));
  const queryIds = new Set(queriesById.keys());
  for (const id of [
    "provider_429",
    "provider_auth_failure",
    "provider_timeout",
    "cost_budget",
    "malformed_stream",
    "network_disconnect",
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
    if (!queryIds.has(id)) {
      throw new Error(`missing provider failure log query ${id}`);
    }
  }
  for (const group of PROVIDER_FAILURE_DASHBOARD_GROUPS) {
    if (!evidence.dashboard.group_by.includes(group)) {
      throw new Error(`dashboard missing group ${group}`);
    }
  }

  const alertsById = new Map(evidence.alerts.map((entry) => [entry.id, entry]));
  const alertIds = new Set(alertsById.keys());
  for (const alertEntry of evidence.alerts) {
    if (!alertEntry.query_id) {
      throw new Error(`alert ${alertEntry.id} is missing query_id`);
    }
    const queryEntry = queriesById.get(alertEntry.query_id);
    if (!queryEntry) {
      throw new Error(`alert ${alertEntry.id} references unknown query ${alertEntry.query_id}`);
    }
    if (!queryCoversFailureClass(queryEntry, alertEntry.failure_class)) {
      throw new Error(
        `alert ${alertEntry.id} query ${alertEntry.query_id} does not cover ${alertEntry.failure_class}`,
      );
    }
  }
  for (const thresholdId of REQUIRED_ROLLBACK_TRIGGER_IDS) {
    const threshold = ROLLBACK_TRIGGER_THRESHOLDS.find((entry) => entry.id === thresholdId);
    if (!threshold || !alertIds.has(threshold.shared_alert_id)) {
      throw new Error(`missing shared BAC-527 alert threshold ${thresholdId}`);
    }
  }
  if (!alertIds.has("bac525_release_gate_stale_evidence")) {
    throw new Error("missing release-gate stale evidence alert");
  }

  const coverageByFailureClass = new Map(
    evidence.coverage.map((entry) => [entry.failure_class, entry]),
  );
  for (const failureClass of learnerLoopFailureClasses()) {
    const coverage = coverageByFailureClass.get(failureClass);
    if (!coverage) {
      throw new Error(`missing BAC-510 failure-class coverage for ${failureClass}`);
    }
    if (!coverage.alert_id && !coverage.no_operator_alert_reason) {
      throw new Error(`coverage for ${failureClass} has neither alert nor no-alert rationale`);
    }
    if (coverage.alert_id && !alertIds.has(coverage.alert_id)) {
      throw new Error(`coverage for ${failureClass} references unknown alert ${coverage.alert_id}`);
    }
    if (coverage.alert_id) {
      const alertEntry = alertsById.get(coverage.alert_id);
      const queryEntry = queriesById.get(alertEntry.query_id);
      if (!alertEntry.query_id || !queryEntry) {
        throw new Error(`coverage for ${failureClass} references alert without query`);
      }
      if (!queryCoversFailureClass(queryEntry, failureClass)) {
        throw new Error(
          `coverage for ${failureClass} uses query ${queryEntry.id} that does not cover the failure class or terminal reason`,
        );
      }
    } else {
      if (coverage.requires_query === true && !coverage.query_id) {
        throw new Error(`coverage for ${failureClass} claims dashboard coverage without a query`);
      }
      if (coverage.query_id) {
        const queryEntry = queriesById.get(coverage.query_id);
        if (!queryEntry) {
          throw new Error(`coverage for ${failureClass} references unknown query`);
        }
        if (!queryCoversFailureClass(queryEntry, failureClass)) {
          throw new Error(`coverage for ${failureClass} uses query that does not cover it`);
        }
      }
    }
  }

  assertNoForbiddenEvidenceMarkers(evidence);
  return evidence;
}

export function learnerLoopFailureClasses() {
  return Array.from(
    new Set(
      learnerLoopContract.states
        .map((state) => (typeof state.failure_class === "string" ? state.failure_class : null))
        .filter(Boolean),
    ),
  ).sort();
}

function queryCoversFailureClass(queryEntry, failureClass) {
  const railwayQuery = queryEntry.railway_query;
  if (railwayQuery.includes(`failure_class:"${failureClass}"`)) return true;
  if (failureClass === "rollback" && railwayQuery.includes('owner_decision.decision:"rollback"')) {
    return true;
  }
  return learnerLoopTerminalReasonsForFailureClass(failureClass).some((reason) =>
    railwayQuery.includes(`terminal_reason:"${reason}"`),
  );
}

function learnerLoopTerminalReasonsForFailureClass(failureClass) {
  return learnerLoopContract.states
    .filter((state) => state.failure_class === failureClass)
    .map((state) => (typeof state.terminal_reason === "string" ? state.terminal_reason : null))
    .filter(Boolean);
}

function coverage(failure_class, alert_id, extra = {}) {
  return Object.freeze({
    failure_class,
    alert_id,
    ...extra,
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
