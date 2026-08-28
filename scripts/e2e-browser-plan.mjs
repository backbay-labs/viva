// RELEASE-030 E2E extraction: pure provider/mode/env/URL/run-plan construction
// and validation. Nothing here spawns a process, launches a browser, or
// touches a page -- every function is a pure reduction of `process.env` (or of
// an explicit argument), so the whole module is safely importable for its
// reducers alone, exactly as `e2e-browser.mjs` was before this extraction.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFailureControlPlan,
  failureControlHarnessEvidence,
  failureControlStartIdentity,
  isFailureControlSessionTokenScenario,
} from "./failure-control-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * W-07: the local story's own signed-start identity and the loopback secrets
 * both tiers must agree on.
 *
 * These are constructed local literals, not credentials: the agent child and
 * the web child are both spawned by this process onto freshly allocated
 * loopback ports and are torn down with it. They exist because the merged
 * D-07 Branch A landing contract mints a real, HMAC-signed session token at the
 * web tier and the agent verifies it -- a shared secret IS the contract, and a
 * harness that omitted it could only ever exercise the retired unsigned entry.
 * Both tiers independently require 32-512 bytes and refuse placeholder-shaped
 * values, so these are long, obviously-local, non-secret-shaped literals.
 */
export const LOCAL_STORY_IDENTITY = Object.freeze({
  studySetId: "biology-midterm",
  userId: "user-1",
});
export const LOCAL_STORY_SESSION_TOKEN_SECRET = "viva-local-e2e-session-token-material-0000";
export const LOCAL_STORY_BOOTSTRAP_TOKEN_SECRET = "viva-local-e2e-bootstrap-token-material-0";
export const LOCAL_STORY_AGENT_SCOPED_BEARER = "viva-local-e2e-agent-scoped-read-material0";
/**
 * W-07 / A-32: the scoped session-mint credential the web tier presents to
 * the agent's own record-at-mint path. `config.rs`'s `validate_credentials`
 * collision-checks every scoped agent credential pairwise, so this must be
 * byte-distinct from `LOCAL_STORY_AGENT_SCOPED_BEARER` (the library-read
 * credential) even though both are constructed local literals for the same
 * loopback agent.
 */
export const LOCAL_STORY_SESSION_MINT_BEARER = "viva-local-e2e-session-mint-bearer-material-0";

const ALLOWED_BROWSER_STORY_PROVIDERS = new Set(["synthetic", "fake_cartesia_gemini"]);

/**
 * Hosted targets are compared and logged, so a configured URL is reduced to its
 * origin+path: query and fragment are exactly where a session token would ride.
 */
export function normalizeHostedHttpUrl(value, name) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use http:// or https://`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString().replace(/\/$/g, "");
}

export function normalizeHostedWsUrl(value, name) {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`${name} must use ws:// or wss://`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/g, "");
}

function optionalHostedHttpUrl(name) {
  const value = process.env[name]?.trim();
  return value ? normalizeHostedHttpUrl(value, name) : null;
}

function optionalHostedWsUrl(name) {
  const value = process.env[name]?.trim();
  return value ? normalizeHostedWsUrl(value, name) : null;
}

export function hostedSyntheticIdentity() {
  return {
    studySetId:
      process.env.VIVA_E2E_SYNTHETIC_STUDY_SET_ID?.trim() ||
      process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID?.trim() ||
      "biology-midterm",
    userId:
      process.env.VIVA_E2E_SYNTHETIC_USER_ID?.trim() ||
      process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID?.trim() ||
      "user-1",
  };
}

export function assertHostedSyntheticIdentity(identity) {
  if (
    !/(synthetic|monitor|test)/i.test(identity.userId) ||
    /(learner|student)/i.test(identity.userId)
  ) {
    throw new Error("Hosted browser E2E requires a synthetic monitor user identity.");
  }
}

function defaultHostedScenarioId(failureControlPlan, agentProvider) {
  if (failureControlPlan.enabled) return failureControlPlan.scenario.id;
  if (agentProvider === "fake_cartesia_gemini") return "fake_provider_happy_path";
  return "happy_path";
}

export function hostedDeployIds() {
  return {
    agent:
      process.env.VIVA_E2E_AGENT_DEPLOY_ID?.trim() ||
      process.env.VIVA_HOSTED_AGENT_DEPLOY_ID?.trim() ||
      null,
    web:
      process.env.VIVA_E2E_WEB_DEPLOY_ID?.trim() ||
      process.env.VIVA_HOSTED_WEB_DEPLOY_ID?.trim() ||
      null,
  };
}

export function hostedDeploySha() {
  return (
    process.env.VIVA_E2E_DEPLOY_SHA?.trim() ||
    process.env.VIVA_HOSTED_DEPLOY_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    null
  );
}

