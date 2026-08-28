import assert from "node:assert/strict";
import test from "node:test";

import { buildFailureControlPlan, failureControlHarnessEvidence } from "./failure-control-harness.mjs";
import { buildHostedE2eMatrixContract } from "./hosted-e2e-matrix.mjs";
import {
  assertProductionReleaseGate,
  assertReleaseBundleIntegrity,
  buildProductionReleaseGateEvidence,
  buildReleaseBundleIntegrity,
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  finalizeReleaseEvidenceBundle,
  FORBIDDEN_EVIDENCE_MARKERS,
  GATE_ONLY_EVIDENCE_MARKERS,
  positiveIntegerOrDefault,
  PRODUCTION_RELEASE_GATE_SCHEMA,
  RELEASE_BUNDLE_INTEGRITY_SCHEMA,
} from "./production-release-gate.mjs";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AGENT_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const MONITOR_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

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
  assert.equal(evidence.production_release_gate.container_provenance.build_inputs_pinned, true);
  assert.equal(evidence.production_release_gate.container_provenance.agent_image_digest_match, true);
  assert.equal(evidence.production_release_gate.container_provenance.monitor_image_digest_match, true);
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

test("RELEASE-004: assertReleaseBundleIntegrity's requireHmac option requires a real signing secret and never accepts an env-driven algorithm downgrade", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence(),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });
  assert.equal(evidence.release_bundle.integrity.signature_algorithm, "hmac-sha256");

  // A verifying environment with no secret must reject a production bundle
  // outright -- it must never silently recompute the "expected" signature
  // as a self-hash (the pre-RELEASE-004 behavior) just because the
  // verifier's own environment happens to lack the secret. That is exactly
  // the downgrade this option exists to prevent.
  const envWithoutSecret = { ...productionEnv(), VIVA_RELEASE_BUNDLE_SIGNING_SECRET: undefined };
  assert.throws(
    () => assertReleaseBundleIntegrity(evidence, { env: envWithoutSecret, requireHmac: true }),
    /VIVA_RELEASE_BUNDLE_SIGNING_SECRET/,
  );

  // requireHmac defaults to false and stays fully backward compatible: a
  // bundle that was itself generated with no secret in the first place
  // (self-signed) still only checks self-consistency against a matching
  // (also secret-less) verifying environment, exactly as before this
  // option existed.
  const selfSignedEvidence = { schema: "viva.release_evidence.v1", release_bundle: {} };
  const selfSignedIntegrity = buildReleaseBundleIntegrity({ evidence: selfSignedEvidence, env: {} });
  assert.equal(selfSignedIntegrity.signature_algorithm, "sha256-self");
  const selfSignedBundle = {
    ...selfSignedEvidence,
    release_bundle: { ...selfSignedEvidence.release_bundle, integrity: selfSignedIntegrity },
  };
  assert.doesNotThrow(() => assertReleaseBundleIntegrity(selfSignedBundle, { env: {} }));
});

test("RELEASE-004: assertReleaseBundleIntegrity's requireHmac rejects a bundle relabeled sha256-self even when the verifying environment also lacks a secret", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence(),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });
  const relabeled = {
    ...evidence,
    release_bundle: {
      ...evidence.release_bundle,
      // Re-sign the exact same (otherwise untampered) payload with no
      // secret at all -- what an attacker able to overwrite the stored
      // bundle, but not read the secret, could produce.
      integrity: buildReleaseBundleIntegrity({ evidence, env: {} }),
    },
  };
  assert.equal(relabeled.release_bundle.integrity.signature_algorithm, "sha256-self");
  assert.throws(
    () => assertReleaseBundleIntegrity(relabeled, { env: {}, requireHmac: true }),
    /VIVA_RELEASE_BUNDLE_SIGNING_SECRET/,
  );
});

