#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHostedE2eMatrixContract,
  defaultMatrixProfile,
  failureControlScenarioIdsForProfile,
  failureControlScenarioRequiresExplicitBrowserAction,
  HOSTED_MONITOR_POLICY,
  summarizeHostedE2eResult,
} from "./hosted-e2e-matrix.mjs";
import { childEnvironmentFor } from "./child-environment.mjs";
import { finalizeLiveMonitorRun, reserveLiveMonitorRun } from "./hosted-monitor-state.mjs";
import { spawnManaged } from "./process-supervisor.mjs";
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
  const matrixScenarioIds =
    mode === "pr" ? [...PR_BROWSER_SCENARIO_IDS, ...failureControlScenarioIds] : null;
  const matrix = buildHostedE2eMatrixContract({
    mode,
    profile: matrixProfile,
    runId,
    scenarioIds: matrixScenarioIds,
    scenarioSubset:
      mode === "pr"
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
  // BAC-527: the live-monitor cadence/budget/quarantine decision is durable
  // state resolved by `applyHostedLiveMonitorState` against the S3-backed
  // hosted-monitor-state store, never operator-set environment counters.
  // Target/session configuration is still validated synchronously here so a
  // misconfigured live-monitor target fails fast regardless of today's
  // budget.
  const liveMonitorRequested = mode === "scheduled" && env.VIVA_HOSTED_LIVE_MONITOR_ENABLED === "1";
  const liveMonitorConfig = liveMonitorRequested
    ? hostedLiveMonitorConfigFromEnv(env, matrix.monitor_policy.live_monitor, runId)
    : null;
  const liveMonitor = liveMonitorRequested
    ? { enabled: true, should_run: false, skip_reason: "pending_state_resolution" }
    : {
        enabled: false,
        should_run: false,
        skip_reason: mode === "scheduled" ? "disabled" : "pr_mode",
      };
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
              // RELEASE-016/021: the session-signing failure-control
              // scenarios (expired_token and its session-auth siblings) all
              // require explicit browser action and are therefore never
              // selectable through this hosted PR matrix (see
              // FAILURE_CONTROL_SCENARIOS_REQUIRING_BROWSER_ACTION in
              // hosted-e2e-matrix.mjs) -- no run built here ever needs the
              // session-token signing secret.
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
    deploySha: deploySha || "unknown",
    hostedAgentHttpUrl: baseTarget.agentHttpUrl,
    hostedAgentWsUrl: baseTarget.agentWsUrl,
    hostedWebUrl: baseTarget.webUrl,
    liveMonitor,
    liveMonitorConfig,
    liveMonitorRequested,
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

/**
 * BAC-527: resolve the durable live-monitor state and, if the reservation
 * says the live leg should run, append the bounded live-smoke run to the
 * plan. A no-op when the live monitor was not requested (PR mode, or
 * scheduled mode with the opt-in unset) so no state I/O happens on the
 * common path.
 */
export async function applyHostedLiveMonitorState(
  plan,
  { fetchImpl = fetch, deadlineMs, env = process.env } = {},
) {
  if (!plan.liveMonitorRequested) return plan;
  const nowIso = dateFromEnv(env, "VIVA_HOSTED_LIVE_MONITOR_NOW", new Date()).toISOString();
  const reserved = await reserveLiveMonitorRun({
    store: plan.artifactStore,
    fetchImpl,
    runId: plan.runId,
    nowIso,
    livePolicy: plan.matrix.monitor_policy.live_monitor,
    quarantinePolicy: plan.matrix.monitor_policy.self_quarantine,
    deadlineMs,
  });
  const decision = reserved.decision;
  if (!decision.should_run) {
    return { ...plan, liveMonitor: decision };
  }
  const liveRun = scheduledLiveMonitorRun(
    plan.liveMonitorConfig.target,
    plan.matrix.monitor_policy.live_monitor,
    plan.runTimeoutMs,
    plan.runId,
    plan.liveMonitorConfig,
    decision,
    plan.deploySha,
  );
  return {
    ...plan,
    liveMonitor: decision,
    runs: [...plan.runs, liveRun],
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
  // RELEASE-016/021: the plan carries live identity only, never a minted
  // token -- `materializeHostedLiveSmokeRun` mints the session capability
  // immediately before the live-smoke child is spawned, not here. Validate
  // the signing secret's presence now, synchronously, so a misconfigured
  // live monitor fails fast before `applyHostedLiveMonitorState` commits any
  // durable-state reservation or a preceding leg is spawned -- but discard
  // the value immediately: materialization re-reads it fresh from `env` at
  // spawn time, so it is never retained on this config, the plan, or the
  // hosted summary.
  requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET");
  const identity = hostedLiveMonitorIdentityFromEnv(env, runId);
  const agentDeployId = (
    env.VIVA_HOSTED_LIVE_MONITOR_AGENT_DEPLOY_ID ??
    env.VIVA_HOSTED_AGENT_DEPLOY_ID ??
    "unknown"
  ).trim() || "unknown";
  return {
    agentDeployId,
    bearerToken,
    audioFile:
      env.VIVA_HOSTED_LIVE_MONITOR_AUDIO_FILE?.trim() || "/app/evidence/live-smoke-answer.pcm",
    identity,
    remoteMaxSessionCostUsd,
    target,
  };
}

function hostedLiveMonitorIdentityFromEnv(env, runId) {
  const userId = requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_USER_ID");
  const studySetId = requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_STUDY_SET_ID");
  const baseSessionId = requiredValue(env, "VIVA_HOSTED_LIVE_MONITOR_SESSION_ID");
  const sessionId = liveMonitorRunSessionId(baseSessionId, runId);
  assertSyntheticIdentity(userId);
  return {
    session_id: sessionId,
    study_set_id: studySetId,
    user_id: userId,
  };
}

function liveMonitorRunSessionId(baseSessionId, runId) {
  return uuidFromStableInput(`viva-live-monitor:${baseSessionId}:${runId}:${randomUUID()}`);
}

function signHostedLiveSmokeSession(claims, secret) {
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `viva1.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * RELEASE-016/021: mint the live-smoke session capability at the last
 * possible moment -- immediately before this specific run is spawned, never
 * at plan construction. `env` (defaulting to this process's own environment)
 * is read only here, so the raw signing secret never has to be threaded
 * through the plan/run object, the hosted summary, or any earlier stage of
 * the pipeline. The returned token's expiry is computed from `nowSeconds`
 * (the moment of this call) plus the run's own timeout -- which already
 * folds in the runner's 30s flush grace -- plus an additional 60s safety
 * margin, so it always retains its full validity window regardless of how
 * long any earlier plan run took to execute.
 *
 * ROW 356/RELEASE-021 ADJUDICATION: the signed claims carry exactly the
 * fields the deployed agent's `SessionTokenClaims`
 * (agent/crates/agent-service/src/config.rs) requires and accepts --
 * `user_id`, `study_set_id`, `session_id`, `issued_at`, `not_before`,
 * `expires_at`, `nonce` (matching the deployed agent's own signed-token
 * mint helper in agent/crates/agent-service/src/app.rs: `not_before` equals `issued_at`,
 * both taken from this call's own moment). That struct derives
 * `#[serde(deny_unknown_fields)]` over a closed field set this lane does not
 * own (Rust capability source under agent/crates), so a run id,
 * deploy SHA, agent deploy id, or provider mode claim would make the
 * deployed server reject the whole token as malformed before any provider
 * work, not merely ignore the extra field -- adding one is not a change this
 * lane can safely make. `run.runId`, `run.deploySha`, `run.agentDeployId`,
 * and `run.provider` stay on the returned run object, outside the signed
 * envelope, alongside the rest of the run's already non-secret
 * configuration; run/deploy identity binding for this same live-smoke leg is
 * enforced at a different, already-proven seam instead --
 * production-release-gate.mjs's `summarizeLiveSmoke` requires exact equality
 * between the live-smoke evidence's own reported `run_id`/`agent_deploy_id`/
 * `deploy_sha` fields and `VIVA_RELEASE_RUN_ID`/`VIVA_RELEASE_AGENT_DEPLOY_ID`/
 * `VIVA_RELEASE_DEPLOY_SHA` before a production release can ever become
 * `allowed: true` (Task 10, RELEASE-003/007/008). Binding them
 * cryptographically into the verified token itself would require extending
 * that Rust struct (the way `failure_control` is already nested there) --
 * capability source this lane does not own, a deferred voice-lane handoff,
 * not silently dropped scope.
 */
export function materializeHostedLiveSmokeRun(
  run,
  env = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const secret = requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET");
  const claims = {
    user_id: run.identity.user_id,
    study_set_id: run.identity.study_set_id,
    session_id: run.identity.session_id,
    // ROW 356/RELEASE-021 LIVE DEFECT (fixed here): issued_at/not_before were
    // missing entirely. config.rs's list of required signed-claim names
    // requires both -- its claims decoder rejects any claims object
    // that omits either with MissingClaim, before it even reaches the
    // issued_at <= not_before < expires_at time-order check. Every hosted
    // live-smoke token minted without them would have been rejected by any
    // real deployed agent.
    issued_at: nowSeconds,
    not_before: nowSeconds,
    expires_at: nowSeconds + Math.ceil(run.timeoutMs / 1000) + 60,
    nonce: randomUUID(),
  };
  return {
    ...run,
    env: {
      ...run.env,
      VIVA_LIVE_SMOKE_SESSION_TOKEN: signHostedLiveSmokeSession(claims, secret),
    },
  };
}

// ROW 356/RELEASE-021: the one place `main()`'s per-run loop decides what to
// actually spawn -- extracted so the "mint immediately before this specific
// run, never earlier" placement is itself directly testable. `now` is a
// zero-argument PROVIDER, not a raw value: `main()` never captures one
// timestamp above the loop and threads it through every iteration -- each
// call here reads `now()` itself, fresh, so a future edit that hoisted the
// mint back up to plan-construction time (one shared `now` reused across
// every run) is caught by calling this twice with a provider that changes
// between calls, the same way real wall-clock time would advance across a
// slow leading run.
export function prepareRunForSpawn(run, { env = process.env, now = defaultNowSeconds } = {}) {
  return run.runner === "live-provider-smoke" ? materializeHostedLiveSmokeRun(run, env, now()) : run;
}

function defaultNowSeconds() {
  return Math.floor(Date.now() / 1000);
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
  deploySha,
) {
  // BAC-527: the smoke enforces its own max_duration_ms_per_run deadline
  // internally and writes classified partial evidence when interrupted;
  // this outer supervisory kill grants a fixed 30s evidence-flush grace on
  // top of that before it hard-kills a process that failed to self-abort.
  const timeoutMs = Math.min(runTimeoutMs, livePolicy.max_duration_ms_per_run + 30_000);
  return {
    name: "scheduled_hosted_live_smoke",
    scenario_id: "live_provider_smoke",
    runner: "live-provider-smoke",
    resultFileName: "evidence.json",
    // RELEASE-016/021: normalized identity/binding the just-in-time
    // materializer reads at spawn time -- never a pre-minted token. The
    // agent deployment remains the only component that holds the raw
    // Cartesia/Gemini provider keys.
    agentDeployId: liveConfig.agentDeployId,
    deploySha,
    identity: liveConfig.identity,
    provider: "cartesia_gemini",
    runId,
    env: {
      VIVA_AGENT_PROVIDER: "cartesia_gemini",
      // BAC-527: translate the authoritative durable decision once into the
      // smoke's public contract. This is the exact variable name
      // `live-provider-smoke.mjs` reads; no `VIVA_HOSTED_*` state leaks into
      // the child.
      VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES: String(liveMonitorDecision.consecutive_failures ?? 0),
      VIVA_HOSTED_RUN_ID: runId,
      // RELEASE-016/021: the child attests it will use the deployed agent's
      // already-configured, zero-retention-approved provider secrets; it
      // never receives the raw Cartesia/Gemini keys itself.
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
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
      VIVA_LIVE_SMOKE_RUN_ID: runId,
      VIVA_LIVE_SMOKE_SESSION_ID: liveConfig.identity.session_id,
      // RELEASE-016/021: the session capability env key is deliberately
      // absent here -- it is minted just-in-time by
      // `materializeHostedLiveSmokeRun`, immediately before this run is
      // spawned.
      VIVA_LIVE_SMOKE_STUDY_SET_ID: liveConfig.identity.study_set_id,
      VIVA_LIVE_SMOKE_USER_ID: liveConfig.identity.user_id,
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
  const basePlan = buildHostedMonitorPlan();
  const plan = await applyHostedLiveMonitorState(basePlan, {
    fetchImpl: fetch,
    deadlineMs: Date.now() + basePlan.publishTimeoutMs,
  });
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
    // RELEASE-016/021: mint the live-smoke session capability immediately
    // before this specific run is spawned -- never earlier in the loop, and
    // never at plan construction -- so its TTL is always measured from this
    // moment, not from however long any preceding run took. No `now` is
    // captured above this loop and passed in: prepareRunForSpawn's own
    // default reads the live clock itself, fresh, on every call.
    const spawnRun = prepareRunForSpawn(run);
    let outcome = await runHostedMonitorCommand(spawnRun, runDir, evidenceArtifactDir);
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
      summarizeHostedRun(
        run,
        runDir,
        evidenceArtifactDir,
        outcome,
        resultRead.result,
        root,
        plan.liveMonitor,
      ),
    );
  }

  const liveRun = plan.runs.find((run) => run.runner === "live-provider-smoke");
  if (liveRun) {
    const liveRunSummary = summary.runs.find((run) => run.name === liveRun.name);
    const finalized = await finalizeLiveMonitorRun({
      store: plan.artifactStore,
      fetchImpl: fetch,
      runId: plan.runId,
      failed: liveRunSummary?.status !== "passed",
      nowIso: new Date().toISOString(),
      quarantinePolicy: plan.matrix.monitor_policy.self_quarantine,
      deadlineMs: Date.now() + plan.publishTimeoutMs,
    });
    if (!finalized.finalized) {
      summary.runs.push({
        name: "live_monitor_state_finalize",
        runner: "hosted-monitor-state",
        status: "failed",
        failure_class: finalized.failure_class ?? "publish_failed",
        sanitized: true,
      });
    }
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

/**
 * RELEASE-018/025: the manifest is uploaded last, and only after every
 * earlier object in this run's directory has succeeded -- `publishOptions`
 * is the single deadline-bounded, retry-aware options object shared by both
 * the bulk upload and the final manifest PUT, so a failure anywhere in the
 * former throws before the latter is ever attempted. A publication failure
 * is recorded as a local sanitized `publish-failure.json` (never itself
 * re-attempted for upload) before the failure is re-thrown, so the run still
 * fails closed while leaving a diagnosable local artifact behind.
 */
export async function publishHostedEvidence(outputDir, summary, plan, options = {}) {
  const published = await writePublishedManifest(outputDir, summary, plan);
  await auditHostedArtifacts(outputDir);
  const publishDeadlineMs = options.deadlineMs ?? Date.now() + plan.publishTimeoutMs;
  const publishOptions = { ...options, deadlineMs: publishDeadlineMs };
  try {
    const uploaded = await publishDirectoryToS3(
      outputDir,
      plan.artifactPrefix,
      plan.artifactStore,
      publishOptions,
    );
    if (uploaded.length + 1 !== published.durable_artifact_store.uploaded_files) {
      throw new Error("hosted monitor upload count drifted before manifest publication");
    }
    await putS3Object(
      plan.artifactStore,
      buildObjectKey(plan.artifactPrefix, "manifest.json"),
      Buffer.from(`${JSON.stringify(published, null, 2)}\n`),
      "application/json",
      publishOptions,
    );
  } catch (error) {
    await writePublishFailureArtifact(outputDir, error);
    throw error;
  }
  return published;
}

async function writePublishFailureArtifact(outputDir, error) {
  const message = typeof error?.message === "string" ? error.message : "publish failed";
  const failure = {
    schema: "viva.hosted_monitor_publish_failure.v1",
    failure_class: "publish_failed",
    object_key: typeof error?.objectKey === "string" ? error.objectKey : null,
    attempt_count: Number.isSafeInteger(error?.attempts) ? error.attempts : null,
    // `message` is always one of putS3Object's own constructed strings
    // ("artifact upload failed/timed out for <key> ...") -- never a raw
    // fetch/response object -- so it can never carry a header or credential
    // value; the length cap is a defensive backstop only.
    message: message.slice(0, 500),
    sanitized: true,
  };
  await writeFile(
    path.join(outputDir, "publish-failure.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
  );
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

export function summarizeHostedRun(
  run,
  runDir,
  resultDir,
  outcome,
  result,
  rootDir = root,
  liveMonitorDecision = null,
) {
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
    live_smoke: summarizeLiveSmokeResult(result, liveMonitorDecision, run),
    manuscript_ready: result?.manuscript_ready === true,
    page_error_count: Array.isArray(result?.page_errors) ? result.page_errors.length : 0,
    sanitized: true,
  };
}

function summarizeLiveSmokeResult(result, liveMonitorDecision, run) {
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
    // RELEASE-003/007/008: bind to the run the monitor itself constructed
    // and dispatched (scheduledLiveMonitorRun's own runId/agentDeployId/
    // deploySha) -- the authoritative identity for which release run and
    // deploy this specific leg targeted -- rather than trusting whatever
    // the child self-reported, which a hosted-spawned child cannot always
    // independently verify. Falls back to the child's own report only when
    // the dispatched run carries none (e.g. a manually-run smoke result
    // read back outside this runner's own dispatch loop).
    run_id: run?.runId ?? result.run_id ?? null,
    agent_deploy_id: run?.agentDeployId ?? result.agent_deploy_id ?? null,
    deploy_sha: run?.deploySha ?? result.deploy_sha ?? null,
    self_quarantine: liveMonitorSelfQuarantine(result, liveMonitorDecision),
    // BAC-527: transport_error, protocol_error, and structured_error must
    // stay distinct all the way into the hosted summary, not just the raw
    // smoke evidence.
    event_counts: summarizeLiveSmokeEventCounts(result.websocket?.event_counts),
    sanitized: true,
  };
}

function summarizeLiveSmokeEventCounts(eventCounts) {
  if (!eventCounts || typeof eventCounts !== "object") return null;
  return {
    transport_error: Number.isInteger(eventCounts.transport_error)
      ? eventCounts.transport_error
      : 0,
    protocol_error: Number.isInteger(eventCounts.protocol_error) ? eventCounts.protocol_error : 0,
    structured_error: Number.isInteger(eventCounts.structured_error)
      ? eventCounts.structured_error
      : 0,
  };
}

function liveSmokeTerminalReason(result) {
  return result?.terminal_reason ?? result?.websocket?.terminal_reason ?? null;
}

// BAC-527: the prior consecutive-failure count and staleness are already
// resolved once by the durable state module at plan-resolution time
// (`applyHostedLiveMonitorState`); this only applies the "+1 on failure"
// arithmetic so the hosted summary agrees with the durable state and the
// smoke's own observability evidence.
function liveMonitorSelfQuarantine(result, liveMonitorDecision) {
  const policy = HOSTED_MONITOR_POLICY.self_quarantine;
  const terminalReason = liveSmokeTerminalReason(result);
  const failureClass = result?.failure?.failure_class ?? result?.failure_class ?? null;
  const currentFailure =
    terminalReason === policy.terminal_reason || failureClass === policy.failure_class;
  const observedAt = optionalDateValue(result?.generated_at) ?? new Date();
  const priorConsecutiveFailures = Number.isSafeInteger(liveMonitorDecision?.consecutive_failures)
    ? liveMonitorDecision.consecutive_failures
    : 0;
  const priorFailureStale = liveMonitorDecision?.prior_failure_stale === true;
  const priorLastFailureAt = liveMonitorDecision?.last_failure_at ?? null;
  const priorSecondsSinceLastFailure = liveMonitorDecision?.seconds_since_last_failure ?? null;
  const consecutiveFailures = currentFailure ? priorConsecutiveFailures + 1 : 0;
  const triggered = currentFailure && consecutiveFailures >= policy.consecutive_failures;
  return {
    triggered,
    consecutive_failures: consecutiveFailures,
    current_failure: currentFailure,
    prior_failure_stale: priorFailureStale,
    last_failure_at: currentFailure ? observedAt.toISOString() : priorLastFailureAt,
    seconds_since_last_failure: priorSecondsSinceLastFailure,
    required_consecutive_failures: policy.consecutive_failures,
    terminal_reason: currentFailure ? terminalReason : null,
    failure_class: currentFailure ? failureClass : null,
    cooldown_seconds: policy.cooldown_seconds,
    observation_window_seconds: policy.observation_window_seconds,
  };
}

/**
 * RELEASE-015: every hosted monitor child is a wrapper. `bun run e2e:browser`
 * execs Node, which launches Chromium and (in loopback mode) cargo; `bun run
 * live:smoke` execs Node holding a websocket. Signalling only the wrapper's pid
 * at the timeout left those grandchildren alive, holding the evidence directory
 * and the port that the next run in the same matrix then raced. Ending the log
 * streams at signal time additionally discarded whatever the child wrote while
 * dying -- exactly the output that explains a timeout.
 *
 * The child is therefore a supervised process-group child: SIGTERM to the whole
 * group, a bounded grace, SIGKILL only if needed, and the log streams closed
 * strictly after the child itself is gone.
 */
export async function runHostedMonitorCommand(
  run,
  runDir,
  evidenceArtifactDir,
  { commandFactory = hostedMonitorCommand, graceMs = 5_000, spawnImpl = spawnManaged } = {},
) {
  const runner = run.runner ?? "e2e-browser";
  const logPrefix = runner === "live-provider-smoke" ? "live-smoke" : "e2e";
  const command = commandFactory(run, evidenceArtifactDir);
  const child = spawnImpl({
    command: command.bin,
    args: command.args,
    cwd: root,
    env: hostedMonitorChildEnv(run, command),
    stdoutPath: path.join(runDir, `${logPrefix}.stdout.log`),
    stderrPath: path.join(runDir, `${logPrefix}.stderr.log`),
    label: `hosted ${run.name}`,
  });

  try {
    await child.ready;
  } catch {
    // A spawn error never escapes into this runner's own cleanup path: the
    // managed promise carries it and the run is recorded as a sanitized
    // spawn failure.
    await child.stop({ graceMs });
    return writeRunOutcomeArtifact(
      runDir,
      "runner-failure.json",
      failedRunOutcome(run, "spawn_error"),
    );
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.stop({ graceMs });
  }, run.timeoutMs);
  timeout.unref?.();
  const { code, signal } = await child.exit.catch(() => ({ code: null, signal: null }));
  clearTimeout(timeout);
  // stop() is idempotent: whether the timeout already started the teardown or
  // the child exited on its own, this is the one call that awaits the group's
  // exit and only then finishes both log streams.
  const stopped = await child.stop({ graceMs });

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
  if (stopped.logFlushFailed) {
    // The run's own logs are release evidence: a truncated stream is a failed
    // run, never a quietly-passed one.
    return writeRunOutcomeArtifact(
      runDir,
      "runner-failure.json",
      failedRunOutcome(run, "log_flush_failed"),
    );
  }
  const exitStatus = code ?? signal;
  if (exitStatus !== 0) {
    return writeRunOutcomeArtifact(
      runDir,
      "runner-failure.json",
      failedRunOutcome(run, "process_exit", exitDetails(exitStatus)),
    );
  }
  return {
    run: run.name,
    status: "passed",
    sanitized: true,
    exit_code: 0,
  };
}

// RELEASE-029: every hosted monitor child (the hosted browser E2E harness
// and the live-provider smoke) receives an explicitly constructed
// environment keyed off its role, never this process's own ambient
// environment. `run.env`/`command.env` are already this runner's own
// normalized plan/target configuration — never a blind copy of
// `parentEnv` by name.
export function hostedMonitorChildEnv(run, command, parentEnv = process.env) {
  const role = (run.runner ?? "e2e-browser") === "live-provider-smoke" ? "hosted-live" : "hosted-browser";
  return childEnvironmentFor(role, {
    parentEnv,
    explicit: { ...run.env, ...command.env },
  });
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

const DEFAULT_PUBLISH_MAX_ATTEMPTS = 3;
const PUBLISH_BACKOFF_BASE_MS = 100;

/**
 * RELEASE-018/025: retries only a classified-retryable failure -- a thrown
 * fetch error, or HTTP 408/429/5xx -- for at most `maxAttempts` (default 3),
 * with every attempt's timeout and every backoff bounded by the same
 * `options.deadlineMs`. Any other 4xx fails immediately with a single
 * attempt. SigV4 (the date header and signature) is recomputed fresh on
 * every attempt so a retried request never carries a stale signature.
 * `fetchImpl`/`sleep`/`nowMs`/`jitter` are injectable so tests never sleep
 * in real time; each defaults to the real implementation.
 */
export async function putS3Object(store, key, body, contentType, options = {}) {
  const {
    deadlineMs,
    fetchImpl = fetch,
    jitter = defaultPublishJitter,
    maxAttempts = DEFAULT_PUBLISH_MAX_ATTEMPTS,
    nowMs = Date.now,
    sleep = defaultPublishSleep,
  } = options;
  const payloadHash = sha256Hex(body);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptNowMs = nowMs();
    const timeoutMs =
      deadlineMs === undefined
        ? defaultPublishTimeoutMs
        : remainingPublishMsForAttempt(deadlineMs, attemptNowMs, key, attempt);
    const endpoint = new URL(store.endpoint);
    endpoint.hostname = `${store.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`;
    // Derived from the injectable clock (not a bare `new Date()`) so a
    // retried attempt's signature is both genuinely fresh in production and
    // deterministically provable in tests.
    const amzDate = new Date(attemptNowMs).toISOString().replace(/[:-]|\.\d{3}/g, "");
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
    const controller = new AbortController();
    // Deliberately referenced, never unref'd: under Node 24 an unref'd abort
    // timer can let the event loop consider itself idle and move on before
    // this correctness-critical abort fires.
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let transportError = null;
    try {
      response = await fetchImpl(endpoint, {
        body,
        headers: {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 Credential=${store.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        method: "PUT",
        signal: controller.signal,
      });
    } catch (error) {
      transportError = controller.signal.aborted
        ? s3PublishError(`artifact upload timed out for ${key}`, { attempts: attempt, key })
        : error;
    } finally {
      clearTimeout(timeout);
    }
    const isLastAttempt = attempt === maxAttempts;
    if (!transportError) {
      // Checked as a status range, not `response.ok` -- an injected test
      // `fetchImpl` may return a minimal duck-typed response that never
      // implements the real `Response` object's `ok` getter.
      if (isSuccessStatus(response.status)) return;
      if (!isRetryablePublishStatus(response.status) || isLastAttempt) {
        throw s3PublishError(`artifact upload failed for ${key} with HTTP ${response.status}`, {
          attempts: attempt,
          key,
        });
      }
    } else if (isLastAttempt) {
      throw transportError;
    }
    // Bounded backoff before the next attempt; never sleep past the
    // deadline, and never start a backoff the remaining budget cannot cover.
    const remaining =
      deadlineMs === undefined
        ? undefined
        : remainingPublishMsForAttempt(deadlineMs, nowMs(), key, attempt);
    const rawBackoff = PUBLISH_BACKOFF_BASE_MS * 2 ** (attempt - 1) + jitter();
    const backoffMs = remaining === undefined ? rawBackoff : Math.min(rawBackoff, remaining - 1);
    if (backoffMs <= 0) {
      if (transportError) throw transportError;
      throw s3PublishError(`artifact upload failed for ${key} with HTTP ${response.status}`, {
        attempts: attempt,
        key,
      });
    }
    await sleep(backoffMs);
  }
}

function s3PublishError(message, { key, attempts }) {
  const error = new Error(message);
  error.objectKey = key;
  error.attempts = attempts;
  return error;
}

function isSuccessStatus(status) {
  return status >= 200 && status <= 299;
}

function isRetryablePublishStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function defaultPublishSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultPublishJitter() {
  return Math.floor(Math.random() * 50);
}

export function remainingPublishMs(deadlineMs, nowMs = Date.now()) {
  const remaining = Math.floor(deadlineMs - nowMs);
  if (!Number.isFinite(deadlineMs) || remaining <= 0) {
    throw new Error("hosted monitor publication timed out");
  }
  return remaining;
}

// `putS3Object`'s two internal `remainingPublishMs` call sites (the
// pre-fetch timeout budget, and the post-response backoff budget) both run
// with `key`/`attempt` already in scope: reclassifying a deadline-exhaustion
// throw through `s3PublishError` here, instead of letting `remainingPublishMs`'s
// own bare `Error` propagate directly, keeps the in-flight object key and
// attempt count on the error object -- and therefore in the sanitized local
// `publish-failure.json` written from it -- exactly like every other
// terminal failure this loop can throw.
function remainingPublishMsForAttempt(deadlineMs, nowMsValue, key, attempt) {
  try {
    return remainingPublishMs(deadlineMs, nowMsValue);
  } catch (error) {
    throw s3PublishError(error.message, { attempts: attempt, key });
  }
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

function optionalDateValue(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizeRunId(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("VIVA_HOSTED_RUN_ID must not be empty or a dot path segment");
  }
  return sanitized;
}

// RELEASE-018/025: no `image/png` branch here -- `publishableHostedFiles`
// (via `isPublishableHostedArtifact`/`isTextArtifact`) never selects a PNG
// for upload, so this function never receives one. A future decision to
// publish screenshots durably must add PNG upload, checksum, redaction,
// content type, retry, and fetch-after-publish proof together, not resurrect
// a dormant content-type branch alone.
export function contentTypeFor(file) {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".log") || file.endsWith(".txt")) return "text/plain; charset=utf-8";
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