export function hostedPostgresDurability(hostedMode) {
  if (process.env.VIVA_E2E_POSTGRES_DURABLE === "1") return "durable";
  return hostedMode ? "hosted_not_asserted" : "loopback_not_asserted";
}

function buildE2EFailureControlEnv(hostedWebUrl) {
  const scenario =
    process.env.VIVA_E2E_FAILURE_CONTROL_SCENARIO ?? process.env.VIVA_FAILURE_CONTROL_SCENARIO;
  const enabled =
    process.env.VIVA_FAILURE_CONTROL_ENABLED === "1" ||
    Boolean(process.env.VIVA_E2E_FAILURE_CONTROL_SCENARIO);
  if (!enabled) return {};
  if (!scenario?.trim()) {
    throw new Error(
      "VIVA_E2E_FAILURE_CONTROL_SCENARIO is required when failure control is enabled",
    );
  }
  return {
    VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS:
      process.env.VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS ?? hostedWebUrl ?? null,
    VIVA_FAILURE_CONTROL_ENABLED: "1",
    VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY:
      process.env.VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY ?? "1",
    VIVA_FAILURE_CONTROL_SCENARIO: scenario.trim(),
    VIVA_FAILURE_CONTROL_SECRET:
      process.env.VIVA_FAILURE_CONTROL_SECRET ?? "local-e2e-failure-control-secret",
    VIVA_FAILURE_CONTROL_STUDY_SET_IDS:
      process.env.VIVA_FAILURE_CONTROL_STUDY_SET_IDS ?? "biology-midterm",
    VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS:
      process.env.VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS ?? "user-1",
    VIVA_VOICE_SESSION_TOKEN_SECRET:
      process.env.VIVA_VOICE_SESSION_TOKEN_SECRET ?? "local-e2e-session-token-secret",
  };
}

/**
 * Build the whole normalized, frozen run plan once from `process.env`. Every
 * other module receives this plan explicitly rather than reading
 * `process.env` a second time, so the harness has exactly one normalized
 * configuration surface.
 *
 * Field evaluation order matches the original single-file module's top-level
 * declaration order exactly, because `failureControlEnv` (and therefore
 * `failureControlPlan`) reads `hostedWebUrl` at a point before any local
 * (non-hosted) web origin is known -- preserved here by construction, since
 * `hostedWebUrl` is a plan input, never the runtime-resolved local `webUrl`.
 */
export function buildE2EPlan() {
  const artifactDir = path.resolve(root, process.env.VIVA_E2E_ARTIFACT_DIR ?? "artifacts/e2e-browser");
  const hostedWebUrl = optionalHostedHttpUrl("VIVA_E2E_HOSTED_WEB_URL");
  const hostedAgentHttpUrl = optionalHostedHttpUrl("VIVA_E2E_HOSTED_AGENT_HTTP_URL");
  const hostedAgentWsUrl = optionalHostedWsUrl("VIVA_E2E_HOSTED_AGENT_WS_URL");
  const hostedMode = Boolean(hostedWebUrl || hostedAgentHttpUrl || hostedAgentWsUrl);
  const hostedRestBearerToken = process.env.VIVA_E2E_HOSTED_REST_BEARER_TOKEN?.trim() ?? "";
  const agentProvider = process.env.VIVA_E2E_AGENT_PROVIDER ?? "synthetic";
  const failureControlEnv = buildE2EFailureControlEnv(hostedWebUrl);
  const failureControlPlan = buildFailureControlPlan({
    env: { ...process.env, ...failureControlEnv },
  });
  const failureControlEvidence = failureControlHarnessEvidence(failureControlPlan);
  const failureControlIdentity = failureControlPlan.enabled
    ? failureControlStartIdentity(failureControlPlan)
    : null;
  const sessionTokenFailureScenario =
    failureControlPlan.enabled && isFailureControlSessionTokenScenario(failureControlPlan.scenario);
  const durableStateReleaseClaimed =
    process.env.VIVA_E2E_DURABLE_STATE_RELEASE_CLAIMED === "1" ||
    process.env.VIVA_RELEASE_DURABLE_STATE_CLAIMED === "1";
  const stopToRecap = process.env.VIVA_E2E_STOP_TO_RECAP === "1";
  const hostedScenarioId =
    process.env.VIVA_E2E_HOSTED_SCENARIO_ID?.trim() ||
    defaultHostedScenarioId(failureControlPlan, agentProvider);
  const deterministicPartialRecapScenario = hostedScenarioId === "deterministic_partial_recap";
  const traceRequested = process.env.VIVA_E2E_TRACE === "1";
  const validationRunId = `browser-story-${agentProvider}-${new Date()
    .toISOString()
    .replaceAll(/[:.]/g, "-")}`;
  const requirePostAnswerSourceFolio =
    process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === undefined
      ? agentProvider === "synthetic"
      : process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === "1";
  const requireCorrectionMarginalia = agentProvider === "synthetic" && !stopToRecap;
  const requireVoiceTransportMatrix = process.env.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX === "1";
  const loopbackTestSkipAllowed = process.env.VIVA_ALLOW_LOOPBACK_TEST_SKIP === "1";
  /**
   * W-07: the disposable durable database the local signed-session story needs.
   *
   * Supplied by the caller (a disposable container locally; Task 17's
   * `scripts/ci-durable-postgres.sh` in CI). It is a connection URL the harness
   * passes through unchanged, never a value copied by name out of the ambient
   * environment.
   */
  const localAgentDatabaseUrl = process.env.VIVA_E2E_AGENT_DATABASE_URL?.trim() || "";
  const localSignedSessionMode = !hostedMode && Boolean(localAgentDatabaseUrl);
  const requireLearningTruth =
    !failureControlPlan.enabled &&
    !stopToRecap &&
    process.env.VIVA_E2E_REQUIRE_LEARNING_TRUTH !== "0";

  return Object.freeze({
    root,
    artifactDir,
    hostedWebUrl,
    hostedAgentHttpUrl,
    hostedAgentWsUrl,
    hostedMode,
    hostedRestBearerToken,
    agentProvider,
    failureControlEnv,
    failureControlPlan,
    failureControlEvidence,
    failureControlIdentity,
    sessionTokenFailureScenario,
    allowedBrowserStoryProviders: ALLOWED_BROWSER_STORY_PROVIDERS,
    durableStateReleaseClaimed,
    stopToRecap,
    hostedScenarioId,
    deterministicPartialRecapScenario,
    traceRequested,
    validationRunId,
    requirePostAnswerSourceFolio,
    requireCorrectionMarginalia,
    requireVoiceTransportMatrix,
    loopbackTestSkipAllowed,
    localAgentDatabaseUrl,
    localSignedSessionMode,
    requireLearningTruth,
  });
}

