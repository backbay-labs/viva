import assert from "node:assert/strict";
import test from "node:test";

import { buildHostedE2eMatrixContract } from "./hosted-e2e-matrix.mjs";
import {
  assertReleaseBundleIntegrity,
  finalizeReleaseEvidenceBundle,
  PRODUCTION_RELEASE_GATE_SCHEMA,
  RELEASE_BUNDLE_INTEGRITY_SCHEMA,
} from "./production-release-gate.mjs";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("production release gate allows fresh hosted evidence with signed bundle integrity", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence(),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });

  assert.equal(evidence.production_release_gate.schema, PRODUCTION_RELEASE_GATE_SCHEMA);
  assert.equal(evidence.production_release_gate.allowed, true);
  assert.deepEqual(evidence.production_release_gate.missing_required_evidence, []);
  assert.equal(evidence.production_release_gate.deploy_identity.matches_live, true);
  assert.equal(evidence.production_release_gate.deploy_identity.matches_release, true);
  assert.equal(evidence.production_release_gate.durability.production_durable, true);
  assert.equal(evidence.production_release_gate.issue_proofs.bac_529_quota_sufficient, true);
  assert.equal(evidence.release_bundle.integrity.schema, RELEASE_BUNDLE_INTEGRITY_SCHEMA);
  assert.equal(evidence.release_bundle.integrity.signature_algorithm, "hmac-sha256");
  assert.equal(evidence.release_bundle.integrity.signature_key_present, true);
  assert.doesNotThrow(() => assertReleaseBundleIntegrity(evidence, { env: productionEnv() }));

  const tampered = {
    ...evidence,
    browser_e2e: {
      ...evidence.browser_e2e,
      hosted_e2e: {
        ...evidence.browser_e2e.hosted_e2e,
        deploy_ids: { ...evidence.browser_e2e.hosted_e2e.deploy_ids, web: "web-tampered" },
      },
    },
  };
  assert.throws(
    () => assertReleaseBundleIntegrity(tampered, { env: productionEnv() }),
    /integrity verification failed/,
  );
});

test("production release gate rejects browser-skip evidence", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          browser_e2e: {
            skipped: true,
            reason: "VIVA_RELEASE_CHECK_SKIP_BROWSER=1 and no existing browser result was found",
          },
        }),
        env: productionEnv({ VIVA_RELEASE_CHECK_SKIP_BROWSER: "1" }),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /production_browser_skip_disabled|hosted_browser_evidence/,
  );
});

test("production release gate rejects stale and live-deploy-mismatched evidence", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({ generated_at: "2026-06-23T00:00:00.000Z" }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /fresh_evidence_bundle/,
  );

  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence(),
        env: productionEnv({ VIVA_LIVE_WEB_DEPLOY_ID: "web-live-different" }),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /deploy_id_match/,
  );
});

test("production release gate rejects hosted origin mismatches despite config hashes", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          browser_e2e: completeBrowserEvidence({
            hosted_e2e: completeHostedE2e({ web_url: "https://wrong-web.example.com" }),
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /config_parity/,
  );
});

test("production release gate rejects stale live-smoke evidence", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ generated_at: "2026-06-23T00:00:00.000Z" }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /budget_capped_live_smoke/,
  );
});

test("production release gate requires executed recovery results", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          hosted_e2e_matrix: buildHostedE2eMatrixContract({
            generatedAt: "2026-06-25T00:00:00.000Z",
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /submitted_answer_recovery_matrix/,
  );
});

test("production release gate requires observed provider failure proof", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          provider_failure_observability: completeProviderFailureObservability({
            observations: [{ query_id: "provider_429", sanitized: true }],
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /provider_failure_recovery_proof/,
  );
});

test("production release gate requires explicit sanitized release evidence", () => {
  const evidence = completeEvidence();
  delete evidence.sanitized;
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence,
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /release_evidence_sanitized/,
  );
});

