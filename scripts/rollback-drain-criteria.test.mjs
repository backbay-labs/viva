import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RELEASE_LEARNER_LOOP_CONTRACT,
  RELEASE_LEARNER_LOOP_CONTRACT as learnerLoopContract,
  validatedLearnerLoopForRelease,
} from "./release-contract-validation.mjs";
import fixture from "./fixtures/rollback-drain-threshold-samples.json" with { type: "json" };
import {
  assertRollbackReleaseGate,
  BAC_510_ROLLBACK_COVERAGE,
  buildRollbackReleaseEvidence,
  evaluateRollbackDecision,
  REQUIRED_ROLLBACK_TRIGGER_IDS,
  ROLLBACK_DRAIN_BEHAVIOR,
  ROLLBACK_DRAIN_PROOF_COMMANDS,
  ROLLBACK_TRIGGER_THRESHOLDS,
  rollbackCriteriaEvidence,
} from "./rollback-drain-criteria.mjs";

test("rollback criteria define concrete BAC-527 thresholds and BAC-525 alert ids", () => {
  const thresholdsById = new Map(ROLLBACK_TRIGGER_THRESHOLDS.map((entry) => [entry.id, entry]));
  const sharedAlertIds = new Set();

  for (const id of REQUIRED_ROLLBACK_TRIGGER_IDS) {
    assert(thresholdsById.has(id), `missing threshold ${id}`);
  }

  for (const threshold of ROLLBACK_TRIGGER_THRESHOLDS) {
    assert.equal(threshold.operator, ">=");
    assert.equal(threshold.production_release_blocking, true);
    assert(Number.isFinite(threshold.value) && threshold.value > 0);
    assert(Number.isInteger(threshold.window_seconds) && threshold.window_seconds > 0);
    assert(Number.isInteger(threshold.sustained_seconds) && threshold.sustained_seconds > 0);
    assert(threshold.sustained_seconds <= threshold.window_seconds);
    assert.match(threshold.shared_alert_id, /^bac525_[a-z0-9_]+$/);
    assert.equal(sharedAlertIds.has(threshold.shared_alert_id), false);
    sharedAlertIds.add(threshold.shared_alert_id);
  }

  assert.equal(thresholdsById.get("provider_429_rate_percent").value, 10);
  assert.equal(thresholdsById.get("provider_429_rate_percent").window_seconds, 600);
  assert.equal(thresholdsById.get("provider_429_rate_percent").sustained_seconds, 300);
  assert.equal(thresholdsById.get("provider_timeout_rate_percent").value, 5);
  assert.equal(thresholdsById.get("provider_auth_failure_count").value, 1);
  assert.equal(thresholdsById.get("stuck_checking_sessions").value, 3);
  assert.equal(thresholdsById.get("recap_failure_rate_percent").value, 5);
  assert.equal(
    thresholdsById.get("recap_failure_rate_percent").failure_class,
    "partial_stage_success",
  );
  assert.equal(thresholdsById.get("token_refresh_failure_rate_percent").value, 2);
  assert.equal(
    thresholdsById.get("token_refresh_failure_rate_percent").failure_class,
    "session_auth_failure",
  );
  assert.equal(thresholdsById.get("live_monitor_consecutive_failures").value, 2);
});

test("threshold fixture flips rollback decision at each concrete boundary", () => {
  assert.equal(fixture.schema, "viva.rollback_threshold_fixture.v1");

  for (const sample of fixture.cases) {
    const decision = evaluateRollbackDecision(sample);
    assert.equal(
      decision.rollback_required,
      sample.expected.rollback_required,
      `${sample.id} rollback_required mismatch`,
    );
    assert.deepEqual(
      decision.triggered_thresholds.map((entry) => entry.id),
      sample.expected.triggered_thresholds,
      `${sample.id} triggered thresholds mismatch`,
    );
  }
});