/**
 * Configuration that must hold before the story runs, checked here rather than
 * at import time so this module can be imported for its reducers alone.
 */
export function assertHarnessConfiguration(plan) {
  if (plan.hostedMode && !(plan.hostedWebUrl && plan.hostedAgentHttpUrl && plan.hostedAgentWsUrl)) {
    throw new Error(
      "Hosted browser E2E requires VIVA_E2E_HOSTED_WEB_URL, VIVA_E2E_HOSTED_AGENT_HTTP_URL, and VIVA_E2E_HOSTED_AGENT_WS_URL together.",
    );
  }
  if (plan.hostedMode && !plan.hostedRestBearerToken) {
    throw new Error("Hosted browser E2E requires VIVA_E2E_HOSTED_REST_BEARER_TOKEN.");
  }
  if (!plan.allowedBrowserStoryProviders.has(plan.agentProvider)) {
    throw new Error(
      `BAC-307 browser-story capture only supports non-live providers: ${[
        ...plan.allowedBrowserStoryProviders,
      ].join(", ")}.`,
    );
  }
  if (plan.hostedMode && plan.traceRequested) {
    throw new Error("Hosted browser E2E cannot retain Playwright traces.");
  }
  assertLocalSignedSessionSupport(plan);
}

/**
 * W-07: refuse a local run that cannot possibly reach an authenticated session,
 * up front and by name, instead of failing 20 seconds later on a disabled
 * button or an absent question heading.
 *
 * Three merged gates make a durable store a hard prerequisite of the local
 * story, and none of them belongs to this lane:
 *
 * 1. `validate_runtime_store_preflight` (agent-service config) refuses public
 *    signed-session mode over the in-memory store.
 * 2. Without a session-token secret the agent's library snapshot reports every
 *    start action `session_token_unavailable`, so the landing's Start control
 *    renders disabled and no affordance can reach `POST /api/viva-session/start`.
 * 3. The agent's authenticated projection route is constructed only where the
 *    scoped library-read credential and the session-token secret both exist,
 *    and `/session` opens its socket only once an
 *    `AuthenticatedStudyProjectionV1` has validated.
 *
 * The caller therefore supplies a disposable, migrated, fixture-seeded
 * Postgres. A run without one is refused rather than silently reduced to the
 * retired unsigned entry.
 */
export function assertLocalSignedSessionSupport(plan) {
  if (plan.hostedMode || plan.failureControlPlan.enabled || plan.localSignedSessionMode) return;
  throw new Error(
    "Local browser E2E requires VIVA_E2E_AGENT_DATABASE_URL: a disposable, migrated, fixture-seeded PostgreSQL 16 URL. The merged agent refuses signed-session mode over a volatile store, its library snapshot then reports every start action session_token_unavailable, and /session opens no socket without an authenticated study projection -- so no local run without a durable store can reach an authenticated session.",
  );
}
