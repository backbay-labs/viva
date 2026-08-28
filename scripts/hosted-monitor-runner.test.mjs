import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FAILURE_CONTROL_SCENARIOS } from "./failure-control-harness.mjs";
import {
  failureControlScenarioRequiresExplicitBrowserAction,
  HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY,
} from "./hosted-e2e-matrix.mjs";
import {
  applyHostedLiveMonitorState,
  buildHostedMonitorPlan,
  buildObjectKey,
  contentTypeFor,
  hostedMonitorChildEnv,
  isPublishableHostedArtifact,
  isRejectedHostedArtifact,
  materializeHostedLiveSmokeRun,
  normalizeHostedUrl,
  prepareRunForSpawn,
  publishableHostedFiles,
  publishHostedEvidence,
  putS3Object,
  remainingPublishMs,
  runHostedMonitorCommand,
  summarizeHostedRun,
  writePublishedManifest,
} from "./hosted-monitor-runner.mjs";
import { finalizeLiveMonitorRun, zeroLiveMonitorState } from "./hosted-monitor-state.mjs";
import { configurationFailureEvidence } from "./live-provider-smoke.mjs";
import { assertNoForbiddenEvidenceMarkers } from "./redaction-control.mjs";

const baseEnv = Object.freeze({
  VIVA_HOSTED_AGENT_HTTP_URL: "https://agent.example.com/",
  VIVA_HOSTED_AGENT_WS_URL: "wss://agent.example.com/ws",
  VIVA_HOSTED_ARTIFACT_BUCKET: "viva-monitor-evidence",
  VIVA_HOSTED_ARTIFACT_ENDPOINT: "https://storage.railway.app",
  VIVA_HOSTED_ARTIFACT_KEY_ID: "redacted-key-id",
  VIVA_HOSTED_ARTIFACT_REGION: "auto",
  VIVA_HOSTED_ARTIFACT_SECRET_KEY: "redacted-secret-key",
  VIVA_HOSTED_FAKE_PROVIDER_AGENT_HTTP_URL: "https://fake-agent.example.com/",
  VIVA_HOSTED_FAKE_PROVIDER_AGENT_WS_URL: "wss://fake-agent.example.com/ws",
  VIVA_HOSTED_FAKE_PROVIDER_WEB_URL: "https://fake-web.example.com/",
  VIVA_HOSTED_DEPLOY_SHA: "abc123hostedsha",
  VIVA_HOSTED_FAILURE_CONTROL_AGENT_HTTP_URL: "https://failure-agent.example.com/",
  VIVA_HOSTED_FAILURE_CONTROL_AGENT_WS_URL: "wss://failure-agent.example.com/ws",
  VIVA_HOSTED_FAILURE_CONTROL_WEB_URL: "https://failure-web.example.com/",
  VIVA_HOSTED_REST_BEARER_TOKEN: "redacted-rest-bearer",
  VIVA_HOSTED_RUN_ID: "run-2026-06-23T19-20-00Z",
  VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID: "biology-midterm",
  VIVA_HOSTED_SYNTHETIC_USER_ID: "synthetic-monitor-user",
  VIVA_HOSTED_WEB_URL: "https://web.example.com/",
  VIVA_VOICE_SESSION_TOKEN_SECRET: "redacted-session-secret",
});

const HOSTILE_PARENT_ENV = Object.freeze({
  PATH: "/hostile/bin",
  HOME: "/home/hostile-parent",
  CI: "1",
  DATABASE_URL: "postgres://hostile:leak@internal-db.example/prod",
  CARTESIA_API_KEY: "hostile-cartesia-key-value",
  GEMINI_API_KEY: "hostile-gemini-key-value",
  VIVA_VOICE_SESSION_TOKEN_SECRET: "hostile-session-signing-secret",
  VIVA_FAILURE_CONTROL_SECRET: "hostile-failure-control-secret",
  VIVA_RELEASE_RUN_ID: "hostile-release-run-id",
  VIVA_SOME_UNRELATED_FLAG: "hostile-unrelated-value",
  NODE_OPTIONS: "--require /tmp/viva-hostile-parent.cjs",
  BUN_OPTIONS: "--hostile-flag",
});

test("hostedMonitorChildEnv routes the browser-story child through the hosted-browser role and clears a hostile parent", () => {
  const run = {
    name: "scheduled_hosted_synthetic_monitor",
    runner: "e2e-browser",
    env: { VIVA_E2E_AGENT_PROVIDER: "synthetic", VIVA_E2E_HOSTED_WEB_URL: "https://web.example.com" },
  };
  const command = { bin: "bun", args: ["run", "e2e:browser"], env: { VIVA_E2E_ARTIFACT_DIR: "artifacts/x" } };

  const env = hostedMonitorChildEnv(run, command, HOSTILE_PARENT_ENV);

  assert.equal(env.VIVA_E2E_AGENT_PROVIDER, "synthetic");
  assert.equal(env.VIVA_E2E_HOSTED_WEB_URL, "https://web.example.com");
  assert.equal(env.VIVA_E2E_ARTIFACT_DIR, "artifacts/x");
  assert.equal(env.PATH, "/hostile/bin");
  assert.equal("DATABASE_URL" in env, false);
  assert.equal("CARTESIA_API_KEY" in env, false);
  assert.equal("GEMINI_API_KEY" in env, false);
  assert.equal("VIVA_RELEASE_RUN_ID" in env, false);
  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal("BUN_OPTIONS" in env, false);
  assert.equal("VIVA_SOME_UNRELATED_FLAG" in env, false);
});

test("hostedMonitorChildEnv routes the live-provider-smoke child through the hosted-live role and clears a hostile parent", () => {
  const run = {
    name: "scheduled_hosted_live_smoke",
    runner: "live-provider-smoke",
    env: { VIVA_AGENT_PROVIDER: "cartesia_gemini", VIVA_LIVE_SMOKE_SESSION_TOKEN: "viva1.claims.sig" },
  };
  const command = {
    bin: "bun",
    args: ["run", "live:smoke"],
    env: { VIVA_LIVE_SMOKE_ARTIFACT_DIR: "artifacts/live" },
  };

  const env = hostedMonitorChildEnv(run, command, HOSTILE_PARENT_ENV);

  assert.equal(env.VIVA_AGENT_PROVIDER, "cartesia_gemini");
  assert.equal(env.VIVA_LIVE_SMOKE_SESSION_TOKEN, "viva1.claims.sig");
  assert.equal(env.VIVA_LIVE_SMOKE_ARTIFACT_DIR, "artifacts/live");
  assert.equal("CARTESIA_API_KEY" in env, false);
  assert.equal("GEMINI_API_KEY" in env, false);
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in env, false);
  assert.equal("VIVA_FAILURE_CONTROL_SECRET" in env, false);
});

test("hostedMonitorChildEnv passes the live-provider-secrets-confirmed attestation through without ever admitting raw provider keys", () => {
  const run = {
    name: "scheduled_hosted_live_smoke",
    runner: "live-provider-smoke",
    env: {
      VIVA_AGENT_PROVIDER: "cartesia_gemini",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_SESSION_TOKEN: "viva1.claims.sig",
    },
  };
  const command = { bin: "bun", args: ["run", "live:smoke"], env: {} };

  const env = hostedMonitorChildEnv(run, command, HOSTILE_PARENT_ENV);

  assert.equal(env.VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED, "1");
  assert.equal("CARTESIA_API_KEY" in env, false);
  assert.equal("GEMINI_API_KEY" in env, false);
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in env, false);
});

function failureControlEnvPrefix(scenarioId) {
  return `VIVA_HOSTED_FAILURE_CONTROL_${scenarioId.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
}

function failureControlTargetEnvFor(scenarioId) {
  const prefix = failureControlEnvPrefix(scenarioId);
  const hostSegment = scenarioId.replaceAll("_", "-");
  return {
    [`${prefix}_AGENT_HTTP_URL`]: `https://failure-${hostSegment}-agent.example.com/`,
    [`${prefix}_AGENT_WS_URL`]: `wss://failure-${hostSegment}-agent.example.com/ws`,
    [`${prefix}_WEB_URL`]: `https://failure-${hostSegment}-web.example.com/`,
  };
}

function allFailureControlTargetEnv() {
  return Object.assign(
    {},
    ...FAILURE_CONTROL_SCENARIOS.map((scenario) => failureControlTargetEnvFor(scenario.id)),
  );
}

function prRunnableFailureControlScenarios() {
  return FAILURE_CONTROL_SCENARIOS.filter(
    (scenario) => !failureControlScenarioRequiresExplicitBrowserAction(scenario.id),
  );
}

function explicitBrowserActionFailureControlScenarioIds() {
  return FAILURE_CONTROL_SCENARIOS.filter((scenario) =>
    failureControlScenarioRequiresExplicitBrowserAction(scenario.id),
  ).map((scenario) => scenario.id);
}

function sessionAuthFailureControlScenarioIds() {
  return FAILURE_CONTROL_SCENARIOS.filter((scenario) => scenario.stage === "session_auth").map(
    (scenario) => scenario.id,
  );
}

