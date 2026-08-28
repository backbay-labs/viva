#!/usr/bin/env node
// RELEASE-029: every process this repo spawns — hosted browser/live-smoke
// children, the local E2E harness's own agent/web children, dev-agent, and
// release-check's command/readiness children — receives an explicitly
// constructed environment, never Node's implicit ambient inheritance
// (`env: process.env` or `env: { ...process.env, ... }`). A fixed,
// role-independent operational allowlist (PATH, HOME, temp-dir variants,
// CI, locale) is layered with a typed, per-role set of explicit keys drawn
// from already-normalized plan/target inputs; nothing else the parent
// process happens to be carrying — stray provider keys, database URLs,
// production auth, failure-control values, NODE_OPTIONS/BUN_OPTIONS
// injection, unrelated VIVA_* values — can reach a spawned child.
//
// This module is a deny-first core: it has no generic "extra object" escape
// hatch. A caller may only set a key that this file has, by name, granted to
// that specific role; anything else is rejected before spawn.

// Selected operational keys only: enough for a child process to run at all
// (locate binaries, resolve $HOME-relative config/cache directories, use the
// correct temp directory, know it is running under CI, and use the correct
// locale). Never anything credential-shaped, never a runtime-injection
// vector such as NODE_OPTIONS/BUN_OPTIONS.
const OPERATIONAL_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "LANG",
  "LC_ALL",
]);

// The typed per-command map. Each role names exactly the explicit keys its
// spawn site may set. A role never receives a key it does not name here,
// even if the caller asks for it and even if the parent process happens to
// carry a same-named value.
const ROLE_EXPLICIT_KEYS = Object.freeze({
  // hosted-monitor-runner.mjs: the `bun run e2e:browser` child driven
  // against a hosted (already-deployed) web/agent origin, for both the
  // scheduled synthetic run and every PR-mode matrix/failure-control run.
  "hosted-browser": Object.freeze([
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
    "VIVA_E2E_AGENT_PROVIDER",
    "VIVA_E2E_ARTIFACT_DIR",
    "VIVA_E2E_DEPLOY_SHA",
    "VIVA_E2E_FAILURE_CONTROL_SCENARIO",
    "VIVA_E2E_HOSTED_AGENT_HTTP_URL",
    "VIVA_E2E_HOSTED_AGENT_WS_URL",
    "VIVA_E2E_HOSTED_REST_BEARER_TOKEN",
    "VIVA_E2E_HOSTED_SCENARIO_ID",
    "VIVA_E2E_HOSTED_WEB_URL",
    "VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO",
    "VIVA_E2E_SYNTHETIC_STUDY_SET_ID",
    "VIVA_E2E_SYNTHETIC_USER_ID",
    "VIVA_E2E_TRACE",
    "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS",
    "VIVA_FAILURE_CONTROL_ENABLED",
    "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY",
    "VIVA_FAILURE_CONTROL_SECRET",
    "VIVA_FAILURE_CONTROL_STUDY_SET_IDS",
    "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS",
    "VIVA_HOSTED_RUN_ID",
    // RELEASE-016/021: the session-signing failure-control scenarios
    // (expired_token and its session-auth siblings) all require explicit
    // browser action and are therefore never selectable through the hosted
    // PR matrix (see FAILURE_CONTROL_SCENARIOS_REQUIRING_BROWSER_ACTION in
    // hosted-e2e-matrix.mjs) -- no run this role ever builds needs the
    // session-token signing secret, so it is deliberately absent from this
    // list rather than granted and left unused.
  ]),
  // hosted-monitor-runner.mjs: the `bun run live:smoke` child driven
  // against the live (real Cartesia/Gemini-backed) hosted target. Never
  // receives a raw provider key or the session-token signing secret — see
  // `materializeHostedLiveSmokeRun`.
  "hosted-live": Object.freeze([
    "VIVA_AGENT_PROVIDER",
    "VIVA_HOSTED_RUN_ID",
    "VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES",
    "VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED",
    "VIVA_LIVE_PROVIDER_SMOKE",
    "VIVA_LIVE_SMOKE",
    "VIVA_LIVE_SMOKE_AGENT_HTTP_URL",
    "VIVA_LIVE_SMOKE_AGENT_WS_URL",
    "VIVA_LIVE_SMOKE_ARTIFACT_DIR",
    "VIVA_LIVE_SMOKE_AUDIO_FILE",
    "VIVA_LIVE_SMOKE_EVIDENCE_PATH",
    "VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD",
    "VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES",
    "VIVA_LIVE_SMOKE_MAX_DURATION_MS",
    "VIVA_LIVE_SMOKE_MAX_TOKENS",
    "VIVA_LIVE_SMOKE_MAX_TURNS",
    "VIVA_LIVE_SMOKE_ORIGIN",
    "VIVA_LIVE_SMOKE_RUN_ID",
    "VIVA_LIVE_SMOKE_SESSION_ID",
    "VIVA_LIVE_SMOKE_SESSION_TOKEN",
    "VIVA_LIVE_SMOKE_STUDY_SET_ID",
    "VIVA_LIVE_SMOKE_USER_ID",
    "VIVA_VOICE_WS_BEARER_TOKEN",
    "VIVA_VOICE_WS_MAX_SESSION_COST_USD",
  ]),
  // e2e-browser.mjs (local, non-hosted mode only): the local `cargo run`
  // agent-service child it supervises itself.
  "local-browser-agent": Object.freeze([
    "VIVA_AGENT_BIND_ADDR",
    // W-07: the durable-store and scoped-read keys the merged signed-session
    // configuration requires. `validate_runtime_store_preflight` refuses public
    // signed-session mode over a volatile store, and the agent's authenticated
    // projection route exists only where BOTH the scoped library-read
    // credential and the session-token secret are configured -- so the browser
    // gate can reach an authenticated study session only with these present.
    "VIVA_AGENT_DATABASE_URL",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_AGENT_PROVIDER",
    "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS",
    "VIVA_FAILURE_CONTROL_ENABLED",
    "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY",
    "VIVA_FAILURE_CONTROL_SCENARIO",
    "VIVA_FAILURE_CONTROL_SECRET",
    "VIVA_FAILURE_CONTROL_STUDY_SET_IDS",
    "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS",
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_VOICE_WS_ALLOWED_ORIGINS",
  ]),
  // e2e-browser.mjs (local, non-hosted mode only): the local `bun run --cwd
  // apps/web dev` child it supervises itself.
  //
  // W-07: the server-side keys below are the merged D-07 Branch A landing
  // contract's own configuration. Without them the landing's library row
  // reports `session_capability_unavailable` and its Start action renders
  // disabled, so no affordance on the page can reach
  // `POST /api/viva-session/start` — which is precisely the "zero start POSTs"
  // W-07 recorded. Every value the harness supplies for these is a constructed
  // loopback literal, never a value copied by name out of `parentEnv`.
  "local-browser-web": Object.freeze([
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_AGENT_REST_BEARER_TOKEN",
    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_WEB_CANONICAL_ORIGIN",
    "VIVA_WEB_SINGLE_INSTANCE",
  ]),
  // e2e-browser.mjs: the `bun run e2e:browser:audio` child it drives for the
  // required voice-transport matrix. The audio harness takes its whole
  // configuration from CLI arguments and a fixed artifact directory, so it
  // needs no explicit key at all -- only the operational allowlist.
  "local-browser-audio": Object.freeze([]),
  // dev-agent.mjs: the local `cargo run` agent-service child a developer
  // runs directly.
  "dev-agent": Object.freeze([
    "VIVA_AGENT_BIND_ADDR",
    "VIVA_AGENT_PROVIDER",
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_VOICE_WS_BEARER_TOKEN",
  ]),
  // release-check.mjs: the generic named-command runner (`run()`) used for
  // hygiene, every `node --test`/`cargo test`/`cargo build` proof, the
  // rollback-drain proof commands, and the browser E2E children it drives
  // itself.
  "release-check-command": Object.freeze([
    // W-07: the disposable durable-store URL the local browser story needs to
    // reach an authenticated session. It is a caller-constructed connection
    // string threaded through to `e2e-browser.mjs`, never a value copied by
    // name out of the release runner's own environment.
    "VIVA_E2E_AGENT_DATABASE_URL",
    "VIVA_E2E_AGENT_PROVIDER",
    "VIVA_E2E_ARTIFACT_DIR",
    "VIVA_E2E_DURABLE_STATE_RELEASE_CLAIMED",
    "VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO",
  ]),
  // release-check.mjs: the local agent-service binary spawned directly
  // (not via `bun run`/cargo) once per provider-readiness target. The
  // `cartesia_gemini` target's placeholder provider keys are constructed,
  // non-secret literals from `provider-readiness-matrix.mjs`, proving the
  // gate keeps the live provider unselectable without zero-retention
  // confirmation — never a value copied by name from the parent process.
  "release-check-provider-readiness": Object.freeze([
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "VIVA_AGENT_BIND_ADDR",
    "VIVA_AGENT_PROVIDER",
  ]),
});

