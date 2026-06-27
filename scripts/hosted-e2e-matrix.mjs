import learnerLoopContract from "../packages/core/src/learner-loop-contract.json" with {
  type: "json",
};
import { FAILURE_CONTROL_SCENARIOS } from "./failure-control-harness.mjs";

export const HOSTED_E2E_MATRIX_SCHEMA = "viva.hosted_e2e_matrix.v1";
export const HOSTED_E2E_RESULT_SCHEMA = "viva.hosted_e2e_result.v1";
export const HOSTED_E2E_MONITOR_POLICY_SCHEMA = "viva.hosted_monitor_policy.v1";
const SUPPORTED_MATRIX_PROFILES = new Set(["contract", "full", "pr", "scheduled"]);

export const HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS = Object.freeze([
  "web_url",
  "agent_url",
  "deploy_ids",
  "provider",
  "model",
  "control_mode",
  "postgres_durability",
  ...learnerLoopContract.evidence_fields,
  "screenshots",
  "traces",
  "log_correlation",
  "redaction_audit",
]);

const BASELINE_SCENARIOS = Object.freeze([
  scenario({
    id: "happy_path",
    title: "Hosted happy path",
    milestone: "M0",
    owner_issue: "BAC-524",
    runner: "e2e-browser",
    profiles: ["scheduled", "pr"],
    provider: "synthetic",
    stage: "feedback",
    terminal_reason: "completed",
    recap_success_expected: true,
    coverage: [
      "fresh_signed_session",
      "hosted_websocket",
      "answer_to_feedback",
      "recap_ready",
      "terminal_ui_dominance",
      "answer_attempt_preservation",
    ],
  }),
  scenario({
    id: "fake_provider_happy_path",
    title: "Hosted fake provider happy path",
    milestone: "M0",
    owner_issue: "BAC-524",
    runner: "e2e-browser",
    profiles: ["pr"],
    provider: "fake_cartesia_gemini",
    stage: "feedback",
    terminal_reason: "completed",
    recap_success_expected: true,
    coverage: ["provider_shaped_path", "recap_ready", "sanitized_browser_story"],
  }),
  scenario({
    id: "token_free_session_history",
    title: "Token-free session history",
    milestone: "M1",
    owner_issue: "BAC-515",
    runner: "e2e-browser-url-audit",
    profiles: ["pr"],
    provider: "synthetic",
    stage: "client",
    terminal_reason: "completed",
    recap_success_expected: true,
    coverage: [
      "back_forward_recovery",
      "refresh_recovery",
      "visible_url_canonicalized",
    ],
  }),
  scenario({
    id: "deterministic_partial_recap",
    title: "Deterministic partial recap",
    milestone: "M3",
    owner_issue: "BAC-523",
    runner: "e2e-browser",
    profiles: ["pr"],
    provider: "fake_cartesia_gemini",
    failure_class: "partial_stage_success",
    stage: "websocket",
    terminal_reason: "partial_stage_success",
    recap_success_expected: true,
    coverage: ["durable_partial_recap", "learner_recovery_copy"],
  }),
  scenario({
    id: "pre_loop_ingestion_failure",
    title: "Pre-loop ingestion failure",
    milestone: "M1",
    owner_issue: "BAC-532",
    runner: "hosted-contract-slice",
    profiles: ["contract"],
    provider: "synthetic",
    blocked_by: ["BAC-532"],
    failure_class: "pre_loop_unavailable",
    stage: "pre_loop",
    terminal_reason: null,
    recap_success_expected: false,
    coverage: ["ingestion_deadline", "safe_recovery_before_question"],
  }),
  scenario({
    id: "multi_tab_second_session",
    title: "Second tab session reconciliation",
    milestone: "M1",
    owner_issue: "BAC-535",
    runner: "hosted-contract-slice",
    profiles: ["contract"],
    provider: "synthetic",
    blocked_by: ["BAC-535"],
    failure_class: "stale_client_session",
    stage: "client",
    terminal_reason: null,
    recap_success_expected: false,
    coverage: ["single_active_session", "bfcache_restore_reconciliation"],
  }),
]);

