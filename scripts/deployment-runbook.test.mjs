import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { containerRuntimeSmokeSteps } from "./container-runtime-smoke.mjs";

const RUNBOOK_PATH = "docs/deployment-runbook.md";

test("deployment runbook covers the beta operating path and stop rules", async () => {
  const runbook = await readFile(RUNBOOK_PATH, "utf8");

  assert.match(runbook, /^# Viva Deployment Runbook$/m);
  const topology = requiredSection(runbook, "## Topology");
  const runtime = requiredSection(runbook, "## Runtime Configuration");
  const postgres = requiredSection(runbook, "## Managed Postgres");
  const secrets = requiredSection(runbook, "## Secrets And Origins");
  const health = requiredSection(runbook, "## Health Checks");
  const smoke = requiredSection(runbook, "## Release Smoke");
  const hostedMonitor = requiredSection(runbook, "## Hosted E2E Monitor Substrate");
  const rollback = requiredSection(runbook, "## Rollback And Drain");
  const redaction = requiredSection(runbook, "## Logs And Evidence Redaction");

  assertIncludesAll(topology, [
    "HTTPS",
    "WSS",
    'NEXT_PUBLIC_VIVA_API_URL="https://agent.viva.example.com"',
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "/study-sets/paste",
    "/study-sets/library",
    "/health",
    "/live",
    "/ready",
    "/health/brain",
    "/ws",
  ]);

  assertIncludesAll(runtime, [
    "VIVA_AGENT_BIND_ADDR",
    "VIVA_AGENT_PROVIDER",
    "direct browser WSS",
    "REST paste/library bootstrap uses the REST bootstrap bearer path",
    "synthetic",
    "cartesia_gemini",
    "fake_cartesia_gemini",
    "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME",
    "CARTESIA_ZERO_DATA_RETENTION_ENABLED",
    "GEMINI_ZERO_DATA_RETENTION_APPROVED",
    "VIVA_VOICE_WS_MAX_SESSIONS",
    "VIVA_VOICE_WS_SESSION_SECONDS",
    "VIVA_VOICE_WS_TURN_SECONDS",
    "VIVA_VOICE_WS_MAX_USER_SESSIONS",
    "VIVA_VOICE_WS_MAX_IP_SESSIONS",
    "VIVA_VOICE_WS_MAX_AUDIO_BYTES_PER_MINUTE",
    "VIVA_VOICE_WS_MAX_SESSION_COST_USD",
    // SERVICE-003 (Plan 08 handoff, applied by Plan 12 Task 15 Step 5A): the
    // per-IP cap's client-address derivation is peer-first, trusted-proxy-aware.
    "VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS",
    "socket peer address",
    "needs no forwarding proxy header",
    "X-Forwarded-For",
    "right to left",
    "X-Real-IP",
    "trusted proxy",
    "rejected before a session slot",
  ]);

  // SERVICE-003: a direct (non-proxied) deployment must never be documented as
  // requiring a forwarding header -- that claim is exactly the spoofable
  // left-most-XFF defect (Important I2) this section closes.
  assert.doesNotMatch(
    runtime,
    /direct[a-z /-]*\brequires?\b[^.\n]{0,60}forward/i,
    "runtime section must not claim a direct deployment requires a forwarding proxy header",
  );

  assertIncludesAll(postgres, [
    "DATABASE_URL",
    "VIVA_AGENT_DATABASE_URL",
    "postgres",
    "in_memory",
    "bun run validate",
  ]);

  assertIncludesAll(secrets, [
    "no-secret loopback/dev path",
    "signed-session production path",
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_VOICE_WS_BEARER_TOKEN",
    "VIVA_VOICE_WS_ALLOWED_ORIGINS",
    "deterministic failure controls",
    "VIVA_FAILURE_CONTROL_ENABLED",
    "VIVA_FAILURE_CONTROL_SCENARIO",
    "VIVA_FAILURE_CONTROL_SECRET",
    "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS",
    "VIVA_FAILURE_CONTROL_STUDY_SET_IDS",
    "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS",
    "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY",
    "public generic force-failure endpoint",
    "REST bootstrap",
    "/api/viva-session/start",
    "/api/viva-session/refresh",
    "server-only same-origin session bootstrap",
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_REST_BEARER_TOKEN",
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_MINT_MAX_PER_MINUTE",
    // A-34.4: the agent-side session-mint credential rides the combined 12B
    // admission; the mint/record scoping sentence is the A-36 authority record.
    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
    "mint/record operation only",
    "token_refresh_outcome",
    "invalid_rejected",
    "Authorization: Bearer",
    "connectVivaAgent({ token })",
    "bearer.",
    "session_bootstrap_token",
    "WebSocket protocol credential",
    "browser never needs the REST bearer",
    "nonce",
  ]);

  assertIncludesAll(health, [
    "/health",
    "/live",
    "/ready",
    "/health/brain",
    "HTTP 200",
    "HTTP 503",
    "configured",
    "selectable",
    "live_runtime",
    "cartesia_gemini",
    "placeholder",
  ]);

  assertIncludesAll(smoke, [
    "no-secret default validation",
    "opt-in live smoke",
    "bun run validate",
    "bun run release:check",
    "bun run live:smoke",
    "VIVA_E2E_FAILURE_CONTROL_SCENARIO",
    "failure_control_harness disabled state",
    "rollback_drain criteria",
    "provider_failure_observability dashboard criteria",
    "hosted_e2e_matrix contract",
    "production_release_gate summary",
    "release_bundle integrity hash/signature",
    "browser-skipped result cannot certify production readiness",
    "VIVA_LIVE_PROVIDER_SMOKE",
    "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME",
    "VIVA_LIVE_SMOKE_AUDIO_FILE",
    "VIVA_LIVE_SMOKE_MAX_DURATION_MS",
    "VIVA_LIVE_SMOKE_MAX_TURNS",
    "VIVA_VOICE_WS_MAX_SESSION_COST_USD",
    "bun run e2e:browser",
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "CARTESIA_ZERO_DATA_RETENTION_ENABLED",
    "GEMINI_ZERO_DATA_RETENTION_APPROVED",
    "cartesia_gemini",
    "selectable: true",
    "live_runtime: true",
    "recap_ready",
    "VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED",
    "never reads",
    "the only component that holds them",
  ]);

  assertIncludesAll(hostedMonitor, [
    "Railway cron service",
    "viva-hosted-monitor",
    "railway.json",
    "intentionally scoped to the `viva-hosted-monitor` service",
    "Dockerfile.monitor",
    "bun run hosted:monitor",
    "VIVA_HOSTED_RUNNER_MODE=scheduled",
    "VIVA_HOSTED_RUNNER_MODE=pr",
    "VIVA_HOSTED_MATRIX_PROFILE",
    "VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS",
    "provider 429",
    "provider timeout",
    "silent stall",
    "malformed stream",
    "double submit",
    "typed fallback",
    "BAC-532",
    "BAC-535",
    "VIVA_HOSTED_LIVE_MONITOR_ENABLED",
    "VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL",
    "VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD",
    "VIVA_HOSTED_LIVE_MONITOR_AUDIO_FILE",
    "VIVA_HOSTED_LIVE_MONITOR_SESSION_ID",
    "VIVA_HOSTED_LIVE_MONITOR_STUDY_SET_ID",
    "VIVA_HOSTED_LIVE_MONITOR_USER_ID",
    "VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD",
    "/app/evidence/live-smoke-answer.pcm",
    "pre-provisioned synthetic live-session",
    "scheduled_hosted_live_smoke",
    "bun run live:smoke",
    "viva-monitor-live-smoke",
    "0.25 USD per run",
    "0.50 USD per day",
    "self-quarantine",
    "VIVA_HOSTED_WEB_URL",
    "VIVA_HOSTED_AGENT_HTTP_URL",
    "VIVA_HOSTED_AGENT_WS_URL",
    "VIVA_HOSTED_REST_BEARER_TOKEN",
    "VIVA_E2E_AGENT_PROVIDER",
    "VIVA_HOSTED_PUBLISH_TIMEOUT_MS",
    "VIVA_HOSTED_FAKE_PROVIDER_WEB_URL",
    "VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_RATE_LIMITED_WEB_URL",
    "VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_RATE_LIMITED_AGENT_HTTP_URL",
    "VIVA_HOSTED_FAILURE_CONTROL_TYPED_FALLBACK_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}",
    "fake_cartesia_gemini",
    "cartesia_gemini",
    "VIVA_HOSTED_ARTIFACT_BUCKET",
    "VIVA_FAILURE_CONTROL_SECRET",
    "failed or timed-out browser legs",
    "must not share one hosted agent origin",
    "synthetic or fake monitor deployment",
    "synthetic monitor identity",
    "token-refresh outcome",
    "publishes only text, JSON, and log artifacts",
    "object prefix",
    "not GitHub Actions",
    "Durable live-monitor state",
    "viva-hosted-monitor/state/live-monitor-state.v1.json",
    "no longer operator-set environment state",
    "runs_today",
    "tokens_today",
    "cost_usd_today",
    "consecutive_failures",
    "last_applied_run_id",
    "active_reservation",
    "never carries a learner/provider payload or a secret value",
    "cas-probe.v1.json",
    "If-Match",
    "If-None-Match: *",
    "state_unavailable",
    "Plan 15 handoff item 4",
    "compare-and-swap",
    "conservatively charged",
    "never refunded from unverifiable partial evidence",
    "publish_failed",
    "manifest last",
    "VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES",
    "VIVA_LIVE_SMOKE_RUN_ID",
    "VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED",
    "immediately before spawning",
    "never persisted in the plan",
    "run's own timeout plus",
    "flush grace",
    "agent deploy id",
  ]);

  assertIncludesAll(rollback, [
    "curl -fsS",
    "%{http_code}",
    "live_status",
    "ready_status",
    "200",
    "503",
    "SIGTERM",
    "session_phase",
    "drained",
    "voice session draining",
    "Provider 429 rate",
    ">=10%",
    "Provider timeout rate",
    ">=5%",
    "Provider auth failure",
    ">=1",
    "Stuck checking",
    "45s",
    "Recap failure rate",
    "Token refresh failure rate",
    ">=2%",
    "Live monitor failure",
    "scripts/rollback-drain-criteria.mjs",
    "ready_route_reports_unavailable_during_voice_drain",
    "websocket_preflight_rejects_new_sessions_after_drain_begins",
    "websocket_drain_emits_terminal_phase_before_close",
    "websocket_drain_interrupts_active_provider_response",
    "VIVA_PRODUCTION_RELEASE",
    "VIVA_RELEASE_RUN_ID",
    "VIVA_RELEASE_WEB_DEPLOY_ID",
    "VIVA_RELEASE_AGENT_DEPLOY_ID",
    "VIVA_RELEASE_DEPLOY_SHA",
    "VIVA_LIVE_WEB_DEPLOY_ID",
    "VIVA_LIVE_AGENT_DEPLOY_ID",
    "VIVA_RELEASE_WEB_ORIGIN",
    "VIVA_RELEASE_AGENT_ORIGIN",
    "VIVA_RELEASE_CONFIG_DIFF_SHA256",
    "VIVA_RELEASE_SECRETS_SNAPSHOT_SHA256",
    "VIVA_RELEASE_PROVIDER_MODE",
    "VIVA_RELEASE_POSTGRES_STATE",
    "VIVA_RELEASE_RECOVERY_VALIDATION",
    "VIVA_RELEASE_LIVE_SMOKE_EVIDENCE_PATH",
    "VIVA_PROVIDER_LIMITER_STATE",
    "VIVA_GEMINI_QUOTA_CONFIRMED=1",
    "VIVA_GEMINI_QUOTA_RPM_LIMIT",
    "VIVA_GEMINI_QUOTA_TPM_LIMIT",
    "VIVA_RELEASE_BUNDLE_SIGNING_SECRET",
    "browser-skipped evidence",
    "ephemeral durability mode",
    "VIVA_RELEASE_OWNER",
    "VIVA_RELEASE_OWNER_DECISION=proceed",
    "VIVA_RELEASE_OWNER_DECIDED_AT_UTC",
    "Exact run and deploy binding",
    "resolving any production path",
    "lexicographically latest run directory",
    "one-character difference is rejected",
    "sanitized",
    "must be strictly `true`",
    "not only the runs a",
    "required recovery scenario names",
    "live_smoke_run_id_match",
    "live_smoke_agent_deploy_match",
    "live_smoke_deploy_sha_match",
    "VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID",
    "Downstream bundle verification",
    "release:verify",
    "verify-release-bundle.mjs",
    "accepts exactly one evidence path",
    "hmac-sha256",
    "signature_key_present",
    "rejected outright",
    "never silently downgraded",
    "sha256-self",
    "wrong secret, or any tamper",
    "stale at verification time",
    "VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS",
    "future-dated",
    "rejected exactly like a tampered one",
    "verification failure, never a silently skipped check",
    "assertProductionReleaseGate",
    "validly signed but incomplete bundle is still rejected",
    "sanitized JSON line",
    "payload_sha256",
    "never a secret or raw evidence field",
    "Plan 15 supplies the real secret",
    "authorized deployment/release environment",
    "Container supply chain",
    "sha256:",
    "rust:1.94.1-slim-bookworm",
    "debian:bookworm-slim",
    "mcr.microsoft.com/playwright:v1.61.0-noble",
    "Bun 1.3.3 from verified release bytes",
    "bun-linux-x64.zip",
    "bun-linux-aarch64.zip",
    "sha256sum -c",
    "`RUN` layer",
    "uid/gid `10001:10001`",
    "pwuser",
    "/app/evidence",
    "before the `USER`",
    "re-enters root",
    "build_inputs",
    "deployment_outputs",
    "VIVA_RELEASE_AGENT_IMAGE_DIGEST",
    "VIVA_RELEASE_MONITOR_IMAGE_DIGEST",
    "swapped between agent and monitor",
    "never inferred from a",
    "can never masquerade as",
  ]);

  assertIncludesAll(redaction, [
    "provider keys",
    "raw audio",
    "transcript text",
    "answer text",
    "prompts",
    "full notes",
    "source excerpts",
    "raw provider responses",
    "forbidden_hits",
  ]);

  assert.doesNotMatch(runbook, /\b(kubernetes|k8s|soc\s*-?\s*2|payments?|lms)\b/i);
});

test("hosted monitor substrate config is deployable off GitHub Actions", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["hosted:monitor"], "node scripts/hosted-monitor-runner.mjs");

  const railwayMonitor = JSON.parse(await readFile("railway.json", "utf8"));
  assert.equal(railwayMonitor.build.builder, "DOCKERFILE");
  assert.equal(railwayMonitor.build.dockerfilePath, "Dockerfile.monitor");
  assert.equal(railwayMonitor.deploy.startCommand, "bun run hosted:monitor");
  assert.equal(railwayMonitor.deploy.cronSchedule, "*/30 * * * *");
  assert.equal(railwayMonitor.deploy.restartPolicyType, "NEVER");
  assert.deepEqual(railwayMonitor.build.watchPatterns.sort(), [
    "Dockerfile.monitor",
    "agent/fixtures/**",
    "apps/web/**",
    "bun.lock",
    "docs/deployment-runbook.md",
    "package.json",
    "packages/**",
    "railway.json",
    "scripts/**",
  ]);

  const dockerfile = await readFile("Dockerfile.monitor", "utf8");
  assert.match(dockerfile, /mcr\.microsoft\.com\/playwright:v1\.61\.0-noble@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /bun-v1\.3\.3/);
  assert.match(dockerfile, /bun install --frozen-lockfile/);
  assert.match(dockerfile, /\/app\/evidence\/live-smoke-answer\.pcm/);
  assert.match(dockerfile, /bun", "run", "hosted:monitor"/);
  // RELEASE-026: verified Bun bytes (not a curl-piped installer script),
  // and a non-root pwuser owning the evidence directory before CMD.
  assert.doesNotMatch(dockerfile, /curl[^\n]*\|\s*(ba)?sh\b/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /\nUSER pwuser\s*\n/);
  assert.match(dockerfile, /chown(?:\s+-R)?\s+pwuser:pwuser\s+\/app\/evidence/);
});

