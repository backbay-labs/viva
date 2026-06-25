import learnerLoopContract from "../packages/core/src/learner-loop-contract.json" with {
  type: "json",
};

const CRITERIA_SCHEMA = "viva.rollback_drain_criteria.v1";
const DECISION_SCHEMA = "viva.rollback_decision.v1";
const EVIDENCE_SCHEMA = "viva.rollback_release_gate.v1";
const OWNER_DECISIONS = new Set(["proceed", "hold", "rollback"]);

export const REQUIRED_ROLLBACK_TRIGGER_IDS = Object.freeze([
  "provider_429_rate_percent",
  "provider_timeout_rate_percent",
  "provider_auth_failure_count",
  "stuck_checking_sessions",
  "recap_failure_rate_percent",
  "token_refresh_failure_rate_percent",
  "live_monitor_consecutive_failures",
]);

export const ROLLBACK_DRAIN_BEHAVIOR = Object.freeze({
  no_new_work_admitted: true,
  ready_endpoint: Object.freeze({
    expected_http_status: 503,
    ready: false,
    draining: true,
  }),
  live_endpoint: Object.freeze({
    expected_http_status: 200,
    remains_healthy_during_drain: true,
  }),
  websocket_preflight: Object.freeze({
    expected_http_status: 503,
    learner_safe_error: "voice session draining",
  }),
  active_manuscripts: Object.freeze({
    terminal_frame_type: "session_phase",
    terminal_reason: "drained",
    learner_copy_contract_state_id: "deploy_drain",
  }),
  proof_commands: Object.freeze([
    "cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws ready_route_reports_unavailable_during_voice_drain",
    "cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws websocket_preflight_rejects_new_sessions_after_drain_begins",
    "cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws websocket_drain_emits_terminal_phase_before_close",
    "cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws websocket_drain_interrupts_active_provider_response",
  ]),
});

const threshold = ({
  id,
  failure_class,
  terminal_reason = null,
  metric,
  metric_label,
  operator = ">=",
  value,
  unit,
  window_seconds,
  sustained_seconds,
  minimum_sample_metric = null,
  minimum_sample_value = null,
  minimum_failure_metric = null,
  minimum_failure_value = null,
  stage,
  owner_role = "incident commander",
  shared_alert_id,
}) =>
  Object.freeze({
    id,
    failure_class,
    terminal_reason,
    metric,
    metric_label,
    operator,
    value,
    unit,
    window_seconds,
    sustained_seconds,
    minimum_sample_metric,
    minimum_sample_value,
    minimum_failure_metric,
    minimum_failure_value,
    stage,
    owner_role,
    production_release_blocking: true,
    shared_alert_id,
  });

