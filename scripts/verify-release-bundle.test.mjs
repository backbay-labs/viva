import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHostedE2eMatrixContract } from "./hosted-e2e-matrix.mjs";
import {
  assertReleaseBundleIntegrity,
  buildProductionReleaseGateEvidence,
  buildReleaseBundleIntegrity,
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  finalizeReleaseEvidenceBundle,
} from "./production-release-gate.mjs";
import { verifyReleaseBundleEvidence } from "./verify-release-bundle.mjs";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GENERATED_AT = new Date("2026-06-25T00:30:00.000Z");
// ROW 341/RELEASE-011: the verifier now independently re-checks freshness
// against its own "now" (see assertFreshProductionEvidence), so every fixed-
// GENERATED_AT bundle below verifies at a fixed, nearby "verification
// happened shortly after generation" instant -- never real Date.now(), which
// only drifts further from GENERATED_AT with every day this suite runs.
const VERIFY_NOW = new Date(GENERATED_AT.getTime() + 5 * 60 * 1000);
const AGENT_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const MONITOR_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

test("RELEASE-004: verifies a correctly signed, exactly-identity-matched production bundle and returns a sanitized summary", () => {
  const evidence = productionBundle();

  const summary = verifyReleaseBundleEvidence(evidence, { env: productionEnv(), now: VERIFY_NOW });

  assert.equal(summary.schema, "viva.release_bundle_verification.v1");
  assert.equal(summary.verified, true);
  assert.equal(summary.production_requested, true);
  assert.equal(summary.run_id, "release-run-1");
  assert.equal(summary.deploy_sha, "deploy-sha-abc");
  assert.equal(summary.web_deploy_id, "web-deploy-123");
  assert.equal(summary.agent_deploy_id, "agent-deploy-456");
  assert.equal(summary.payload_sha256, evidence.release_bundle.integrity.payload_sha256);

  const serializedSummary = JSON.stringify(summary);
  assert.doesNotMatch(serializedSummary, /test-release-bundle-signing-secret/);
});

test("RELEASE-004: rejects a production bundle when the verifying environment has no signing secret at all", () => {
  const evidence = productionBundle();
  const envWithoutSecret = { ...productionEnv(), VIVA_RELEASE_BUNDLE_SIGNING_SECRET: undefined };

  assert.throws(
    () => verifyReleaseBundleEvidence(evidence, { env: envWithoutSecret }),
    /VIVA_RELEASE_BUNDLE_SIGNING_SECRET/,
  );
});

test("RELEASE-004: rejects a bundle relabeled sha256-self even when the verifying environment also lacks a secret", () => {
  const evidence = productionBundle();
  const relabeled = {
    ...evidence,
    release_bundle: {
      ...evidence.release_bundle,
      integrity: buildReleaseBundleIntegrity({ evidence, env: {} }),
    },
  };
  assert.equal(relabeled.release_bundle.integrity.signature_algorithm, "sha256-self");

  assert.throws(
    () => verifyReleaseBundleEvidence(relabeled, { env: {} }),
    /VIVA_RELEASE_BUNDLE_SIGNING_SECRET/,
  );
});

test("RELEASE-004: rejects signature_key_present !== true even when the payload and signature still match", () => {
  const evidence = productionBundle();
  const tampered = {
    ...evidence,
    release_bundle: {
      ...evidence.release_bundle,
      integrity: { ...evidence.release_bundle.integrity, signature_key_present: false },
    },
  };

  assert.throws(
    () => verifyReleaseBundleEvidence(tampered, { env: productionEnv() }),
    /signature_key_present/,
  );
});

test("RELEASE-004: rejects a correct HMAC computed with the wrong secret", () => {
  const evidence = productionBundle();
  const wrongSecretEnv = {
    ...productionEnv(),
    VIVA_RELEASE_BUNDLE_SIGNING_SECRET: "a-completely-different-secret",
  };

  assert.throws(
    () => verifyReleaseBundleEvidence(evidence, { env: wrongSecretEnv }),
    /integrity verification failed/,
  );
});