const FAILURE_CONTROL_SCENARIO_ROWS = Object.freeze(
  FAILURE_CONTROL_SCENARIOS.map((entry) =>
    scenario({
      id: entry.id,
      title: titleFromScenarioId(entry.id),
      milestone: "M0",
      owner_issue: "BAC-528",
      runner: "e2e-browser-failure-control",
      profiles: ["pr"],
      provider: "synthetic",
      control_scenario_id: entry.id,
      failure_class: entry.failure_class,
      stage: entry.stage,
      terminal_reason: entry.terminal_reason,
      recap_success_expected: failureControlScenarioExpectsRecapSuccess(entry),
      coverage: coverageForFailureControlScenario(entry.id),
    }),
  ),
);

export const HOSTED_E2E_SCENARIOS = Object.freeze([
  ...BASELINE_SCENARIOS,
  ...FAILURE_CONTROL_SCENARIO_ROWS,
]);

const failureControlScenarioIdSet = new Set(
  FAILURE_CONTROL_SCENARIO_ROWS.map((entry) => entry.control_scenario_id),
);
const FAILURE_CONTROL_SCENARIOS_REQUIRING_BROWSER_ACTION = new Set([
  ...FAILURE_CONTROL_SCENARIOS.filter((entry) => entry.browser_control).map((entry) => entry.id),
  "double_submit_race",
]);
const hostedScenarioIdSet = new Set(HOSTED_E2E_SCENARIOS.map((entry) => entry.id));

export const HOSTED_MONITOR_POLICY = Object.freeze({
  schema: HOSTED_E2E_MONITOR_POLICY_SCHEMA,
  synthetic_monitor: {
    cadence_seconds: 30 * 60,
    max_runs_per_day: 48,
    runner_mode: "scheduled",
    separate_from_learner_traffic: true,
  },
  live_monitor: {
    enabled_env: "VIVA_HOSTED_LIVE_MONITOR_ENABLED",
    default_enabled: false,
    min_cadence_seconds: 6 * 60 * 60,
    max_runs_per_day: 2,
    max_turns_per_run: 1,
    max_duration_ms_per_run: 90_000,
    max_audio_bytes_per_run: 262_144,
    max_cost_usd_per_run: 0.25,
    max_cost_usd_per_day: 0.5,
    max_tokens_per_run: 4_096,
    max_tokens_per_day: 8_192,
    separate_from_learner_traffic: true,
  },
  self_quarantine: {
    failure_class: "quota_rate_failure",
    terminal_reason: "provider_rate_limited",
    consecutive_failures: 2,
    observation_window_seconds: 60 * 60,
    cooldown_seconds: 6 * 60 * 60,
  },
  alerting: {
    dedupe_window_seconds: 30 * 60,
    cooldown_seconds: 60 * 60,
  },
});

export function buildHostedE2eMatrixContract({
  generatedAt = new Date().toISOString(),
  mode = "pr",
  profile = defaultMatrixProfile(mode),
  runId = null,
  scenarioIds = null,
  scenarioSubset = null,
} = {}) {
  const scenarios = scenariosForProfileInternal(profile, mode, { scenarioIds });
  return {
    schema: HOSTED_E2E_MATRIX_SCHEMA,
    generated_at: generatedAt,
    mode,
    profile,
    run_id: runId,
    bac_510_contract: {
      schema: learnerLoopContract.schema,
      max_submitted_answer_resolution_ms: learnerLoopContract.max_submitted_answer_resolution_ms,
      required_evidence_fields: HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS,
    },
    monitor_policy: HOSTED_MONITOR_POLICY,
    scenario_count: scenarios.length,
    ...(scenarioSubset ? { scenario_subset: scenarioSubset } : {}),
    scenarios,
    stop_rules: {
      ready_endpoint_alone_counts: false,
      vercel_ready_alone_counts: false,
      railway_online_alone_counts: false,
      local_only_evidence_counts: false,
      browser_skip_counts: false,
    },
    sanitized: true,
  };
}