test("RELEASE-004: assertReleaseBundleIntegrity's requireHmac rejects signature_key_present !== true even when payload and signature still match", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence(),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });
  const tampered = {
    ...evidence,
    release_bundle: {
      ...evidence.release_bundle,
      integrity: { ...evidence.release_bundle.integrity, signature_key_present: false },
    },
  };
  assert.throws(
    () => assertReleaseBundleIntegrity(tampered, { env: productionEnv(), requireHmac: true }),
    /signature_key_present/,
  );
});

test("RELEASE-005/006/009/010/011: production-release-gate.mjs derives its FORBIDDEN_EVIDENCE_MARKERS from the one canonical redaction-control.mjs list plus explicit gate-only additions, not an independent duplicate", () => {
  assert(GATE_ONLY_EVIDENCE_MARKERS.includes("raw_prompt"));
  assert(GATE_ONLY_EVIDENCE_MARKERS.includes("provider_prompt"));
  // Every canonical marker (including ones this file's own list previously
  // omitted, like the physiology fixture strings and the release-check
  // placeholder-key literals) must be present here too -- proving this is a
  // superset of the canonical list, not a hand-typed, independently
  // drifting subset.
  for (const marker of ["preload stroke volume cardiac output", "NADH donates high-energy electrons", "viva-release-check-cartesia-placeholder-key", "bearer."]) {
    assert(FORBIDDEN_EVIDENCE_MARKERS.includes(marker), `expected canonical marker "${marker}" to be present`);
  }
});

test("RELEASE-005/006/009/010/011: assertProductionReleaseGate's marker scan is controlled by the caller's injected env, not process.env", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence(),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });
  assert.equal(evidence.production_release_gate.hosted_browser_evidence.model, "synthetic-viva");

  const envWithLeakedValue = { ...productionEnv(), FAKE_SECRET_TOKEN: "synthetic-viva" };
  assert.throws(
    () => assertProductionReleaseGate(evidence, { env: envWithLeakedValue }),
    /includes secret value from FAKE_SECRET_TOKEN/,
  );

  // This test process's own real process.env has no such key, so calling
  // with the default env parameter must not throw -- proving the scan
  // reads the passed-in `env` argument, not process.env.
  assert.equal("FAKE_SECRET_TOKEN" in process.env, false);
  assert.doesNotThrow(() => assertProductionReleaseGate(evidence));
});

test("RELEASE-005/006/009/010/011: DEFAULT_MAX_EVIDENCE_AGE_SECONDS and positiveIntegerOrDefault are exported for reuse by release-check-core.mjs's own release_gate summary", () => {
  assert.equal(DEFAULT_MAX_EVIDENCE_AGE_SECONDS, 24 * 60 * 60);
  assert.equal(positiveIntegerOrDefault("3600", DEFAULT_MAX_EVIDENCE_AGE_SECONDS), 3600);
  assert.equal(positiveIntegerOrDefault(undefined, DEFAULT_MAX_EVIDENCE_AGE_SECONDS), DEFAULT_MAX_EVIDENCE_AGE_SECONDS);
  assert.equal(positiveIntegerOrDefault("not-a-number", DEFAULT_MAX_EVIDENCE_AGE_SECONDS), DEFAULT_MAX_EVIDENCE_AGE_SECONDS);
  assert.equal(positiveIntegerOrDefault("-5", DEFAULT_MAX_EVIDENCE_AGE_SECONDS), DEFAULT_MAX_EVIDENCE_AGE_SECONDS);
});

