import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  FAILURE_CONTROL_SCENARIOS,
  buildFailureControlPlan,
  failureControlScenarioMarker,
  failureControlSessionTargetForScenario,
  failureControlStartIdentity,
  failureControlHarnessEvidence,
  isFailureControlSessionTokenScenario,
  parseFailureControlSessionTarget,
} from "./failure-control-harness.mjs";

const REQUIRED_SCENARIOS = Object.freeze([
  "provider_rate_limited",
  "provider_auth_failed",
  "provider_timeout",
  "silent_stall",
  "provider_malformed_stream",
  "provider_network_disconnect",
  "sonic_tts_timeout",
  "recap_timeout",
  "invalid_token",
  "expired_token",
  "replayed_token",
  "malformed_token",
  "slow_stale_socket_close",
  "double_submit_race",
  "mic_denied",
  "typed_fallback",
]);

test("failure-control harness catalogs every deterministic BAC-528 scenario", () => {
  const ids = new Set(FAILURE_CONTROL_SCENARIOS.map((scenario) => scenario.id));

  for (const id of REQUIRED_SCENARIOS) {
    assert(ids.has(id), `missing deterministic control scenario ${id}`);
  }

  for (const scenario of FAILURE_CONTROL_SCENARIOS) {
    assert.match(scenario.id, /^[a-z0-9_]+$/);
    assert.match(scenario.failure_class, /^[a-z0-9_]+$/);
    assert.match(scenario.stage, /^[a-z0-9_]+$/);
    assert.equal(scenario.sanitized_evidence, true);
    assert.equal(typeof scenario.synthetic_identity_only, "boolean");
    assert.equal(scenario.control_secret_required, true);
    assert.equal(scenario.allowlisted_origin_required, true);
    assert.equal(scenario.release_gate_must_fail_if_enabled, true);
  }

  for (const id of ["invalid_token", "expired_token", "replayed_token", "malformed_token"]) {
    const scenario = FAILURE_CONTROL_SCENARIOS.find((entry) => entry.id === id);
    assert.equal(scenario.failure_class, "auth_material_failure");
    assert.equal(scenario.stage, "session_auth");
    assert.equal(scenario.terminal_reason, "session_auth_rejected");
    assert.equal(isFailureControlSessionTokenScenario(scenario), true);
  }
});

test("failure-control plan is hard-off unless every control gate is present", () => {
  assert.deepEqual(buildFailureControlPlan({ env: {} }), {
    enabled: false,
    reason: "disabled",
  });

  assert.throws(
    () =>
      buildFailureControlPlan({
        env: {
          VIVA_FAILURE_CONTROL_ENABLED: "1",
          VIVA_FAILURE_CONTROL_SCENARIO: "provider_rate_limited",
        },
      }),
    /control secret/,
  );

  assert.throws(
    () =>
      buildFailureControlPlan({
        env: {
          VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: "https://viva.example",
          VIVA_FAILURE_CONTROL_ENABLED: "1",
          VIVA_FAILURE_CONTROL_SCENARIO: "provider_rate_limited",
          VIVA_FAILURE_CONTROL_SECRET: "control-secret",
          VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: "synthetic-user",
          VIVA_FAILURE_CONTROL_STUDY_SET_IDS: "biology-midterm",
        },
      }),
    /per-identity cap/,
  );
});

