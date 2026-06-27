#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  buildHostedE2eMatrixContract,
  defaultMatrixProfile,
  failureControlScenarioIdsForProfile,
  failureControlScenarioRequiresExplicitBrowserAction,
  HOSTED_MONITOR_POLICY,
  summarizeHostedE2eResult,
} from "./hosted-e2e-matrix.mjs";
import { auditTextArtifacts } from "./redaction-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostedArtifactRoot = path.join(root, "artifacts/hosted-monitor");
const defaultRunTimeoutMs = 10 * 60 * 1000;
const defaultPublishTimeoutMs = 2 * 60 * 1000;
const PR_BROWSER_SCENARIO_IDS = Object.freeze([
  "happy_path",
  "fake_provider_happy_path",
  "token_free_session_history",
]);

export function buildHostedMonitorPlan(env = process.env) {
  const mode = (env.VIVA_HOSTED_RUNNER_MODE || "scheduled").trim();
  if (!["scheduled", "pr"].includes(mode)) {
    throw new Error("VIVA_HOSTED_RUNNER_MODE must be scheduled or pr");
  }

  const syntheticUserId = requiredValue(env, "VIVA_HOSTED_SYNTHETIC_USER_ID");
  const syntheticStudySetId = requiredValue(env, "VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID");
  assertSyntheticIdentity(syntheticUserId);
  const runTimeoutMs = positiveInteger(
    env.VIVA_HOSTED_RUN_TIMEOUT_MS,
    defaultRunTimeoutMs,
    "VIVA_HOSTED_RUN_TIMEOUT_MS",
  );
  const publishTimeoutMs = positiveInteger(
    env.VIVA_HOSTED_PUBLISH_TIMEOUT_MS,
    defaultPublishTimeoutMs,
    "VIVA_HOSTED_PUBLISH_TIMEOUT_MS",
  );

  const runId = sanitizeRunId(
    env.VIVA_HOSTED_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  const matrixProfile = matrixProfileForMode(env, mode);
  const deploySha = (env.VIVA_HOSTED_DEPLOY_SHA || env.GITHUB_SHA || "").trim();
  const failureControlScenarioIds =
    mode === "pr"
      ? failureControlScenarioIdsForProfile({
          configuredValue: env.VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS ?? "",
          profile: matrixProfile,
        })
      : [];
  const explicitFailureControlSubset =
    mode === "pr" && hasExplicitFailureControlScenarioSubset(env);
  const matrixScenarioIds = mode === "pr"
    ? [...PR_BROWSER_SCENARIO_IDS, ...failureControlScenarioIds]
    : null;
  const matrix = buildHostedE2eMatrixContract({
    mode,
    profile: matrixProfile,
    runId,
    scenarioIds: matrixScenarioIds,
    scenarioSubset: mode === "pr"
      ? {
          selected: true,
          explicitly_configured: explicitFailureControlSubset,
          configured_env: "VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS",
          scenario_ids: matrixScenarioIds,
          excluded_requires_browser_action: failureControlScenarioIdsForProfile({
            includeBrowserActionScenarios: true,
            profile: matrixProfile,
          })
            .filter(failureControlScenarioRequiresExplicitBrowserAction)
            .filter((scenarioId) => !failureControlScenarioIds.includes(scenarioId)),
        }
      : null,
  });
  const artifactPrefix = `viva-hosted-monitor/${mode}/${runId}`;
  const baseTarget = hostedTargetFromEnv(env, {
    agentHttpName: "VIVA_HOSTED_AGENT_HTTP_URL",
    agentWsName: "VIVA_HOSTED_AGENT_WS_URL",
    provider: env.VIVA_E2E_AGENT_PROVIDER || "synthetic",
    webName: "VIVA_HOSTED_WEB_URL",
  });
  const baseEnv = {
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID: syntheticStudySetId,
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID: syntheticUserId,
    VIVA_E2E_HOSTED_REST_BEARER_TOKEN: requiredValue(env, "VIVA_HOSTED_REST_BEARER_TOKEN"),
    VIVA_E2E_SYNTHETIC_STUDY_SET_ID: syntheticStudySetId,
    VIVA_E2E_SYNTHETIC_USER_ID: syntheticUserId,
    VIVA_HOSTED_RUN_ID: runId,
    VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"),
    ...(deploySha ? { VIVA_E2E_DEPLOY_SHA: deploySha } : {}),
  };
  const syntheticTarget = {
    ...baseTarget,
    provider: "synthetic",
  };
  const fakeTarget =
    mode === "pr"
      ? hostedTargetFromEnv(env, {
          agentHttpName: "VIVA_HOSTED_FAKE_PROVIDER_AGENT_HTTP_URL",
          agentWsName: "VIVA_HOSTED_FAKE_PROVIDER_AGENT_WS_URL",
          provider: "fake_cartesia_gemini",
          webName: "VIVA_HOSTED_FAKE_PROVIDER_WEB_URL",
        })
      : null;
  const failureControlTargets =
    mode === "pr"
      ? new Map(
          failureControlScenarioIds.map((scenarioId) => [
            scenarioId,
            hostedFailureControlTargetFromEnv(env, scenarioId, {
              allowGenericTarget: failureControlScenarioIds.length === 1,
            }),
          ]),
        )
      : new Map();
  const liveMonitorDecision =
    mode === "scheduled"
      ? liveMonitorScheduleDecision(
          env,
          matrix.monitor_policy.live_monitor,
          matrix.monitor_policy.self_quarantine,
        )
      : {
          enabled: false,
          should_run: false,
          skip_reason: "pr_mode",
        };
  const liveMonitorConfig = liveMonitorDecision.should_run
    ? hostedLiveMonitorConfigFromEnv(env, matrix.monitor_policy.live_monitor, runId)
    : null;
  const scheduledRuns = [
    {
      name: "scheduled_hosted_synthetic_monitor",
      scenario_id: "happy_path",
      env: runEnv(baseEnv, syntheticTarget, {
        VIVA_E2E_HOSTED_SCENARIO_ID: "happy_path",
        VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
      }),
      timeoutMs: runTimeoutMs,
    },
    ...(liveMonitorDecision.should_run
      ? [
          scheduledLiveMonitorRun(
            liveMonitorConfig.target,
            matrix.monitor_policy.live_monitor,
            runTimeoutMs,
            runId,
            liveMonitorConfig,
            liveMonitorDecision,
          ),
        ]
      : []),
  ];
  const runs =
    mode === "scheduled"
      ? scheduledRuns
      : [
          {
            name: "pr_hosted_synthetic_matrix",
            scenario_id: "happy_path",
            env: runEnv(baseEnv, syntheticTarget, {
              VIVA_E2E_HOSTED_SCENARIO_ID: "happy_path",
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1",
            }),
            timeoutMs: runTimeoutMs,
          },
          {
            name: "pr_hosted_fake_provider_matrix",
            scenario_id: "fake_provider_happy_path",
            env: runEnv(baseEnv, fakeTarget, {
              VIVA_E2E_HOSTED_SCENARIO_ID: "fake_provider_happy_path",
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
            }),
            timeoutMs: runTimeoutMs,
          },
          {
            name: "pr_hosted_token_free_session_history",
            scenario_id: "token_free_session_history",
            env: runEnv(baseEnv, syntheticTarget, {
              VIVA_E2E_HOSTED_SCENARIO_ID: "token_free_session_history",
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
            }),
            timeoutMs: runTimeoutMs,
          },
          ...failureControlScenarioIds.map((scenarioId) => ({
            name: `pr_hosted_failure_control_${scenarioId}`,
            scenario_id: scenarioId,
            env: runEnv(baseEnv, failureControlTargets.get(scenarioId), {
              VIVA_E2E_FAILURE_CONTROL_SCENARIO: scenarioId,
              VIVA_E2E_HOSTED_SCENARIO_ID: scenarioId,
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
              VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: failureControlTargets.get(scenarioId).webUrl,
              VIVA_FAILURE_CONTROL_ENABLED: "1",
              VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY:
                env.VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY || "1",
              VIVA_FAILURE_CONTROL_SECRET: requiredValue(env, "VIVA_FAILURE_CONTROL_SECRET"),
              VIVA_FAILURE_CONTROL_STUDY_SET_IDS: syntheticStudySetId,
              VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: syntheticUserId,
            }),
            timeoutMs: runTimeoutMs,
          })),
        ];

  return {
    artifactPrefix,
    artifactStore: {
      accessKeyId: requiredValue(env, "VIVA_HOSTED_ARTIFACT_KEY_ID"),
      bucket: requiredValue(env, "VIVA_HOSTED_ARTIFACT_BUCKET"),
      endpoint: normalizeHostedUrl(requiredValue(env, "VIVA_HOSTED_ARTIFACT_ENDPOINT")),
      region: env.VIVA_HOSTED_ARTIFACT_REGION || "auto",
      secretAccessKey: requiredValue(env, "VIVA_HOSTED_ARTIFACT_SECRET_KEY"),
    },
    hostedAgentHttpUrl: baseTarget.agentHttpUrl,
    hostedAgentWsUrl: baseTarget.agentWsUrl,
    hostedWebUrl: baseTarget.webUrl,
    liveMonitor: liveMonitorDecision,
    matrix,
    matrixProfile,
    mode,
    publishTimeoutMs,
    runId,
    runTimeoutMs,
    runs,
    syntheticStudySetId,
    syntheticUserId,
  };
}

function matrixProfileForMode(env, mode) {
  const profile = (env.VIVA_HOSTED_MATRIX_PROFILE || defaultMatrixProfile(mode)).trim();
  if (!["contract", "full", "pr", "scheduled"].includes(profile)) {
    throw new Error(`unsupported hosted E2E matrix profile ${profile}`);
  }
  if (mode === "scheduled" && profile !== "scheduled") {
    throw new Error(
      "scheduled hosted monitor requires VIVA_HOSTED_MATRIX_PROFILE=scheduled or unset",
    );
  }
  if (mode === "pr" && !["full", "pr"].includes(profile)) {
    throw new Error("PR hosted monitor requires VIVA_HOSTED_MATRIX_PROFILE=full, pr, or unset");
  }
  return profile;
}

function hostedTargetFromEnv(env, { agentHttpName, agentWsName, provider, webName }) {
  return {
    agentHttpUrl: normalizeHostedUrl(requiredValue(env, agentHttpName)),
    agentWsUrl: normalizeWebSocketUrl(requiredValue(env, agentWsName)),
    provider,
    webUrl: normalizeHostedUrl(requiredValue(env, webName)),
  };
}

function hostedFailureControlTargetFromEnv(env, scenarioId, { allowGenericTarget = false } = {}) {
  const prefix = failureControlScenarioEnvPrefix(scenarioId);
  const specificTargetKeys = [
    `${prefix}_AGENT_HTTP_URL`,
    `${prefix}_AGENT_WS_URL`,
    `${prefix}_WEB_URL`,
  ];
  const hasSpecificTarget = specificTargetKeys.some((key) => env[key]);
  if (hasSpecificTarget) {
    return hostedTargetFromEnv(env, {
      agentHttpName: specificTargetKeys[0],
      agentWsName: specificTargetKeys[1],
      provider: "synthetic",
      webName: specificTargetKeys[2],
    });
  }
  if (allowGenericTarget) {
    return hostedTargetFromEnv(env, {
      agentHttpName: "VIVA_HOSTED_FAILURE_CONTROL_AGENT_HTTP_URL",
      agentWsName: "VIVA_HOSTED_FAILURE_CONTROL_AGENT_WS_URL",
      provider: "synthetic",
      webName: "VIVA_HOSTED_FAILURE_CONTROL_WEB_URL",
    });
  }
  throw new Error(
    `multi-scenario hosted failure-control PR runs require per-scenario target ${specificTargetKeys.join(
      ", ",
    )}`,
  );
}

function failureControlScenarioEnvPrefix(scenarioId) {
  return `VIVA_HOSTED_FAILURE_CONTROL_${scenarioId.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
}

function runEnv(baseEnv, target, extra = {}) {
  return {
    ...baseEnv,
    VIVA_E2E_AGENT_PROVIDER: target.provider,
    VIVA_E2E_HOSTED_AGENT_HTTP_URL: target.agentHttpUrl,
    VIVA_E2E_HOSTED_AGENT_WS_URL: target.agentWsUrl,
    VIVA_E2E_HOSTED_WEB_URL: target.webUrl,
    ...extra,
  };
}

function hasExplicitFailureControlScenarioSubset(env) {
  return (env.VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS ?? "").trim().length > 0;
}

function liveMonitorScheduleDecision(env, livePolicy, quarantinePolicy) {
  if (env.VIVA_HOSTED_LIVE_MONITOR_ENABLED !== "1") {
    return {
      enabled: false,
      should_run: false,
      skip_reason: "disabled",
    };
  }
  const now = dateFromEnv(env, "VIVA_HOSTED_LIVE_MONITOR_NOW", new Date());
  const stateDate = (env.VIVA_HOSTED_LIVE_MONITOR_STATE_DATE ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stateDate)) {
    return {
      enabled: true,
      now: now.toISOString(),
      should_run: false,
      skip_reason: "state_date_missing",
    };
  }
  const today = now.toISOString().slice(0, 10);
  const runsToday =
    stateDate === today
      ? nonNegativeInteger(
          env.VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY,
          "VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY",
        )
      : 0;
  const tokensToday =
    stateDate === today
      ? nonNegativeInteger(
          env.VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY,
          "VIVA_HOSTED_LIVE_MONITOR_TOKENS_TODAY",
        )
      : 0;
  const consecutiveFailures = optionalNonNegativeInteger(
    env.VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES,
    "VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES",
    0,
  );
  const priorFailureState = liveMonitorPriorFailureState(
    env,
    now,
    quarantinePolicy,
    consecutiveFailures,
  );
  const quarantinedUntil = optionalDateFromEnv(env, "VIVA_HOSTED_LIVE_MONITOR_QUARANTINED_UNTIL");
  if (quarantinedUntil && quarantinedUntil.getTime() > now.getTime()) {
    return {
      ...priorFailureStateEvidence(priorFailureState),
      enabled: true,
      now: now.toISOString(),
      quarantined_until: quarantinedUntil.toISOString(),
      should_run: false,
      skip_reason: "self_quarantined",
    };
  }
  if (runsToday >= livePolicy.max_runs_per_day) {
    return {
      ...priorFailureStateEvidence(priorFailureState),
      enabled: true,
      now: now.toISOString(),
      runs_today: runsToday,
      should_run: false,
      skip_reason: "daily_budget_exhausted",
    };
  }
  if (tokensToday >= livePolicy.max_tokens_per_day) {
    return {
      ...priorFailureStateEvidence(priorFailureState),
      enabled: true,
      max_tokens_per_day: livePolicy.max_tokens_per_day,
      now: now.toISOString(),
      should_run: false,
      skip_reason: "daily_token_budget_exhausted",
      tokens_today: tokensToday,
    };
  }
  if (tokensToday + livePolicy.max_tokens_per_run > livePolicy.max_tokens_per_day) {
    return {
      ...priorFailureStateEvidence(priorFailureState),
      enabled: true,
      max_tokens_per_day: livePolicy.max_tokens_per_day,
      max_tokens_per_run: livePolicy.max_tokens_per_run,
      now: now.toISOString(),
      should_run: false,
      skip_reason: "daily_token_budget_remaining_too_low",
      token_budget_remaining: Math.max(0, livePolicy.max_tokens_per_day - tokensToday),
      tokens_today: tokensToday,
    };
  }
  const lastRunAt = optionalDateFromEnv(env, "VIVA_HOSTED_LIVE_MONITOR_LAST_RUN_AT");
  if (lastRunAt) {
    const elapsedSeconds = Math.floor((now.getTime() - lastRunAt.getTime()) / 1000);
    if (elapsedSeconds < livePolicy.min_cadence_seconds) {
      return {
        ...priorFailureStateEvidence(priorFailureState),
        enabled: true,
        last_run_at: lastRunAt.toISOString(),
        min_cadence_seconds: livePolicy.min_cadence_seconds,
        now: now.toISOString(),
        seconds_since_last_run: Math.max(0, elapsedSeconds),
        should_run: false,
        skip_reason: "cadence_wait",
      };
    }
  }
  return {
    ...priorFailureStateEvidence(priorFailureState),
    enabled: true,
    max_runs_per_day: livePolicy.max_runs_per_day,
    min_cadence_seconds: livePolicy.min_cadence_seconds,
    now: now.toISOString(),
    quarantine_cooldown_seconds: quarantinePolicy.cooldown_seconds,
    runs_today: runsToday,
    should_run: true,
    tokens_today: tokensToday,
  };
}

function hostedLiveMonitorConfigFromEnv(env, livePolicy, runId) {
  const target = hostedTargetFromEnv(env, {
    agentHttpName: "VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL",
    agentWsName: "VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL",
    provider: "cartesia_gemini",
    webName: "VIVA_HOSTED_LIVE_MONITOR_WEB_URL",
  });
  const bearerToken = (
    env.VIVA_HOSTED_LIVE_MONITOR_REST_BEARER_TOKEN ??
    env.VIVA_HOSTED_REST_BEARER_TOKEN ??
    ""
  ).trim();
  if (!bearerToken) {
    throw new Error(
      "VIVA_HOSTED_LIVE_MONITOR_REST_BEARER_TOKEN or VIVA_HOSTED_REST_BEARER_TOKEN is required",
    );
  }
  const remoteMaxSessionCostUsd = positiveNumber(
    requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD"),
    "VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD",
  );
  if (remoteMaxSessionCostUsd > livePolicy.max_cost_usd_per_run) {
    throw new Error(
      "VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD must be less than or equal to the hosted live monitor policy cap",
    );
  }
  const session = hostedLiveMonitorSessionFromEnv(env, runId);
  return {
    bearerToken,
    audioFile:
      env.VIVA_HOSTED_LIVE_MONITOR_AUDIO_FILE?.trim() || "/app/evidence/live-smoke-answer.pcm",
    remoteMaxSessionCostUsd,
    session,
    target,
  };
}

function hostedLiveMonitorSessionFromEnv(env, runId) {
  const userId = requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_USER_ID");
  const studySetId = requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_STUDY_SET_ID");
  const baseSessionId = requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_SESSION_ID");
  const sessionId = liveMonitorRunSessionId(baseSessionId, runId);
  assertSyntheticIdentity(userId);
  return {
    sessionId,
    signedSession: signedLiveMonitorSession({
      secret: requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"),
      sessionId,
      studySetId,
      userId,
    }),
    studySetId,
    userId,
  };
}

function liveMonitorRunSessionId(baseSessionId, runId) {
  return uuidFromStableInput(`viva-live-monitor:${baseSessionId}:${runId}:${randomUUID()}`);
}

function signedLiveMonitorSession({ secret, sessionId, studySetId, userId }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const claims = {
    user_id: userId,
    study_set_id: studySetId,
    session_id: sessionId,
    expires_at: expiresAt,
    nonce: randomUUID(),
  };
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `viva1.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function uuidFromStableInput(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function scheduledLiveMonitorRun(
  target,
  livePolicy,
  runTimeoutMs,
  runId,
  liveConfig,
  liveMonitorDecision,
) {
  const timeoutMs = Math.min(runTimeoutMs, livePolicy.max_duration_ms_per_run);
  return {
    name: "scheduled_hosted_live_smoke",
    scenario_id: "live_provider_smoke",
    runner: "live-provider-smoke",
    resultFileName: "evidence.json",
    env: {
      VIVA_AGENT_PROVIDER: "cartesia_gemini",
      VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES: String(
        liveMonitorDecision.consecutive_failures ?? 0,
      ),
      ...(liveMonitorDecision.last_failure_at
        ? { VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT: liveMonitorDecision.last_failure_at }
        : {}),
      VIVA_HOSTED_RUN_ID: runId,
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_SMOKE: "1",
      VIVA_LIVE_SMOKE_AGENT_HTTP_URL: target.agentHttpUrl,
      VIVA_LIVE_SMOKE_AGENT_WS_URL: target.agentWsUrl,
      VIVA_LIVE_SMOKE_AUDIO_FILE: liveConfig.audioFile,
      VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD: String(
        liveConfig.remoteMaxSessionCostUsd,
      ),
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: String(livePolicy.max_audio_bytes_per_run),
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: String(livePolicy.max_duration_ms_per_run),
      VIVA_LIVE_SMOKE_MAX_TOKENS: String(livePolicy.max_tokens_per_run),
      VIVA_LIVE_SMOKE_MAX_TURNS: String(livePolicy.max_turns_per_run),
      VIVA_LIVE_SMOKE_ORIGIN: target.webUrl,
      VIVA_LIVE_SMOKE_SESSION_ID: liveConfig.session.sessionId,
      ...(liveConfig.session.signedSession
        ? { VIVA_LIVE_SMOKE_SESSION_TOKEN: liveConfig.session.signedSession }
        : {}),
      VIVA_LIVE_SMOKE_STUDY_SET_ID: liveConfig.session.studySetId,
      VIVA_LIVE_SMOKE_USER_ID: liveConfig.session.userId,
      VIVA_VOICE_WS_BEARER_TOKEN: liveConfig.bearerToken,
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: String(liveConfig.remoteMaxSessionCostUsd),
    },
    timeoutMs,
  };
}

export function normalizeHostedUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("hosted URLs must use http:// or https://");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString().replace(/\/$/g, "");
}

export function buildObjectKey(prefix, relativePath) {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const normalizedRelative = relativePath.replaceAll("\\", "/").replace(/^\/+/g, "");
  if (
    !normalizedRelative ||
    path.posix.isAbsolute(normalizedRelative) ||
    normalizedRelative.split("/").includes("..")
  ) {
    throw new Error(`unsafe artifact path: ${relativePath}`);
  }
  return `${normalizedPrefix}/${normalizedRelative}`;
}

async function main() {
  const plan = buildHostedMonitorPlan();
  const outputDir = path.join(hostedArtifactRoot, plan.mode, plan.runId);
  await mkdir(outputDir, { recursive: true });
  const summary = {
    schema: "viva.hosted_monitor_run.v1",
    generated_at: new Date().toISOString(),
    mode: plan.mode,
    run_id: plan.runId,
    artifact_prefix: plan.artifactPrefix,
    hosted_e2e_matrix: plan.matrix,
    hosted_web_origin: plan.hostedWebUrl,
    hosted_agent_origin: plan.hostedAgentHttpUrl,
    live_monitor: plan.liveMonitor,
    runner_identity: {
      synthetic_user_id: plan.syntheticUserId,
      study_set_id: plan.syntheticStudySetId,
      learner_identity_used: false,
    },
    runs: [],
  };

  for (const run of plan.runs) {
    const runDir = path.join(outputDir, run.name);
    const evidenceArtifactDir = path.join(runDir, artifactSubdirForRun(run));
    await mkdir(runDir, { recursive: true });
    let outcome = await runHostedMonitorCommand(run, runDir, evidenceArtifactDir);
    const resultRead = await readRunResult(evidenceArtifactDir, run);
    if (outcome.status === "passed" && !resultRead.result) {
      outcome = await writeRunOutcomeArtifact(
        runDir,
        "runner-failure.json",
        failedRunOutcome(run, resultRead.failureClass),
      );
    }
    await auditHostedArtifacts(runDir);
    summary.runs.push(
      summarizeHostedRun(run, runDir, evidenceArtifactDir, outcome, resultRead.result),
    );
  }

  const failedRuns = summary.runs.filter((run) => run.status !== "passed").map((run) => run.name);
  const published = await publishHostedEvidence(outputDir, summary, plan);
  console.log(JSON.stringify(published, null, 2));
  if (failedRuns.length > 0) {
    throw new Error(
      `hosted monitor failed after publishing durable manifest: ${failedRuns.join(", ")}`,
    );
  }
}

async function publishHostedEvidence(outputDir, summary, plan) {
  const published = await writePublishedManifest(outputDir, summary, plan);
  await auditHostedArtifacts(outputDir);
  const publishDeadlineMs = Date.now() + plan.publishTimeoutMs;
  const uploaded = await publishDirectoryToS3(outputDir, plan.artifactPrefix, plan.artifactStore, {
    deadlineMs: publishDeadlineMs,
  });
  if (uploaded.length + 1 !== published.durable_artifact_store.uploaded_files) {
    throw new Error("hosted monitor upload count drifted before manifest publication");
  }
  await putS3Object(
    plan.artifactStore,
    buildObjectKey(plan.artifactPrefix, "manifest.json"),
    Buffer.from(`${JSON.stringify(published, null, 2)}\n`),
    "application/json",
    { deadlineMs: publishDeadlineMs },
  );
  return published;
}

export async function writePublishedManifest(outputDir, summary, plan) {
  const manifestPath = path.join(outputDir, "manifest.json");
  const publishable = await publishableHostedFiles(outputDir);
  const published = {
    ...summary,
    status: summary.runs.every((run) => run.status === "passed") ? "passed" : "failed",
    durable_artifact_store: {
      bucket: plan.artifactStore.bucket,
      object_prefix: plan.artifactPrefix,
      published_artifact_policy: "text_json_logs_only",
      uploaded_files: publishable.length + 1,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
  return published;
}

function artifactSubdirForRun(run) {
  return run.runner === "live-provider-smoke" ? "live-smoke" : "browser";
}

async function readRunResult(runDir, run = {}) {
  const fileName =
    run.resultFileName ?? (run.runner === "live-provider-smoke" ? "evidence.json" : "result.json");
  try {
    return {
      failureClass: null,
      result: JSON.parse(await readFile(path.join(runDir, fileName), "utf8")),
    };
  } catch (error) {
    return {
      failureClass:
        error?.code === "ENOENT"
          ? `missing_${path.basename(fileName, ".json")}`
          : "invalid_result_json",
      result: null,
    };
  }
}

export function summarizeHostedRun(run, runDir, resultDir, outcome, result, rootDir = root) {
  const resultRelativeDir = path.relative(runDir, resultDir).replaceAll("\\", "/");
  const browserStoryArtifact =
    result?.browser_story_artifact && resultRelativeDir
      ? `${resultRelativeDir}/${result.browser_story_artifact}`
      : (result?.browser_story_artifact ?? null);
  return {
    name: run.name,
    runner: run.runner ?? "e2e-browser",
    scenario_id: run.scenario_id ?? result?.hosted_e2e?.scenario_id ?? null,
    artifact_dir: path.relative(rootDir, runDir),
    status: outcome.status,
    failure_class: outcome.failure_class ?? null,
    exit_code: outcome.exit_code ?? null,
    terminal_signal: outcome.terminal_signal ?? null,
    timeout_ms: outcome.timeout_ms ?? null,
    browser_story_artifact: browserStoryArtifact,
    browser_story_frames: Array.isArray(result?.browser_story?.frames)
      ? result.browser_story.frames.map((frame) => frame.id).filter(Boolean)
      : [],
    failure_control_terminal: result?.failure_control_terminal
      ? {
          scenario_id: result.failure_control_terminal.scenario_id,
          terminal_reason: result.failure_control_terminal.terminal_reason,
          sanitized: result.failure_control_terminal.sanitized === true,
        }
      : null,
    hosted_e2e: summarizeHostedE2eResult(result),
    live_smoke: summarizeLiveSmokeResult(result, run.env ?? {}),
    manuscript_ready: result?.manuscript_ready === true,
    page_error_count: Array.isArray(result?.page_errors) ? result.page_errors.length : 0,
    sanitized: true,
  };
}

function summarizeLiveSmokeResult(result, env = {}) {
  if (result?.schema !== "viva.live_provider_smoke.v1") return null;
  const terminalReason = liveSmokeTerminalReason(result);
  return {
    schema: result.schema,
    status: result.status ?? null,
    provider: result.provider ?? null,
    terminal_reason: terminalReason,
    failure_class: result.failure?.failure_class ?? result.failure_class ?? null,
    caps: result.caps ?? null,
    privacy: result.privacy ?? null,
    self_quarantine: liveMonitorSelfQuarantine(result, env),
    sanitized: true,
  };
}

function liveSmokeTerminalReason(result) {
  return result?.terminal_reason ?? result?.websocket?.terminal_reason ?? null;
}

function liveMonitorSelfQuarantine(result, env = {}) {
  const policy = HOSTED_MONITOR_POLICY.self_quarantine;
  const terminalReason = liveSmokeTerminalReason(result);
  const failureClass = result?.failure?.failure_class ?? result?.failure_class ?? null;
  const currentFailure =
    terminalReason === policy.terminal_reason || failureClass === policy.failure_class;
  const observedAt =
    optionalDateValue(result?.generated_at) ??
    optionalDateFromEnv(env, "VIVA_HOSTED_LIVE_MONITOR_NOW") ??
    new Date();
  const configuredConsecutiveFailures = optionalNonNegativeInteger(
    env.VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES,
    "VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES",
    0,
  );
  const priorFailureState = liveMonitorPriorFailureState(
    env,
    observedAt,
    policy,
    configuredConsecutiveFailures,
  );
  const consecutiveFailures = currentFailure ? priorFailureState.consecutiveFailures + 1 : 0;
  const triggered = currentFailure && consecutiveFailures >= policy.consecutive_failures;
  return {
    triggered,
    consecutive_failures: consecutiveFailures,
    current_failure: currentFailure,
    prior_failure_stale: priorFailureState.stale,
    last_failure_at: priorFailureState.lastFailureAt?.toISOString() ?? null,
    seconds_since_last_failure: priorFailureState.secondsSinceLastFailure,
    required_consecutive_failures: policy.consecutive_failures,
    terminal_reason: currentFailure ? terminalReason : null,
    failure_class: currentFailure ? failureClass : null,
    cooldown_seconds: policy.cooldown_seconds,
    observation_window_seconds: policy.observation_window_seconds,
  };
}

async function runHostedMonitorCommand(run, runDir, evidenceArtifactDir) {
  const runner = run.runner ?? "e2e-browser";
  const logPrefix = runner === "live-provider-smoke" ? "live-smoke" : "e2e";
  const stdout = createWriteStream(path.join(runDir, `${logPrefix}.stdout.log`));
  const stderr = createWriteStream(path.join(runDir, `${logPrefix}.stderr.log`));
  const stdoutFinished = finished(stdout);
  const stderrFinished = finished(stderr);
  const command = hostedMonitorCommand(run, evidenceArtifactDir);
  const child = spawn(command.bin, command.args, {
    cwd: root,
    env: {
      ...process.env,
      ...run.env,
      ...command.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let timedOut = false;
  let killTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    killTimer.unref?.();
  }, run.timeoutMs);
  timeout.unref?.();
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve(exitCode ?? signal));
    });
  } catch {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    await flushHostedRunLogs(stdoutFinished, stderrFinished);
    return writeRunOutcomeArtifact(
      runDir,
      "runner-failure.json",
      failedRunOutcome(run, "spawn_error"),
    );
  }
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  const logFlushFailure = await flushHostedRunLogs(stdoutFinished, stderrFinished);
  if (timedOut) {
    return writeRunOutcomeArtifact(
      runDir,
      "timeout.json",
      failedRunOutcome(run, "timeout", {
        status: "timed_out",
        timeout_ms: run.timeoutMs,
      }),
    );
  }
  if (logFlushFailure) {
    return writeRunOutcomeArtifact(
      runDir,
      "runner-failure.json",
      failedRunOutcome(run, "log_flush_failed"),
    );
  }
  if (code !== 0) {
    return writeRunOutcomeArtifact(
      runDir,
      "runner-failure.json",
      failedRunOutcome(run, "process_exit", exitDetails(code)),
    );
  }
  return {
    run: run.name,
    status: "passed",
    sanitized: true,
    exit_code: 0,
  };
}

function hostedMonitorCommand(run, evidenceArtifactDir) {
  const runner = run.runner ?? "e2e-browser";
  if (runner === "e2e-browser") {
    return {
      bin: "bun",
      args: ["run", "e2e:browser"],
      env: {
        VIVA_E2E_ARTIFACT_DIR: evidenceArtifactDir,
        VIVA_E2E_TRACE: "0",
      },
    };
  }
  if (runner === "live-provider-smoke") {
    return {
      bin: "bun",
      args: ["run", "live:smoke"],
      env: {
        VIVA_LIVE_SMOKE_ARTIFACT_DIR: evidenceArtifactDir,
        VIVA_LIVE_SMOKE_EVIDENCE_PATH: path.join(evidenceArtifactDir, "evidence.json"),
      },
    };
  }
  throw new Error(`unsupported hosted monitor runner ${runner}`);
}

async function flushHostedRunLogs(stdoutFinished, stderrFinished) {
  const results = await Promise.allSettled([stdoutFinished, stderrFinished]);
  return results.some((result) => result.status === "rejected");
}

function failedRunOutcome(run, failureClass, extra = {}) {
  return {
    run: run.name,
    status: "failed",
    failure_class: failureClass,
    sanitized: true,
    ...extra,
  };
}

function exitDetails(code) {
  return typeof code === "number" ? { exit_code: code } : { terminal_signal: String(code) };
}

async function writeRunOutcomeArtifact(runDir, fileName, outcome) {
  await writeFile(path.join(runDir, fileName), `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

async function publishDirectoryToS3(directory, prefix, store, options = {}) {
  const uploaded = [];
  for (const file of await publishableHostedFiles(directory)) {
    const relative = path.relative(directory, file);
    const key = buildObjectKey(prefix, relative);
    const body = await readFile(file);
    await putS3Object(store, key, body, contentTypeFor(file), options);
    uploaded.push(key);
  }
  return uploaded;
}

export async function putS3Object(store, key, body, contentType, options = {}) {
  const endpoint = new URL(store.endpoint);
  endpoint.hostname = `${store.bucket}.${endpoint.hostname}`;
  endpoint.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`;
  const payloadHash = sha256Hex(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    "content-type": contentType,
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}`)
    .join("\n");
  const canonicalRequest = [
    "PUT",
    endpoint.pathname,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${store.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join("\n");
  const signature = hmacHex(
    signingKey(store.secretAccessKey, dateStamp, store.region),
    stringToSign,
  );
  const timeoutMs =
    options.deadlineMs === undefined
      ? defaultPublishTimeoutMs
      : remainingPublishMs(options.deadlineMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let response;
  try {
    response = await fetch(endpoint, {
      body,
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${store.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      method: "PUT",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`artifact upload timed out for ${key}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`artifact upload failed for ${key} with HTTP ${response.status}`);
  }
}