export function defaultMatrixProfile(mode) {
  return mode === "scheduled" ? "scheduled" : "full";
}

export function scenariosForProfile(profile, mode = "pr") {
  return scenariosForProfileInternal(profile, mode);
}

function scenariosForProfileInternal(profile, mode = "pr", { scenarioIds = null } = {}) {
  const normalized = profile || defaultMatrixProfile(mode);
  if (!SUPPORTED_MATRIX_PROFILES.has(normalized)) {
    throw new Error(
      `unsupported hosted E2E matrix profile ${normalized}; expected one of ${Array.from(
        SUPPORTED_MATRIX_PROFILES,
      ).join(", ")}`,
    );
  }
  let scenarios;
  if (normalized === "contract") scenarios = HOSTED_E2E_SCENARIOS;
  else if (normalized === "full") {
    scenarios = HOSTED_E2E_SCENARIOS.filter((entry) => entry.profiles.includes("pr"));
  } else {
    scenarios = HOSTED_E2E_SCENARIOS.filter((entry) => entry.profiles.includes(normalized));
  }
  if (!scenarioIds) return scenarios;
  const selectedIds = Array.from(new Set(scenarioIds));
  for (const id of selectedIds) {
    if (!hostedScenarioIdSet.has(id)) {
      throw new Error(`unknown hosted E2E matrix scenario ${id}`);
    }
  }
  const selectedIdSet = new Set(selectedIds);
  return scenarios.filter((entry) => selectedIdSet.has(entry.id));
}

export function failureControlScenarioIdsForProfile({
  configuredValue = "",
  includeBrowserActionScenarios = false,
  profile = "full",
} = {}) {
  const configured = configuredValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const ids =
    configured.length > 0
      ? configured
      : scenariosForProfile(profile, "pr")
          .map((entry) => entry.control_scenario_id)
          .filter(Boolean);

  const uniqueIds = Array.from(new Set(ids));
  for (const id of uniqueIds) {
    if (!failureControlScenarioIdSet.has(id)) {
      throw new Error(`unknown hosted failure-control matrix scenario ${id}`);
    }
  }
  const requiringBrowserAction = uniqueIds.filter((id) =>
    failureControlScenarioRequiresExplicitBrowserAction(id),
  );
  if (configured.length > 0 && requiringBrowserAction.length > 0) {
    throw new Error(
      `hosted failure-control PR scenarios require explicit browser actions before they can run: ${requiringBrowserAction.join(",")}`,
    );
  }
  return includeBrowserActionScenarios
    ? uniqueIds
    : uniqueIds.filter((id) => !failureControlScenarioRequiresExplicitBrowserAction(id));
}

export function failureControlScenarioRequiresExplicitBrowserAction(scenarioId) {
  return FAILURE_CONTROL_SCENARIOS_REQUIRING_BROWSER_ACTION.has(scenarioId);
}