test("hosted monitor plan runs scheduled synthetic browser proof against hosted URLs", () => {
  const plan = buildHostedMonitorPlan(baseEnv);

  assert.equal(plan.mode, "scheduled");
  assert.equal(plan.artifactPrefix, "viva-hosted-monitor/scheduled/run-2026-06-23T19-20-00Z");
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].name, "scheduled_hosted_synthetic_monitor");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_WEB_URL, "https://web.example.com");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_AGENT_HTTP_URL, "https://agent.example.com");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_AGENT_WS_URL, "wss://agent.example.com/ws");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_REST_BEARER_TOKEN, "redacted-rest-bearer");
  assert.equal(plan.runs[0].env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID, "synthetic-monitor-user");
  assert.equal(plan.runs[0].env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID, "biology-midterm");
  assert.equal(plan.runs[0].env.VIVA_E2E_SYNTHETIC_USER_ID, "synthetic-monitor-user");
  assert.equal(plan.runs[0].env.VIVA_E2E_SYNTHETIC_STUDY_SET_ID, "biology-midterm");
  assert.equal(plan.runs[0].env.VIVA_E2E_DEPLOY_SHA, "abc123hostedsha");
  assert.equal(plan.runs[0].env.VIVA_E2E_STOP_TO_RECAP, undefined);
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_SCENARIO_ID, "happy_path");
  assert.equal(plan.runs[0].env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO, "0");
  assert.equal(plan.matrix.schema, "viva.hosted_e2e_matrix.v1");
  assert.equal(plan.matrix.profile, "scheduled");
  assert.equal(plan.matrix.scenario_count, 1);
  assert.equal(plan.matrix.monitor_policy.live_monitor.max_cost_usd_per_run, 0.25);
  assert.equal(plan.runTimeoutMs, 600000);
  assert.equal(plan.publishTimeoutMs, 120000);
  // RELEASE-016/021: the baseline scheduled synthetic run never needs the
  // session-signing secret.
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in plan.runs[0].env, false);
});

test("hosted monitor scheduled synthetic mode builds without any live-provider secret or key", () => {
  const { VIVA_VOICE_SESSION_TOKEN_SECRET, ...envWithoutSessionSecret } = baseEnv;

  const plan = buildHostedMonitorPlan(envWithoutSessionSecret);

  assert.equal(plan.runs.length, 1);
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in plan.runs[0].env, false);
  assert.equal("CARTESIA_API_KEY" in plan.runs[0].env, false);
  assert.equal("GEMINI_API_KEY" in plan.runs[0].env, false);
  const childEnv = hostedMonitorChildEnv(
    plan.runs[0],
    { bin: "bun", args: ["run", "e2e:browser"], env: {} },
    envWithoutSessionSecret,
  );
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in childEnv, false);
  assert.equal("CARTESIA_API_KEY" in childEnv, false);
  assert.equal("GEMINI_API_KEY" in childEnv, false);
});

test("hosted monitor PR mode never requires the session-signing secret for any hosted-runnable failure-control scenario", () => {
  const { VIVA_VOICE_SESSION_TOKEN_SECRET, ...envWithoutSessionSecret } = baseEnv;
  const runnableFailureControlScenarios = prRunnableFailureControlScenarios();

  const plan = buildHostedMonitorPlan({
    ...envWithoutSessionSecret,
    ...allFailureControlTargetEnv(),
    VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
    VIVA_HOSTED_RUNNER_MODE: "pr",
  });

  assert.equal(plan.matrix.scenario_count, 3 + runnableFailureControlScenarios.length);
  for (const run of plan.runs) {
    assert.equal(
      "VIVA_VOICE_SESSION_TOKEN_SECRET" in run.env,
      false,
      `${run.name} must not require the session-signing secret`,
    );
  }
});

const liveMonitorTargetEnv = Object.freeze({
  VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL: "https://live-agent.example.com/",
  VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD: "0.10",
  VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL: "wss://live-agent.example.com/ws",
  VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
  VIVA_HOSTED_LIVE_MONITOR_REST_BEARER_TOKEN: "redacted-live-rest-bearer",
  VIVA_HOSTED_LIVE_MONITOR_SESSION_ID: "live-monitor-session-1",
  VIVA_HOSTED_LIVE_MONITOR_STUDY_SET_ID: "live-monitor-study-set",
  VIVA_HOSTED_LIVE_MONITOR_USER_ID: "synthetic-live-monitor-user",
  VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
});

test("hosted monitor plan defers the live-monitor schedule decision to durable state resolution", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    ...liveMonitorTargetEnv,
  });

  assert.equal(plan.liveMonitorRequested, true);
  assert.equal(plan.liveMonitor.should_run, false);
  assert.equal(plan.liveMonitor.skip_reason, "pending_state_resolution");
  assert.deepEqual(
    plan.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor"],
  );
  assert.equal(plan.liveMonitorConfig.target.agentHttpUrl, "https://live-agent.example.com");
});

test("hosted monitor resolves durable state and schedules bounded live smoke on a first-ever run", async () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    ...liveMonitorTargetEnv,
  });
  const { fetchImpl } = fakeS3Store();

  const resolved = await applyHostedLiveMonitorState(plan, {
    fetchImpl,
    deadlineMs: Date.now() + 5000,
    env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
  });

  assert.deepEqual(
    resolved.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor", "scheduled_hosted_live_smoke"],
  );
  const liveRun = resolved.runs[1];
  assert.equal(liveRun.runner, "live-provider-smoke");
  assert.equal(liveRun.resultFileName, "evidence.json");
  assert.equal(liveRun.env.VIVA_LIVE_PROVIDER_SMOKE, "1");
  assert.equal(liveRun.env.VIVA_AGENT_PROVIDER, "cartesia_gemini");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_AGENT_HTTP_URL, "https://live-agent.example.com");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_AGENT_WS_URL, "wss://live-agent.example.com/ws");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_ORIGIN, "https://live-web.example.com");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_MAX_DURATION_MS, "90000");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_MAX_TURNS, "1");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES, "262144");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_AUDIO_FILE, "/app/evidence/live-smoke-answer.pcm");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_MAX_TOKENS, "4096");
  assert.match(
    liveRun.env.VIVA_LIVE_SMOKE_SESSION_ID,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(liveRun.env.VIVA_LIVE_SMOKE_SESSION_ID, "live-monitor-session-1");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_STUDY_SET_ID, "live-monitor-study-set");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_USER_ID, "synthetic-live-monitor-user");
  assert.equal(liveRun.env.VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED, "1");
  assert.equal("CARTESIA_API_KEY" in liveRun.env, false);
  assert.equal("GEMINI_API_KEY" in liveRun.env, false);
  // RELEASE-016/021: the plan/resolved-run carries live identity only -- no
  // token is minted until immediately before this run is spawned.
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_SESSION_TOKEN, undefined);
  assert.deepEqual(liveRun.identity, {
    session_id: liveRun.env.VIVA_LIVE_SMOKE_SESSION_ID,
    study_set_id: "live-monitor-study-set",
    user_id: "synthetic-live-monitor-user",
  });
  assert.equal(liveRun.runId, plan.runId);
  assert.equal(liveRun.deploySha, "abc123hostedsha");
  assert.equal(liveRun.agentDeployId, "unknown");
  assert.equal(liveRun.provider, "cartesia_gemini");
  assert.equal(liveRun.env.VIVA_VOICE_WS_BEARER_TOKEN, "redacted-live-rest-bearer");
  assert.equal(liveRun.env.VIVA_VOICE_WS_MAX_SESSION_COST_USD, "0.1");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD, "0.1");
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_RUN_ID, plan.runId);
  assert.equal(liveRun.env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES, "0");
  assert.equal("VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES" in liveRun.env, false);
  assert.equal("VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT" in liveRun.env, false);
  // BAC-527: the smoke's own internal deadline stays exactly
  // max_duration_ms_per_run (90s, carried in VIVA_LIVE_SMOKE_MAX_DURATION_MS
  // above); the runner's outer supervisory kill grants a fixed 30s
  // evidence-flush grace on top of that before it hard-kills the process.
  assert.equal(liveRun.timeoutMs, 120000);
  assert.equal(resolved.liveMonitor.should_run, true);
  assert.equal(resolved.liveMonitor.runs_today, 1);
  assert.equal(resolved.liveMonitor.tokens_today, 4096);
  assert.equal(resolved.liveMonitor.cost_usd_today, 0.25);
  assert.equal(resolved.liveMonitor.max_cost_usd_per_day, 0.5);
  assert.equal(resolved.liveMonitor.consecutive_failures, 0);
  assert.equal(typeof resolved.liveMonitor.etag_hash, "string");

  // RELEASE-016/021: the session capability is minted only immediately
  // before spawn, via a distinct call the runner makes right at that point.
  const materialized = materializeHostedLiveSmokeRun(
    liveRun,
    { VIVA_VOICE_SESSION_TOKEN_SECRET: "redacted-session-secret" },
    2_000_000_000,
  );
  const liveSessionClaims = decodedSignedSession(
    materialized.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
    "redacted-session-secret",
  );
  assert.equal(liveSessionClaims.session_id, liveRun.env.VIVA_LIVE_SMOKE_SESSION_ID);
  assert.equal(liveSessionClaims.study_set_id, "live-monitor-study-set");
  assert.equal(liveSessionClaims.user_id, "synthetic-live-monitor-user");
  assert.equal(typeof liveSessionClaims.nonce, "string");
  // Exactly the deployed agent's required SessionTokenClaims fields (ROW 356:
  // issued_at/not_before were previously missing here entirely -- see the
  // "signs only claims..." test below and materializeHostedLiveSmokeRun's
  // own adjudication comment).
  assert.deepEqual(
    Object.keys(liveSessionClaims).sort(),
    ["expires_at", "issued_at", "nonce", "not_before", "session_id", "study_set_id", "user_id"],
  );
  assert.equal(materialized.runId, plan.runId);
  assert.equal(materialized.deploySha, "abc123hostedsha");
  assert.equal(materialized.agentDeployId, "unknown");
  assert.equal(materialized.provider, "cartesia_gemini");
  // Full TTL: the run's own timeout (120s, which already folds in the
  // runner's 30s flush grace) plus an additional 60s safety margin, measured
  // from the moment materialization happened -- not from any earlier
  // plan-construction time.
  assert.equal(liveSessionClaims.expires_at, 2_000_000_000 + 180);
  // Materialization must never mutate the original plan/run object.
  assert.equal(liveRun.env.VIVA_LIVE_SMOKE_SESSION_TOKEN, undefined);
});