export function remainingPublishMs(deadlineMs, nowMs = Date.now()) {
  const remaining = Math.floor(deadlineMs - nowMs);
  if (!Number.isFinite(deadlineMs) || remaining <= 0) {
    throw new Error("hosted monitor publication timed out");
  }
  return remaining;
}

async function auditHostedArtifacts(directory) {
  for (const file of await listFiles(directory)) {
    if (isRejectedHostedArtifact(file)) {
      throw new Error(`hosted monitor artifact ${path.relative(root, file)} is not allowed`);
    }
  }
  await auditTextArtifacts([directory], {
    context: "hosted monitor artifact",
    rootDir: root,
    zipMessage: (relative) => `hosted monitor artifact ${relative} is not allowed`,
  });
}

export async function publishableHostedFiles(directory) {
  const files = [];
  for (const file of await listFiles(directory)) {
    if (path.basename(file) === "manifest.json") continue;
    if (isPublishableHostedArtifact(file)) files.push(file);
  }
  return files.sort();
}

export function isPublishableHostedArtifact(file) {
  return isTextArtifact(file) && !isRejectedHostedArtifact(file);
}

export function isRejectedHostedArtifact(file) {
  return /\.(zip|trace|har|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(file);
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function normalizeWebSocketUrl(value) {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error("VIVA_HOSTED_AGENT_WS_URL must use ws:// or wss://");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/g, "");
}

function assertSyntheticIdentity(userId) {
  if (!/(synthetic|monitor|test)/i.test(userId) || /(learner|student)/i.test(userId)) {
    throw new Error(
      "VIVA_HOSTED_SYNTHETIC_USER_ID must be a synthetic monitor identity, never a learner",
    );
  }
}

function requiredValue(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${name} is required`);
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value, name, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return nonNegativeInteger(value, name);
}

function positiveNumber(value, name) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function dateFromEnv(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO date`);
  }
  return parsed;
}

