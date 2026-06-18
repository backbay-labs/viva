import assert from "node:assert/strict";
import test from "node:test";

import { buildDevAgentEnv, devAgentArgs } from "./dev-agent.mjs";

test("local dev agent defaults to loopback synthetic without inherited auth secrets", () => {
  const env = buildDevAgentEnv({
    VIVA_VOICE_SESSION_TOKEN_SECRET: "prod-session-secret",
    VIVA_VOICE_WS_BEARER_TOKEN: "prod-bearer",
  });

  assert.equal(env.VIVA_AGENT_BIND_ADDR, "127.0.0.1:4318");
  assert.equal(env.VIVA_AGENT_PROVIDER, "synthetic");
  assert.equal(env.VIVA_VOICE_SESSION_TOKEN_SECRET, "");
  assert.equal(env.VIVA_VOICE_WS_BEARER_TOKEN, "");
});

test("local dev agent preserves explicit loopback/provider values", () => {
  const env = buildDevAgentEnv({
    VIVA_AGENT_BIND_ADDR: "  127.0.0.1:6543  ",
    VIVA_AGENT_PROVIDER: " fake_cartesia_gemini ",
  });

  assert.equal(env.VIVA_AGENT_BIND_ADDR, "127.0.0.1:6543");
  assert.equal(env.VIVA_AGENT_PROVIDER, "fake_cartesia_gemini");
});

test("signed-session dev mode preserves explicit secrets for production-path testing", () => {
  const env = buildDevAgentEnv({
    VIVA_DEV_AGENT_SIGNED_SESSION: "1",
    VIVA_VOICE_SESSION_TOKEN_SECRET: "local-session-secret",
    VIVA_VOICE_WS_BEARER_TOKEN: "local-bearer",
  });

  assert.equal(env.VIVA_VOICE_SESSION_TOKEN_SECRET, "local-session-secret");
  assert.equal(env.VIVA_VOICE_WS_BEARER_TOKEN, "local-bearer");
});

test("dev agent cargo args keep extra cargo arguments intact", () => {
  assert.deepEqual(devAgentArgs(["--locked"]), [
    "run",
    "--manifest-path",
    "agent/Cargo.toml",
    "-p",
    "agent-service",
    "--locked",
  ]);
});
