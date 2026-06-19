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
    "REST bootstrap",
    "Authorization: Bearer",
    "connectVivaAgent({ token })",
    "bearer.",
    "direct browser signed-session path omits it",
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
    "VIVA_LIVE_PROVIDER_SMOKE",
    "VIVA_LIVE_SMOKE_AUDIO_FILE",
    "VIVA_LIVE_SMOKE_MAX_DURATION_MS",
    "VIVA_LIVE_SMOKE_MAX_TURNS",
    "VIVA_VOICE_WS_MAX_SESSION_COST_USD",
    "bun run e2e:browser",
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "cartesia_gemini",
    "selectable: true",
    "live_runtime: true",
    "recap_ready",
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
