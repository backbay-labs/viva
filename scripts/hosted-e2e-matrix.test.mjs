import assert from "node:assert/strict";
import test from "node:test";
import { FAILURE_CONTROL_SCENARIOS } from "./failure-control-harness.mjs";
import {
  assertHostedE2eMatrixContract,
  buildHostedBrowserEvidence,
  buildHostedE2eMatrixContract,
  failureControlScenarioIdsForProfile,
  failureControlScenarioRequiresExplicitBrowserAction,
  HOSTED_E2E_MATRIX_SCHEMA,
  HOSTED_E2E_MONITOR_POLICY_SCHEMA,
  HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS,
  HOSTED_E2E_RESULT_SCHEMA,
  HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
  HOSTED_LIVE_MONITOR_STATE_PROBE_KEY,
  HOSTED_LIVE_MONITOR_STATE_SCHEMA,
  HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,
  HOSTED_MONITOR_POLICY,
  hostedEvidenceStageForScenario,
  scenariosForProfile,
  summarizeHostedE2eResult,
  withHostedEvidenceAudit,
} from "./hosted-e2e-matrix.mjs";
import {
  RELEASE_LEARNER_LOOP_CONTRACT,
  validatedLearnerLoopForRelease,
} from "./release-contract-validation.mjs";

const FORBIDDEN_MARKERS = Object.freeze([
  "pcm16_base64",
  "answer_text",
  "transcript_final",
  "source_context",
  "pasted_text",
  "session_token",
  "viva1.",
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "Bearer ",
]);

function prRunnableFailureControlScenarios() {
  return FAILURE_CONTROL_SCENARIOS.filter(
    (scenario) => !failureControlScenarioRequiresExplicitBrowserAction(scenario.id),
  );
}

function sessionAuthFailureControlScenarioIds() {
  return FAILURE_CONTROL_SCENARIOS.filter((scenario) => scenario.stage === "session_auth").map(
    (scenario) => scenario.id,
  );
}

test("hosted E2E matrix contract exposes BAC-510 fields and required scenarios", () => {
  const contract = buildHostedE2eMatrixContract({
    generatedAt: "2026-06-25T00:00:00.000Z",
    mode: "pr",
    runId: "run-1",
  });

  assert.equal(contract.schema, HOSTED_E2E_MATRIX_SCHEMA);
  assert.equal(contract.mode, "pr");
  assert.equal(contract.profile, "full");
  assert.equal(contract.run_id, "run-1");
  assert.equal(contract.bac_510_contract.max_submitted_answer_resolution_ms, 45_000);
  assert.deepEqual(
    [
      "terminal_reason",
      "failure_class",
      "stage",
      "provider",
      "model",
      "deploy_sha",
      "latency_ms",
      "usage",
      "cost_usd",
      "token_refresh_outcome",
      "recap_success",
    ].every((field) => contract.bac_510_contract.required_evidence_fields.includes(field)),
    true,
  );
  assert.doesNotThrow(() => assertHostedE2eMatrixContract(contract));

  const ids = new Set(contract.scenarios.map((scenario) => scenario.id));
  for (const id of [
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
  ]) {
    assert(ids.has(id), `missing hosted matrix scenario ${id}`);
  }
});

test("hosted scheduled matrix contract validates its scheduled scenario set", () => {
  const contract = buildHostedE2eMatrixContract({
    generatedAt: "2026-06-25T00:00:00.000Z",
    mode: "scheduled",
    runId: "scheduled-run-1",
  });

  assert.equal(contract.mode, "scheduled");
  assert.equal(contract.profile, "scheduled");
  assert.equal(contract.scenario_subset, undefined);
  assert.deepEqual(
    contract.scenarios.map((scenario) => scenario.id),
    ["happy_path"],
  );
  assert.doesNotThrow(() => assertHostedE2eMatrixContract(contract));
});

test("hosted token-free session history coverage does not claim unobserved BFCache restore", () => {
  const contract = buildHostedE2eMatrixContract({
    generatedAt: "2026-06-25T00:00:00.000Z",
    mode: "pr",
    runId: "run-1",
  });
  const scenario = contract.scenarios.find((entry) => entry.id === "token_free_session_history");

  assert(scenario);
  assert(scenario.coverage.includes("back_forward_recovery"));
  assert(scenario.coverage.includes("refresh_recovery"));
  assert.equal(scenario.coverage.includes("bfcache_restore"), false);
});

