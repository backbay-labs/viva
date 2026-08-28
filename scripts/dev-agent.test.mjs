import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildDevAgentEnv,
  devAgentArgs,
  devAgentChildOptions,
  runDevAgent,
} from "./dev-agent.mjs";

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

test("local dev agent clears a hostile parent environment down to the operational allowlist plus its own explicit keys", () => {
  const env = buildDevAgentEnv({
    PATH: "/usr/bin",
    HOME: "/home/hostile",
    DATABASE_URL: "postgres://hostile:leak@db.example/prod",
    CARTESIA_API_KEY: "hostile-cartesia-key",
    GEMINI_API_KEY: "hostile-gemini-key",
    AWS_SECRET_ACCESS_KEY: "hostile-aws-secret",
    NODE_OPTIONS: "--require /tmp/viva-hostile-parent.cjs",
    BUN_OPTIONS: "--hostile-flag",
    VIVA_RELEASE_RUN_ID: "hostile-release-run",
    VIVA_FAILURE_CONTROL_SECRET: "hostile-failure-control-secret",
    VIVA_SOME_UNRELATED_FLAG: "hostile-unrelated-value",
  });

  assert.equal(env.VIVA_AGENT_BIND_ADDR, "127.0.0.1:4318");
  assert.equal(env.VIVA_AGENT_PROVIDER, "synthetic");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/hostile");
  assert.equal("DATABASE_URL" in env, false);
  assert.equal("CARTESIA_API_KEY" in env, false);
  assert.equal("GEMINI_API_KEY" in env, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal("BUN_OPTIONS" in env, false);
  assert.equal("VIVA_RELEASE_RUN_ID" in env, false);
  assert.equal("VIVA_FAILURE_CONTROL_SECRET" in env, false);
  assert.equal("VIVA_SOME_UNRELATED_FLAG" in env, false);
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

// RELEASE-015: dev-agent's cargo child execs a further agent-service
// grandchild that holds :4318. Killing only the cargo pid leaves that
// listener behind, so the child is described as a managed, process-group
// child and torn down through the shared supervisor's idempotent cleanup.
test("dev agent describes its cargo child as a managed process-group child with an explicit environment", () => {
  const options = devAgentChildOptions({
    parentEnv: { PATH: "/usr/bin", VIVA_AGENT_PROVIDER: "fake_cartesia_gemini" },
    argv: ["--locked"],
  });

  assert.equal(options.command, "cargo");
  assert.deepEqual(options.args, devAgentArgs(["--locked"]));
  assert.equal(options.detached, process.platform !== "win32");
  assert.equal(Object.isFrozen(options.env), true, "spawnManaged only accepts a frozen role env");
  assert.equal(options.env.VIVA_AGENT_PROVIDER, "fake_cartesia_gemini");
  assert.equal("DATABASE_URL" in options.env, false);
  // Interactive by design: the developer keeps cargo's own stdout/stderr, so
  // no log paths are captured for this role.
  assert.equal(options.stdoutPath, undefined);
  assert.equal(options.stderrPath, undefined);
});

test("dev agent stops its managed child once, whichever interrupt arrives first", async () => {
  const stops = [];
  const child = {
    state: "running",
    ready: Promise.resolve({ pid: 4242 }),
    exit: Promise.resolve({ code: 0, signal: null }),
    stop: async (options) => {
      stops.push(options);
      return { state: "exited", code: 0, signal: "SIGTERM", escalated: false };
    },
  };
  const signals = new EventEmitter();
  const exits = [];

  const handle = runDevAgent({
    spawnImpl: () => child,
    signalTarget: signals,
    exitImpl: (code) => exits.push(code),
    parentEnv: { PATH: "/usr/bin" },
    argv: [],
  });

  signals.emit("SIGINT", "SIGINT");
  signals.emit("SIGTERM", "SIGTERM");
  await handle.cleanupSettled;

  assert.equal(stops.length, 1, "one idempotent teardown for both signals");
  assert.equal(stops[0].graceMs > 0, true);
});