test("production release gate marks BAC-528 unsafe when failure-control harness evidence truthfully reports itself enabled, independent of release-check's own throw", () => {
  // scripts/release-check.mjs independently throws before assembling any
  // evidence when its own in-process failure-control plan is enabled
  // (scripts/release-check.mjs:84-86). This test proves the second,
  // independent layer -- the gate's `bac_528_harness_disabled` proof --
  // also attests something real on its own: even in a fixture that bypasses
  // that throw entirely (never calls it), a bundle whose
  // `failure_control_harness.enabled_for_release` is `true` must be flagged
  // unsafe, not silently passed.
  const enabledPlan = buildFailureControlPlan({
    env: {
      VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: "https://viva.example",
      VIVA_FAILURE_CONTROL_ENABLED: "1",
      VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY: "1",
      VIVA_FAILURE_CONTROL_SCENARIO: "provider_rate_limited",
      VIVA_FAILURE_CONTROL_SECRET: "control-secret",
      VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: "synthetic-user",
      VIVA_FAILURE_CONTROL_STUDY_SET_IDS: "biology-midterm",
    },
  });
  const enabledHarnessEvidence = failureControlHarnessEvidence(enabledPlan);
  assert.equal(enabledHarnessEvidence.enabled_for_release, true);

  const gate = buildProductionReleaseGateEvidence({
    evidence: completeEvidence({ failure_control_harness: enabledHarnessEvidence }),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });

  assert.equal(gate.issue_proofs.bac_528_harness_disabled, false);
  assert.equal(gate.allowed, false);
  assert(gate.missing_required_evidence.includes("bac528_harness_disabled"));

  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({ failure_control_harness: enabledHarnessEvidence }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /bac528_harness_disabled/,
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

test("production release gate rejects future-dated live-smoke evidence", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ generated_at: "2026-06-25T00:45:00.000Z" }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /budget_capped_live_smoke/,
  );
});

test("production release gate rejects live smoke evidence with a missing or one-character-different run_id", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ run_id: null }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_run_id_match/,
  );

  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          // One character different from productionEnv()'s "release-run-1".
          live_smoke: completeLiveSmoke({ run_id: "release-run-2" }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_run_id_match/,
  );
});

test("production release gate rejects live smoke evidence with a missing or mismatched agent_deploy_id", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ agent_deploy_id: null }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_agent_deploy_match/,
  );

  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ agent_deploy_id: "agent-deploy-999" }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_agent_deploy_match/,
  );
});

test("production release gate rejects live smoke evidence with a missing or mismatched deploy_sha", () => {
  // deploy_sha is a release's own primary identity key exactly like run_id
  // and agent_deploy_id (the two tests above using this same env) -- a
  // missing expected value is a verification failure, not a skip, so it
  // must never silently pass just because VIVA_RELEASE_DEPLOY_SHA (or the
  // live smoke evidence's own deploy_sha) happens to be absent.
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ deploy_sha: null }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_deploy_sha_match/,
  );

  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ deploy_sha: "deploy-sha-different" }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_deploy_sha_match/,
  );
});

test("production release gate rejects production evidence when VIVA_RELEASE_DEPLOY_SHA itself is absent from the environment, never silently skipping the check", () => {
  // Reproduces the exact review-reported gap: a production gate whose
  // live_smoke.deploy_sha is wrong must not report deploy_sha_match: true
  // (and omit live_smoke_deploy_sha_match from missing_required_evidence)
  // just because the operator forgot to set VIVA_RELEASE_DEPLOY_SHA.
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({ deploy_sha: "TOTALLY-WRONG-SHA-FROM-ANOTHER-BUILD" }),
        }),
        env: productionEnv({ VIVA_RELEASE_DEPLOY_SHA: undefined }),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /live_smoke_deploy_sha_match/,
  );
});

test("production release gate allows and truthfully attests matching deploy_sha", () => {
  const matching = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence({
      live_smoke: completeLiveSmoke({ deploy_sha: "deploy-sha-abc" }),
    }),
    env: productionEnv({ VIVA_RELEASE_DEPLOY_SHA: "deploy-sha-abc" }),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });
  assert.equal(matching.production_release_gate.live_smoke.deploy_sha_match, true);
  assert.equal(matching.production_release_gate.allowed, true);
});

test("RELEASE-026: production release gate rejects missing container image digests", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence(),
        env: productionEnv({ VIVA_RELEASE_AGENT_IMAGE_DIGEST: undefined }),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /container_agent_image_digest/,
  );
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence(),
        env: productionEnv({ VIVA_RELEASE_MONITOR_IMAGE_DIGEST: undefined }),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /container_monitor_image_digest/,
  );
});