test("RELEASE-004: correct HMAC and exact secret pass integrity, then assertProductionReleaseGate runs over the stored bundle and rejects an honestly incomplete one", () => {
  const complete = productionBundle();
  assert.doesNotThrow(() =>
    verifyReleaseBundleEvidence(complete, { env: productionEnv(), now: VERIFY_NOW }),
  );

  // `finalizeReleaseEvidenceBundle` itself refuses to return an incomplete
  // production bundle (it throws via its own internal
  // assertProductionReleaseGate call before ever handing one back), so an
  // honestly-incomplete-yet-validly-signed bundle has to be assembled the
  // same way finalizeReleaseEvidenceBundle does internally, one step short
  // of its own final assertions: build the gate from evidence that is
  // honestly missing something (an empty provider-readiness list), sign
  // that exact payload for real, and confirm integrity alone still passes.
  const env = productionEnv();
  const draftEvidence = completeEvidence({
    provider_readiness: { schema: "viva.provider_readiness_matrix.v1", providers: [] },
  });
  const gate = buildProductionReleaseGateEvidence({ evidence: draftEvidence, env, now: GENERATED_AT });
  assert.equal(gate.allowed, false);
  assert(gate.missing_required_evidence.includes("bac529_gemini_quota_sufficiency"));
  const withGate = { ...draftEvidence, production_release_gate: gate };
  const integrity = buildReleaseBundleIntegrity({ evidence: withGate, env });
  assert.equal(integrity.signature_algorithm, "hmac-sha256");
  const incomplete = { ...withGate, release_bundle: { ...withGate.release_bundle, integrity } };

  assert.doesNotThrow(() =>
    assertReleaseBundleIntegrity(incomplete, { env, requireHmac: true }),
  );
  assert.throws(
    () => verifyReleaseBundleEvidence(incomplete, { env, now: VERIFY_NOW }),
    /production release blocked/,
  );
});

test("RELEASE-004: rejects a bundle tampered with after storage", () => {
  const evidence = productionBundle();
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
    () => verifyReleaseBundleEvidence(tampered, { env: productionEnv() }),
    /integrity verification failed/,
  );
});

test("RELEASE-004: rejects a correctly-signed but stale bundle whose bound run_id/deploy_sha/deploy ids differ from the verifier's own expected release identity", () => {
  const evidence = productionBundle();

  const mismatches = [
    ["VIVA_RELEASE_RUN_ID", "a-different-run-id"],
    ["VIVA_RELEASE_DEPLOY_SHA", "a-different-deploy-sha"],
    ["VIVA_RELEASE_WEB_DEPLOY_ID", "a-different-web-deploy-id"],
    ["VIVA_RELEASE_AGENT_DEPLOY_ID", "a-different-agent-deploy-id"],
  ];

  for (const [key, mismatchedValue] of mismatches) {
    assert.throws(
      () =>
        verifyReleaseBundleEvidence(evidence, {
          env: { ...productionEnv(), [key]: mismatchedValue },
          now: VERIFY_NOW,
        }),
      /does not match the verifier's expected release identity/,
      `expected a rejection for a mismatched ${key}`,
    );
  }

  // Unmodified, the same bundle still verifies -- proving each mismatch
  // above is what triggered the rejection, not some other fixture defect.
  assert.doesNotThrow(() =>
    verifyReleaseBundleEvidence(evidence, { env: productionEnv(), now: VERIFY_NOW }),
  );
});

test("RELEASE-004: a missing expected-identity value is a verification failure, not a silently skipped check", () => {
  const evidence = productionBundle();
  const envMissingRunId = { ...productionEnv(), VIVA_RELEASE_RUN_ID: undefined };

  assert.throws(
    () => verifyReleaseBundleEvidence(evidence, { env: envMissingRunId, now: VERIFY_NOW }),
    /requires VIVA_RELEASE_RUN_ID/,
  );
});

test("ROW 341/RELEASE-011: the verifier rejects a bundle that was fresh at generation time once it has since aged past the max-age window -- it does not merely trust the stored gate.allowed", () => {
  const evidence = productionBundle();
  // The stored gate said fresh (`allowed: true`) as of GENERATED_AT; nothing
  // about the bundle's own content changes here -- only how much later this
  // verification claims to be happening.
  assert.equal(evidence.production_release_gate.allowed, true);

  const justPastDefaultWindow = new Date(
    GENERATED_AT.getTime() + (DEFAULT_MAX_EVIDENCE_AGE_SECONDS + 1) * 1000,
  );
  assert.throws(
    () =>
      verifyReleaseBundleEvidence(evidence, { env: productionEnv(), now: justPastDefaultWindow }),
    /evidence is stale at verification time/,
  );
  // The bundle's own stored gate is untouched by the rejection above.
  assert.equal(evidence.production_release_gate.allowed, true);
});