function optionalDateFromEnv(env, name) {
  const value = env[name];
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return dateFromEnv(env, name, null);
}

function optionalDateValue(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function liveMonitorPriorFailureState(env, now, policy, configuredConsecutiveFailures) {
  if (configuredConsecutiveFailures <= 0) {
    return {
      consecutiveFailures: 0,
      lastFailureAt: null,
      secondsSinceLastFailure: null,
      stale: false,
    };
  }
  const lastFailureAt = optionalDateFromEnv(env, "VIVA_HOSTED_LIVE_MONITOR_LAST_FAILURE_AT");
  if (!lastFailureAt) {
    return {
      consecutiveFailures: 0,
      lastFailureAt: null,
      secondsSinceLastFailure: null,
      stale: true,
    };
  }
  const secondsSinceLastFailure = Math.max(
    0,
    Math.floor((now.getTime() - lastFailureAt.getTime()) / 1000),
  );
  const stale = secondsSinceLastFailure > policy.observation_window_seconds;
  return {
    consecutiveFailures: stale ? 0 : configuredConsecutiveFailures,
    lastFailureAt,
    secondsSinceLastFailure,
    stale,
  };
}

function priorFailureStateEvidence(state) {
  return {
    consecutive_failures: state.consecutiveFailures,
    last_failure_at: state.lastFailureAt?.toISOString() ?? null,
    prior_failure_stale: state.stale,
    seconds_since_last_failure: state.secondsSinceLastFailure,
  };
}

function sanitizeRunId(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("VIVA_HOSTED_RUN_ID must not be empty or a dot path segment");
  }
  return sanitized;
}

function contentTypeFor(file) {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".log") || file.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret, dateStamp, region) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function isTextArtifact(file) {
  return /\.(json|log|txt|stdout|stderr)$/i.test(file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