test("RELEASE-004: downstream bundle verification is wired as a package script", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["release:verify"], "node scripts/verify-release-bundle.mjs");
});

// ROWS 365/529/685 LIVE DEFECT fix: agent/Dockerfile targets the agent
// service, but `docker build -f agent/Dockerfile agent` (the plan's original
// build-context recipe) can never succeed -- agent-domain's include_str! of
// packages/core/src/learner-loop-contract.json reaches outside a context
// scoped to agent/ alone. The Dockerfile now requires the repository root as
// its build context (see the real command in container-runtime-smoke.mjs and
// docs/deployment-runbook.md); this test pins that its COPY sources are
// repo-root-relative, not agent-directory-relative, so a future edit cannot
// silently revert to the broken agent-only recipe.
test("hosted monitor agent Dockerfile targets the agent service and requires the repository root as its build context, not the agent directory alone", async () => {
  const dockerfile = await readFile("agent/Dockerfile", "utf8");
  assert.match(dockerfile, /cargo build --manifest-path Cargo\.toml --release -p agent-service/);
  assert.match(
    dockerfile,
    /VIVA_AGENT_BIND_ADDR=\$\{VIVA_AGENT_BIND_ADDR:-0\.0\.0\.0:\$\{PORT:-4318\}\}/,
  );
  assert.doesNotMatch(dockerfile, /Dockerfile\.monitor|hosted:monitor/);
  // Repo-root-relative COPY sources: `docker build -f agent/Dockerfile agent`
  // cannot provide these paths, only `docker build -f agent/Dockerfile .` can.
  assert.match(dockerfile, /^COPY agent\/Cargo\.toml agent\/Cargo\.lock agent\/rust-toolchain\.toml/m);
  assert.match(dockerfile, /^COPY agent\/crates /m);
  assert.match(dockerfile, /^COPY packages\/core /m);
  // RELEASE-026: pinned digests and a non-root runtime user.
  assert.match(dockerfile, /^FROM rust:1\.94\.1-slim-bookworm@sha256:[0-9a-f]{64} AS builder$/m);
  assert.match(dockerfile, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64} AS runtime$/m);
  assert.match(dockerfile, /\nUSER 10001:10001\s*\n/);
});

