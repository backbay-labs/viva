import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertProviderLimiterReleaseEvidence,
  parseProviderLimiterAdmissionProof,
  providerLimiterReleaseEvidence,
  PROVIDER_LIMITER_ADMISSION_TEST_ARGS,
  PROVIDER_LIMITER_ADMISSION_TEST_BINARY,
  PROVIDER_LIMITER_ADMISSION_TEST_NAME,
  PROVIDER_LIMITER_ADMISSION_TEST_PACKAGE,
} from "./provider-limiter-evidence.mjs";

const VOICE_WS_INTEGRATION_TEST_PATH = "agent/crates/agent-service/tests/voice_ws.rs";

// Captured verbatim from a real, passing invocation of the exact release
// command this task binds evidence to (stdout only; RUSTUP_TOOLCHAIN=1.94.1):
//   cargo test --manifest-path agent/Cargo.toml -p agent-service \
//     --test voice_ws websocket_provider_backoff_denies_next_answer_before_brain_input \
//     -- --exact --nocapture
const REAL_SINGLE_PASS_LOG =
  "\nrunning 1 test\n" +
  "test websocket_provider_backoff_denies_next_answer_before_brain_input ... ok\n\n" +
  "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 126 filtered out; finished in 0.05s\n";

// Captured verbatim from the same command with the test name replaced by a
// nonexistent identifier: cargo's `--exact` filter matches nothing, cargo
// itself still exits 0, and the release-check `run()` helper (which only
// checks the child's exit code) would otherwise treat this as success.
const REAL_ZERO_TEST_LOG =
  "\nrunning 0 tests\n\n" +
  "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 127 filtered out; finished in 0.00s\n";

test("provider limiter admission proof constant names the exact release command target", () => {
  assert.equal(
    PROVIDER_LIMITER_ADMISSION_TEST_NAME,
    "websocket_provider_backoff_denies_next_answer_before_brain_input",
  );
  assert.deepEqual(PROVIDER_LIMITER_ADMISSION_TEST_ARGS, [
    "test",
    "--manifest-path",
    "agent/Cargo.toml",
    "-p",
    PROVIDER_LIMITER_ADMISSION_TEST_PACKAGE,
    "--test",
    PROVIDER_LIMITER_ADMISSION_TEST_BINARY,
    PROVIDER_LIMITER_ADMISSION_TEST_NAME,
    "--",
    "--exact",
    "--nocapture",
  ]);
});

test("provider limiter admission proof names a Rust test that actually exists in the voice_ws integration suite", async () => {
  // Cheap cross-file drift guard only (mirrors scripts/e2e-browser-static.test.mjs's
  // protocol-version pinning): proves the name has not silently drifted from
  // source, but never substitutes for the execution/count proof below.
  const source = await readFile(VOICE_WS_INTEGRATION_TEST_PATH, "utf8");
  assert.match(source, new RegExp(`async fn ${PROVIDER_LIMITER_ADMISSION_TEST_NAME}\\(\\)`));
});

test("provider limiter admission proof parses a real single-passed-test cargo log", () => {
  const proof = parseProviderLimiterAdmissionProof(REAL_SINGLE_PASS_LOG);

  assert.equal(proof.test_name, PROVIDER_LIMITER_ADMISSION_TEST_NAME);
  assert.equal(proof.passed_count, 1);
  assert.match(proof.log_sha256, /^[a-f0-9]{64}$/);
});

test("provider limiter admission proof rejects a zero-test cargo filter even though cargo itself exits 0", () => {
  assert.throws(
    () => parseProviderLimiterAdmissionProof(REAL_ZERO_TEST_LOG),
    /did not observe exactly one passed execution/,
  );
});

test("provider limiter admission proof rejects a log that never names the expected test", () => {
  assert.throws(
    () => parseProviderLimiterAdmissionProof(REAL_SINGLE_PASS_LOG, { testName: "some_other_test_name" }),
    /did not observe exactly one passed execution/,
  );
});

