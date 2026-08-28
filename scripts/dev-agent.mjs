#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironmentFor } from "./child-environment.mjs";
import {
  installSignalCleanup,
  spawnManaged,
  SUPERVISOR_DEFAULT_GRACE_MS,
} from "./process-supervisor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// RELEASE-029: build the cargo child's environment explicitly from the
// "dev-agent" role's typed allowlist instead of blindly forwarding this
// process's own environment — a hostile or merely cluttered ambient
// environment (a stray DATABASE_URL, provider key, or NODE_OPTIONS/
// BUN_OPTIONS injection) must never reach the locally-run agent-service.
export function buildDevAgentEnv(source = process.env) {
  const signedSession = source.VIVA_DEV_AGENT_SIGNED_SESSION === "1";
  return childEnvironmentFor("dev-agent", {
    parentEnv: source,
    explicit: {
      VIVA_AGENT_BIND_ADDR: trimmed(source.VIVA_AGENT_BIND_ADDR) || "127.0.0.1:4318",
      VIVA_AGENT_PROVIDER: trimmed(source.VIVA_AGENT_PROVIDER) || "synthetic",
      VIVA_VOICE_SESSION_TOKEN_SECRET: signedSession
        ? (source.VIVA_VOICE_SESSION_TOKEN_SECRET ?? "")
        : "",
      VIVA_VOICE_WS_BEARER_TOKEN: signedSession ? (source.VIVA_VOICE_WS_BEARER_TOKEN ?? "") : "",
    },
  });
}

export function devAgentArgs(extraArgs = []) {
  return ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service", ...extraArgs];
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * RELEASE-015: `cargo run` is a wrapper — it execs the agent-service binary as
 * a *further* process that owns the bind address. Signalling only cargo's pid
 * leaves that binary holding `127.0.0.1:4318`, so the developer's next
 * `bun run dev:agent` fails to bind or, worse, talks to the stale build. The
 * child is therefore a managed process-group child and the interrupt path is
 * one idempotent group teardown.
 *
 * stdio stays inherited: this is the interactive developer command, and cargo's
 * own compiler output is the point of running it.
 */
export function devAgentChildOptions({ parentEnv = process.env, argv = [] } = {}) {
  return {
    command: "cargo",
    args: devAgentArgs(argv),
    cwd: root,
    env: buildDevAgentEnv(parentEnv),
    detached: process.platform !== "win32",
    label: "dev-agent cargo",
  };
}

export function runDevAgent({
  parentEnv = process.env,
  argv = process.argv.slice(2),
  spawnImpl = spawnManaged,
  signalTarget = process,
  exitImpl = (code) => process.exit(code),
  graceMs = SUPERVISOR_DEFAULT_GRACE_MS,
} = {}) {
  const child = spawnImpl(devAgentChildOptions({ parentEnv, argv }));
  let cleanupSettled = Promise.resolve();

  const signals = installSignalCleanup({
    target: signalTarget,
    cleanup: () => {
      cleanupSettled = child.stop({ graceMs }).then(() => exitImpl(0));
      return cleanupSettled;
    },
  });

  const finished = (async () => {
    try {
      await child.ready;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      signals.uninstall();
      exitImpl(1);
      return;
    }
    const { code, signal } = await child.exit.catch(() => ({ code: 1, signal: null }));
    signals.uninstall();
    if (signals.invoked) return;
    // The child's whole group is already gone; report its status without
    // re-signalling this process (which would race the exit above).
    exitImpl(signal ? 1 : (code ?? 1));
  })();

  return {
    child,
    finished,
    get cleanupSettled() {
      return cleanupSettled;
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runDevAgent();
}
