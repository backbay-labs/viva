import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FAILURE_CONTROL_SCENARIOS } from "./failure-control-harness.mjs";
import { failureControlScenarioRequiresExplicitBrowserAction } from "./hosted-e2e-matrix.mjs";
import {
  buildHostedMonitorPlan,
  buildObjectKey,
  isPublishableHostedArtifact,
  isRejectedHostedArtifact,
  normalizeHostedUrl,
  publishableHostedFiles,
  putS3Object,
  remainingPublishMs,
  summarizeHostedRun,
  writePublishedManifest,
} from "./hosted-monitor-runner.mjs";

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
});

test("hosted monitor scheduled live opt-in runs bounded live smoke", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL: "https://live-agent.example.com/",
    VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD: "0.10",
    VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL: "wss://live-agent.example.com/ws",
    VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES: "1",
    VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
    VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT: "2026-06-23T19:10:00.000Z",
    VIVA_HOSTED_LIVE_MONITOR_REST_BEARER_TOKEN: "redacted-live-rest-bearer",
    VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "1",
    VIVA_HOSTED_LIVE_MONITOR_SESSION_ID: "live-monitor-session-1",
    VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
    VIVA_HOSTED_LIVE_MONITOR_STUDY_SET_ID: "live-monitor-study-set",
    VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "2048",
    VIVA_HOSTED_LIVE_MONITOR_USER_ID: "synthetic-live-monitor-user",
    VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
    VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
  });

  assert.deepEqual(
    plan.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor", "scheduled_hosted_live_smoke"],
  );
  assert.equal(plan.runs[1].runner, "live-provider-smoke");
  assert.equal(plan.runs[1].resultFileName, "evidence.json");
  assert.equal(plan.runs[1].env.VIVA_LIVE_PROVIDER_SMOKE, "1");
  assert.equal(plan.runs[1].env.VIVA_AGENT_PROVIDER, "cartesia_gemini");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_AGENT_HTTP_URL, "https://live-agent.example.com");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_AGENT_WS_URL, "wss://live-agent.example.com/ws");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_ORIGIN, "https://live-web.example.com");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_MAX_DURATION_MS, "90000");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_MAX_TURNS, "1");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES, "262144");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_AUDIO_FILE, "/app/evidence/live-smoke-answer.pcm");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_MAX_TOKENS, "4096");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_SESSION_ID, "live-monitor-session-1");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_STUDY_SET_ID, "live-monitor-study-set");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_USER_ID, "synthetic-live-monitor-user");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_SESSION_TOKEN, undefined);
  assert.equal(plan.runs[1].env.VIVA_VOICE_WS_BEARER_TOKEN, "redacted-live-rest-bearer");
  assert.equal(plan.runs[1].env.VIVA_VOICE_WS_MAX_SESSION_COST_USD, "0.1");
  assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD, "0.1");
  assert.equal(plan.runs[1].env.VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES, "1");
  assert.equal(
    plan.runs[1].env.VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT,
    "2026-06-23T19:10:00.000Z",
  );
  assert.equal(plan.runs[1].env.VIVA_HOSTED_LIVE_MONITOR_BUDGET_BUCKET, undefined);
  assert.equal(plan.runs[1].timeoutMs, 90000);
  assert.equal(plan.liveMonitor.should_run, true);
  assert.equal(plan.liveMonitor.runs_today, 1);
  assert.equal(plan.liveMonitor.tokens_today, 2048);
  assert.equal(plan.liveMonitor.consecutive_failures, 1);
  assert.equal(plan.liveMonitor.last_failure_at, "2026-06-23T19:10:00.000Z");
  assert.equal(plan.liveMonitor.seconds_since_last_failure, 600);
  assert.equal("budget_bucket" in plan.matrix.monitor_policy.live_monitor, false);

  const summary = summarizeHostedRun(
    plan.runs[1],
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
      caps: { max_session_cost_usd: 0.1 },
      privacy: { raw_audio_retained: false },
    },
    "/tmp",
  );
  assert.equal(summary.live_smoke.self_quarantine.triggered, true);
  assert.equal(summary.live_smoke.self_quarantine.consecutive_failures, 2);
});