function fixtureLiveSmokeRun(overrides = {}) {
  return {
    agentDeployId: "agent-deploy-42",
    deploySha: "deploy-sha-abc",
    env: { VIVA_LIVE_SMOKE_SESSION_ID: "session-1" },
    identity: {
      session_id: "session-1",
      study_set_id: "biology-midterm",
      user_id: "synthetic-live-monitor-user",
    },
    name: "scheduled_hosted_live_smoke",
    provider: "cartesia_gemini",
    runId: "run-2026-06-23a",
    runner: "live-provider-smoke",
    timeoutMs: 120_000,
    ...overrides,
  };
}

test("materializeHostedLiveSmokeRun mints a fresh single-use nonce and a full TTL measured from the call, not plan time", () => {
  const secretEnv = { VIVA_VOICE_SESSION_TOKEN_SECRET: "the-signing-secret" };
  const run = fixtureLiveSmokeRun();

  // An injected slow synthetic leg: whatever earlier plan runs took, this
  // call happens much later than a hypothetical plan-construction time.
  const laterNowSeconds = 1_800_000_000;
  const materialized = materializeHostedLiveSmokeRun(run, secretEnv, laterNowSeconds);
  const claims = decodedSignedSession(materialized.env.VIVA_LIVE_SMOKE_SESSION_TOKEN, secretEnv.VIVA_VOICE_SESSION_TOKEN_SECRET);

  assert.equal(claims.expires_at, laterNowSeconds + Math.ceil(run.timeoutMs / 1000) + 60);
  assert.equal(claims.session_id, "session-1");
  assert.equal(claims.study_set_id, "biology-midterm");
  assert.equal(claims.user_id, "synthetic-live-monitor-user");
  // The run/deploy/provider identity travels on the materialized run object,
  // outside the signed envelope -- see the wire-format regression test below
  // for why the token itself cannot also carry them.
  assert.equal(materialized.runId, "run-2026-06-23a");
  assert.equal(materialized.deploySha, "deploy-sha-abc");
  assert.equal(materialized.agentDeployId, "agent-deploy-42");
  assert.equal(materialized.provider, "cartesia_gemini");

  // Single-use: two materializations of the same logical run never reuse a
  // nonce or produce the same token.
  const secondMaterialized = materializeHostedLiveSmokeRun(run, secretEnv, laterNowSeconds);
  const secondClaims = decodedSignedSession(
    secondMaterialized.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
    secretEnv.VIVA_VOICE_SESSION_TOKEN_SECRET,
  );
  assert.notEqual(secondClaims.nonce, claims.nonce);
  assert.notEqual(
    secondMaterialized.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
    materialized.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
  );
});

test("materializeHostedLiveSmokeRun binds claims to the exact run so a one-field mismatch cannot pass off as another run, and rejects a tampered signature", () => {
  const secretEnv = { VIVA_VOICE_SESSION_TOKEN_SECRET: "the-signing-secret" };
  const identityFor = (sessionId) => ({
    session_id: sessionId,
    study_set_id: "biology-midterm",
    user_id: "synthetic-live-monitor-user",
  });
  const runA = fixtureLiveSmokeRun({
    runId: "run-a",
    deploySha: "sha-a",
    identity: identityFor("session-a"),
  });
  const runB = fixtureLiveSmokeRun({
    runId: "run-b",
    deploySha: "sha-b",
    identity: identityFor("session-b"),
  });

  const materializedA = materializeHostedLiveSmokeRun(runA, secretEnv, 1_800_000_000);
  const materializedB = materializeHostedLiveSmokeRun(runB, secretEnv, 1_800_000_000);
  const claimsA = decodedSignedSession(
    materializedA.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
    secretEnv.VIVA_VOICE_SESSION_TOKEN_SECRET,
  );
  const claimsB = decodedSignedSession(
    materializedB.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
    secretEnv.VIVA_VOICE_SESSION_TOKEN_SECRET,
  );

  // Each run's token is bound to that run's own synthetic session identity
  // -- the field the deployed server's verifier actually checks -- and to a
  // fresh nonce; run id and deploy SHA still differ on the materialized run
  // object itself, for audit, outside the signed envelope (see the
  // wire-format regression test above for why they cannot also be claims).
  assert.notEqual(claimsA.session_id, claimsB.session_id);
  assert.notEqual(claimsA.nonce, claimsB.nonce);
  assert.notEqual(materializedA.runId, materializedB.runId);
  assert.notEqual(materializedA.deploySha, materializedB.deploySha);

  // A signature computed over one claims payload must not verify against a
  // different (tampered) claims payload -- the exact mechanism that lets a
  // real verifier reject a one-field mismatch before provider work.
  const [prefix, , originalSignature] = materializedA.env.VIVA_LIVE_SMOKE_SESSION_TOKEN.split(".");
  const tamperedClaimsPart = Buffer.from(
    JSON.stringify({ ...claimsA, session_id: claimsB.session_id }),
  ).toString("base64url");
  assert.throws(
    () =>
      decodedSignedSession(
        `${prefix}.${tamperedClaimsPart}.${originalSignature}`,
        secretEnv.VIVA_VOICE_SESSION_TOKEN_SECRET,
      ),
    /AssertionError/,
  );
});

test("materializeHostedLiveSmokeRun requires the signing secret and never leaks it or the raw run into the serialized result", () => {
  const run = fixtureLiveSmokeRun();

  assert.throws(() => materializeHostedLiveSmokeRun(run, {}, 1_800_000_000), /required/);

  const materialized = materializeHostedLiveSmokeRun(
    run,
    { VIVA_VOICE_SESSION_TOKEN_SECRET: "must-never-appear-in-output" },
    1_800_000_000,
  );
  const serialized = JSON.stringify(materialized);
  assert.doesNotMatch(serialized, /must-never-appear-in-output/);
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in materialized.env, false);
});