test("rollback drain criteria reconcile to BAC-510 deploy drain and rollback states", () => {
  const stateIds = new Set(learnerLoopContract.states.map((state) => state.id));
  for (const coverage of BAC_510_ROLLBACK_COVERAGE) {
    assert(
      stateIds.has(coverage.contract_state_id),
      `missing BAC-510 state ${coverage.contract_state_id}`,
    );
  }

  const deployDrain = learnerLoopContract.states.find((state) => state.id === "deploy_drain");
  const rollback = learnerLoopContract.states.find((state) => state.id === "rollback");
  assert.equal(deployDrain.terminal_reason, "drained");
  assert.equal(rollback.terminal_reason, "rollback");
  assert.equal(ROLLBACK_DRAIN_BEHAVIOR.ready_endpoint.expected_http_status, 503);
  assert.equal(ROLLBACK_DRAIN_BEHAVIOR.live_endpoint.expected_http_status, 200);
  assert.equal(ROLLBACK_DRAIN_BEHAVIOR.websocket_preflight.expected_http_status, 503);
  assert.equal(ROLLBACK_DRAIN_BEHAVIOR.active_manuscripts.terminal_frame_type, "session_phase");
  assert.equal(ROLLBACK_DRAIN_BEHAVIOR.active_manuscripts.terminal_reason, "drained");
  assert(ROLLBACK_DRAIN_BEHAVIOR.proof_commands.length >= 4);
});

test("rollback drain proof commands are shared between evidence and the release gate", async () => {
  assert.equal(ROLLBACK_DRAIN_PROOF_COMMANDS.length, 4);
  assert.deepEqual(
    ROLLBACK_DRAIN_BEHAVIOR.proof_commands,
    ROLLBACK_DRAIN_PROOF_COMMANDS.map((entry) => [entry.command, ...entry.args].join(" ")),
  );
  assert.equal(
    new Set(ROLLBACK_DRAIN_PROOF_COMMANDS.map((entry) => entry.name)).size,
    ROLLBACK_DRAIN_PROOF_COMMANDS.length,
  );
  for (const proofCommand of ROLLBACK_DRAIN_PROOF_COMMANDS) {
    assert.equal(proofCommand.command, "cargo");
    assert.deepEqual(proofCommand.args.slice(0, 5), [
      "test",
      "--manifest-path",
      "agent/Cargo.toml",
      "-p",
      "agent-service",
    ]);
    assert(proofCommand.args.includes("voice_ws"));
    assert(proofCommand.args.includes("--nocapture"));
  }

  const releaseCheck = await readFile("scripts/release-check.mjs", "utf8");
  assert.match(releaseCheck, /ROLLBACK_DRAIN_PROOF_COMMANDS/);
  assert.match(releaseCheck, /await runRollbackDrainProofCommands\(\);/);
  assert.equal(
    releaseCheck.match(/await runRollbackDrainProofCommands\(\);/g)?.length,
    1,
    "release-check must not rerun rollback drain proofs and overwrite command logs",
  );
  assert(
    releaseCheck.indexOf("await runRollbackDrainProofCommands();") <
      releaseCheck.indexOf("const rollbackDrain = buildRollbackReleaseEvidence();"),
    "release-check must run drain proofs before writing rollback release evidence",
  );
});

test("rollback release evidence is sanitized and blocks production without owner decision", () => {
  const evidence = buildRollbackReleaseEvidence({
    env: {
      VIVA_PRODUCTION_RELEASE: "1",
      VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
      VIVA_RELEASE_AGENT_DEPLOY_ID: "agent-deploy-456",
      VIVA_RELEASE_CONFIG_DIFF_SHA256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      VIVA_RELEASE_PROVIDER_MODE: "cartesia_gemini",
      VIVA_RELEASE_POSTGRES_STATE: "postgres_ready",
      VIVA_RELEASE_RECOVERY_VALIDATION: "release-check-and-drain-smoke-passed",
    },
    generatedAt: new Date("2026-06-25T00:00:00Z"),
  });

  assert.equal(evidence.schema, "viva.rollback_release_gate.v1");
  assert.equal(evidence.production_release_gate.production_requested, true);
  assert.equal(evidence.production_release_gate.thresholds_present, true);
  assert.equal(evidence.production_release_gate.owner_decision_present, false);
  assert.equal(evidence.production_release_gate.allowed, false);
  assert.throws(() => assertRollbackReleaseGate(evidence), /production release blocked/);

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /pcm16_base64/);
  assert.doesNotMatch(serialized, /answer_text/);
  assert.doesNotMatch(serialized, /transcript_final/);
  assert.doesNotMatch(serialized, /source_context/);
  assert.doesNotMatch(serialized, /session_token/);
  assert.doesNotMatch(serialized, /Bearer /);
  assert.doesNotMatch(serialized, /CARTESIA_API_KEY/);
  assert.doesNotMatch(serialized, /GEMINI_API_KEY/);
});