// ROWS 365/529/685: the runbook's hand-written example commands must not
// drift from scripts/container-runtime-smoke.mjs's own step definitions --
// the actually-executed source of truth (see its own comment on why the
// build context and tmpfs uid/gid are what they are).
test("ROWS 365/529/685: the runbook's container-supply-chain commands match container-runtime-smoke.mjs's real steps", async () => {
  const runbook = await readFile(RUNBOOK_PATH, "utf8");
  const section = requiredSection(runbook, "### Container supply chain (RELEASE-026)")
    // The runbook line-wraps long commands with a trailing `\` continuation;
    // collapse that back to the single-line form containerRuntimeSmokeSteps
    // itself produces before comparing.
    .replaceAll(/ \\\n\s*/g, " ");
  const steps = containerRuntimeSmokeSteps();
  for (const step of steps) {
    // The runbook renders this as a human-typed shell line: any arg
    // containing a space (only ever the trailing `-c` shell predicate) is
    // single-quoted there, unlike the bare argv array containerRuntimeSmokeSteps
    // itself returns.
    const shellForm = step.args.map((arg) => (arg.includes(" ") ? `'${arg}'` : arg)).join(" ");
    assert.match(
      section,
      new RegExp(escapeRegExp(shellForm)),
      `runbook is missing or drifted from the real ${step.id} command`,
    );
  }
});

function requiredSection(markdown, heading) {
  const marker = `${heading}\n`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `${heading} section missing`);
  const contentStart = start + marker.length;
  const remaining = markdown.slice(contentStart);
  const nextHeading = remaining.search(/^## /m);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

function assertIncludesAll(text, requiredValues) {
  for (const value of requiredValues) {
    assert.match(text, new RegExp(escapeRegExp(value), "i"));
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
