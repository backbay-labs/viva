import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHostedMonitorPlan,
  buildObjectKey,
  normalizeHostedUrl,
} from "./hosted-monitor-runner.mjs";

const baseEnv = Object.freeze({
  VIVA_HOSTED_AGENT_HTTP_URL: "https://agent.example.com/",
  VIVA_HOSTED_AGENT_WS_URL: "wss://agent.example.com/ws",
  VIVA_HOSTED_ARTIFACT_BUCKET: "viva-monitor-evidence",
  VIVA_HOSTED_ARTIFACT_ENDPOINT: "https://storage.railway.app",
  VIVA_HOSTED_ARTIFACT_KEY_ID: "redacted-key-id",
  VIVA_HOSTED_ARTIFACT_REGION: "auto",
  VIVA_HOSTED_ARTIFACT_SECRET_KEY: "redacted-secret-key",
  VIVA_HOSTED_RUN_ID: "run-2026-06-23T19-20-00Z",
  VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID: "biology-midterm",
  VIVA_HOSTED_SYNTHETIC_USER_ID: "synthetic-monitor-user",
  VIVA_HOSTED_WEB_URL: "https://web.example.com/",
  VIVA_VOICE_SESSION_TOKEN_SECRET: "redacted-session-secret",
});

test("hosted monitor plan runs scheduled synthetic browser proof against hosted URLs", () => {
  const plan = buildHostedMonitorPlan(baseEnv);

  assert.equal(plan.mode, "scheduled");
  assert.equal(plan.artifactPrefix, "viva-hosted-monitor/scheduled/run-2026-06-23T19-20-00Z");
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].name, "scheduled_hosted_synthetic_monitor");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_WEB_URL, "https://web.example.com");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_AGENT_HTTP_URL, "https://agent.example.com");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_AGENT_WS_URL, "wss://agent.example.com/ws");
  assert.equal(plan.runs[0].env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID, "synthetic-monitor-user");
  assert.equal(plan.runs[0].env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID, "biology-midterm");
  assert.equal(plan.runs[0].env.VIVA_E2E_STOP_TO_RECAP, "1");
});

test("hosted monitor PR mode includes the failure-control browser slice", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
    VIVA_HOSTED_RUNNER_MODE: "pr",
  });

  assert.equal(plan.mode, "pr");
  assert.deepEqual(
    plan.runs.map((run) => run.name),
    ["pr_hosted_synthetic_matrix", "pr_hosted_failure_control_provider_rate_limited"],
  );
  assert.equal(
    plan.runs[1].env.VIVA_E2E_FAILURE_CONTROL_SCENARIO,
    "provider_rate_limited",
  );
  assert.equal(plan.runs[1].env.VIVA_FAILURE_CONTROL_ENABLED, "1");
  assert.equal(plan.runs[1].env.VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS, "synthetic-monitor-user");
  assert.equal(plan.runs[1].env.VIVA_FAILURE_CONTROL_STUDY_SET_IDS, "biology-midterm");
});

test("hosted monitor rejects learner-like runner identities", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_SYNTHETIC_USER_ID: "learner-123",
      }),
    /synthetic monitor identity/,
  );
});

test("hosted monitor requires durable artifact store settings", () => {
  const { VIVA_HOSTED_ARTIFACT_BUCKET, ...env } = baseEnv;

  assert.throws(() => buildHostedMonitorPlan(env), /VIVA_HOSTED_ARTIFACT_BUCKET/);
});

test("hosted monitor normalizes URLs and object keys", () => {
  assert.equal(normalizeHostedUrl("https://web.example.com///"), "https://web.example.com");
  assert.throws(() => normalizeHostedUrl("ftp://web.example.com"), /http:\/\/ or https:\/\//);
  assert.equal(
    buildObjectKey("viva-hosted-monitor/scheduled/run-id", "browser/result.json"),
    "viva-hosted-monitor/scheduled/run-id/browser/result.json",
  );
  assert.throws(() => buildObjectKey("prefix", "../secret.txt"), /unsafe artifact path/);
});