export const ROLLBACK_TRIGGER_THRESHOLDS = Object.freeze([
  threshold({
    failure_class: "quota_rate_failure",
    id: "provider_429_rate_percent",
    metric: "provider_429_rate_percent",
    metric_label: "provider 429 responses as percent of submitted provider turns",
    value: 10,
    unit: "percent",
    window_seconds: 600,
    sustained_seconds: 300,
    minimum_sample_metric: "provider_turn_count",
    minimum_sample_value: 20,
    minimum_failure_metric: "provider_429_count",
    minimum_failure_value: 3,
    stage: "provider",
    terminal_reason: "provider_rate_limited",
    shared_alert_id: "bac525_provider_429_rate_percent",
  }),
  threshold({
    failure_class: "timeout",
    id: "provider_timeout_rate_percent",
    metric: "provider_timeout_rate_percent",
    metric_label: "provider timeout terminal turns as percent of submitted provider turns",
    value: 5,
    unit: "percent",
    window_seconds: 600,
    sustained_seconds: 300,
    minimum_sample_metric: "provider_turn_count",
    minimum_sample_value: 20,
    minimum_failure_metric: "provider_timeout_count",
    minimum_failure_value: 2,
    stage: "provider",
    terminal_reason: "provider_timeout",
    shared_alert_id: "bac525_provider_timeout_rate_percent",
  }),
  threshold({
    failure_class: "provider_auth_failure",
    id: "provider_auth_failure_count",
    metric: "provider_auth_failure_count",
    metric_label: "provider auth failures",
    value: 1,
    unit: "count",
    window_seconds: 300,
    sustained_seconds: 60,
    minimum_failure_metric: "provider_auth_failure_count",
    minimum_failure_value: 1,
    stage: "provider_auth",
    terminal_reason: "provider_auth_failed",
    shared_alert_id: "bac525_provider_auth_failure_count",
  }),
  threshold({
    failure_class: "stuck_checking",
    id: "stuck_checking_sessions",
    metric: "stuck_checking_sessions",
    metric_label:
      "active submitted-answer sessions still checking after the 45 second BAC-510 bound",
    value: 3,
    unit: "sessions",
    window_seconds: 120,
    sustained_seconds: 120,
    minimum_failure_metric: "stuck_checking_sessions",
    minimum_failure_value: 3,
    stage: "session",
    shared_alert_id: "bac525_stuck_checking_sessions",
  }),
  threshold({
    failure_class: "recap_failure",
    id: "recap_failure_rate_percent",
    metric: "recap_failure_rate_percent",
    metric_label: "recap failures as percent of recap attempts",
    value: 5,
    unit: "percent",
    window_seconds: 600,
    sustained_seconds: 300,
    minimum_sample_metric: "recap_attempt_count",
    minimum_sample_value: 20,
    minimum_failure_metric: "recap_failure_count",
    minimum_failure_value: 2,
    stage: "recap",
    terminal_reason: "partial_stage_success",
    shared_alert_id: "bac525_recap_failure_rate_percent",
  }),
  threshold({
    failure_class: "auth_material_failure",
    id: "token_refresh_failure_rate_percent",
    metric: "token_refresh_failure_rate_percent",
    metric_label: "session token refresh failures as percent of refresh attempts",
    value: 2,
    unit: "percent",
    window_seconds: 600,
    sustained_seconds: 180,
    minimum_sample_metric: "token_refresh_attempt_count",
    minimum_sample_value: 20,
    minimum_failure_metric: "token_refresh_failure_count",
    minimum_failure_value: 3,
    stage: "session_auth",
    terminal_reason: "session_auth_rejected",
    shared_alert_id: "bac525_token_refresh_failure_rate_percent",
  }),
  threshold({
    failure_class: "live_monitor_failure",
    id: "live_monitor_consecutive_failures",
    metric: "live_monitor_consecutive_failures",
    metric_label: "consecutive live monitor failures",
    value: 2,
    unit: "failures",
    window_seconds: 300,
    sustained_seconds: 120,
    minimum_sample_metric: "live_monitor_attempt_count",
    minimum_sample_value: 2,
    minimum_failure_metric: "live_monitor_consecutive_failures",
    minimum_failure_value: 2,
    stage: "monitor",
    shared_alert_id: "bac525_live_monitor_consecutive_failures",
  }),
]);

export const BAC_510_ROLLBACK_COVERAGE = Object.freeze([
  Object.freeze({
    contract_state_id: "provider_rate_limit",
    threshold_id: "provider_429_rate_percent",
  }),
  Object.freeze({
    contract_state_id: "provider_timeout",
    threshold_id: "provider_timeout_rate_percent",
  }),
  Object.freeze({
    contract_state_id: "provider_auth_failure",
    threshold_id: "provider_auth_failure_count",
  }),
  Object.freeze({
    contract_state_id: "deterministic_partial_recap",
    threshold_id: "recap_failure_rate_percent",
  }),
  Object.freeze({
    contract_state_id: "invalid_expired_replayed_token",
    threshold_id: "token_refresh_failure_rate_percent",
  }),
  Object.freeze({
    contract_state_id: "deploy_drain",
    drain_behavior: "active manuscripts receive terminal session_phase drained",
  }),
  Object.freeze({
    contract_state_id: "rollback",
    release_gate: "production release requires rollback thresholds and owner proceed decision",
  }),
]);