test("provider limiter admission proof rejects an empty or missing log", () => {
  assert.throws(() => parseProviderLimiterAdmissionProof(""), /log is empty/);
  assert.throws(() => parseProviderLimiterAdmissionProof(undefined), /log is empty/);
});

test("provider limiter release evidence is enabled and names admission proofs generated from an executed test run", () => {
  const proof = parseProviderLimiterAdmissionProof(REAL_SINGLE_PASS_LOG);
  const evidence = providerLimiterReleaseEvidence({ env: {}, proof });

  assert.equal(evidence.schema, "viva.provider_limiter.v1");
  assert.equal(evidence.enabled_for_release, true);
  assert.equal(evidence.required_event_kind, "provider_admission");
  assert.deepEqual(evidence.required_detail_fields, {
    admitted: ["admission_decision", "queue_depth", "queue_delay_ms", "budget_state"],
    denied: [
      "admission_decision",
      "reason",
      "terminal_reason",
      "queue_depth",
      "queue_delay_ms",
      "retry_after_ms",
      "reset_hint",
      "budget_state",
    ],
  });
  assert.equal(evidence.proved_by.agent_service_test, PROVIDER_LIMITER_ADMISSION_TEST_NAME);
  assert.equal(evidence.proved_by.passed_count, 1);
  assert.equal(evidence.proved_by.log_sha256, proof.log_sha256);
  assert.match(evidence.proved_by.command, /--exact/);
  assert.match(evidence.proved_by.command, /--test voice_ws/);
  // The evidence may name the command and a sanitized digest, but must never
  // embed the raw captured test output.
  assert.doesNotMatch(JSON.stringify(evidence), /running 1 test/);
  assertProviderLimiterReleaseEvidence(evidence);
});

test("provider limiter release evidence fails closed when the admission proof is missing, incomplete, or names the wrong test", () => {
  assert.throws(
    () => providerLimiterReleaseEvidence({ env: {} }),
    /executed admission-test proof/,
  );
  assert.throws(
    () =>
      providerLimiterReleaseEvidence({
        env: {},
        proof: { test_name: PROVIDER_LIMITER_ADMISSION_TEST_NAME, passed_count: 0, log_sha256: "a".repeat(64) },
      }),
    /executed admission-test proof/,
  );
  assert.throws(
    () =>
      providerLimiterReleaseEvidence({
        env: {},
        proof: { test_name: "a_different_test", passed_count: 1, log_sha256: "a".repeat(64) },
      }),
    /executed admission-test proof/,
  );
  assert.throws(
    () =>
      assertProviderLimiterReleaseEvidence({
        schema: "viva.provider_limiter.v1",
        enabled_for_release: true,
        required_event_kind: "provider_admission",
        required_detail_fields: {
          admitted: ["admission_decision", "queue_depth", "queue_delay_ms", "budget_state"],
          denied: [
            "admission_decision",
            "reason",
            "terminal_reason",
            "queue_depth",
            "queue_delay_ms",
            "retry_after_ms",
            "reset_hint",
            "budget_state",
          ],
        },
        proved_by: { agent_service_test: PROVIDER_LIMITER_ADMISSION_TEST_NAME },
        sanitized_evidence: true,
      }),
    /must report exactly one executed passed test/,
  );
});

test("provider limiter release evidence fails closed when disabled or incomplete", () => {
  assert.throws(
    () => providerLimiterReleaseEvidence({ env: { VIVA_PROVIDER_LIMITER_ENABLED: "0" } }),
    /provider limiter disabled/,
  );

  assert.throws(
    () =>
      assertProviderLimiterReleaseEvidence({
        schema: "viva.provider_limiter.v1",
        enabled_for_release: true,
        required_event_kind: "provider_admission",
        required_detail_fields: { admitted: [], denied: [] },
        proved_by: {},
      }),
    /missing provider limiter evidence fields/,
  );
});