test("production release gate rejects ephemeral durability when durable tickets are claimed", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          browser_e2e: completeBrowserEvidence({
            hosted_e2e: completeHostedE2e({ postgres_durability: "in_memory" }),
          }),
          live_smoke: completeLiveSmoke({ readiness: { store: { durable: false } } }),
        }),
        env: productionEnv({ VIVA_RELEASE_POSTGRES_STATE: "in_memory" }),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /postgres_durability/,
  );
});

test("non-production release evidence records missing proof without failing local checks", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence({
      browser_e2e: { skipped: true },
      live_smoke: null,
    }),
    env: {},
    now: new Date("2026-06-25T00:30:00.000Z"),
  });

  assert.equal(evidence.production_release_gate.production_requested, false);
  assert.equal(evidence.production_release_gate.allowed, false);
  assert.equal(evidence.production_release_gate.reason, "non_production_release_check");
  assert.equal(evidence.release_bundle.integrity.signature_algorithm, "sha256-self");
  assert.equal(evidence.release_bundle.integrity.verified, true);
});

function productionEnv(overrides = {}) {
  return {
    CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
    GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
    VIVA_GEMINI_QUOTA_CONFIRMED: "1",
    VIVA_GEMINI_QUOTA_RPM_LIMIT: "60",
    VIVA_GEMINI_QUOTA_TPM_LIMIT: "60000",
    VIVA_LIVE_AGENT_DEPLOY_ID: "agent-deploy-456",
    VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "262144",
    VIVA_LIVE_SMOKE_MAX_DURATION_MS: "90000",
    VIVA_LIVE_SMOKE_MAX_TURNS: "1",
    VIVA_LIVE_WEB_DEPLOY_ID: "web-deploy-123",
    VIVA_PROVIDER_LIMITER_STATE: "enabled",
    VIVA_PRODUCTION_RELEASE: "1",
    VIVA_RELEASE_AGENT_DEPLOY_ID: "agent-deploy-456",
    VIVA_RELEASE_AGENT_ORIGIN: "https://agent.example.com",
    VIVA_RELEASE_BUNDLE_SIGNING_SECRET: "test-release-bundle-signing-secret",
    VIVA_RELEASE_CHECK_SKIP_BROWSER: "0",
    VIVA_RELEASE_CONFIG_DIFF_SHA256: SHA,
    VIVA_RELEASE_OWNER: "release-owner",
    VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T00:00:00Z",
    VIVA_RELEASE_OWNER_DECISION: "proceed",
    VIVA_RELEASE_POSTGRES_STATE: "postgres_ready",
    VIVA_RELEASE_PROVIDER_MODE: "cartesia_gemini",
    VIVA_RELEASE_RECOVERY_VALIDATION: "hosted-browser-live-smoke-recovery-matrix-passed",
    VIVA_RELEASE_SECRETS_SNAPSHOT_SHA256: SHA,
    VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
    VIVA_RELEASE_WEB_ORIGIN: "https://web.example.com",
    VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
    ...overrides,
  };
}

function completeEvidence(overrides = {}) {
  const generatedAt = overrides.generated_at ?? "2026-06-25T00:00:00.000Z";
  return {
    generated_at: generatedAt,
    schema: "viva.release_evidence.v1",
    artifact_audit: { forbidden_hits: 0, scanned_files: 7 },
    browser_e2e: completeBrowserEvidence(),
    commands: [],
    failure_control_harness: {
      schema: "viva.failure_control_harness.v1",
      enabled_for_release: false,
      sanitized: true,
    },
    fixture_hashes: {},
    hosted_e2e_matrix: completeHostedE2eMatrix(generatedAt),
    live_smoke: completeLiveSmoke(),
    privacy: completePrivacy(),
    provider_failure_observability: completeProviderFailureObservability(),
    provider_readiness: completeProviderReadiness(),
    release_bundle: {
      browser_story_artifacts: [],
      command_logs: [],
      evidence_json: "artifacts/release-check/evidence.json",
    },
    rollback_drain: completeRollbackDrain(),
    sanitized: true,
    ...overrides,
  };
}