export function rollbackCriteriaEvidence() {
  const evidence = {
    schema: CRITERIA_SCHEMA,
    thresholds: ROLLBACK_TRIGGER_THRESHOLDS.map((entry) => ({ ...entry })),
    bac_510_coverage: BAC_510_ROLLBACK_COVERAGE.map((entry) => ({ ...entry })),
    drain_behavior: cloneJson(ROLLBACK_DRAIN_BEHAVIOR),
    alert_source_of_truth: {
      shared_with_bac_525_alerts: true,
      threshold_ids: ROLLBACK_TRIGGER_THRESHOLDS.map((entry) => entry.id),
      shared_alert_ids: ROLLBACK_TRIGGER_THRESHOLDS.map((entry) => entry.shared_alert_id),
    },
    sanitized: true,
  };
  validateRollbackCriteria(evidence);
  assertNoForbiddenEvidenceMarkers(evidence);
  return evidence;
}

export function validateRollbackCriteria(criteria) {
  if (criteria.schema !== CRITERIA_SCHEMA) {
    throw new Error("Invalid rollback criteria schema");
  }
  const thresholdIds = new Set(criteria.thresholds.map((entry) => entry.id));
  const alertIds = new Set();
  for (const id of REQUIRED_ROLLBACK_TRIGGER_IDS) {
    if (!thresholdIds.has(id)) {
      throw new Error(`missing rollback threshold ${id}`);
    }
  }
  for (const entry of criteria.thresholds) {
    if (!REQUIRED_ROLLBACK_TRIGGER_IDS.includes(entry.id)) {
      throw new Error(`unexpected rollback threshold ${entry.id}`);
    }
    if (!Number.isFinite(entry.value) || entry.value <= 0) {
      throw new Error(`rollback threshold ${entry.id} has invalid value`);
    }
    if (!Number.isInteger(entry.window_seconds) || entry.window_seconds <= 0) {
      throw new Error(`rollback threshold ${entry.id} has invalid window`);
    }
    if (!Number.isInteger(entry.sustained_seconds) || entry.sustained_seconds <= 0) {
      throw new Error(`rollback threshold ${entry.id} has invalid sustained duration`);
    }
    if (entry.sustained_seconds > entry.window_seconds) {
      throw new Error(`rollback threshold ${entry.id} sustained duration exceeds window`);
    }
    if (!entry.shared_alert_id || alertIds.has(entry.shared_alert_id)) {
      throw new Error(`rollback threshold ${entry.id} has invalid shared alert id`);
    }
    alertIds.add(entry.shared_alert_id);
  }

  const contractStateIds = new Set(learnerLoopContract.states.map((state) => state.id));
  for (const entry of criteria.bac_510_coverage) {
    if (!contractStateIds.has(entry.contract_state_id)) {
      throw new Error(
        `rollback coverage references unknown BAC-510 state ${entry.contract_state_id}`,
      );
    }
    if (entry.threshold_id && !thresholdIds.has(entry.threshold_id)) {
      throw new Error(`rollback coverage references unknown threshold ${entry.threshold_id}`);
    }
  }

  if (criteria.drain_behavior.ready_endpoint.expected_http_status !== 503) {
    throw new Error("drain behavior must make /ready not-ready");
  }
  if (criteria.drain_behavior.live_endpoint.expected_http_status !== 200) {
    throw new Error("drain behavior must keep /live healthy during drain");
  }
  if (criteria.drain_behavior.active_manuscripts.terminal_frame_type !== "session_phase") {
    throw new Error("drain behavior must close active manuscripts with session_phase");
  }
  if (criteria.drain_behavior.active_manuscripts.terminal_reason !== "drained") {
    throw new Error("drain behavior must use terminal reason drained");
  }
  return criteria;
}