test("ROW 341/RELEASE-011: the verifier's own VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS override -- the exact same variable the bundle and gate honor -- controls the verifier's freshness window too", () => {
  const evidence = productionBundle();
  const wellPastDefaultWindow = new Date(
    GENERATED_AT.getTime() + (DEFAULT_MAX_EVIDENCE_AGE_SECONDS + 1) * 1000,
  );

  // Rejected under the default window.
  assert.throws(
    () =>
      verifyReleaseBundleEvidence(evidence, { env: productionEnv(), now: wellPastDefaultWindow }),
    /evidence is stale at verification time/,
  );

  // The identical age, verified again, now passes once the caller's own
  // environment widens the same canonical override.
  assert.doesNotThrow(() =>
    verifyReleaseBundleEvidence(evidence, {
      env: productionEnv({
        VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS: String(DEFAULT_MAX_EVIDENCE_AGE_SECONDS * 2),
      }),
      now: wellPastDefaultWindow,
    }),
  );
});

test("RELEASE-004: a non-production bundle's self-integrity remains diagnosable but its gate can never become allowed: true", () => {
  const nonProductionEnv = productionEnv({ VIVA_PRODUCTION_RELEASE: "0" });
  const evidence = productionBundle({ envOverrides: { VIVA_PRODUCTION_RELEASE: "0" } });
  assert.equal(evidence.production_release_gate.production_requested, false);
  assert.equal(evidence.production_release_gate.allowed, false);

  // Verification does not throw (it is diagnosable, not a hard failure for
  // a non-production bundle -- requireHmac is never forced on just because
  // this bundle happens to still carry a real secret) and it never flips
  // the underlying gate's own `allowed` field -- that stays `false`,
  // permanently, for this bundle.
  const summary = verifyReleaseBundleEvidence(evidence, { env: nonProductionEnv });
  assert.equal(summary.verified, true);
  assert.equal(summary.production_requested, false);
  assert.equal(evidence.production_release_gate.allowed, false);
});