export function buildHostedBrowserEvidence({
  agentUrl,
  controlMode,
  deployIds = {},
  deploySha = null,
  failureClass = null,
  hostedMode,
  latencyMs = null,
  model,
  postgresDurability = null,
  provider,
  recapSuccess,
  redactionAudit = null,
  runId = null,
  scenarioId,
  screenshots = [],
  stage,
  terminalReason,
  tokenRefreshOutcome = "not_observed",
  trace = null,
  usage = null,
  webUrl,
} = {}) {
  return {
    schema: HOSTED_E2E_RESULT_SCHEMA,
    scenario_id: scenarioId,
    hosted_mode: hostedMode === true,
    web_url: sanitizeEvidenceUrl(webUrl),
    agent_url: sanitizeEvidenceUrl(agentUrl),
    deploy_ids: {
      agent: deployIds.agent ?? null,
      web: deployIds.web ?? null,
    },
    deploy_sha: deploySha ?? deployIds.sha ?? null,
    provider,
    model: model ?? modelForProvider(provider),
    control_mode: controlMode ?? "none",
    postgres_durability: postgresDurability ?? "not_asserted",
    terminal_reason: terminalReason ?? null,
    failure_class: failureClass ?? null,
    stage: stage ?? null,
    latency_ms: latencyMs,
    usage: usage ?? usageUnavailable(),
    cost_usd: null,
    token_refresh_outcome: tokenRefreshOutcome,
    recap_success: recapSuccess === true,
    screenshots: Array.isArray(screenshots) ? screenshots : [],
    traces: trace ? "local_only_not_published" : "none",
    log_correlation: {
      hosted_run_id: runId,
      validation_run_id: null,
    },
    redaction_audit: redactionAudit ?? {
      forbidden_hits: null,
      sanitized: true,
    },
    sanitized: true,
  };
}

export function hostedEvidenceStageForScenario({
  deterministicPartialRecap = false,
  failureControlStage = null,
  recapVisible = false,
  scenarioId = null,
} = {}) {
  if (failureControlStage) return failureControlStage;
  if (deterministicPartialRecap && recapVisible) return "websocket";
  if (scenarioId === "token_free_session_history" && recapVisible) return "client";
  return recapVisible ? "feedback" : null;
}

export function withHostedEvidenceAudit(result, artifactAudit) {
  if (!result?.hosted_e2e) return result;
  return {
    ...result,
    hosted_e2e: {
      ...result.hosted_e2e,
      log_correlation: {
        ...result.hosted_e2e.log_correlation,
        validation_run_id: result.browser_story?.validation_run_id ?? null,
      },
      redaction_audit: {
        forbidden_hits: artifactAudit?.forbidden_hits ?? null,
        scanned_files: artifactAudit?.scanned_files ?? null,
        sanitized: artifactAudit?.forbidden_hits === 0,
      },
    },
  };
}

export function summarizeHostedE2eResult(result) {
  const evidence = result?.hosted_e2e;
  if (!evidence) return null;
  return {
    schema: evidence.schema,
    scenario_id: evidence.scenario_id,
    hosted_mode: evidence.hosted_mode === true,
    provider: evidence.provider,
    model: evidence.model,
    control_mode: evidence.control_mode,
    postgres_durability: evidence.postgres_durability,
    terminal_reason: evidence.terminal_reason,
    failure_class: evidence.failure_class,
    stage: evidence.stage,
    recap_success: evidence.recap_success === true,
    token_refresh_outcome: evidence.token_refresh_outcome,
    redaction_audit: evidence.redaction_audit,
    deploy_ids: evidence.deploy_ids,
    deploy_sha: evidence.deploy_sha,
    log_correlation: evidence.log_correlation,
    sanitized: evidence.sanitized === true,
  };
}