test("rollback release evidence allows production only with complete deploy and owner proceed fields", () => {
  const evidence = buildRollbackReleaseEvidence({
    env: {
      VIVA_PRODUCTION_RELEASE: "1",
      VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
      VIVA_RELEASE_AGENT_DEPLOY_ID: "agent-deploy-456",
      VIVA_RELEASE_CONFIG_DIFF_SHA256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      VIVA_RELEASE_PROVIDER_MODE: "cartesia_gemini",
      VIVA_RELEASE_POSTGRES_STATE: "postgres_ready",
      VIVA_RELEASE_RECOVERY_VALIDATION: "release-check-and-drain-smoke-passed",
      VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T00:00:00Z",
      VIVA_RELEASE_OWNER_DECISION: "proceed",
      VIVA_RELEASE_OWNER: "release-owner",
    },
    generatedAt: new Date("2026-06-25T00:00:00Z"),
  });

  assert.equal(evidence.production_release_gate.owner_decision_present, true);
  assert.equal(evidence.production_release_gate.owner_decision_allows_release, true);
  assert.deepEqual(evidence.production_release_gate.missing_production_fields, []);
  assert.deepEqual(evidence.production_release_gate.invalid_production_fields, []);
  assert.equal(evidence.production_release_gate.postgres_ready, true);
  assert.equal(evidence.production_release_gate.recovery_validation_passed, true);
  assert.equal(evidence.production_release_gate.allowed, true);
  assert.doesNotThrow(() => assertRollbackReleaseGate(evidence));
});

test("production release evidence blocks failed Postgres or recovery validation states", () => {
  const evidence = buildRollbackReleaseEvidence({
    env: {
      VIVA_PRODUCTION_RELEASE: "1",
      VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
      VIVA_RELEASE_AGENT_DEPLOY_ID: "agent-deploy-456",
      VIVA_RELEASE_CONFIG_DIFF_SHA256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      VIVA_RELEASE_PROVIDER_MODE: "cartesia_gemini",
      VIVA_RELEASE_POSTGRES_STATE: "postgres_down",
      VIVA_RELEASE_RECOVERY_VALIDATION: "failed",
      VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T00:00:00Z",
      VIVA_RELEASE_OWNER_DECISION: "proceed",
      VIVA_RELEASE_OWNER: "release-owner",
    },
    generatedAt: new Date("2026-06-25T00:00:00Z"),
  });

  assert.deepEqual(evidence.production_release_gate.missing_production_fields, []);
  assert.deepEqual(evidence.production_release_gate.invalid_production_fields, [
    "postgres_state",
    "recovery_validation",
  ]);
  assert.equal(evidence.production_release_gate.postgres_ready, false);
  assert.equal(evidence.production_release_gate.recovery_validation_passed, false);
  assert.equal(evidence.production_release_gate.allowed, false);
  assert.equal(
    evidence.production_release_gate.reason,
    "production_release_recovery_state_not_ready",
  );
  assert.throws(() => assertRollbackReleaseGate(evidence), /production release blocked/);
});

test("production release evidence requires release-scoped deploy and provider fields", () => {
  const evidence = buildRollbackReleaseEvidence({
    env: {
      VIVA_PRODUCTION_RELEASE: "1",
      VIVA_WEB_DEPLOY_ID: "generic-web-deploy",
      VIVA_AGENT_DEPLOY_ID: "generic-agent-deploy",
      VIVA_RELEASE_CONFIG_DIFF_SHA256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      VIVA_AGENT_PROVIDER: "cartesia_gemini",
      VIVA_RELEASE_POSTGRES_STATE: "postgres_ready",
      VIVA_RELEASE_RECOVERY_VALIDATION: "release-check-and-drain-smoke-passed",
      VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T00:00:00Z",
      VIVA_RELEASE_OWNER_DECISION: "proceed",
      VIVA_RELEASE_OWNER: "release-owner",
    },
    generatedAt: new Date("2026-06-25T00:00:00Z"),
  });

  assert.equal(evidence.production_snapshot.web_deploy_id, null);
  assert.equal(evidence.production_snapshot.agent_deploy_id, null);
  assert.equal(evidence.production_snapshot.provider_mode, null);
  assert.deepEqual(evidence.production_release_gate.missing_production_fields, [
    "web_deploy_id",
    "agent_deploy_id",
    "provider_mode",
  ]);
  assert.equal(evidence.production_release_gate.allowed, false);
  assert.throws(() => assertRollbackReleaseGate(evidence), /production release blocked/);
});