function completeBrowserEvidence(overrides = {}) {
  return {
    agent_provider: "synthetic",
    browser_story: { artifact_forbidden_hits: 0 },
    hosted_e2e: completeHostedE2e(),
    ...overrides,
  };
}

function completeHostedE2e(overrides = {}) {
  return {
    schema: "viva.hosted_e2e_result.v1",
    agent_url: "https://agent.example.com",
    control_mode: "none",
    deploy_ids: { agent: "agent-deploy-456", web: "web-deploy-123" },
    failure_class: null,
    hosted_mode: true,
    model: "synthetic-viva",
    postgres_durability: "durable",
    provider: "synthetic",
    recap_success: true,
    redaction_audit: { forbidden_hits: 0, sanitized: true },
    scenario_id: "happy_path",
    stage: "feedback",
    terminal_reason: "completed",
    token_refresh_outcome: "not_required",
    web_url: "https://web.example.com",
    ...overrides,
  };
}

function completeLiveSmoke(overrides = {}) {
  return {
    schema: "viva.live_provider_smoke.v1",
    caps: {
      max_audio_bytes: 262_144,
      max_duration_ms: 90_000,
      max_session_cost_usd: 0.25,
      max_turns: 1,
    },
    enabled: true,
    generated_at: "2026-06-25T00:10:00.000Z",
    provider: "cartesia_gemini",
    readiness: {
      store: { durable: true },
    },
    status: "passed",
    ...overrides,
  };
}

function completeHostedE2eMatrix(generatedAt) {
  return {
    ...buildHostedE2eMatrixContract({ generatedAt }),
    results: [
      "provider_rate_limited",
      "provider_timeout",
      "invalid_token",
      "expired_token",
      "replayed_token",
      "double_submit_race",
      "deterministic_partial_recap",
    ].map((scenarioId) => ({
      scenario_id: scenarioId,
      status: "passed",
      sanitized: true,
    })),
  };
}

function completePrivacy() {
  return {
    answers_persisted: false,
    consent_disclosure_in_product: true,
    deletion_proof: {
      proves_removed: ["answer-attempt envelopes", "usage rows", "recaps", "review items"],
      proves_session_tombstoned: true,
    },
    raw_audio_persisted: false,
    transcripts_persisted: false,
  };
}

function completeProviderFailureObservability(overrides = {}) {
  return {
    schema: "viva.provider_failure_observability.v1",
    log_queries: [
      { id: "provider_429" },
      { id: "provider_timeout" },
      { id: "token_refresh_failure" },
      { id: "recap_failure" },
      { id: "release_gate_stale_evidence" },
    ],
    observations: [
      { query_id: "provider_429", sanitized: true },
      { query_id: "provider_timeout", sanitized: true },
      { query_id: "token_refresh_failure", sanitized: true },
      { query_id: "recap_failure", sanitized: true },
      { query_id: "release_gate_stale_evidence", sanitized: true },
    ],
    sanitized: true,
    ...overrides,
  };
}

function completeProviderReadiness() {
  return {
    schema: "viva.provider_readiness_matrix.v1",
    providers: [{ provider: "cartesia_gemini" }],
  };
}

function completeRollbackDrain() {
  return {
    schema: "viva.rollback_release_gate.v1",
    production_release_gate: {
      allowed: true,
      owner_decision_allows_release: true,
      owner_decision_present: true,
      thresholds_present: true,
    },
    production_snapshot: {
      agent_deploy_id: "agent-deploy-456",
      config_diff_sha256: SHA,
      postgres_state: "postgres_ready",
      provider_mode: "cartesia_gemini",
      recovery_validation: "hosted-browser-live-smoke-recovery-matrix-passed",
      web_deploy_id: "web-deploy-123",
    },
  };
}