export const CHILD_ENVIRONMENT_ROLES = Object.freeze(Object.keys(ROLE_EXPLICIT_KEYS));

/**
 * Build the exact environment object for a spawned child: the fixed
 * operational allowlist (only the keys actually present in `parentEnv`)
 * plus `explicit`'s keys, restricted to the ones `role` is allowed to set.
 *
 * There is no generic escape hatch for additional keys. `explicit` values
 * must already be the caller's own normalized plan/target configuration —
 * never a blind copy of `parentEnv` by name.
 */
export function childEnvironmentFor(role, { parentEnv, explicit = {} } = {}) {
  const allowedKeys = ROLE_EXPLICIT_KEYS[role];
  if (!allowedKeys) {
    throw new Error(`child-environment: unknown role "${role}"`);
  }
  if (!parentEnv || typeof parentEnv !== "object") {
    throw new Error("child-environment: parentEnv is required");
  }
  if (!explicit || typeof explicit !== "object") {
    throw new Error("child-environment: explicit must be an object");
  }
  assertKnownRoleKeys(role, allowedKeys, explicit);

  const env = pickDefined(parentEnv, OPERATIONAL_KEYS);
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue;
    env[key] = String(value);
  }
  return Object.freeze(env);
}

function assertKnownRoleKeys(role, allowedKeys, explicit) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(explicit).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `child-environment: role "${role}" does not allow explicit key(s): ${unknown.join(", ")}`,
    );
  }
}

function pickDefined(source, keys) {
  const picked = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}