test("RELEASE-004: the CLI accepts exactly one evidence path, verifies a stored bundle, and exits non-zero on failure without leaking the secret", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-verify-release-bundle-"));
  try {
    const evidencePath = path.join(dir, "evidence.json");
    const evidence = freshProductionBundle();
    await writeFile(evidencePath, JSON.stringify(evidence));

    const ok = spawnSync(
      process.execPath,
      ["scripts/verify-release-bundle.mjs", evidencePath],
      { cwd: repoRoot(), encoding: "utf8", env: cliEnv(productionEnv()) },
    );
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout.trim());
    assert.equal(parsed.verified, true);
    assert.equal(parsed.run_id, "release-run-1");

    const wrongSecretEnv = cliEnv({
      ...productionEnv(),
      VIVA_RELEASE_BUNDLE_SIGNING_SECRET: "a-completely-different-secret",
    });
    const failed = spawnSync(
      process.execPath,
      ["scripts/verify-release-bundle.mjs", evidencePath],
      { cwd: repoRoot(), encoding: "utf8", env: wrongSecretEnv },
    );
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.stderr, /test-release-bundle-signing-secret/);
    assert.doesNotMatch(failed.stderr, /a-completely-different-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RELEASE-004: the documented downstream form (docs/deployment-runbook.md), `bun run release:verify -- <path>`, reaches the CLI with the evidence path as its own argument rather than a literal `--`", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-verify-release-bundle-bun-"));
  try {
    const evidencePath = path.join(dir, "evidence.json");
    const evidence = freshProductionBundle();
    await writeFile(evidencePath, JSON.stringify(evidence));

    // package.json's own "release:verify" script is `node
    // scripts/verify-release-bundle.mjs` (asserted separately by
    // scripts/deployment-runbook.test.mjs); this proves the *documented
    // production invocation itself* -- through `bun run`, past its `--`
    // separator -- resolves argv[2] to the evidence path rather than the
    // literal string `--`, which would otherwise fail path resolution
    // silently past this suite's own direct-`node` CLI test above.
    const result = spawnSync("bun", ["run", "release:verify", "--", evidencePath], {
      cwd: repoRoot(),
      encoding: "utf8",
      env: cliEnv(productionEnv()),
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.verified, true);
    assert.equal(parsed.run_id, "release-run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function productionBundle({ envOverrides = {}, evidenceOverrides = {}, now = GENERATED_AT } = {}) {
  return finalizeReleaseEvidenceBundle({
    evidence: completeEvidence(evidenceOverrides),
    env: productionEnv(envOverrides),
    now,
  });
}

// ROW 341/RELEASE-011: a bundle generated at real "now", for the CLI tests
// below, whose own default `now` is the real wall clock at verification
// time (a few milliseconds later) -- so freshness passes on its own
// (comfortably inside even the default 24h window) without an explicit
// override, and the CLI tests stay focused on secret/exit-code behavior.
function freshProductionBundle(overrides = {}) {
  const generatedAt = new Date();
  return productionBundle({
    ...overrides,
    evidenceOverrides: {
      generated_at: generatedAt.toISOString(),
      // completeLiveSmoke()'s own generated_at is otherwise fixed at
      // GENERATED_AT -- freshness there is a separate, pre-existing gate
      // requirement (not this row's concern), so it has to move with the
      // rest of the bundle to keep it satisfied at a live "now".
      live_smoke: completeLiveSmoke({ generated_at: generatedAt.toISOString() }),
      ...(overrides.evidenceOverrides ?? {}),
    },
    now: generatedAt,
  });
}

function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

function cliEnv(source) {
  const env = { PATH: process.env.PATH };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    env[key] = String(value);
  }
  return env;
}

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
    VIVA_RELEASE_DEPLOY_SHA: "deploy-sha-abc",
    VIVA_RELEASE_AGENT_IMAGE_DIGEST: AGENT_IMAGE_DIGEST,
    VIVA_RELEASE_MONITOR_IMAGE_DIGEST: MONITOR_IMAGE_DIGEST,
    VIVA_RELEASE_OWNER: "release-owner",
    VIVA_RELEASE_OWNER_DECIDED_AT_UTC: "2026-06-25T00:00:00Z",
    VIVA_RELEASE_OWNER_DECISION: "proceed",
    VIVA_RELEASE_POSTGRES_STATE: "postgres_ready",
    VIVA_RELEASE_PROVIDER_MODE: "cartesia_gemini",
    VIVA_RELEASE_RECOVERY_VALIDATION: "hosted-browser-live-smoke-recovery-matrix-passed",
    VIVA_RELEASE_RUN_ID: "release-run-1",
    VIVA_RELEASE_SECRETS_SNAPSHOT_SHA256: SHA,
    VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
    VIVA_RELEASE_WEB_ORIGIN: "https://web.example.com",
    VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
    ...overrides,
  };
}

function completeEvidence(overrides = {}) {
  const generatedAt = overrides.generated_at ?? GENERATED_AT.toISOString();
  return {
    generated_at: generatedAt,
    schema: "viva.release_evidence.v1",
    artifact_audit: { forbidden_hits: 0, scanned_files: 7 },
    browser_e2e: completeBrowserEvidence(),
    commands: [],
    container_provenance: completeContainerProvenance(),
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
      voice_limits: { max_session_cost_usd: 0.25 },
    },
    status: "passed",
    run_id: "release-run-1",
    agent_deploy_id: "agent-deploy-456",
    deploy_sha: "deploy-sha-abc",
    ...overrides,
  };
}

function completeContainerProvenance(overrides = {}) {
  return {
    schema: "viva.container_provenance.v1",
    build_inputs: {
      base_images: {
        rust_builder:
          "rust:1.94.1-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2",
        debian_runtime:
          "debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241",
        playwright_monitor:
          "mcr.microsoft.com/playwright:v1.61.0-noble@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a",
      },
      bun_archives: {
        "linux/amd64": {
          name: "bun-linux-x64.zip",
          sha256: "f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d",
        },
        "linux/arm64": {
          name: "bun-linux-aarch64.zip",
          sha256: "41b9f4f25256db897c2c135320e4f96c373e20ae6f06d8015187dac83591efc8",
        },
      },
      bun_version: "1.3.3",
    },
    deployment_outputs: {
      status: "proven",
      agent_image_digest: AGENT_IMAGE_DIGEST,
      monitor_image_digest: MONITOR_IMAGE_DIGEST,
    },
    sanitized: true,
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
