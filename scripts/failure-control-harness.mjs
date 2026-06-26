import { createHmac } from "node:crypto";

const HARNESS_SCHEMA = "viva.failure_control_harness.v1";
const SESSION_TOKEN_SCENARIOS = new Set([
  "invalid_token",
  "expired_token",
  "replayed_token",
  "malformed_token",
]);

const scenario = ({
  id,
  failure_class,
  stage,
  terminal_reason = null,
  browser_control = false,
}) =>
  Object.freeze({
    allowlisted_origin_required: true,
    browser_control,
    control_secret_required: true,
    failure_class,
    id,
    release_gate_must_fail_if_enabled: true,
    sanitized_evidence: true,
    stage,
    synthetic_identity_only: true,
    terminal_reason,
  });

export const FAILURE_CONTROL_SCENARIOS = Object.freeze([
  scenario({
    failure_class: "quota_rate_failure",
    id: "provider_rate_limited",
    stage: "gemini",
    terminal_reason: "provider_rate_limited",
  }),
  scenario({
    failure_class: "provider_auth_failure",
    id: "provider_auth_failed",
    stage: "provider_auth",
    terminal_reason: "provider_auth_failed",
  }),
  scenario({
    failure_class: "timeout",
    id: "provider_timeout",
    stage: "gemini",
    terminal_reason: "provider_timeout",
  }),
  scenario({
    failure_class: "timeout",
    id: "silent_stall",
    stage: "provider_stream",
    terminal_reason: "provider_timeout",
  }),
  scenario({
    failure_class: "malformed_stream",
    id: "provider_malformed_stream",
    stage: "provider_stream",
    terminal_reason: "provider_malformed_stream",
  }),
  scenario({
    failure_class: "network_disconnect",
    id: "provider_network_disconnect",
    stage: "provider_stream",
    terminal_reason: "provider_network_disconnect",
  }),
  scenario({
    failure_class: "timeout",
    id: "sonic_tts_timeout",
    stage: "sonic_tts",
    terminal_reason: "provider_timeout",
  }),
  scenario({
    failure_class: "timeout",
    id: "recap_timeout",
    stage: "recap",
    terminal_reason: "provider_timeout",
  }),
  scenario({
    browser_control: true,
    failure_class: "auth_material_failure",
    id: "invalid_token",
    stage: "session_auth",
    terminal_reason: "session_auth_rejected",
  }),
  scenario({
    browser_control: true,
    failure_class: "auth_material_failure",
    id: "expired_token",
    stage: "session_auth",
    terminal_reason: "session_auth_rejected",
  }),
  scenario({
    browser_control: true,
    failure_class: "auth_material_failure",
    id: "replayed_token",
    stage: "session_auth",
    terminal_reason: "session_auth_rejected",
  }),
  scenario({
    browser_control: true,
    failure_class: "auth_material_failure",
    id: "malformed_token",
    stage: "session_auth",
    terminal_reason: "session_auth_rejected",
  }),
  scenario({
    failure_class: "slow_client",
    id: "slow_stale_socket_close",
    stage: "websocket_generation",
    terminal_reason: "slow_client",
  }),
  scenario({
    failure_class: "slow_client",
    id: "double_submit_race",
    stage: "answer_submission",
    terminal_reason: "slow_client",
  }),
  scenario({
    browser_control: true,
    failure_class: "slow_client",
    id: "mic_denied",
    stage: "browser_mic",
    terminal_reason: "slow_client",
  }),
  scenario({
    browser_control: true,
    failure_class: "partial_stage_success",
    id: "typed_fallback",
    stage: "browser_fallback",
    terminal_reason: "partial_stage_success",
  }),
]);

const scenariosById = new Map(FAILURE_CONTROL_SCENARIOS.map((entry) => [entry.id, entry]));

export function buildFailureControlPlan({ env = process.env } = {}) {
  if (env.VIVA_FAILURE_CONTROL_ENABLED !== "1") {
    return { enabled: false, reason: "disabled" };
  }

  const scenarioId = requiredValue(env, "VIVA_FAILURE_CONTROL_SCENARIO", "scenario");
  const selected = scenariosById.get(scenarioId);
  if (!selected) {
    throw new Error(`unknown failure-control scenario ${scenarioId}`);
  }
  requiredValue(env, "VIVA_FAILURE_CONTROL_SECRET", "control secret");
  const syntheticUserIds = requiredList(
    env,
    "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS",
    "synthetic identity allowlist",
  );
  const studySetIds = requiredList(
    env,
    "VIVA_FAILURE_CONTROL_STUDY_SET_IDS",
    "study-set allowlist",
  );
  const allowedOrigins = requiredList(
    env,
    "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS",
    "origin allowlist",
  );
  const maxSessionsPerIdentity = positiveInteger(
    requiredValue(
      env,
      "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY",
      "per-identity cap",
    ),
    "per-identity cap",
  );

  return {
    allowedOrigins,
    enabled: true,
    maxSessionsPerIdentity,
    scenario: selected,
    studySetIds,
    syntheticUserIds,
  };
}

