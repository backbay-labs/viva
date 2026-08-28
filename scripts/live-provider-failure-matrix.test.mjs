import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_PROVIDER_FAILURE_MATRIX,
  failureMatrixEvidence,
  liveProviderFailureForSmokeReason,
} from "./live-provider-failure-matrix.mjs";
import {
  isReleaseVoiceTerminalReason,
  RELEASE_LEARNER_LOOP_CONTRACT as learnerLoopContract,
  RELEASE_VOICE_TERMINAL_REASONS,
  validatedLearnerLoopForRelease,
} from "./release-contract-validation.mjs";

const REQUIRED_FAILURE_CLASSES = Object.freeze([
  "provider_auth_failure",
  "quota_rate_failure",
  "timeout",
  "malformed_stream",
  "network_disconnect",
  "durability_degraded",
  "slow_client",
  "cancellation",
  "partial_stage_success",
]);

test("live provider failure matrix covers every Act 3 degradation class", () => {
  const classes = new Set(LIVE_PROVIDER_FAILURE_MATRIX.map((entry) => entry.failure_class));

  for (const failureClass of REQUIRED_FAILURE_CLASSES) {
    assert(classes.has(failureClass), `missing ${failureClass}`);
  }

  for (const entry of LIVE_PROVIDER_FAILURE_MATRIX) {
    assert.match(entry.failure_class, /^[a-z0-9_]+$/);
    assert.match(entry.terminal_reason, /^[a-z0-9_]+$/);
    assert.equal(entry.terminal_session_phase.type, "session_phase");
    assert.equal(entry.terminal_session_phase.phase, "recap");
    assert.equal(entry.terminal_session_phase.terminal_reason, entry.terminal_reason);
    assert.match(entry.evidence_code, /^[a-z0-9_]+$/);
    assert.equal(entry.sanitized_evidence, true);
    assert.equal(typeof entry.user_copy.capsule_label, "string");
    assert.equal(typeof entry.user_copy.marginalia_title, "string");
    assert.equal(typeof entry.user_copy.marginalia_text, "string");
    assert.equal(typeof entry.user_copy.next_action_label, "string");
    assert(entry.user_copy.next_action_label.length > 0);
  }
});

test("live provider failure matrix is reconciled with the BAC-510 learner-loop contract", () => {
  for (const entry of LIVE_PROVIDER_FAILURE_MATRIX) {
    const contractState = learnerLoopContract.states.find(
      (state) =>
        state.failure_class === entry.failure_class &&
        state.terminal_reason === entry.terminal_reason,
    );

    assert(
      contractState,
      `missing learner-loop contract state for ${entry.failure_class}/${entry.terminal_reason}`,
    );
    assert.equal(contractState.stage, entry.stage);
    assert.equal(contractState.copy.capsule_label, entry.user_copy.capsule_label);
    assert.equal(contractState.copy.next_action_label, entry.user_copy.next_action_label);
    assert.equal(contractState.copy.status_label, entry.user_copy.status_label);
    assert.equal(contractState.sanitized_evidence, true);
  }
});

test("live provider failure matrix evidence is sanitized and excludes provider payload fields", () => {
  const evidence = failureMatrixEvidence();
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.schema, "viva.live_provider_failure_matrix.v1");
  assert.equal(evidence.entries.length, LIVE_PROVIDER_FAILURE_MATRIX.length);
  assert.doesNotMatch(serialized, /pcm16_base64/);
  assert.doesNotMatch(serialized, /answer_text/);
  assert.doesNotMatch(serialized, /transcript_final/);
  assert.doesNotMatch(serialized, /source_context/);
  assert.doesNotMatch(serialized, /pasted_text/);
  assert.doesNotMatch(serialized, /session_token/);
  assert.doesNotMatch(serialized, /CARTESIA_API_KEY/);
  assert.doesNotMatch(serialized, /GEMINI_API_KEY/);
});

test("live smoke local terminal reasons map to matrix degradations", () => {
  assert.equal(
    liveProviderFailureForSmokeReason("readiness_not_live_selectable").failure_class,
    "provider_auth_failure",
  );
  assert.equal(
    liveProviderFailureForSmokeReason("readiness_store_unavailable").failure_class,
    "durability_degraded",
  );
  assert.equal(
    liveProviderFailureForSmokeReason("durability_degraded").failure_class,
    "durability_degraded",
  );
  assert.equal(liveProviderFailureForSmokeReason("recap_timeout").failure_class, "timeout");
  assert.equal(liveProviderFailureForSmokeReason("rate_limit").failure_class, "quota_rate_failure");
  assert.equal(
    liveProviderFailureForSmokeReason("cost_budget").failure_class,
    "quota_rate_failure",
  );
  assert.equal(
    liveProviderFailureForSmokeReason("server_error_frame").failure_class,
    "malformed_stream",
  );
  assert.equal(
    liveProviderFailureForSmokeReason("invalid_server_frame").failure_class,
    "malformed_stream",
  );
  assert.equal(
    liveProviderFailureForSmokeReason("socket_closed_before_recap").failure_class,
    "network_disconnect",
  );
  assert.equal(liveProviderFailureForSmokeReason("turn_cap_exceeded").failure_class, "slow_client");
  assert.equal(
    liveProviderFailureForSmokeReason("recap_observed").failure_class,
    "partial_stage_success",
  );
});

// RELEASE-028: the matrix is derived from the *validated* contract singleton,
// and the terminal reasons it publishes are checked against the shared
// published vocabulary rather than a second local list.
test("every wire terminal reason the matrix publishes is in the shared voice terminal vocabulary", () => {
  // `terminal_reason` is what the *server* sends and what the matrix hands to
  // evidence and operator copy; it must be a member of the published closed
  // vocabulary, not a release-side invention. (`smoke_terminal_reasons` are
  // deliberately different: they are the harness's own local stage labels,
  // used only to route a smoke failure back to its wire class.)
  const reasons = LIVE_PROVIDER_FAILURE_MATRIX.map((entry) => entry.terminal_reason);
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    assert.equal(
      isReleaseVoiceTerminalReason(reason),
      true,
      `${reason} is not a published terminal reason`,
    );
  }
  // And the whole matrix is derived from the closed set, never wider than it.
  assert.ok(reasons.length <= RELEASE_VOICE_TERMINAL_REASONS.length);
});

test("the matrix consumes a validated contract: an unknown nested field is refused with the stable code", () => {
  const hostile = structuredClone(
    JSON.parse(JSON.stringify(learnerLoopContract)),
  );
  hostile.states[0].viva_hostile_unknown_key = "viva-hostile-sentinel-value-9f2a";

  assert.throws(
    () => validatedLearnerLoopForRelease(hostile),
    (error) => {
      assert.equal(error.code, "learner_loop_contract_invalid");
      assert.equal(`${error.message}${error.stack}`.includes("viva-hostile-sentinel-value-9f2a"), false);
      return true;
    },
  );
});

test("the matrix's contract-derived rows are frozen against a consumer rewriting them", () => {
  assert.equal(Object.isFrozen(learnerLoopContract.states), true);
  assert.throws(() => {
    learnerLoopContract.states[0].stage = "rewritten";
  }, TypeError);
});
