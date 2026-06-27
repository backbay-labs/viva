import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  ]);

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
    "VIVA_HOSTED_LIVE_MONITOR_STATE_DATE",
    "VIVA_HOSTED_LIVE_MONITOR_RUNS_TODAY",
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
    "VIVA_RELEASE_WEB_DEPLOY_ID",
    "VIVA_RELEASE_AGENT_DEPLOY_ID",
    "VIVA_RELEASE_CONFIG_DIFF_SHA256",
    "VIVA_RELEASE_PROVIDER_MODE",
    "VIVA_RELEASE_POSTGRES_STATE",
    "VIVA_RELEASE_RECOVERY_VALIDATION",
    "VIVA_RELEASE_OWNER",
    "VIVA_RELEASE_OWNER_DECISION=proceed",
    "VIVA_RELEASE_OWNER_DECIDED_AT_UTC",
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
  assert.match(dockerfile, /mcr\.microsoft\.com\/playwright:v1\.61\.0/);
  assert.match(dockerfile, /bun-v1\.3\.3/);
  assert.match(dockerfile, /bun install --frozen-lockfile/);
  assert.match(dockerfile, /\/app\/evidence\/live-smoke-answer\.pcm/);
  assert.match(dockerfile, /bun", "run", "hosted:monitor"/);
});

test("hosted monitor agent targets can deploy from the agent directory", async () => {
  const dockerfile = await readFile("agent/Dockerfile", "utf8");
  assert.match(dockerfile, /cargo build --manifest-path Cargo\.toml --release -p agent-service/);
  assert.match(
    dockerfile,
    /VIVA_AGENT_BIND_ADDR=\$\{VIVA_AGENT_BIND_ADDR:-0\.0\.0\.0:\$\{PORT:-4318\}\}/,
  );
  assert.doesNotMatch(dockerfile, /Dockerfile\.monitor|hosted:monitor/);
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