export function failureControlStartIdentity(plan) {
  if (plan?.enabled !== true) {
    throw new Error("failure-control plan is not enabled");
  }
  const userId = plan.syntheticUserIds?.[0]?.trim();
  const studySetId = plan.studySetIds?.[0]?.trim();
  if (!userId || !studySetId) {
    throw new Error("failure-control plan has no configured synthetic start identity");
  }
  return { studySetId, userId };
}

export function failureControlScenarioMarker(scenario) {
  const id = scenario?.id?.trim();
  if (!id) {
    throw new Error("failure-control scenario id is required");
  }
  return `failure-control-${id}`;
}

export function isFailureControlSessionTokenScenario(scenario) {
  return SESSION_TOKEN_SCENARIOS.has(scenario?.id);
}

export function parseFailureControlSessionTarget(target) {
  const url = new URL(target, "http://viva.local");
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const sessionToken = hashParams.get("session_token")?.trim();
  const parsed = {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    sessionId: url.searchParams.get("session_id")?.trim() ?? "",
    sessionToken: sessionToken ?? "",
    studySetId: url.searchParams.get("study_set_id")?.trim() ?? "",
    userId: url.searchParams.get("user_id")?.trim() ?? "",
  };
  if (!parsed.userId || !parsed.studySetId || !parsed.sessionId || !parsed.sessionToken) {
    throw new Error("failure-control session target is missing identity or token fields");
  }
  return parsed;
}

export function failureControlSessionTargetForScenario(
  target,
  scenario,
  { sessionSecret = process.env.VIVA_VOICE_SESSION_TOKEN_SECRET, now = Math.floor(Date.now() / 1000) } = {},
) {
  const parsed = parseFailureControlSessionTarget(target);
  if (!isFailureControlSessionTokenScenario(scenario)) {
    return {
      target,
      token_mode: "valid",
      preconsume_replay: false,
    };
  }
  const mode = scenario.id;
  const sessionToken =
    mode === "invalid_token"
      ? invalidSessionToken(parsed.sessionToken)
      : mode === "expired_token"
        ? expiredSessionToken(parsed.sessionToken, sessionSecret, now)
        : mode === "malformed_token"
          ? "not-a-viva-token"
          : parsed.sessionToken;
  return {
    target: targetWithSessionToken(target, sessionToken),
    token_mode: mode,
    preconsume_replay: mode === "replayed_token",
  };
}

export function failureControlHarnessEvidence(plan) {
  const enabled = plan?.enabled === true;
  const scenarioIds = FAILURE_CONTROL_SCENARIOS.map((entry) => entry.id);
  return {
    schema: HARNESS_SCHEMA,
    enabled_for_release: false,
    selected_scenario: enabled ? plan.scenario.id : null,
    scenario_count: FAILURE_CONTROL_SCENARIOS.length,
    scenario_ids: scenarioIds,
    controls: {
      allowlisted_origin_required: true,
      control_secret_required: true,
      per_identity_cap: enabled ? plan.maxSessionsPerIdentity : null,
      release_gate_must_fail_if_enabled: true,
      signed_control_claim_required: true,
      synthetic_identity_only: true,
    },
    deterministic: true,
    sanitized: true,
  };
}

function targetWithSessionToken(target, sessionToken) {
  const url = new URL(target, "http://viva.local");
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  hashParams.set("session_token", sessionToken);
  const hash = hashParams.toString();
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ""}`;
}

function invalidSessionToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "viva1" || !parts[2]) {
    return `${token}.tampered`;
  }
  const last = parts[2].at(-1);
  const replacement = last === "A" ? "B" : "A";
  return `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${replacement}`;
}

function expiredSessionToken(token, secret, now) {
  const trimmedSecret = secret?.trim();
  if (!trimmedSecret) {
    throw new Error("VIVA_VOICE_SESSION_TOKEN_SECRET is required for expired-token control");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "viva1") {
    throw new Error("failure-control expired-token control requires a signed viva1 token");
  }
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  claims.expires_at = Math.max(0, now - 61);
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `viva1.${claimsPart}`;
  const signature = createHmac("sha256", trimmedSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function requiredValue(env, name, label) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`failure-control ${label} is required`);
  }
  return value;
}

function requiredList(env, name, label) {
  const values = requiredValue(env, name, label)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`failure-control ${label} is required`);
  }
  return values;
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`failure-control ${label} must be a positive integer`);
  }
  return parsed;
}