test("hosted monitor image generates the live-smoke fixture at protocol sample rate", async () => {
  const dockerfile = await readFile(path.join(process.cwd(), "Dockerfile.monitor"), "utf8");

  assert.match(dockerfile, /const sampleRate=24000/);
  assert.doesNotMatch(dockerfile, /const sampleRate=16000/);
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
        VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "0",
        VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
        VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "0",
        VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
        VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
      }),
    /VIVA_HOSTED_LIVE_MONITOR_USER_ID/,
  );
});

test("hosted monitor scheduled live opt-in gates cadence and daily budget before scheduling", () => {
  const cadence = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
    VIVA_HOSTED_LIVE_MONITOR_LAST_RUN_AT: "2026-06-23T18:20:00.000Z",
    VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
    VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "1",
    VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
    VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "1024",
  });
  assert.deepEqual(
    cadence.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor"],
  );
  assert.equal(cadence.liveMonitor.skip_reason, "cadence_wait");

  const dailyBudget = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
    VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
    VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "2",
    VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
    VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "1024",
  });
  assert.deepEqual(
    dailyBudget.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor"],
  );
  assert.equal(dailyBudget.liveMonitor.skip_reason, "daily_budget_exhausted");
});

test("hosted monitor scheduled live opt-in gates daily token budget", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
    VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
    VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "1",
    VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
    VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "8192",
  });

  assert.deepEqual(
    plan.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor"],
  );
  assert.equal(plan.liveMonitor.skip_reason, "daily_token_budget_exhausted");
  assert.equal(plan.liveMonitor.max_tokens_per_day, 8192);
  assert.equal(plan.liveMonitor.tokens_today, 8192);

  const lowRemaining = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
    VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
    VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "1",
    VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
    VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "7000",
  });

  assert.deepEqual(
    lowRemaining.runs.map((run) => run.name),
    ["scheduled_hosted_synthetic_monitor"],
  );
  assert.equal(lowRemaining.liveMonitor.skip_reason, "daily_token_budget_remaining_too_low");
  assert.equal(lowRemaining.liveMonitor.max_tokens_per_day, 8192);
  assert.equal(lowRemaining.liveMonitor.max_tokens_per_run, 4096);
  assert.equal(lowRemaining.liveMonitor.token_budget_remaining, 1192);
  assert.equal(lowRemaining.liveMonitor.tokens_today, 7000);
});

test("hosted monitor scheduled live opt-in requires remote cap evidence for runnable live targets", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL: "https://live-agent.example.com/",
        VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL: "wss://live-agent.example.com/ws",
        VIVA_HOSTED_LIVE_MONITOR_ENABLED: "1",
        VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
        VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "0",
        VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
        VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "0",
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
        VIVA_HOSTED_LIVE_MONITOR_NOW: "2026-06-23T19:20:00.000Z",
        VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY: "0",
        VIVA_HOSTED_LIVE_MONITOR_STATE_DATE: "2026-06-23",
        VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY: "0",
        VIVA_HOSTED_LIVE_MONITOR_WEB_URL: "https://live-web.example.com/",
      }),
    /must be less than or equal to the hosted live monitor policy cap/,
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
  assert.deepEqual(plan.matrix.scenario_subset.excluded_requires_browser_action, [
    "double_submit_race",
    "mic_denied",
    "typed_fallback",
  ]);
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
  assert.deepEqual(plan.matrix.scenario_subset.excluded_requires_browser_action, [
    "double_submit_race",
    "mic_denied",
    "typed_fallback",
  ]);
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

test("hosted monitor summaries require consecutive live failures before quarantine", () => {
  const summary = summarizeHostedRun(
    {
      name: "scheduled_hosted_live_smoke",
      runner: "live-provider-smoke",
      env: {
        VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES: "1",
        VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT: "2026-06-23T19:10:00.000Z",
      },
    },
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
  );

  assert.equal(summary.live_smoke.self_quarantine.triggered, true);
  assert.equal(summary.live_smoke.self_quarantine.consecutive_failures, 2);
  assert.equal(summary.live_smoke.self_quarantine.required_consecutive_failures, 2);
});

test("hosted monitor expires stale live-failure counts before quarantine", () => {
  const summary = summarizeHostedRun(
    {
      name: "scheduled_hosted_live_smoke",
      runner: "live-provider-smoke",
      env: {
        VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES: "1",
        VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT: "2026-06-23T17:00:00.000Z",
      },
    },
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