test("hosted E2E matrix keeps future product slices contracted but not in default runs", () => {
  const contractRows = scenariosForProfile("contract");
  const fullRows = scenariosForProfile("full", "pr");
  const contractIds = new Set(contractRows.map((scenario) => scenario.id));
  const fullIds = new Set(fullRows.map((scenario) => scenario.id));

  assert(contractIds.has("pre_loop_ingestion_failure"));
  assert(contractIds.has("multi_tab_second_session"));
  assert.equal(fullIds.has("pre_loop_ingestion_failure"), false);
  assert.equal(fullIds.has("multi_tab_second_session"), false);
});

test("hosted PR profile expands to browser-runnable deterministic failure-control scenarios", () => {
  const expected = prRunnableFailureControlScenarios()
    .map((scenario) => scenario.id)
    .sort();
  assert.deepEqual(failureControlScenarioIdsForProfile({ profile: "full" }).sort(), expected);
  for (const scenarioId of sessionAuthFailureControlScenarioIds()) {
    assert.equal(failureControlScenarioRequiresExplicitBrowserAction(scenarioId), true);
    assert.equal(expected.includes(scenarioId), false);
  }
  assert.deepEqual(
    failureControlScenarioIdsForProfile({
      includeBrowserActionScenarios: true,
      profile: "full",
    }).sort(),
    FAILURE_CONTROL_SCENARIOS.map((scenario) => scenario.id).sort(),
  );
  assert.deepEqual(
    failureControlScenarioIdsForProfile({
      configuredValue: "provider_rate_limited,provider_timeout,provider_rate_limited",
      profile: "full",
    }),
    ["provider_rate_limited", "provider_timeout"],
  );
  assert.throws(
    () => failureControlScenarioIdsForProfile({ configuredValue: "unknown_scenario" }),
    /unknown hosted failure-control matrix scenario/,
  );
  assert.throws(
    () => failureControlScenarioIdsForProfile({ configuredValue: "mic_denied" }),
    /require explicit browser actions/,
  );
  assert.throws(
    () => failureControlScenarioIdsForProfile({ profile: "typo" }),
    /unsupported hosted E2E matrix profile/,
  );
  assert.throws(() => scenariosForProfile("typo"), /unsupported hosted E2E matrix profile/);
});

test("hosted matrix contract can publish a selected PR scenario subset", () => {
  const contract = buildHostedE2eMatrixContract({
    mode: "pr",
    profile: "full",
    runId: "subset-run",
    scenarioIds: [
      "happy_path",
      "fake_provider_happy_path",
      "token_free_session_history",
      "deterministic_partial_recap",
      "provider_rate_limited",
      "provider_timeout",
    ],
    scenarioSubset: {
      selected: true,
      configured_env: "VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS",
      scenario_ids: [
        "happy_path",
        "fake_provider_happy_path",
        "token_free_session_history",
        "deterministic_partial_recap",
        "provider_rate_limited",
        "provider_timeout",
      ],
    },
  });

  assert.equal(contract.scenario_count, 6);
  assert.equal(contract.scenario_subset.selected, true);
  assert.deepEqual(
    contract.scenarios.map((scenario) => scenario.id),
    [
      "happy_path",
      "fake_provider_happy_path",
      "token_free_session_history",
      "deterministic_partial_recap",
      "provider_rate_limited",
      "provider_timeout",
    ],
  );
  assert.doesNotThrow(() => assertHostedE2eMatrixContract(contract));
  assert.throws(
    () => buildHostedE2eMatrixContract({ scenarioIds: ["unknown_scenario"] }),
    /unknown hosted E2E matrix scenario/,
  );
});

test("hosted failure-control rows only expect recap success for recap-stage scenarios", () => {
  const rows = scenariosForProfile("full", "pr");

  assert.equal(
    rows.find((scenario) => scenario.id === "typed_fallback").recap_success_expected,
    false,
  );
  assert.equal(
    rows.find((scenario) => scenario.id === "deterministic_partial_recap").recap_success_expected,
    true,
  );
});

test("hosted browser evidence stage matches scenario-specific matrix rows", () => {
  assert.equal(
    hostedEvidenceStageForScenario({
      recapVisible: true,
      scenarioId: "token_free_session_history",
    }),
    "client",
  );
  assert.equal(
    hostedEvidenceStageForScenario({
      deterministicPartialRecap: true,
      recapVisible: true,
      scenarioId: "deterministic_partial_recap",
    }),
    "websocket",
  );
  assert.equal(
    hostedEvidenceStageForScenario({
      failureControlStage: "gemini",
      recapVisible: true,
      scenarioId: "provider_rate_limited",
    }),
    "gemini",
  );
  assert.equal(hostedEvidenceStageForScenario({ recapVisible: true }), "feedback");
});

