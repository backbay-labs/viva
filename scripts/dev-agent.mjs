#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildDevAgentEnv(source = process.env) {
  const env = { ...source };
  env.VIVA_AGENT_BIND_ADDR = trimmed(env.VIVA_AGENT_BIND_ADDR) || "127.0.0.1:4318";
  env.VIVA_AGENT_PROVIDER = trimmed(env.VIVA_AGENT_PROVIDER) || "synthetic";

  if (env.VIVA_DEV_AGENT_SIGNED_SESSION !== "1") {
    env.VIVA_VOICE_SESSION_TOKEN_SECRET = "";
    env.VIVA_VOICE_WS_BEARER_TOKEN = "";
  }

  return env;
}

export function devAgentArgs(extraArgs = []) {
  return ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service", ...extraArgs];
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function run() {
  const child = spawn("cargo", devAgentArgs(process.argv.slice(2)), {
    cwd: root,
    env: buildDevAgentEnv(),
    stdio: "inherit",
  });

  child.once("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run();
}