export function evaluateRollbackDecision(sample, thresholds = ROLLBACK_TRIGGER_THRESHOLDS) {
  const observedWindowSeconds = integerMetric(sample, "window_seconds");
  const observedSustainedSeconds = integerMetric(sample, "sustained_seconds");
  const metrics = isRecord(sample.metrics) ? sample.metrics : {};
  const triggered = [];

  for (const threshold of thresholds) {
    const observed = numeric(metrics[threshold.metric]);
    const sampleValue = threshold.minimum_sample_metric
      ? numeric(metrics[threshold.minimum_sample_metric])
      : null;
    const failureValue = threshold.minimum_failure_metric
      ? numeric(metrics[threshold.minimum_failure_metric])
      : null;
    const windowSatisfied = observedWindowSeconds >= threshold.window_seconds;
    const sustainedSatisfied = observedSustainedSeconds >= threshold.sustained_seconds;
    const sampleSatisfied =
      threshold.minimum_sample_metric === null || sampleValue >= threshold.minimum_sample_value;
    const failureSatisfied =
      threshold.minimum_failure_metric === null || failureValue >= threshold.minimum_failure_value;
    const valueSatisfied = compare(observed, threshold.operator, threshold.value);

    if (
      windowSatisfied &&
      sustainedSatisfied &&
      sampleSatisfied &&
      failureSatisfied &&
      valueSatisfied
    ) {
      triggered.push({
        id: threshold.id,
        failure_class: threshold.failure_class,
        terminal_reason: threshold.terminal_reason,
        metric: threshold.metric,
        observed,
        threshold: threshold.value,
        unit: threshold.unit,
        window_seconds: threshold.window_seconds,
        sustained_seconds: threshold.sustained_seconds,
        shared_alert_id: threshold.shared_alert_id,
      });
    }
  }

  const decision = {
    schema: DECISION_SCHEMA,
    rollback_required: triggered.length > 0,
    triggered_thresholds: triggered,
    no_new_work_admitted_when_triggered: triggered.length > 0,
    learner_terminal_state_when_draining: ROLLBACK_DRAIN_BEHAVIOR.active_manuscripts,
    sanitized: true,
  };
  assertNoForbiddenEvidenceMarkers(decision);
  return decision;
}

export function buildRollbackReleaseEvidence({ env = process.env, generatedAt = new Date() } = {}) {
  const criteria = rollbackCriteriaEvidence();
  const productionRequested = env.VIVA_PRODUCTION_RELEASE === "1";
  const ownerDecision = normalizeOwnerDecision(env);
  const productionSnapshot = normalizeProductionSnapshot(env);
  const missingProductionFields = missingRequiredProductionFields(productionSnapshot);
  const thresholdsPresent = REQUIRED_ROLLBACK_TRIGGER_IDS.every((id) =>
    criteria.thresholds.some((thresholdEntry) => thresholdEntry.id === id),
  );
  const ownerDecisionPresent =
    ownerDecision.decision !== null &&
    ownerDecision.owner !== null &&
    ownerDecision.decided_at_utc !== null;
  const ownerProceed = ownerDecision.decision === "proceed";
  const productionAllowed =
    productionRequested &&
    thresholdsPresent &&
    ownerDecisionPresent &&
    ownerProceed &&
    missingProductionFields.length === 0;

  const evidence = {
    schema: EVIDENCE_SCHEMA,
    generated_at: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    criteria,
    required_production_fields: requiredProductionFields(),
    production_snapshot: productionSnapshot,
    owner_decision: ownerDecision,
    production_release_gate: {
      production_requested: productionRequested,
      thresholds_present: thresholdsPresent,
      owner_decision_present: ownerDecisionPresent,
      owner_decision_allows_release: ownerProceed,
      missing_production_fields: missingProductionFields,
      allowed: productionAllowed,
      reason: productionAllowed
        ? "owner_proceed_decision_and_required_rollback_evidence_present"
        : productionRequested
          ? "production_release_missing_required_rollback_evidence_or_owner_proceed_decision"
          : "non_production_release_check",
    },
    sanitized: true,
  };
  assertNoForbiddenEvidenceMarkers(evidence);
  return evidence;
}

