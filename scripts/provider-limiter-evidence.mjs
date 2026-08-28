import { createHash } from "node:crypto";

const ADMITTED_DETAIL_FIELDS = Object.freeze([
  "admission_decision",
  "queue_depth",
  "queue_delay_ms",
  "budget_state",
]);

const DENIED_DETAIL_FIELDS = Object.freeze([
  "admission_decision",
  "reason",
  "terminal_reason",
  "queue_depth",
  "queue_delay_ms",
  "retry_after_ms",
  "reset_hint",
  "budget_state",
]);

// RELEASE-002/RELEASE-020 (BAC-528's sibling `proved_by` finding): the exact
// Rust integration test this evidence attests to, named once and shared by
// both the evidence builder and the release orchestration command
// (scripts/release-check.mjs) that actually runs it. `--test` scopes cargo
// to the one integration-test binary and `--exact` forbids a substring
// match, so a rename/typo cannot silently widen or narrow the filter.
export const PROVIDER_LIMITER_ADMISSION_TEST_NAME =
  "websocket_provider_backoff_denies_next_answer_before_brain_input";
export const PROVIDER_LIMITER_ADMISSION_TEST_PACKAGE = "agent-service";
export const PROVIDER_LIMITER_ADMISSION_TEST_BINARY = "voice_ws";
export const PROVIDER_LIMITER_ADMISSION_TEST_MANIFEST_PATH = "agent/Cargo.toml";
export const PROVIDER_LIMITER_ADMISSION_TEST_ARGS = Object.freeze([
  "test",
  "--manifest-path",
  PROVIDER_LIMITER_ADMISSION_TEST_MANIFEST_PATH,
  "-p",
  PROVIDER_LIMITER_ADMISSION_TEST_PACKAGE,
  "--test",
  PROVIDER_LIMITER_ADMISSION_TEST_BINARY,
  PROVIDER_LIMITER_ADMISSION_TEST_NAME,
  "--",
  "--exact",
  "--nocapture",
]);
const PROVIDER_LIMITER_ADMISSION_TEST_COMMAND = ["cargo", ...PROVIDER_LIMITER_ADMISSION_TEST_ARGS].join(" ");

export function assertProviderLimiterEnabledForRelease(env = process.env) {
  if (disabled(env.VIVA_PROVIDER_LIMITER_ENABLED)) {
    throw new Error("provider limiter disabled for release evidence generation");
  }
}

/**
 * Parses the captured stdout of PROVIDER_LIMITER_ADMISSION_TEST_ARGS (cargo
 * writes `running N tests` / `test <name> ... ok` / `test result: ...` to
 * stdout, not stderr -- verified against a real run) and proves it observed
 * exactly one passed execution of the named test. A zero-test `--exact`
 * filter (a rename, a typo, or a moved test) still makes cargo itself exit
 * 0 with "0 passed" -- this is the check that catches what an exit-code-only
 * caller cannot.
 */
export function parseProviderLimiterAdmissionProof(
  log,
  { testName = PROVIDER_LIMITER_ADMISSION_TEST_NAME } = {},
) {
  if (typeof log !== "string" || log.trim().length === 0) {
    throw new Error("provider limiter admission proof log is empty");
  }
  const summaryMatch = log.match(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed;/m);
  const passLines = [...log.matchAll(/^test (\S+) \.\.\. ok$/gm)].map((match) => match[1]);
  const passedCount = summaryMatch ? Number.parseInt(summaryMatch[2], 10) : Number.NaN;
  const failedCount = summaryMatch ? Number.parseInt(summaryMatch[3], 10) : Number.NaN;
  const exactPassLineCount = passLines.filter((name) => name === testName).length;
  const observedExactlyOnePass =
    summaryMatch?.[1] === "ok" &&
    passedCount === 1 &&
    failedCount === 0 &&
    passLines.length === 1 &&
    exactPassLineCount === 1;
  if (!observedExactlyOnePass) {
    const summaryDescription = summaryMatch
      ? `${passedCount} passed, ${failedCount} failed`
      : "no cargo test result summary";
    throw new Error(
      `provider limiter admission proof did not observe exactly one passed execution of ${testName} (${summaryDescription})`,
    );
  }
  return Object.freeze({
    test_name: testName,
    passed_count: passedCount,
    log_sha256: sha256Hex(log),
  });
}

export function providerLimiterReleaseEvidence({ env = process.env, proof } = {}) {
  assertProviderLimiterEnabledForRelease(env);
  if (!isValidAdmissionProof(proof)) {
    throw new Error(
      "provider limiter release evidence requires an executed admission-test proof reporting exactly one passed test",
    );
  }
  const evidence = {
    schema: "viva.provider_limiter.v1",
    enabled_for_release: true,
    required_event_kind: "provider_admission",
    required_detail_fields: {
      admitted: [...ADMITTED_DETAIL_FIELDS],
      denied: [...DENIED_DETAIL_FIELDS],
    },
    proved_by: {
      agent_service_test: PROVIDER_LIMITER_ADMISSION_TEST_NAME,
      release_gate_test: "provider-limiter-evidence.test.mjs",
      command: PROVIDER_LIMITER_ADMISSION_TEST_COMMAND,
      passed_count: proof.passed_count,
      log_sha256: proof.log_sha256,
    },
    sanitized_evidence: true,
  };
  assertProviderLimiterReleaseEvidence(evidence);
  return evidence;
}

export function assertProviderLimiterReleaseEvidence(evidence) {
  if (evidence?.schema !== "viva.provider_limiter.v1") {
    throw new Error("missing provider limiter release evidence");
  }
  if (evidence.enabled_for_release !== true) {
    throw new Error("provider limiter disabled in release evidence");
  }
  if (evidence.required_event_kind !== "provider_admission") {
    throw new Error("missing provider admission evidence kind");
  }
  assertFields(
    evidence.required_detail_fields?.admitted,
    ADMITTED_DETAIL_FIELDS,
    "admitted",
  );
  assertFields(evidence.required_detail_fields?.denied, DENIED_DETAIL_FIELDS, "denied");
  if (evidence.proved_by?.agent_service_test !== PROVIDER_LIMITER_ADMISSION_TEST_NAME) {
    throw new Error("missing provider limiter admission test proof");
  }
  if (evidence.proved_by?.passed_count !== 1) {
    throw new Error("provider limiter admission proof must report exactly one executed passed test");
  }
  if (
    typeof evidence.proved_by?.log_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.proved_by.log_sha256)
  ) {
    throw new Error("provider limiter admission proof must record a sanitized log digest");
  }
  if (
    typeof evidence.proved_by?.command !== "string" ||
    !evidence.proved_by.command.includes(PROVIDER_LIMITER_ADMISSION_TEST_NAME)
  ) {
    throw new Error("provider limiter admission proof must record the executed command");
  }
  if (evidence.sanitized_evidence !== true) {
    throw new Error("provider limiter evidence must be sanitized");
  }
}

function isValidAdmissionProof(proof) {
  return (
    proof != null &&
    proof.test_name === PROVIDER_LIMITER_ADMISSION_TEST_NAME &&
    proof.passed_count === 1 &&
    typeof proof.log_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(proof.log_sha256)
  );
}

function assertFields(actual, required, decision) {
  if (!Array.isArray(actual)) {
    throw new Error(`missing provider limiter evidence fields: ${decision}`);
  }
  for (const field of required) {
    if (!actual.includes(field)) {
      throw new Error(`missing provider limiter evidence fields: ${decision}.${field}`);
    }
  }
}

function disabled(value) {
  return ["0", "false", "off", "no"].includes(String(value ?? "").trim().toLowerCase());
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