test("materializeHostedLiveSmokeRun signs only claims the deployed agent's SessionTokenClaims wire format accepts", () => {
  // config.rs's SessionTokenClaims derives deny_unknown_fields over exactly
  // these 7 required names plus optional failure_control (unset here); a
  // claims object missing any of the 7, or carrying an extra one (a run id,
  // deploy SHA, agent deploy id, or provider mode), is rejected before any
  // provider work. Cross-checked against the real Rust source below so the
  // two cannot silently drift the way ROW 356 found issued_at/not_before
  // already had.
  const secretEnv = { VIVA_VOICE_SESSION_TOKEN_SECRET: "the-signing-secret" };
  const run = fixtureLiveSmokeRun();

  const materialized = materializeHostedLiveSmokeRun(run, secretEnv, 1_800_000_000);
  const claims = decodedSignedSession(
    materialized.env.VIVA_LIVE_SMOKE_SESSION_TOKEN,
    secretEnv.VIVA_VOICE_SESSION_TOKEN_SECRET,
  );

  const requiredClaimNames =
    "expires_at,issued_at,nonce,not_before,session_id,study_set_id,user_id".split(",");
  assert.deepEqual(Object.keys(claims).sort(), requiredClaimNames);
  for (const forbiddenClaim of ["run_id", "deploy_sha", "agent_deploy_id", "provider_mode"]) {
    assert.equal(forbiddenClaim in claims, false, `must never carry ${forbiddenClaim}`);
  }

  // Cross-file drift guard: reads config.rs's own
  // SESSION_TOKEN_REQUIRED_CLAIM_NAMES directly, rather than re-trusting the
  // comment above.
  const configRs = readFileSync(
    new URL("../agent/crates/agent-service/src/config.rs", import.meta.url),
    "utf8",
  );
  const requiredMatch = configRs.match(
    /const SESSION_TOKEN_REQUIRED_CLAIM_NAMES: &\[&str\] = &\[([^\]]+)\];/,
  );
  assert(requiredMatch, "could not locate SESSION_TOKEN_REQUIRED_CLAIM_NAMES in config.rs");
  const rustRequiredClaimNames = [...requiredMatch[1].matchAll(/"([a-z_]+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(rustRequiredClaimNames, requiredClaimNames);
});

// ROW 356/RELEASE-021: main()'s per-run loop is not exported, so nothing
// could previously prove *where* the live-smoke mint happened -- only that
// materializeHostedLiveSmokeRun itself, called directly and in isolation,
// used whatever nowSeconds it was handed. This exercises the actual
// extracted call site the loop now delegates to, with an injected clock
// PROVIDER that changes between calls -- proving each call reads it fresh,
// per call, the way real elapsed wall-clock time would. A future edit that
// hoisted the mint to plan time (reading `now()` once, sharing that one
// value across every run) would make both calls below observe the same
// clock value and fail the `notEqual`.
test("ROW 356/RELEASE-021: prepareRunForSpawn reads its clock provider fresh on every call, so hoisting the live-smoke mint to plan time (one shared now for every run) is caught", () => {
  const clockValues = [1_000, 5_000]; // simulates ~66 minutes elapsing before the second run spawns
  let callCount = 0;
  const now = () => {
    callCount += 1;
    return clockValues[callCount - 1];
  };
  const env = { VIVA_VOICE_SESSION_TOKEN_SECRET: "the-signing-secret" };
  const run = fixtureLiveSmokeRun();

  const first = prepareRunForSpawn(run, { env, now });
  const second = prepareRunForSpawn(run, { env, now });

  const firstClaims = decodedSignedSession(first.env.VIVA_LIVE_SMOKE_SESSION_TOKEN, env.VIVA_VOICE_SESSION_TOKEN_SECRET);
  const secondClaims = decodedSignedSession(second.env.VIVA_LIVE_SMOKE_SESSION_TOKEN, env.VIVA_VOICE_SESSION_TOKEN_SECRET);

  assert.equal(callCount, 2, "each call must read the clock provider itself, exactly once");
  assert.equal(firstClaims.issued_at, 1_000);
  assert.equal(secondClaims.issued_at, 5_000);
  assert.notEqual(
    firstClaims.expires_at,
    secondClaims.expires_at,
    "a plan-time hoist would call now() once and share one expires_at across every run",
  );
  // Single-use at this seam too (not only when materializeHostedLiveSmokeRun
  // is called directly, above): each spawn-time mint gets its own fresh nonce.
  assert.notEqual(firstClaims.nonce, secondClaims.nonce, "each spawn-time mint must use a fresh nonce");

  // A non-live-smoke run is passed through untouched, at neither call site's
  // clock cost -- prepareRunForSpawn's own contract for the non-materializing
  // branch.
  const otherRun = fixtureLiveSmokeRun({ runner: "hosted-e2e-matrix" });
  assert.equal(prepareRunForSpawn(otherRun, { env, now }), otherRun);
});

// The behavioral test above proves the extracted seam itself is correct
// when called fresh, per iteration -- it says nothing about whether main()'s
// loop actually calls it that way, since main() is not exported. This closes
// that remaining gap: no local variable capturing a "now" (a raw
// Math.floor(Date.now()/1000) or a captured provider) exists anywhere ahead
// of the per-run loop for prepareRunForSpawn to be handed -- the loop calls
// it with no second argument at all, so every call gets prepareRunForSpawn's
// own live default, read fresh, in that call.
test("ROW 356/RELEASE-021: main()'s per-run loop calls prepareRunForSpawn with no captured/hoisted now argument", () => {
  const source = readFileSync(new URL("./hosted-monitor-runner.mjs", import.meta.url), "utf8");
  const mainStart = source.indexOf("async function main()");
  assert.notEqual(mainStart, -1);
  const loopStart = source.indexOf("for (const run of plan.runs)", mainStart);
  assert.notEqual(loopStart, -1);
  const preLoopSource = source.slice(mainStart, loopStart);
  // Not a blanket ban on Date.now() text (the unrelated publish-deadline
  // computation above the loop legitimately uses it) -- specifically, no
  // *declared local variable* whose name reads as a clock/now value or
  // provider exists for prepareRunForSpawn to be handed instead of its own
  // live default.
  assert.doesNotMatch(
    preLoopSource,
    /\bconst\s+\w*[Nn]ow\w*\s*=/,
    "main() must not capture a clock value or provider above the per-run loop",
  );
  const loopSource = source.slice(loopStart);
  assert.match(loopSource, /const spawnRun = prepareRunForSpawn\(run\);/);
  // The one call site itself passes no second argument -- every call gets
  // prepareRunForSpawn's own live default, not something main() threads in.
  assert.doesNotMatch(loopSource, /prepareRunForSpawn\(run,/);
});

test("the resolved plan's decision/matrix state and the materialized run's hosted summary pass redaction audit against a hostile parent", async () => {
  const plan = buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv });
  const { fetchImpl } = fakeS3Store();
  const resolved = await applyHostedLiveMonitorState(plan, {
    fetchImpl,
    deadlineMs: Date.now() + 5000,
    env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
  });
  const liveRun = resolved.runs[1];

  // "The plan": its durable-state decision and matrix contract, which is
  // exactly what ends up embedded in the published manifest -- never the
  // per-run env (operational config, not evidence).
  assert.doesNotThrow(() =>
    assertNoForbiddenEvidenceMarkers(
      { live_monitor: resolved.liveMonitor, matrix: resolved.matrix },
      { context: "resolved plan state", env: HOSTILE_PARENT_ENV },
    ),
  );

  // "The materialized run summary": summarizeHostedRun's sanitized output
  // for the live-smoke run, after materialization has happened.
  const materialized = materializeHostedLiveSmokeRun(
    liveRun,
    { VIVA_VOICE_SESSION_TOKEN_SECRET: "redacted-session-secret" },
    2_000_000_000,
  );
  const summary = summarizeHostedRun(
    materialized,
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      status: "passed",
      provider: "cartesia_gemini",
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
    },
    "/tmp",
    resolved.liveMonitor,
  );
  assert.doesNotThrow(() =>
    assertNoForbiddenEvidenceMarkers(summary, {
      context: "materialized live-smoke run summary",
      env: HOSTILE_PARENT_ENV,
    }),
  );
});

test("hostedMonitorChildEnv keeps a hostile parent's provider keys and signing secret out of the materialized live-smoke child", () => {
  const run = fixtureLiveSmokeRun({
    env: {
      VIVA_AGENT_PROVIDER: "cartesia_gemini",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_SESSION_ID: "session-1",
    },
  });
  const materialized = materializeHostedLiveSmokeRun(
    run,
    { VIVA_VOICE_SESSION_TOKEN_SECRET: "the-real-signing-secret" },
    1_800_000_000,
  );
  const command = { bin: "bun", args: ["run", "live:smoke"], env: {} };

  const childEnv = hostedMonitorChildEnv(materialized, command, HOSTILE_PARENT_ENV);

  assert.equal(childEnv.VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED, "1");
  assert.match(childEnv.VIVA_LIVE_SMOKE_SESSION_TOKEN, /^viva1\./);
  assert.equal("CARTESIA_API_KEY" in childEnv, false);
  assert.equal("GEMINI_API_KEY" in childEnv, false);
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in childEnv, false);
  assert.equal("DATABASE_URL" in childEnv, false);
  assert.equal("VIVA_FAILURE_CONTROL_SECRET" in childEnv, false);
  const serializedChildEnv = JSON.stringify(childEnv);
  assert.doesNotMatch(serializedChildEnv, /hostile-cartesia-key-value/);
  assert.doesNotMatch(serializedChildEnv, /hostile-gemini-key-value/);
  assert.doesNotMatch(serializedChildEnv, /hostile-session-signing-secret/);
  assert.doesNotMatch(serializedChildEnv, /hostile-failure-control-secret/);
  assert.doesNotMatch(serializedChildEnv, /the-real-signing-secret/);
});

test("hosted monitor durable state persists consecutive failures and cost across independently invoked scheduled runs", async () => {
  const { fetchImpl } = fakeS3Store();
  // The frozen production self-quarantine policy observes failures for only
  // one hour, strictly shorter than the six-hour minimum cadence between
  // scheduled runs, so two cadence-respecting invocations can never both
  // fall inside the production observation window. Widen it here to prove
  // the durable persistence mechanism itself — that two independently built
  // plans, with different run IDs and output directories, correctly read
  // back and accumulate state through one shared store — which is exactly
  // what BAC-527 requires and is orthogonal to the separately-tested
  // cadence and observation-window gates.
  const quarantinePolicy = {
    consecutive_failures: 2,
    observation_window_seconds: 86_400,
    cooldown_seconds: 21600,
  };
  const withWiderObservationWindow = (plan) => ({
    ...plan,
    matrix: {
      ...plan.matrix,
      monitor_policy: { ...plan.matrix.monitor_policy, self_quarantine: quarantinePolicy },
    },
  });

  const firstPlan = withWiderObservationWindow(
    buildHostedMonitorPlan({
      ...baseEnv,
      ...liveMonitorTargetEnv,
      VIVA_HOSTED_RUN_ID: "run-2026-06-23a",
    }),
  );
  const firstResolved = await applyHostedLiveMonitorState(firstPlan, {
    fetchImpl,
    deadlineMs: Date.now() + 5000,
    env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T02:00:00.000Z" },
  });
  const firstRun = firstResolved.runs[1];
  assert.equal(firstRun.env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES, "0");

  await finalizeLiveMonitorRun({
    store: firstPlan.artifactStore,
    fetchImpl,
    runId: firstPlan.runId,
    failed: true,
    nowIso: "2026-06-23T02:01:00.000Z",
    quarantinePolicy,
  });

  const secondPlan = withWiderObservationWindow(
    buildHostedMonitorPlan({
      ...baseEnv,
      ...liveMonitorTargetEnv,
      VIVA_HOSTED_RUN_ID: "run-2026-06-23b",
    }),
  );
  const secondResolved = await applyHostedLiveMonitorState(secondPlan, {
    fetchImpl,
    deadlineMs: Date.now() + 5000,
    env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T09:00:00.000Z" },
  });
  const secondRun = secondResolved.runs[1];
  const secondPlanResolved = secondResolved;

  assert.equal(secondRun.env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES, "1");
  assert.equal(secondRun.env.VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES, undefined);
  assert.equal(secondPlanResolved.liveMonitor.cost_usd_today, 0.5);
  assert.equal(secondPlanResolved.liveMonitor.max_cost_usd_per_day, 0.5);

  const secondEvidence = configurationFailureEvidence({
    env: secondRun.env,
    now: () => new Date("2026-06-23T09:00:05.000Z"),
  });
  assert.equal(secondEvidence.failure_class, secondEvidence.failure.failure_class);
  assert.equal(secondEvidence.monitor.live_monitor_consecutive_failures, 2);

  const finalized = await finalizeLiveMonitorRun({
    store: secondPlan.artifactStore,
    fetchImpl,
    runId: secondPlan.runId,
    failed: true,
    nowIso: "2026-06-23T09:00:10.000Z",
    quarantinePolicy,
  });
  assert.equal(finalized.state.last_applied_run_id, secondPlan.runId);
  assert.equal(
    finalized.state.consecutive_failures,
    secondEvidence.monitor.live_monitor_consecutive_failures,
    "durable state, hosted summary, and observability evidence must agree on consecutive failures",
  );
});

test("hosted monitor fails the live leg closed when durable state is unavailable", async () => {
  const plan = buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv });
  const unavailableFetch = async () => ({
    status: 403,
    headers: { get: () => null },
    text: async () => "forbidden",
  });

  const resolved = await applyHostedLiveMonitorState(plan, {
    fetchImpl: unavailableFetch,
    deadlineMs: Date.now() + 5000,
    env: {},
  });

  assert.equal(resolved.liveMonitor.should_run, false);
  assert.equal(resolved.liveMonitor.skip_reason, "state_unavailable");
  assert.deepEqual(
    resolved.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor"],
  );
});