export function assertRollbackReleaseGate(evidence) {
  if (evidence.schema !== EVIDENCE_SCHEMA) {
    throw new Error("Invalid rollback release gate schema");
  }
  validateRollbackCriteria(evidence.criteria);
  if (evidence.production_release_gate.thresholds_present !== true) {
    throw new Error("production release is missing rollback thresholds");
  }
  if (
    evidence.production_release_gate.production_requested === true &&
    evidence.production_release_gate.allowed !== true
  ) {
    throw new Error(
      `production release blocked: ${evidence.production_release_gate.reason}; missing=${evidence.production_release_gate.missing_production_fields.join(",")}; owner_decision_present=${evidence.production_release_gate.owner_decision_present}`,
    );
  }
  assertNoForbiddenEvidenceMarkers(evidence);
  return evidence;
}

function normalizeOwnerDecision(env) {
  const decision = stringOrNull(env.VIVA_RELEASE_OWNER_DECISION);
  if (decision !== null && !OWNER_DECISIONS.has(decision)) {
    throw new Error(
      `VIVA_RELEASE_OWNER_DECISION must be one of ${Array.from(OWNER_DECISIONS).join(", ")}`,
    );
  }
  return {
    decision,
    owner: stringOrNull(env.VIVA_RELEASE_OWNER),
    decided_at_utc: stringOrNull(env.VIVA_RELEASE_OWNER_DECIDED_AT_UTC),
  };
}

function normalizeProductionSnapshot(env) {
  return {
    web_deploy_id: stringOrNull(env.VIVA_RELEASE_WEB_DEPLOY_ID ?? env.VIVA_WEB_DEPLOY_ID),
    agent_deploy_id: stringOrNull(env.VIVA_RELEASE_AGENT_DEPLOY_ID ?? env.VIVA_AGENT_DEPLOY_ID),
    config_diff_sha256: sha256OrNull(env.VIVA_RELEASE_CONFIG_DIFF_SHA256),
    provider_mode: stringOrNull(env.VIVA_RELEASE_PROVIDER_MODE ?? env.VIVA_AGENT_PROVIDER),
    postgres_state: stringOrNull(env.VIVA_RELEASE_POSTGRES_STATE),
    recovery_validation: stringOrNull(env.VIVA_RELEASE_RECOVERY_VALIDATION),
  };
}

function requiredProductionFields() {
  return [
    "web_deploy_id",
    "agent_deploy_id",
    "config_diff_sha256",
    "provider_mode",
    "postgres_state",
    "recovery_validation",
  ];
}

function missingRequiredProductionFields(snapshot) {
  return requiredProductionFields().filter((field) => !snapshot[field]);
}

function integerMetric(sample, key) {
  const value = numeric(sample?.[key]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`rollback decision sample missing non-negative integer ${key}`);
  }
  return value;
}

function compare(observed, operator, thresholdValue) {
  if (operator === ">=") return observed >= thresholdValue;
  throw new Error(`unsupported rollback threshold operator ${operator}`);
}

function numeric(value) {
  return Number.isFinite(value) ? value : Number.NaN;
}

function sha256OrNull(value) {
  const normalized = stringOrNull(value);
  if (normalized === null) return null;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("VIVA_RELEASE_CONFIG_DIFF_SHA256 must be a lowercase sha256 hex digest");
  }
  return normalized;
}

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertNoForbiddenEvidenceMarkers(value) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    "pcm16_base64",
    "answer_text",
    "transcript_final",
    "source_context",
    "pasted_text",
    "session_token",
    "viva1.",
    "session-secret",
    "raw_prompt",
    "provider_prompt",
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "Bearer ",
  ];
  for (const needle of forbidden) {
    if (serialized.includes(needle)) {
      throw new Error(`rollback evidence includes forbidden payload marker: ${needle}`);
    }
  }
  for (const [name, envValue] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    if (envValue && envValue.length >= 8 && serialized.includes(envValue)) {
      throw new Error(`rollback evidence includes secret value from ${name}`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