test("owner decision timestamps must be valid UTC instants", () => {
  assert.throws(
    () =>
      buildRollbackReleaseEvidence({
        env: {
          VIVA_PRODUCTION_RELEASE: "1",
          VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
          VIVA_RELEASE_AGENT_DEPLOY_ID: "agent-deploy-456",
          VIVA_RELEASE_CONFIG_DIFF_SHA256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          VIVA_RELEASE_PROVIDER_MODE: "cartesia_gemini",
          VIVA_RELEASE_POSTGRES_STATE: "postgres_ready",
          VIVA_RELEASE_RECOVERY_VALIDATION: "release-check-and-drain-smoke-passed",
          VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "not-a-date",
          VIVA_RELEASE_OWNER_DECISION: "proceed",
          VIVA_RELEASE_OWNER: "release-owner",
        },
      }),
    /VIVA_RELEASE_OWNER_DECIDED_AT_UTC must be a valid UTC ISO timestamp/,
  );
  assert.throws(
    () =>
      buildRollbackReleaseEvidence({
        env: {
          VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T00:00:00+00:00",
        },
      }),
    /VIVA_RELEASE_OWNER_DECIDED_AT_UTC must be a valid UTC ISO timestamp/,
  );
  assert.throws(
    () =>
      buildRollbackReleaseEvidence({
        env: {
          VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-02-31T00:00:00Z",
        },
      }),
    /VIVA_RELEASE_OWNER_DECIDED_AT_UTC must be a valid UTC ISO timestamp/,
  );
  assert.throws(
    () =>
      buildRollbackReleaseEvidence({
        env: {
          VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T24:00:00Z",
        },
      }),
    /VIVA_RELEASE_OWNER_DECIDED_AT_UTC must be a valid UTC ISO timestamp/,
  );
});

test("default non-production release evidence carries thresholds without allowing production", () => {
  const evidence = buildRollbackReleaseEvidence({
    env: {
      VIVA_WEB_DEPLOY_ID: "generic-web-deploy",
      VIVA_AGENT_DEPLOY_ID: "generic-agent-deploy",
      VIVA_AGENT_PROVIDER: "fake_cartesia_gemini",
    },
    generatedAt: new Date("2026-06-25T00:00:00Z"),
  });

  assert.equal(evidence.production_release_gate.production_requested, false);
  assert.equal(evidence.production_release_gate.thresholds_present, true);
  assert.equal(evidence.production_release_gate.allowed, false);
  assert.equal(evidence.production_snapshot.web_deploy_id, "generic-web-deploy");
  assert.equal(evidence.production_snapshot.agent_deploy_id, "generic-agent-deploy");
  assert.equal(evidence.production_snapshot.provider_mode, "fake_cartesia_gemini");
  assert.doesNotThrow(() => assertRollbackReleaseGate(evidence));
  assert.equal(rollbackCriteriaEvidence().schema, "viva.rollback_drain_criteria.v1");
});

// RELEASE-028: the rollback gate's contract-state check reads the validated
// singleton, so an unknown or misspelled learner-loop state can never reach it.
test("rollback drain coverage names only states the validated learner-loop contract defines", () => {
  const contractStateIds = new Set(learnerLoopContract.states.map((state) => state.id));
  const named = BAC_510_ROLLBACK_COVERAGE.map((entry) => entry.contract_state_id);

  assert.ok(named.length > 0);
  for (const stateId of named) {
    assert.equal(contractStateIds.has(stateId), true, `${stateId} is not a contract state`);
  }
  assert.equal(Object.isFrozen(learnerLoopContract), true);
});


// RELEASE-028 bypass control: this consumer's own hostile variant. If the
// published validator ever stopped rejecting unknown keys, this test fails
// here rather than letting an unchecked state reach the gate.
test("the rollback gate refuses a learner-loop variant carrying an unknown nested field", () => {
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