test("hosted monitor durable state honors failure-count self-quarantine before scheduling", async () => {
  const { fetchImpl } = seededFakeS3Store({
    consecutive_failures: 2,
    last_failure_at: "2026-06-23T19:10:00.000Z",
  });

  const plan = buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv });
  const resolved = await applyHostedLiveMonitorState(plan, {
    fetchImpl,
    deadlineMs: Date.now() + 5000,
    env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
  });

  assert.equal(resolved.liveMonitor.should_run, false);
  assert.equal(resolved.liveMonitor.skip_reason, "self_quarantined");
  assert.equal(resolved.liveMonitor.quarantined_until, "2026-06-24T01:10:00.000Z");
});

test("hosted monitor durable state honors the minimum cadence between runs", async () => {
  const { fetchImpl } = seededFakeS3Store({ last_run_at: "2026-06-23T18:20:00.000Z" });

  const plan = buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv });
  const resolved = await applyHostedLiveMonitorState(plan, {
    fetchImpl,
    deadlineMs: Date.now() + 5000,
    env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
  });

  assert.equal(resolved.liveMonitor.should_run, false);
  assert.equal(resolved.liveMonitor.skip_reason, "cadence_wait");
});

test("hosted monitor durable state gates the daily run and token budgets", async () => {
  const runBudget = seededFakeS3Store({ runs_today: 2 });
  const runResolved = await applyHostedLiveMonitorState(
    buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv }),
    {
      fetchImpl: runBudget.fetchImpl,
      deadlineMs: Date.now() + 5000,
      env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
    },
  );
  assert.equal(runResolved.liveMonitor.skip_reason, "daily_budget_exhausted");

  const tokenExhausted = seededFakeS3Store({ tokens_today: 8192 });
  const tokenExhaustedResolved = await applyHostedLiveMonitorState(
    buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv }),
    {
      fetchImpl: tokenExhausted.fetchImpl,
      deadlineMs: Date.now() + 5000,
      env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
    },
  );
  assert.equal(tokenExhaustedResolved.liveMonitor.skip_reason, "daily_token_budget_exhausted");

  const tokenLow = seededFakeS3Store({ tokens_today: 7000 });
  const tokenLowResolved = await applyHostedLiveMonitorState(
    buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv }),
    {
      fetchImpl: tokenLow.fetchImpl,
      deadlineMs: Date.now() + 5000,
      env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
    },
  );
  assert.equal(tokenLowResolved.liveMonitor.skip_reason, "daily_token_budget_remaining_too_low");
  assert.equal(tokenLowResolved.liveMonitor.token_budget_remaining, 1192);
});

test("hosted monitor durable state gates the daily cost budget", async () => {
  const exhausted = seededFakeS3Store({ cost_usd_today: 0.5 });
  const exhaustedResolved = await applyHostedLiveMonitorState(
    buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv }),
    {
      fetchImpl: exhausted.fetchImpl,
      deadlineMs: Date.now() + 5000,
      env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
    },
  );
  assert.equal(exhaustedResolved.liveMonitor.skip_reason, "daily_cost_budget_exhausted");

  const low = seededFakeS3Store({ cost_usd_today: 0.26 });
  const lowResolved = await applyHostedLiveMonitorState(
    buildHostedMonitorPlan({ ...baseEnv, ...liveMonitorTargetEnv }),
    {
      fetchImpl: low.fetchImpl,
      deadlineMs: Date.now() + 5000,
      env: { VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z" },
    },
  );
  assert.equal(lowResolved.liveMonitor.skip_reason, "daily_cost_budget_remaining_too_low");
});

test("hosted monitor scheduled live opt-in requires a pre-provisioned synthetic session", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL: "https://live-agent.example.com/",
        VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD: "0.10",
        VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL: "wss://live-agent.example.com/ws",
        VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
        VIVA_HOSTED_LIVE_MONITOR_REST_BEARER_TOKEN: "redacted-live-rest-bearer",
        VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
      }),
    /VIVA_HOSTED_LIVE_MONITOR_USER_ID/,
  );
});

test("hosted monitor scheduled mode refuses PR matrix profiles", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_MATRIX_PROFILE: "full",
      }),
    /scheduled hosted monitor requires VIVA_HOSTED_MATRIX_PROFILE=scheduled or unset/,
  );
});

test("hosted monitor scheduled live opt-in requires remote cap evidence for runnable live targets", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL: "https://live-agent.example.com/",
        VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL: "wss://live-agent.example.com/ws",
        VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
        VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
      }),
    /VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD/,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL: "https://live-agent.example.com/",
        VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD: "0.5",
        VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL: "wss://live-agent.example.com/ws",
        VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
        VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
      }),
    /must be less than or equal to the hosted live monitor policy cap/,
  );
});

test("hosted monitor scheduled live opt-in fails fast when the session-signing secret is absent, before any durable-state reservation or run is spawned", () => {
  const { VIVA_VOICE_SESSION_TOKEN_SECRET, ...envWithoutSessionSecret } = baseEnv;

  // buildHostedMonitorPlan is fully synchronous and takes no fetchImpl -- if
  // it throws here, no durable-state I/O against the live-monitor budget and
  // no run (browser leg or live leg) could possibly have started yet. That
  // matters because `applyHostedLiveMonitorState` commits a durable S3
  // reservation, and the browser leg spawns, only after this plan is built.
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...envWithoutSessionSecret,
        ...liveMonitorTargetEnv,
      }),
    /VIVA_VOICE_SESSION_TOKEN_SECRET is required/,
  );
});

test("hosted monitor plan validates the session-signing secret's presence without retaining its value", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    ...liveMonitorTargetEnv,
    VIVA_VOICE_SESSION_TOKEN_SECRET: "must-never-be-retained-on-the-plan",
  });

  assert.doesNotMatch(JSON.stringify(plan), /must-never-be-retained-on-the-plan/);
});

test("hosted monitor image generates the live-smoke fixture at protocol sample rate", async () => {
  const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile.monitor"), "utf8");

  assert.match(dockerfile, /espeak-ng/);
  assert.match(dockerfile, /-ar 24000/);
  assert.match(dockerfile, /-f s16le/);
  assert.doesNotMatch(dockerfile, /440/);
  assert.doesNotMatch(dockerfile, /const sampleRate=16000/);
});

test("hosted monitor PR mode expands the deterministic failure-control matrix", () => {
  const runnableFailureControlScenarios = prRunnableFailureControlScenarios();
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    ...allFailureControlTargetEnv(),
    VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
    VIVA_HOSTED_RUNNER_MODE: "pr",
  });

  assert.equal(plan.mode, "pr");
  assert.equal(plan.matrixProfile, "full");
  assert.equal(plan.matrix.scenario_count, 3 + runnableFailureControlScenarios.length);
  assert.equal(plan.matrix.scenario_subset.selected, true);
  assert.equal(plan.matrix.scenario_subset.explicitly_configured, false);
  assert.deepEqual(
    [...plan.matrix.scenario_subset.excluded_requires_browser_action].sort(),
    explicitBrowserActionFailureControlScenarioIds().sort(),
  );
  assert.equal(
    plan.runs.some((run) => sessionAuthFailureControlScenarioIds().includes(run.scenario_id)),
    false,
  );
  assert.deepEqual(
    plan.runs.map((run) => run.name),
    [
      "pr_hosted_synthetic_matrix",
      "pr_hosted_fake_provider_matrix",
      "pr_hosted_token_free_session_history",
      ...runnableFailureControlScenarios.map(
        (scenario) => `pr_hosted_failure_control_${scenario.id}`,
      ),
    ],
  );
  assert.equal(
    plan.matrix.scenarios.some((scenario) => scenario.id === "deterministic_partial_recap"),
    false,
  );
  assert.equal(plan.runs[1].env.VIVA_E2E_AGENT_PROVIDER, "fake_cartesia_gemini");
  assert.equal(plan.runs[1].env.VIVA_E2E_HOSTED_WEB_URL, "https://fake-web.example.com");
  assert.equal(plan.runs[1].env.VIVA_E2E_HOSTED_SCENARIO_ID, "fake_provider_happy_path");
  assert.equal(plan.runs[2].scenario_id, "token_free_session_history");
  assert.equal(plan.runs[2].env.VIVA_E2E_AGENT_PROVIDER, "synthetic");
  assert.equal(plan.runs[2].env.VIVA_E2E_HOSTED_SCENARIO_ID, "token_free_session_history");
  assert.equal(plan.runs[3].scenario_id, runnableFailureControlScenarios[0].id);
  assert.equal(plan.runs[3].env.VIVA_E2E_FAILURE_CONTROL_SCENARIO, "provider_rate_limited");
  assert.equal(plan.runs[3].env.VIVA_E2E_HOSTED_SCENARIO_ID, "provider_rate_limited");
  assert.equal(
    plan.runs[3].env.VIVA_E2E_HOSTED_WEB_URL,
    "https://failure-provider-rate-limited-web.example.com",
  );
  assert.equal(
    plan.runs[3].env.VIVA_E2E_HOSTED_AGENT_HTTP_URL,
    "https://failure-provider-rate-limited-agent.example.com",
  );
  assert.equal(
    plan.runs[3].env.VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS,
    "https://failure-provider-rate-limited-web.example.com",
  );
  assert.equal(plan.runs[3].env.VIVA_FAILURE_CONTROL_ENABLED, "1");
  assert.equal(plan.runs[3].env.VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS, "synthetic-monitor-user");
  assert.equal(plan.runs[3].env.VIVA_FAILURE_CONTROL_STUDY_SET_IDS, "biology-midterm");
});