test("hosted monitor policy caps live cadence and self-quarantines sustained provider 429s", () => {
  assert.equal(HOSTED_MONITOR_POLICY.schema, HOSTED_E2E_MONITOR_POLICY_SCHEMA);
  assert.equal(HOSTED_MONITOR_POLICY.synthetic_monitor.cadence_seconds, 1800);
  assert.equal(HOSTED_MONITOR_POLICY.live_monitor.default_enabled, false);
  assert.equal(HOSTED_MONITOR_POLICY.live_monitor.max_turns_per_run, 1);
  assert.equal(HOSTED_MONITOR_POLICY.live_monitor.max_cost_usd_per_run, 0.25);
  assert.equal(HOSTED_MONITOR_POLICY.live_monitor.max_cost_usd_per_day, 0.5);
  assert.equal(HOSTED_MONITOR_POLICY.live_monitor.max_runs_per_day, 2);
  assert.equal(HOSTED_MONITOR_POLICY.self_quarantine.failure_class, "quota_rate_failure");
  assert.equal(HOSTED_MONITOR_POLICY.self_quarantine.terminal_reason, "provider_rate_limited");
  assert.equal(HOSTED_MONITOR_POLICY.self_quarantine.consecutive_failures, 2);
});

test("hosted live monitor durable state object is named one run-independent schema-versioned key", () => {
  assert.equal(HOSTED_LIVE_MONITOR_STATE_SCHEMA, "viva.hosted_live_monitor_state.v1");
  assert.equal(
    HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
    "viva-hosted-monitor/state/live-monitor-state.v1.json",
  );
  assert.doesNotMatch(HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY, /\$\{|<run_id>|run-2026/);
  assert.notEqual(HOSTED_LIVE_MONITOR_STATE_PROBE_KEY, HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY);
  assert.match(HOSTED_LIVE_MONITOR_STATE_PROBE_KEY, /^viva-hosted-monitor\/state\//);
});

test("hosted browser evidence records required production fields without forbidden payloads", () => {
  const evidence = buildHostedBrowserEvidence({
    agentUrl: "https://agent.example.com/ws?debug=secret#fragment",
    controlMode: "failure_control",
    deployIds: { agent: "railway-agent-123", web: "vercel-web-456" },
    deploySha: "abc123hostedsha",
    failureClass: "quota_rate_failure",
    hostedMode: true,
    latencyMs: 1234,
    postgresDurability: "durable",
    provider: "synthetic",
    recapSuccess: false,
    runId: "run-123",
    scenarioId: "provider_rate_limited",
    screenshots: ["failure-control-terminal.png"],
    stage: "gemini",
    terminalReason: "provider_rate_limited",
    tokenRefreshOutcome: "not_required",
    webUrl: "https://web.example.com/session?debug=secret#fragment",
  });

  assert.equal(evidence.schema, HOSTED_E2E_RESULT_SCHEMA);
  assert.equal(evidence.web_url, "https://web.example.com/session");
  assert.equal(evidence.agent_url, "https://agent.example.com/ws");
  assert.equal(evidence.provider, "synthetic");
  assert.equal(evidence.model, "synthetic-viva");
  assert.equal(evidence.deploy_ids.agent, "railway-agent-123");
  assert.equal(evidence.deploy_ids.web, "vercel-web-456");
  assert.equal(evidence.deploy_sha, "abc123hostedsha");
  assert.equal(evidence.failure_class, "quota_rate_failure");
  assert.equal(evidence.terminal_reason, "provider_rate_limited");
  assert.equal(evidence.stage, "gemini");
  assert.equal(evidence.latency_ms, 1234);
  assert.equal(evidence.recap_success, false);
  assert.equal(evidence.usage.redacted, true);
  assert.equal(evidence.sanitized, true);

  const serialized = JSON.stringify(evidence);
  for (const marker of FORBIDDEN_MARKERS) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(marker)));
  }
});