test("RELEASE-026: production release gate rejects a stored container image digest that no longer matches the verifying environment's expected digest", () => {
  // Exactly the RELEASE-003/007/008 binding pattern applied to container
  // images: the *stored* evidence value and the *verifying* environment's
  // expected value are two independent sources that must agree -- a missing
  // expected value is a verification failure, not a skip.
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          container_provenance: completeContainerProvenance({
            deployment_outputs: {
              status: "proven",
              agent_image_digest: `sha256:${"9".repeat(64)}`,
              monitor_image_digest: MONITOR_IMAGE_DIGEST,
            },
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /container_agent_image_digest/,
  );
});

test("RELEASE-026: production release gate rejects tag-only, malformed, or swapped output-image digests", () => {
  for (const badAgentDigest of ["latest", "v1.2.3", "sha256:not-hex", AGENT_IMAGE_DIGEST.slice(0, -1)]) {
    assert.throws(
      () =>
        finalizeReleaseEvidenceBundle({
          evidence: completeEvidence({
            container_provenance: completeContainerProvenance({
              deployment_outputs: {
                status: "proven",
                agent_image_digest: badAgentDigest,
                monitor_image_digest: MONITOR_IMAGE_DIGEST,
              },
            }),
          }),
          env: productionEnv(),
          now: new Date("2026-06-25T00:30:00.000Z"),
        }),
      /container_agent_image_digest/,
      `expected rejection for malformed agent digest ${JSON.stringify(badAgentDigest)}`,
    );
  }

  // Swapped: the agent and monitor digests were written to the wrong field.
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          container_provenance: completeContainerProvenance({
            deployment_outputs: {
              status: "proven",
              agent_image_digest: MONITOR_IMAGE_DIGEST,
              monitor_image_digest: AGENT_IMAGE_DIGEST,
            },
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /container_agent_image_digest|container_monitor_image_digest/,
  );
});

test("RELEASE-026: production release gate rejects unpinned container build_inputs, and a base-image digest can never masquerade as a deployed output digest", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          container_provenance: completeContainerProvenance({
            build_inputs: {
              base_images: {
                rust_builder: "rust:1.94.1-slim-bookworm", // mutable tag, no digest
                debian_runtime: "debian:bookworm-slim@sha256:" + "a".repeat(64),
                playwright_monitor: "mcr.microsoft.com/playwright:v1.61.0-noble@sha256:" + "b".repeat(64),
              },
              bun_archives: {
                "linux/amd64": { name: "bun-linux-x64.zip", sha256: "c".repeat(64) },
                "linux/arm64": { name: "bun-linux-aarch64.zip", sha256: "d".repeat(64) },
              },
              bun_version: "1.3.3",
            },
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /container_build_inputs_pinned/,
  );

  // A base-image digest supplied as if it were the deployment's own output
  // digest is exactly as unproven as a completely missing one: the gate
  // compares against VIVA_RELEASE_AGENT_IMAGE_DIGEST, never against
  // build_inputs, so this can only "pass" by accident if the operator's own
  // expected env value happens to equal a base image digest too -- which the
  // production env fixture below deliberately does not.
  const baseImageDigestRef = REVIEWED_BUILD_INPUTS().base_images.debian_runtime;
  const baseImageDigestOnly = `sha256:${baseImageDigestRef.split("@sha256:")[1]}`;
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          container_provenance: completeContainerProvenance({
            deployment_outputs: {
              status: "proven",
              agent_image_digest: baseImageDigestOnly,
              monitor_image_digest: MONITOR_IMAGE_DIGEST,
            },
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /container_agent_image_digest/,
  );
});

test("production release gate requires observed remote live-smoke cost cap", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          live_smoke: completeLiveSmoke({
            readiness: {
              store: { durable: true },
              voice_limits: { max_session_cost_usd: 0.5 },
            },
          }),
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

test("production release gate does not let provider-failure fixtures certify observations", () => {
  assert.throws(
    () =>
      finalizeReleaseEvidenceBundle({
        evidence: completeEvidence({
          provider_failure_observability: completeProviderFailureObservability({
            observations: [
              { query_id: "token_refresh_failure", sanitized: true },
              { query_id: "recap_failure", sanitized: true },
            ],
            fixture: {
              events: [
                { query_id: "provider_429", sanitized: true },
                { query_id: "provider_timeout", sanitized: true },
                { query_id: "release_gate_stale_evidence", sanitized: true },
              ],
            },
          }),
        }),
        env: productionEnv(),
        now: new Date("2026-06-25T00:30:00.000Z"),
      }),
    /provider_failure_recovery_proof/,
  );
});

test("production release gate does not require a stale-gate incident observation", () => {
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: completeEvidence({
      provider_failure_observability: completeProviderFailureObservability({
        observations: [
          { query_id: "provider_429", sanitized: true },
          { query_id: "provider_timeout", sanitized: true },
          { query_id: "token_refresh_failure", sanitized: true },
          { query_id: "recap_failure", sanitized: true },
        ],
      }),
    }),
    env: productionEnv(),
    now: new Date("2026-06-25T00:30:00.000Z"),
  });

  assert.equal(evidence.production_release_gate.allowed, true);
  assert.equal(
    evidence.production_release_gate.provider_failure_recovery_proof.missing_observed_query_ids
      .includes("release_gate_stale_evidence"),
    false,
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
    // RELEASE-003/007/008: the release's own run identity. run_id,
    // agent_deploy_id (VIVA_RELEASE_AGENT_DEPLOY_ID above), and deploy_sha
    // are all always required in production -- a missing expected value is
    // a verification failure, not a skip -- so this base fixture carries a
    // real VIVA_RELEASE_DEPLOY_SHA matching completeLiveSmoke()'s default
    // deploy_sha, exactly the way it already carries VIVA_RELEASE_RUN_ID/
    // VIVA_RELEASE_AGENT_DEPLOY_ID matching that fixture's run_id/
    // agent_deploy_id. The dedicated binding tests below override it
    // explicitly for the missing/mismatching cases.
    VIVA_RELEASE_DEPLOY_SHA: "deploy-sha-abc",
    VIVA_RELEASE_RUN_ID: "release-run-1",
    VIVA_RELEASE_SECRETS_SNAPSHOT_SHA256: SHA,
    VIVA_RELEASE_WEB_DEPLOY_ID: "web-deploy-123",
    VIVA_RELEASE_WEB_ORIGIN: "https://web.example.com",
    // RELEASE-026: the selected deployment's own exact output-image
    // digests -- required in production, and compared against whatever
    // container_provenance.deployment_outputs the stored evidence itself
    // recorded (completeContainerProvenance()'s defaults, below).
    VIVA_RELEASE_AGENT_IMAGE_DIGEST: AGENT_IMAGE_DIGEST,
    VIVA_RELEASE_MONITOR_IMAGE_DIGEST: MONITOR_IMAGE_DIGEST,
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
    container_provenance: completeContainerProvenance(),
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
      voice_limits: {
        max_session_cost_usd: 0.25,
      },
    },
    status: "passed",
    // RELEASE-003/007/008: bound to productionEnv()'s VIVA_RELEASE_RUN_ID /
    // VIVA_RELEASE_AGENT_DEPLOY_ID / VIVA_RELEASE_DEPLOY_SHA by default so
    // the base fixture continues to certify a real release -- all three are
    // always required in production; a missing expected value is a
    // verification failure, not a skip.
    run_id: "release-run-1",
    agent_deploy_id: "agent-deploy-456",
    deploy_sha: "deploy-sha-abc",
    ...overrides,
  };
}

function REVIEWED_BUILD_INPUTS() {
  return {
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
  };
}

function completeContainerProvenance(overrides = {}) {
  return {
    schema: "viva.container_provenance.v1",
    build_inputs: REVIEWED_BUILD_INPUTS(),
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