test("hosted monitor PR mode refuses non-PR matrix profiles", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
        VIVA_HOSTED_MATRIX_PROFILE: "scheduled",
        VIVA_HOSTED_RUNNER_MODE: "pr",
      }),
    /PR hosted monitor requires VIVA_HOSTED_MATRIX_PROFILE=full, pr, or unset/,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
        VIVA_HOSTED_MATRIX_PROFILE: "contract",
        VIVA_HOSTED_RUNNER_MODE: "pr",
      }),
    /PR hosted monitor requires VIVA_HOSTED_MATRIX_PROFILE=full, pr, or unset/,
  );
});

test("hosted monitor PR mode requires per-scenario targets for multi-scenario failure-control runs", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
        VIVA_HOSTED_RUNNER_MODE: "pr",
      }),
    /multi-scenario hosted failure-control PR runs require per-scenario target/,
  );
});

test("hosted monitor PR mode allows a smaller explicit failure-control scenario subset", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    ...failureControlTargetEnvFor("provider_rate_limited"),
    ...failureControlTargetEnvFor("provider_timeout"),
    VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
    VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS: "provider_rate_limited,provider_timeout",
    VIVA_HOSTED_RUNNER_MODE: "pr",
  });

  assert.deepEqual(
    plan.runs.map((run) => run.scenario_id),
    [
      "happy_path",
      "fake_provider_happy_path",
      "token_free_session_history",
      "provider_rate_limited",
      "provider_timeout",
    ],
  );
  assert.equal(plan.matrix.scenario_count, 5);
  assert.equal(plan.matrix.scenario_subset.selected, true);
  assert.equal(plan.matrix.scenario_subset.explicitly_configured, true);
  assert.deepEqual(
    [...plan.matrix.scenario_subset.excluded_requires_browser_action].sort(),
    explicitBrowserActionFailureControlScenarioIds().sort(),
  );
  assert.deepEqual(
    plan.matrix.scenarios.map((scenario) => scenario.id),
    [
      "happy_path",
      "fake_provider_happy_path",
      "token_free_session_history",
      "provider_rate_limited",
      "provider_timeout",
    ],
  );
});

test("hosted monitor PR mode rejects failure-control scenarios needing explicit browser actions", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
        VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS: "mic_denied",
        VIVA_HOSTED_RUNNER_MODE: "pr",
      }),
    /require explicit browser actions/,
  );
});

test("hosted monitor PR mode rejects session-auth failure-control scenarios", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
        VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS: sessionAuthFailureControlScenarioIds()[0],
        VIVA_HOSTED_RUNNER_MODE: "pr",
      }),
    /require explicit browser actions/,
  );
});

test("hosted monitor PR mode allows the generic failure-control target for one explicit scenario", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
    VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS: "provider_rate_limited",
    VIVA_HOSTED_RUNNER_MODE: "pr",
  });
  const failureRun = plan.runs.at(-1);

  assert.equal(failureRun.scenario_id, "provider_rate_limited");
  assert.equal(failureRun.env.VIVA_E2E_HOSTED_WEB_URL, "https://failure-web.example.com");
  assert.equal(failureRun.env.VIVA_E2E_HOSTED_AGENT_HTTP_URL, "https://failure-agent.example.com");
});