test("hosted browser evidence audit is reflected in runner summaries", () => {
  const result = withHostedEvidenceAudit(
    {
      browser_story: { validation_run_id: "browser-story-synthetic-run" },
      hosted_e2e: buildHostedBrowserEvidence({
        agentUrl: "https://agent.example.com",
        deploySha: "abc123summarysha",
        hostedMode: true,
        provider: "synthetic",
        recapSuccess: true,
        runId: "run-123",
        scenarioId: "happy_path",
        stage: "feedback",
        terminalReason: "completed",
        webUrl: "https://web.example.com",
      }),
    },
    { forbidden_hits: 0, scanned_files: 4 },
  );
  const summary = summarizeHostedE2eResult(result);

  assert.equal(summary.scenario_id, "happy_path");
  assert.equal(summary.web_url, "https://web.example.com");
  assert.equal(summary.agent_url, "https://agent.example.com");
  assert.equal(summary.deploy_sha, "abc123summarysha");
  assert.equal(summary.latency_ms, null);
  assert.equal(summary.retry_after_ms, null);
  assert.equal(summary.retry_after_source, null);
  assert.equal(summary.reset_hint, null);
  assert.equal(summary.budget_state, null);
  assert.equal(summary.usage.redacted, true);
  assert.equal(summary.cost_usd, null);
  assert.deepEqual(summary.local_screenshots, []);
  assert.equal(summary.traces, "none");
  assert.equal(summary.redaction_audit.forbidden_hits, 0);
  assert.equal(summary.redaction_audit.scanned_files, 4);
  assert.equal(summary.log_correlation.validation_run_id, "browser-story-synthetic-run");
  assert.equal(summary.sanitized, true);
  for (const field of HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS) {
    assert.ok(Object.hasOwn(summary, field), `summary preserves ${field}`);
  }
});

test("hosted browser evidence exposes local_screenshots as safe relative local paths, never a durable object reference", () => {
  const evidence = buildHostedBrowserEvidence({
    agentUrl: "https://agent.example.com",
    deploySha: "abc123localshots",
    hostedMode: true,
    provider: "synthetic",
    recapSuccess: true,
    runId: "run-1",
    scenarioId: "happy_path",
    screenshots: ["connected-terminal-fold.png", "source-folio.png"],
    stage: "feedback",
    terminalReason: "completed",
    webUrl: "https://web.example.com",
  });

  assert.equal(Object.hasOwn(evidence, "screenshots"), false, "the old field name must not survive");
  assert.deepEqual(evidence.local_screenshots, [
    "connected-terminal-fold.png",
    "source-folio.png",
  ]);
  for (const name of evidence.local_screenshots) {
    assert.match(name, /^[A-Za-z0-9._-]+\.png$/, `${name} must be a safe relative local filename`);
    assert.doesNotMatch(name, /^https?:\/\//, `${name} must not look like a durable object URL`);
    assert.doesNotMatch(name, /\.\./, `${name} must not traverse directories`);
  }

  const summary = summarizeHostedE2eResult(
    withHostedEvidenceAudit(
      { browser_story: {}, hosted_e2e: evidence },
      { forbidden_hits: 0, scanned_files: 1 },
    ),
  );
  assert.deepEqual(summary.local_screenshots, evidence.local_screenshots);
  assert.equal(Object.hasOwn(summary, "screenshots"), false);
  assert.ok(
    HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS.includes("local_screenshots"),
    "the required-evidence-field list must name the renamed field",
  );
  assert.ok(
    !HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS.includes("screenshots"),
    "the required-evidence-field list must not keep the retired field name",
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// RELEASE-028: the hosted matrix's turn bound and evidence-field allowlist are
// read from the validated learner-loop singleton, never from the raw JSON.
test("hosted matrix bounds and evidence fields come from the validated learner-loop contract", () => {
  assert.equal(
    HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,
    RELEASE_LEARNER_LOOP_CONTRACT.max_submitted_answer_resolution_ms,
  );
  assert.equal(Object.isFrozen(RELEASE_LEARNER_LOOP_CONTRACT), true);

  const contract = buildHostedE2eMatrixContract({
    generatedAt: "2026-08-27T00:00:00.000Z",
    mode: "pr",
    runId: "run-1",
  });
  assert.equal(contract.bac_510_contract.schema, RELEASE_LEARNER_LOOP_CONTRACT.schema);
  assert.equal(
    contract.bac_510_contract.max_submitted_answer_resolution_ms,
    RELEASE_LEARNER_LOOP_CONTRACT.max_submitted_answer_resolution_ms,
  );
  for (const field of RELEASE_LEARNER_LOOP_CONTRACT.evidence_fields) {
    assert.ok(
      HOSTED_E2E_REQUIRED_EVIDENCE_FIELDS.includes(field),
      `${field} must be an accepted hosted evidence field`,
    );
  }
});


// RELEASE-028 bypass control: this consumer's own hostile variant. If the
// published validator ever stopped rejecting unknown keys, this test fails
// here rather than letting an unchecked state reach the gate.
test("the hosted matrix refuses a learner-loop variant carrying an unknown nested field", () => {
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