export function assertHostedE2eMatrixContract(contract) {
  const failures = [];
  if (contract?.schema !== HOSTED_E2E_MATRIX_SCHEMA) {
    failures.push(`schema must be ${HOSTED_E2E_MATRIX_SCHEMA}`);
  }
  if (contract?.bac_510_contract?.max_submitted_answer_resolution_ms !== 45_000) {
    failures.push("BAC-510 45s answer-resolution bound must be present");
  }
  for (const field of HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS) {
    if (!contract?.bac_510_contract?.required_evidence_fields?.includes(field)) {
      failures.push(`required evidence field missing: ${field}`);
    }
  }
  const ids = new Set();
  for (const scenarioRow of contract?.scenarios ?? []) {
    if (ids.has(scenarioRow.id)) failures.push(`duplicate scenario id: ${scenarioRow.id}`);
    ids.add(scenarioRow.id);
    if (!scenarioRow.owner_issue) failures.push(`${scenarioRow.id} must name owner_issue`);
    if (!scenarioRow.stage) failures.push(`${scenarioRow.id} must name stage`);
    if (!scenarioRow.runner) failures.push(`${scenarioRow.id} must name runner`);
    if (scenarioRow.sanitized !== true) failures.push(`${scenarioRow.id} must be sanitized`);
  }
  const requiredScenarioIds = contract?.scenario_subset?.selected
    ? []
    : requiredScenarioIdsForMatrixContract(contract);
  for (const required of requiredScenarioIds) {
    if (!ids.has(required)) failures.push(`matrix scenario missing: ${required}`);
  }
  if (failures.length > 0) {
    throw new Error(`Hosted E2E matrix contract is incomplete: ${failures.join("; ")}`);
  }
}

function requiredScenarioIdsForMatrixContract(contract) {
  if (contract?.mode === "scheduled" || contract?.profile === "scheduled") {
    return ["happy_path"];
  }
  return [
    "happy_path",
    "provider_rate_limited",
    "provider_timeout",
    "silent_stall",
    "provider_auth_failed",
    "provider_malformed_stream",
    "invalid_token",
    "expired_token",
    "replayed_token",
    "double_submit_race",
    "mic_denied",
    "typed_fallback",
    "token_free_session_history",
    "deterministic_partial_recap",
  ];
}

function scenario(input) {
  return Object.freeze({
    blocked_by: Object.freeze(input.blocked_by ?? []),
    control_scenario_id: input.control_scenario_id ?? null,
    coverage: Object.freeze(input.coverage ?? []),
    failure_class: input.failure_class ?? null,
    id: input.id,
    milestone: input.milestone,
    owner_issue: input.owner_issue,
    profiles: Object.freeze(input.profiles),
    provider: input.provider,
    recap_success_expected: input.recap_success_expected === true,
    runner: input.runner,
    sanitized: true,
    stage: input.stage,
    terminal_reason: input.terminal_reason ?? null,
    title: input.title,
  });
}

function coverageForFailureControlScenario(id) {
  const common = ["terminal_reason", "failure_class", "stage", "safe_recovery_path"];
  const perScenario = {
    double_submit_race: ["double_submit"],
    expired_token: ["expired_auth_material"],
    invalid_token: ["invalid_auth_material"],
    malformed_token: ["malformed_auth_material"],
    mic_denied: ["mic_unavailable"],
    provider_auth_failed: ["provider_auth_failure"],
    provider_malformed_stream: ["malformed_stream"],
    provider_network_disconnect: ["network_disconnect"],
    provider_rate_limited: ["provider_429", "sanitized_retry_metadata"],
    provider_timeout: ["provider_timeout"],
    recap_timeout: ["recap_stage_bound"],
    replayed_token: ["replayed_auth_material"],
    silent_stall: ["post_answer_watchdog_expiry"],
    slow_stale_socket_close: ["stale_socket_close"],
    sonic_tts_timeout: ["sonic_stage_bound"],
    typed_fallback: ["typed_fallback"],
  };
  return [...common, ...(perScenario[id] ?? [])];
}

function failureControlScenarioExpectsRecapSuccess(entry) {
  return entry.failure_class === "partial_stage_success" && entry.stage === "recap";
}

function titleFromScenarioId(id) {
  return id
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeEvidenceUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/g, "");
}

function modelForProvider(provider) {
  switch (provider) {
    case "synthetic":
      return "synthetic-viva";
    case "fake_cartesia_gemini":
      return "fake-cartesia-gemini";
    case "cartesia_gemini":
      return "cartesia-gemini-live";
    default:
      return null;
  }
}

function usageUnavailable() {
  return {
    available: false,
    redacted: true,
  };
}