function decodedSignedSession(value, secret) {
  assert.match(value, /^viva1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [prefix, claimsPart, signature] = value.split(".");
  const payload = `${prefix}.${claimsPart}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  assert.equal(signature, expected);
  return JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
}

test("hosted monitor rejects unknown matrix profiles", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
        VIVA_HOSTED_MATRIX_PROFILE: "typo",
        VIVA_HOSTED_RUNNER_MODE: "pr",
      }),
    /unsupported hosted E2E matrix profile/,
  );
});

test("hosted monitor summaries include live smoke quarantine evidence", () => {
  const summary = summarizeHostedRun(
    { name: "scheduled_hosted_live_smoke", runner: "live-provider-smoke" },
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      status: "failed",
      provider: "cartesia_gemini",
      websocket: { terminal_reason: "provider_rate_limited" },
      failure: { failure_class: "quota_rate_failure" },
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
    },
    "/tmp",
  );

  assert.equal(summary.runner, "live-provider-smoke");
  assert.equal(summary.live_smoke.status, "failed");
  assert.equal(summary.live_smoke.terminal_reason, "provider_rate_limited");
  assert.equal(summary.live_smoke.self_quarantine.current_failure, true);
  assert.equal(summary.live_smoke.self_quarantine.triggered, false);
  assert.equal(summary.live_smoke.self_quarantine.consecutive_failures, 1);
  assert.equal(summary.live_smoke.self_quarantine.cooldown_seconds, 21600);
  assert.equal(summary.hosted_e2e, null);
});

test("hosted monitor summaries bind live smoke identity to the run the monitor itself constructed and dispatched, not the child's self-report", () => {
  const summary = summarizeHostedRun(
    {
      name: "scheduled_hosted_live_smoke",
      runner: "live-provider-smoke",
      runId: "release-run-9",
      deploySha: "deploysha9999999999999999999999999999999999",
      agentDeployId: "agent-deploy-9",
    },
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      status: "passed",
      provider: "cartesia_gemini",
      terminal_reason: "recap_observed",
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
      // The child's own self-report is deliberately different from the run
      // the monitor dispatched, proving the summary trusts the monitor's
      // own authoritative binding rather than whatever the (potentially
      // environment-blind) child happened to report about itself.
      run_id: "some-other-run-id",
      agent_deploy_id: "some-other-agent-deploy",
      deploy_sha: "unknown",
    },
    "/tmp",
  );

  assert.equal(summary.live_smoke.run_id, "release-run-9");
  assert.equal(summary.live_smoke.agent_deploy_id, "agent-deploy-9");
  assert.equal(summary.live_smoke.deploy_sha, "deploysha9999999999999999999999999999999999");
});

test("hosted monitor summaries fall back to the child's own reported live smoke identity when the dispatched run carries none", () => {
  const summary = summarizeHostedRun(
    { name: "scheduled_hosted_live_smoke", runner: "live-provider-smoke" },
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      status: "passed",
      provider: "cartesia_gemini",
      terminal_reason: "recap_observed",
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
      run_id: "child-reported-run-id",
      agent_deploy_id: "child-reported-agent-deploy",
      deploy_sha: "child-reported-sha",
    },
    "/tmp",
  );

  assert.equal(summary.live_smoke.run_id, "child-reported-run-id");
  assert.equal(summary.live_smoke.agent_deploy_id, "child-reported-agent-deploy");
  assert.equal(summary.live_smoke.deploy_sha, "child-reported-sha");
});

test("hosted monitor summaries keep transport, protocol, and structured-error counters distinct", () => {
  const summary = summarizeHostedRun(
    { name: "scheduled_hosted_live_smoke", runner: "live-provider-smoke" },
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      status: "failed",
      provider: "cartesia_gemini",
      terminal_reason: "socket_error",
      failure: { failure_class: "network_disconnect" },
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
      websocket: {
        terminal_reason: "socket_error",
        event_counts: { transport_error: 1, protocol_error: 0, structured_error: 0 },
      },
    },
    "/tmp",
  );

  assert.deepEqual(summary.live_smoke.event_counts, {
    transport_error: 1,
    protocol_error: 0,
    structured_error: 0,
  });
});

test("hosted monitor summaries require consecutive live failures before quarantine", () => {
  const summary = summarizeHostedRun(
    { name: "scheduled_hosted_live_smoke", runner: "live-provider-smoke" },
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      generated_at: "2026-06-23T19:20:00.000Z",
      status: "failed",
      provider: "cartesia_gemini",
      terminal_reason: "provider_rate_limited",
      failure: { failure_class: "quota_rate_failure" },
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
    },
    "/tmp",
    {
      consecutive_failures: 1,
      last_failure_at: "2026-06-23T19:10:00.000Z",
      prior_failure_stale: false,
      seconds_since_last_failure: 600,
    },
  );

  assert.equal(summary.live_smoke.self_quarantine.triggered, true);
  assert.equal(summary.live_smoke.self_quarantine.consecutive_failures, 2);
  assert.equal(summary.live_smoke.self_quarantine.required_consecutive_failures, 2);
});

test("hosted monitor expires stale live-failure counts before quarantine", () => {
  const summary = summarizeHostedRun(
    { name: "scheduled_hosted_live_smoke", runner: "live-provider-smoke" },
    "/tmp/run",
    "/tmp/run/live-smoke",
    { exit_code: 0, sanitized: true, status: "passed" },
    {
      schema: "viva.live_provider_smoke.v1",
      generated_at: "2026-06-23T19:20:00.000Z",
      status: "failed",
      provider: "cartesia_gemini",
      terminal_reason: "provider_rate_limited",
      failure: { failure_class: "quota_rate_failure" },
      caps: { max_session_cost_usd: 0.25 },
      privacy: { raw_audio_retained: false },
    },
    "/tmp",
    {
      consecutive_failures: 0,
      last_failure_at: "2026-06-23T17:00:00.000Z",
      prior_failure_stale: true,
      seconds_since_last_failure: 8400,
    },
  );

  assert.equal(summary.live_smoke.self_quarantine.triggered, false);
  assert.equal(summary.live_smoke.self_quarantine.consecutive_failures, 1);
  assert.equal(summary.live_smoke.self_quarantine.prior_failure_stale, true);
  assert.equal(summary.live_smoke.self_quarantine.seconds_since_last_failure, 8400);
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

test("hosted monitor validates run timeout", () => {
  assert.equal(
    buildHostedMonitorPlan({
      ...baseEnv,
      VIVA_HOSTED_RUN_TIMEOUT_MS: "120000",
    }).runTimeoutMs,
    120000,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_RUN_TIMEOUT_MS: "0",
      }),
    /VIVA_HOSTED_RUN_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_PUBLISH_TIMEOUT_MS: "0",
      }),
    /VIVA_HOSTED_PUBLISH_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_RUN_ID: "..",
      }),
    /must not be empty or a dot path segment/,
  );
});

test("hosted monitor writes final manifest for timed-out runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-manifest-"));
  try {
    const run = { name: "scheduled_hosted_synthetic_monitor" };
    const runDir = path.join(dir, run.name);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "timeout.json"),
      `${JSON.stringify(
        {
          failure_class: "timeout",
          run: run.name,
          sanitized: true,
          status: "timed_out",
          timeout_ms: 120000,
        },
        null,
        2,
      )}\n`,
    );

    const summary = {
      schema: "viva.hosted_monitor_run.v1",
      mode: "scheduled",
      run_id: "run-id",
      runs: [
        summarizeHostedRun(
          run,
          runDir,
          runDir,
          {
            failure_class: "timeout",
            sanitized: true,
            status: "timed_out",
            timeout_ms: 120000,
          },
          null,
          dir,
        ),
      ],
    };
    const published = await writePublishedManifest(dir, summary, {
      artifactPrefix: "viva-hosted-monitor/scheduled/run-id",
      artifactStore: { bucket: "viva-monitor-evidence" },
    });

    assert.equal(published.status, "failed");
    assert.equal(published.runs[0].status, "timed_out");
    assert.equal(published.runs[0].failure_class, "timeout");
    assert.equal(published.durable_artifact_store.uploaded_files, 2);

    const stored = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.runs[0].status, "timed_out");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("hosted monitor summarizes browser artifacts below the run log directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-summary-"));
  try {
    const run = { name: "scheduled_hosted_synthetic_monitor" };
    const runDir = path.join(dir, run.name);
    const browserDir = path.join(runDir, "browser");
    await mkdir(browserDir, { recursive: true });

    const summary = summarizeHostedRun(
      run,
      runDir,
      browserDir,
      { exit_code: 0, sanitized: true, status: "passed" },
      {
        browser_story_artifact: "browser-story.json",
        browser_story: { frames: [{ id: "recap" }] },
        manuscript_ready: true,
        page_errors: [],
      },
      dir,
    );

    assert.equal(summary.artifact_dir, "scheduled_hosted_synthetic_monitor");
    assert.equal(summary.browser_story_artifact, "browser/browser-story.json");
    assert.deepEqual(summary.browser_story_frames, ["recap"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("hosted monitor S3 uploads honor the publication deadline", async () => {
  assert.equal(remainingPublishMs(110, 100), 10);
  assert.throws(() => remainingPublishMs(99, 100), /publication timed out/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  try {
    await assert.rejects(
      () =>
        putS3Object(
          {
            accessKeyId: "redacted-key-id",
            bucket: "viva-monitor-evidence",
            endpoint: "https://storage.example.com",
            region: "auto",
            secretAccessKey: "redacted-secret-key",
          },
          "viva-hosted-monitor/scheduled/run-id/result.json",
          Buffer.from("{}\n"),
          "application/json",
          { deadlineMs: Date.now() + 20 },
        ),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted monitor S3 publish retries a transient network error then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNRESET");
    return fakeS3Response(200, '"etag-1"', "");
  };
  const sleepCalls = [];
  await putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
    fetchImpl,
    jitter: () => 0,
    nowMs: () => Date.now(),
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });
  assert.equal(calls, 2, "must retry exactly once after the transient network error");
  assert.equal(sleepCalls.length, 1);
});

test("hosted monitor S3 publish retries HTTP 503 then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return fakeS3Response(503, null, "unavailable");
    return fakeS3Response(200, '"etag-1"', "");
  };
  await putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
    fetchImpl,
    jitter: () => 0,
    sleep: async () => {},
  });
  assert.equal(calls, 2, "must retry exactly once after the transient 503");
});

test("hosted monitor S3 publish honors bounded retry under HTTP 429 without exceeding the overall deadline", async () => {
  const start = 1_000_000;
  let now = start;
  const deadlineMs = start + 10_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    now += 5;
    return fakeS3Response(429, null, "slow down");
  };
  const sleepCalls = [];
  await assert.rejects(
    () =>
      putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
        deadlineMs,
        fetchImpl,
        jitter: () => 0,
        nowMs: () => now,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          now += ms;
        },
      }),
    /HTTP 429/,
  );
  assert.equal(calls, 3, "at most three attempts total");
  assert.equal(sleepCalls.length, 2, "backoff happens only between attempts, never after the last");
  assert.ok(now <= deadlineMs, "the simulated clock never runs past the publication deadline");
});

test("hosted monitor S3 publish fails immediately on HTTP 403 with exactly one attempt", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeS3Response(403, null, "forbidden");
  };
  await assert.rejects(
    () =>
      putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
        fetchImpl,
        sleep: async () => {
          throw new Error("must not back off before a non-retryable 4xx");
        },
      }),
    /HTTP 403/,
  );
  assert.equal(calls, 1, "a non-retryable 4xx must not be retried");
});

test("hosted monitor S3 publish backoff refuses to start when the remaining deadline cannot cover it", async () => {
  const start = 1_000_000;
  let now = start;
  const deadlineMs = start + 25;
  const fetchImpl = async () => {
    now += 24;
    return fakeS3Response(503, null, "unavailable");
  };
  const sleepCalls = [];
  await assert.rejects(
    () =>
      putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
        deadlineMs,
        fetchImpl,
        jitter: () => 0,
        nowMs: () => now,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      }),
    /HTTP 503/,
  );
  assert.equal(sleepCalls.length, 0, "backoff must never start once it cannot fit before the deadline");
});

test("hosted monitor S3 publish recalculates SigV4 per attempt so a retried request never reuses a stale signature", async () => {
  // Two attempts landing in the same wall-clock second legitimately produce
  // the same SigV4 signature (AWS's x-amz-date has one-second granularity);
  // the clock is advanced a full second between attempts so this test proves
  // genuine per-attempt recomputation rather than asserting on timing luck.
  let now = 1_700_000_000_000;
  const signatures = [];
  let calls = 0;
  const fetchImpl = async (_url, init = {}) => {
    calls += 1;
    signatures.push(init.headers.authorization);
    if (calls === 1) return fakeS3Response(500, null, "internal error");
    return fakeS3Response(200, '"etag-1"', "");
  };
  await putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
    fetchImpl,
    jitter: () => 0,
    nowMs: () => now,
    sleep: async () => {
      now += 1_500;
    },
  });
  assert.equal(signatures.length, 2);
  assert.notEqual(signatures[0], signatures[1], "each attempt must recompute its own SigV4 signature");
});

test("hosted monitor never uploads the manifest when an earlier object's publication exhausts its retries, and records a sanitized local publish failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-publish-fail-"));
  try {
    await writeFile(path.join(dir, "result.json"), '{"ok":true}\n');
    await writeFile(path.join(dir, "e2e.stdout.log"), "log\n");

    const putKeys = [];
    const fetchImpl = async (rawUrl) => {
      const url = new URL(rawUrl);
      const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
      putKeys.push(key);
      if (key.endsWith("result.json")) return fakeS3Response(500, null, "internal error");
      return fakeS3Response(200, '"etag-1"', "");
    };

    const plan = {
      artifactPrefix: "viva-hosted-monitor/scheduled/run-publish-fail",
      artifactStore: FAKE_ARTIFACT_STORE,
      publishTimeoutMs: 5_000,
    };
    const summary = { runs: [], schema: "viva.hosted_monitor_run.v1" };

    await assert.rejects(
      () =>
        publishHostedEvidence(dir, summary, plan, {
          fetchImpl,
          jitter: () => 0,
          sleep: async () => {},
        }),
      /HTTP 500/,
    );

    assert.ok(
      !putKeys.some((key) => key.endsWith("manifest.json")),
      "the manifest must never be uploaded once an earlier object's publication has failed",
    );

    const failure = JSON.parse(await readFile(path.join(dir, "publish-failure.json"), "utf8"));
    assert.equal(failure.failure_class, "publish_failed");
    assert.ok(failure.object_key.endsWith("result.json"));
    assert.equal(failure.attempt_count, 3);
    assert.equal(failure.sanitized, true);
    const serializedFailure = JSON.stringify(failure);
    assert.doesNotMatch(serializedFailure, /redacted-secret-key/);
    assert.doesNotMatch(serializedFailure, /AWS4-HMAC-SHA256/);
    assert.doesNotMatch(serializedFailure, /authorization/i);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("hosted monitor records object key and attempt count in publish-failure.json when the publication deadline itself runs out between an attempt's response and its backoff", async () => {
  // Distinct from the HTTP-500-retry-exhaustion test above: here every
  // response is retryable (so the loop never throws from the HTTP-status
  // branch), and the clock is driven past `deadlineMs` inside the fetch
  // itself so `remainingPublishMs` throws its own bare "publication timed
  // out" error from the post-response backoff-budget check, not from a
  // classified `s3PublishError` -- exactly the path that used to lose the
  // in-flight object key and attempt count.
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-publish-deadline-"));
  try {
    await writeFile(path.join(dir, "result.json"), '{"ok":true}\n');

    const start = 1_000_000;
    const deadlineMs = start + 50;
    let now = start;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      now = deadlineMs + 1;
      return fakeS3Response(500, null, "internal error");
    };

    const plan = {
      artifactPrefix: "viva-hosted-monitor/scheduled/run-publish-deadline",
      artifactStore: FAKE_ARTIFACT_STORE,
      publishTimeoutMs: 5_000,
    };
    const summary = { runs: [], schema: "viva.hosted_monitor_run.v1" };

    await assert.rejects(
      () =>
        publishHostedEvidence(dir, summary, plan, {
          deadlineMs,
          fetchImpl,
          jitter: () => 0,
          nowMs: () => now,
          sleep: async () => {},
        }),
      /publication timed out/,
    );
    assert.equal(calls, 1, "the deadline must be observed before a second attempt is ever sent");

    const failure = JSON.parse(await readFile(path.join(dir, "publish-failure.json"), "utf8"));
    assert.equal(failure.failure_class, "publish_failed");
    assert.ok(
      failure.object_key !== null && failure.object_key.endsWith("result.json"),
      `expected object_key to name the in-flight object, got ${JSON.stringify(failure.object_key)}`,
    );
    assert.equal(failure.attempt_count, 1);
    assert.equal(failure.sanitized, true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("hosted monitor S3 publish preserves object key and attempt count when the deadline runs out before a later attempt ever starts", async () => {
  // The mirror-image timing of the test above: the backoff itself (not the
  // fetch) is what consumes the remaining budget, so the *next* attempt's
  // own pre-fetch `remainingPublishMs` call is what throws, before any
  // fetch for that attempt is ever issued.
  const start = 1_000_000;
  const deadlineMs = start + 100;
  let now = start;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeS3Response(500, null, "internal error");
  };
  await assert.rejects(
    () =>
      putS3Object(FAKE_ARTIFACT_STORE, "run/result.json", Buffer.from("{}\n"), "application/json", {
        deadlineMs,
        fetchImpl,
        jitter: () => 0,
        nowMs: () => now,
        sleep: async () => {
          now = deadlineMs + 1;
        },
      }),
    (error) => {
      assert.match(error.message, /publication timed out/);
      assert.equal(error.objectKey, "run/result.json");
      assert.equal(error.attempts, 2);
      return true;
    },
  );
  assert.equal(calls, 1, "the second attempt must never send a request once the deadline has passed");
});

test("hosted monitor publishes the manifest last only after every earlier object succeeds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-publish-order-"));
  try {
    await writeFile(path.join(dir, "result.json"), '{"ok":true}\n');
    await writeFile(path.join(dir, "e2e.stdout.log"), "log\n");

    const putKeys = [];
    const fetchImpl = async (rawUrl) => {
      const url = new URL(rawUrl);
      const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
      putKeys.push(key);
      return fakeS3Response(200, `"etag-${putKeys.length}"`, "");
    };

    const plan = {
      artifactPrefix: "viva-hosted-monitor/scheduled/run-publish-order",
      artifactStore: FAKE_ARTIFACT_STORE,
      publishTimeoutMs: 5_000,
    };
    const summary = { runs: [], schema: "viva.hosted_monitor_run.v1" };

    await publishHostedEvidence(dir, summary, plan, { fetchImpl });

    assert.equal(putKeys.at(-1), "viva-hosted-monitor/scheduled/run-publish-order/manifest.json");
    assert.equal(putKeys.filter((key) => key.endsWith("manifest.json")).length, 1);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
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

test("hosted monitor only publishes text evidence files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-"));
  try {
    await writeFile(path.join(dir, "result.json"), "{}\n");
    await writeFile(path.join(dir, "e2e.stdout.log"), "ok\n");
    await writeFile(path.join(dir, "manifest.json"), "{}\n");
    await writeFile(path.join(dir, "source-folio.png"), "not-published");

    assert.equal(isPublishableHostedArtifact("result.json"), true);
    assert.equal(isPublishableHostedArtifact("e2e.stdout.log"), true);
    assert.equal(isPublishableHostedArtifact("source-folio.png"), false);
    // ROW 682/RELEASE-025: the dead image/png content-type branch's absence
    // was comment-only until now -- a PNG (never reachable via
    // publishableHostedFiles above, but contentTypeFor's own contract) must
    // still fall through to the generic binary type, not image/png.
    assert.equal(contentTypeFor("source-folio.png"), "application/octet-stream");
    // ROW 475/QLT-06: putS3Object's abort deadline must stay referenced --
    // an unref'd timer let Node 24's event loop end before it fired.
    const src = readFileSync(new URL("./hosted-monitor-runner.mjs", import.meta.url), "utf8");
    const decl = src.indexOf("const timeout = setTimeout(() => controller.abort(), timeoutMs);");
    assert.notEqual(decl, -1, "the abort timer declaration must exist for the unref pin to bind");
    assert.doesNotMatch(src.slice(decl, src.indexOf("clearTimeout(timeout)", decl)), /timeout\.unref/);
    assert.equal(isRejectedHostedArtifact("trace.zip"), true);
    assert.equal(isRejectedHostedArtifact("trace.tar"), true);
    assert.equal(isRejectedHostedArtifact("trace.tgz"), true);
    assert.equal(isRejectedHostedArtifact("trace.tar.gz"), true);
    assert.equal(isRejectedHostedArtifact("trace.7z"), true);
    assert.equal(isRejectedHostedArtifact("trace.rar"), true);
    assert.deepEqual(
      (await publishableHostedFiles(dir)).map((file) => path.basename(file)),
      ["e2e.stdout.log", "result.json"],
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

const FAKE_ARTIFACT_STORE = Object.freeze({
  accessKeyId: "redacted-key-id",
  bucket: "viva-monitor-evidence",
  endpoint: "https://storage.example.com",
  region: "auto",
  secretAccessKey: "redacted-secret-key",
});

function fakeS3Store({ seed = {} } = {}) {
  const objects = new Map();
  for (const [key, value] of Object.entries(seed)) {
    objects.set(key, { etag: `"seed-${objects.size}"`, body: JSON.stringify(value) });
  }
  const calls = [];
  let counter = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const method = init.method ?? "GET";
    const headers = lowercaseHeaders(init.headers ?? {});
    calls.push({ key, method, headers });
    const existing = objects.get(key);
    if (method === "GET") {
      if (!existing) return fakeS3Response(404, null, "");
      return fakeS3Response(200, existing.etag, existing.body);
    }
    if (method === "PUT") {
      const ifNoneMatch = headers["if-none-match"];
      const ifMatch = headers["if-match"];
      if (ifNoneMatch !== undefined) {
        if (existing) return fakeS3Response(412, existing.etag, "");
      } else if (ifMatch !== undefined) {
        if (!existing || existing.etag !== ifMatch) {
          return fakeS3Response(412, existing?.etag ?? null, "");
        }
      }
      counter += 1;
      const etag = `"etag-${counter}"`;
      objects.set(key, { etag, body: bodyToString(init.body) });
      return fakeS3Response(200, etag, "");
    }
    throw new Error(`fake store: unsupported method ${method}`);
  };
  return { fetchImpl, objects, calls };
}

function seededFakeS3Store(overrides) {
  return fakeS3Store({
    seed: {
      [HOSTED_LIVE_MONITOR_STATE_OBJECT_KEY]: {
        ...zeroLiveMonitorState("2026-06-23"),
        ...overrides,
      },
    },
  });
}

function fakeS3Response(status, etag, text) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
    text: async () => text,
  };
}

function lowercaseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function bodyToString(body) {
  if (body === undefined || body === null) return "";
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return String(body);
}

// RELEASE-015: the hosted runner's own children are `bun run e2e:browser` /
// `bun run live:smoke` wrappers that exec further processes. A timeout that
// signals only the wrapper pid leaves a Chromium or agent grandchild holding
// the evidence directory and the port, and ending the log streams at signal
// time throws away the diagnostic that explains the timeout.
test("a hosted run that outlives its timeout is reaped as a whole process group with complete logs", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-supervise-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reportPath = path.join(dir, "grandchild.json");
  const grandchildScript = path.join(dir, "grandchild.mjs");
  const wrapper = path.join(dir, "wrapper.mjs");
  await writeFile(
    grandchildScript,
    [
      'import { writeFile } from "node:fs/promises";',
      'import net from "node:net";',
      'const server = net.createServer((socket) => socket.end());',
      'server.listen(0, "127.0.0.1", async () => {',
      `  await writeFile(${JSON.stringify(reportPath)}, JSON.stringify({ pid: process.pid }));`,
      "});",
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    wrapper,
    [
      'import { spawn } from "node:child_process";',
      `spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      'process.stdout.write("wrapper started\\n");',
      'process.on("SIGTERM", () => process.stdout.write("wrapper ignored SIGTERM\\n"));',
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
    "utf8",
  );

  const run = {
    name: "timeout-fixture",
    runner: "e2e-browser",
    timeoutMs: 700,
    env: {},
  };
  const outcome = await runHostedMonitorCommand(run, dir, dir, {
    commandFactory: () => ({ bin: process.execPath, args: [wrapper], env: {} }),
    graceMs: 400,
  });

  assert.equal(outcome.status, "timed_out");
  assert.equal(outcome.run, "timeout-fixture");
  assert.equal(outcome.sanitized, true);

  const grandchild = JSON.parse(await readFile(reportPath, "utf8"));
  const gone = await (async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        process.kill(grandchild.pid, 0);
      } catch (error) {
        return error?.code === "ESRCH";
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  })();
  assert.equal(gone, true, "the timed-out run's grandchild must not survive the runner");

  // The log written while the wrapper was refusing SIGTERM is on disk: the
  // streams were ended only after the child itself was gone.
  const stdout = await readFile(path.join(dir, "e2e.stdout.log"), "utf8");
  assert.match(stdout, /wrapper started/);
  assert.match(stdout, /wrapper ignored SIGTERM/);
});

test("a hosted run whose command cannot be spawned records a sanitized spawn failure, never an escaping rejection", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-spawn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outcome = await runHostedMonitorCommand(
    { name: "missing-binary", runner: "e2e-browser", timeoutMs: 5_000, env: {} },
    dir,
    dir,
    {
      commandFactory: () => ({
        bin: path.join(dir, "viva-not-a-real-binary"),
        args: [],
        env: {},
      }),
    },
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure_class, "spawn_error");
  assert.equal(outcome.sanitized, true);
});