test("failure-control evidence is sanitized and records production-disabled state", () => {
  const plan = buildFailureControlPlan({
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

  assert.equal(plan.enabled, true);
  assert.equal(plan.scenario.id, "provider_rate_limited");
  assert.deepEqual(plan.syntheticUserIds, ["synthetic-user"]);
  assert.deepEqual(plan.allowedOrigins, ["https://viva.example"]);

  const evidence = failureControlHarnessEvidence(plan);
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.schema, "viva.failure_control_harness.v1");
  assert.equal(evidence.enabled_for_release, false);
  assert.equal(evidence.selected_scenario, "provider_rate_limited");
  assert.equal(evidence.controls.control_secret_required, true);
  assert.equal(evidence.controls.synthetic_identity_only, true);
  assert.equal(evidence.controls.per_identity_cap, 1);
  assert.doesNotMatch(serialized, /control-secret/);
  assert.doesNotMatch(serialized, /session_token/);
  assert.doesNotMatch(serialized, /answer_text/);
  assert.doesNotMatch(serialized, /transcript_final/);
  assert.doesNotMatch(serialized, /pcm16_base64/);
  assert.doesNotMatch(serialized, /Bearer /);
});

test("failure-control plan exposes configured first synthetic start identity", () => {
  const plan = buildFailureControlPlan({
    env: {
      VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: "https://viva.example",
      VIVA_FAILURE_CONTROL_ENABLED: "1",
      VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY: "1",
      VIVA_FAILURE_CONTROL_SCENARIO: "provider_rate_limited",
      VIVA_FAILURE_CONTROL_SECRET: "control-secret",
      VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: "synthetic-user, other-user",
      VIVA_FAILURE_CONTROL_STUDY_SET_IDS: "custom-study, biology-midterm",
    },
  });

  assert.deepEqual(failureControlStartIdentity(plan), {
    userId: "synthetic-user",
    studySetId: "custom-study",
  });
  assert.equal(failureControlScenarioMarker(plan.scenario), "failure-control-provider_rate_limited");
});

test("failure-control token scenarios mutate the browser target to prove token recovery paths", () => {
  const secret = "session-secret";
  const token = signedTestToken(secret, {
    user_id: "synthetic-user",
    study_set_id: "biology-midterm",
    session_id: "voice-session-1",
    expires_at: 200,
    nonce: "nonce-valid",
    failure_control: {
      scenario: "provider_rate_limited",
      run_id: "run-1",
      expires_at: 200,
      nonce: "control-nonce",
      signature: "control-signature",
    },
  });
  const target = `/session?user_id=synthetic-user&study_set_id=biology-midterm&session_id=voice-session-1#session_token=${encodeURIComponent(
    token,
  )}`;

  const invalid = failureControlSessionTargetForScenario(
    target,
    scenarioById("invalid_token"),
    { sessionSecret: secret, now: 150 },
  );
  assert.equal(invalid.token_mode, "invalid_token");
  assert.equal(invalid.preconsume_replay, false);
  assert.notEqual(parseFailureControlSessionTarget(invalid.target).sessionToken, token);

  const expired = failureControlSessionTargetForScenario(
    target,
    scenarioById("expired_token"),
    { sessionSecret: secret, now: 150 },
  );
  assert.equal(expired.token_mode, "expired_token");
  assert.equal(expired.preconsume_replay, false);
  assert.equal(decodedTokenClaims(parseFailureControlSessionTarget(expired.target).sessionToken).expires_at, 89);
  assert(validSignature(parseFailureControlSessionTarget(expired.target).sessionToken, secret));

  const replayed = failureControlSessionTargetForScenario(
    target,
    scenarioById("replayed_token"),
    { sessionSecret: secret, now: 150 },
  );
  assert.equal(replayed.token_mode, "replayed_token");
  assert.equal(replayed.preconsume_replay, true);
  assert.equal(parseFailureControlSessionTarget(replayed.target).sessionToken, token);

  const malformed = failureControlSessionTargetForScenario(
    target,
    scenarioById("malformed_token"),
    { sessionSecret: secret, now: 150 },
  );
  assert.equal(malformed.token_mode, "malformed_token");
  assert.equal(parseFailureControlSessionTarget(malformed.target).sessionToken, "not-a-viva-token");
});

test("failure-control expired-token mutation requires the session signing secret", () => {
  const target = `/session?user_id=synthetic-user&study_set_id=biology-midterm&session_id=voice-session-1#session_token=${encodeURIComponent(
    signedTestToken("session-secret", {
      user_id: "synthetic-user",
      study_set_id: "biology-midterm",
      session_id: "voice-session-1",
      expires_at: 200,
      nonce: "nonce-valid",
    }),
  )}`;

  assert.throws(
    () =>
      failureControlSessionTargetForScenario(target, scenarioById("expired_token"), {
        sessionSecret: "",
        now: 150,
      }),
    /SESSION_TOKEN_SECRET/,
  );
});

function scenarioById(id) {
  const scenario = FAILURE_CONTROL_SCENARIOS.find((entry) => entry.id === id);
  assert(scenario, `scenario ${id} should exist`);
  return scenario;
}

function signedTestToken(secret, claims) {
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `viva1.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodedTokenClaims(token) {
  const [, claimsPart] = token.split(".");
  return JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
}

function validSignature(token, secret) {
  const [prefix, claimsPart, signature] = token.split(".");
  const payload = `${prefix}.${claimsPart}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  return signature === expected;
}
