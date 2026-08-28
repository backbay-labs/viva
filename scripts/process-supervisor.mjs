#!/usr/bin/env node
// RELEASE-015: one managed-process helper for every child this repository
// spawns locally — the browser E2E harness's agent/web children, the hosted
// monitor's runner children, release-check's readiness children, and
// dev-agent's cargo child.
//
// Three defects this module exists to make unrepresentable:
//
//  1. **Orphaned grandchildren.** `child.kill()` signals one pid. `cargo run`
//     and `bun run … dev` both exec a *further* process that keeps the port,
//     so killing the wrapper leaves a listener behind and the next run either
//     races it or "succeeds" against the stale one. Every managed child is
//     therefore spawned `detached: true` (its own POSIX process group) and
//     stopped with `process.kill(-pid, …)`, which reaches the whole tree.
//
//  2. **Truncated logs.** Ending a log stream at signal time discards whatever
//     the child wrote while dying — exactly the diagnostic that explains the
//     failure. `stop()` awaits the child's `exit` first and only then ends and
//     `finished()`-awaits both streams.
//
//  3. **Escaping spawn errors.** A `spawn` `error` event (a missing binary, an
//     unexecutable path) fires asynchronously and, unhandled, becomes an
//     unhandled rejection *inside the caller's own cleanup path*. Here it
//     settles the managed `ready`/`exit` promises and leaves `stop()` safe to
//     call from a `finally` block.
//
// The environment is never inherited: `spawnManaged` accepts only the frozen
// role environment `childEnvironmentFor` (RELEASE-029) produces, so no spawn
// site can silently fall back to `process.env`.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import net from "node:net";
import { finished } from "node:stream/promises";

export const SUPERVISOR_DEFAULT_GRACE_MS = 5_000;
export const SUPERVISOR_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);

/** Bounded in-memory tail kept per stream so bind diagnostics stay classifiable. */
const LOG_TAIL_LIMIT = 8 * 1024;

const ADDRESS_IN_USE = /EADDRINUSE|address (?:already )?in use|address in use/i;

/** A `spawnWithPortRetry` boundary that ran out of bounded reallocations. */
export class PortBindExhaustedError extends Error {
  constructor({ label, attempts, ports }) {
    super(
      `Could not bind a local port for ${label} after ${attempts} attempt(s); every attempt observed a bind conflict.`,
    );
    this.name = "PortBindExhaustedError";
    this.code = "port_bind_exhausted";
    this.label = label;
    this.attempts = attempts;
    this.ports = Object.freeze([...ports]);
  }
}

/** A managed child that exited before its port became observable. */
export class ManagedChildExitedError extends Error {
  constructor({ label, code, signal }) {
    super(`${label} exited before its port became observable (code=${code}, signal=${signal}).`);
    this.name = "ManagedChildExitedError";
    this.code = "managed_child_exited";
    this.exitCode = code;
    this.exitSignal = signal;
  }
}

/** A managed child stayed up but never accepted a connection in time. */
export class PortReadinessTimeoutError extends Error {
  constructor({ label, port, timeoutMs }) {
    super(`${label} did not accept a connection on port ${port} within ${timeoutMs}ms.`);
    this.name = "PortReadinessTimeoutError";
    this.code = "port_readiness_timeout";
    this.port = port;
  }
}

/**
 * Only the frozen object `childEnvironmentFor` returns is accepted. `process.env`
 * (and any spread copy of it) is mutable, so this check also structurally rules
 * out the ambient-inheritance spawn shapes RELEASE-029 removed.
 */
function assertExplicitFrozenEnvironment(env) {
  if (!env || typeof env !== "object" || Array.isArray(env) || !Object.isFrozen(env)) {
    throw new Error(
      "process-supervisor: spawnManaged requires the explicit frozen environment produced by childEnvironmentFor(role, …); ambient process.env inheritance is not available.",
    );
  }
}

/**
 * Spawn a child in its own process group with managed lifecycle promises.
 *
 * `stdoutPath`/`stderrPath` capture the child's output; omit both to inherit the
 * parent's stdio (the interactive `dev-agent` case). The returned handle is the
 * only supported way to stop the child.
 */
export function spawnManaged({
  command,
  args = [],
  cwd,
  env,
  stdoutPath,
  stderrPath,
  label = command,
  detached = process.platform !== "win32",
}) {
  assertExplicitFrozenEnvironment(env);
  const captureLogs = Boolean(stdoutPath || stderrPath);
  if (captureLogs && !(stdoutPath && stderrPath)) {
    throw new Error("process-supervisor: stdoutPath and stderrPath must be given together.");
  }

  const streams = captureLogs ? [createWriteStream(stdoutPath), createWriteStream(stderrPath)] : [];
  const tails = ["", ""];

  let state = "starting";
  let pid = null;
  let exitResult = null;
  let spawnError = null;
  let stopPromise = null;

  const child = spawn(command, args, {
    cwd,
    env,
    detached,
    stdio: captureLogs ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
  });

  if (captureLogs) {
    for (const [index, source] of [child.stdout, child.stderr].entries()) {
      source.on("data", (chunk) => {
        tails[index] = `${tails[index]}${chunk}`.slice(-LOG_TAIL_LIMIT);
      });
      source.pipe(streams[index]);
    }
  }

  const ready = new Promise((resolve, reject) => {
    child.once("spawn", () => {
      pid = child.pid ?? null;
      if (state === "starting") state = "running";
      resolve({ pid });
    });
    child.once("error", (error) => {
      spawnError = error;
      state = "failed";
      reject(error);
    });
  });
  // The caller may legitimately never await `ready` (a stop() in a finally
  // block is enough); keep a spawn error from becoming an unhandled rejection
  // that escapes into that cleanup path.
  ready.catch(() => {});

  const exit = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      if (state !== "failed") state = "exited";
      resolve(exitResult);
    });
    child.once("error", (error) => reject(error));
  });
  exit.catch(() => {});

  function signalGroup(signal) {
    if (pid === null) return false;
    try {
      // Negative pid = the whole process group, so `cargo run`'s and
      // `bun run`'s exec'd grandchildren receive it too.
      if (detached) process.kill(-pid, signal);
      else child.kill(signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      // A group that is already partially reaped is not an error worth
      // failing a teardown over; fall back to the direct pid.
      try {
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Returns true when a log stream failed to finish. A caller that treats its
   * logs as evidence (the hosted monitor) must be able to fail closed on that
   * rather than publish a run whose output was silently truncated.
   */
  async function flushLogs() {
    if (!captureLogs) return false;
    for (const stream of streams) {
      if (!stream.writableEnded) stream.end();
    }
    const results = await Promise.allSettled(streams.map((stream) => finished(stream)));
    return results.some((result) => result.status === "rejected");
  }

  async function performStop(graceMs) {
    if (spawnError) {
      const logFlushFailed = await flushLogs();
      return {
        state: "failed",
        code: null,
        signal: null,
        escalated: false,
        logFlushFailed,
        error: spawnError,
      };
    }
    await ready.catch(() => {});
    if (exitResult) {
      const logFlushFailed = await flushLogs();
      state = "exited";
      return {
        state,
        code: exitResult.code,
        signal: exitResult.signal,
        escalated: false,
        logFlushFailed,
      };
    }

    state = "stopping";
    let escalated = false;
    signalGroup("SIGTERM");
    const graceful = await Promise.race([
      exit.then(() => true).catch(() => true),
      delay(graceMs).then(() => false),
    ]);
    if (!graceful && !exitResult) {
      escalated = true;
      signalGroup("SIGKILL");
      await exit.catch(() => {});
    }
    // Logs are ended only after the child itself is gone, so nothing the
    // child wrote while dying is lost.
    const logFlushFailed = await flushLogs();
    state = "exited";
    return {
      state,
      code: exitResult?.code ?? null,
      signal: escalated ? "SIGKILL" : (exitResult?.signal ?? "SIGTERM"),
      escalated,
      logFlushFailed,
    };
  }

  return {
    label,
    get pid() {
      return pid;
    },
    get state() {
      return state;
    },
    get exitResult() {
      return exitResult;
    },
    get spawnError() {
      return spawnError;
    },
    ready,
    exit,
    /** The bounded tail of everything the child wrote, for bind classification. */
    logText() {
      return `${tails[0]}${tails[1]}`;
    },
    /** Idempotent: repeated calls (a finally block plus a signal handler) share one teardown. */
    stop({ graceMs = SUPERVISOR_DEFAULT_GRACE_MS } = {}) {
      stopPromise ??= performStop(graceMs);
      return stopPromise;
    },
  };
}

/**
 * Install one idempotent cleanup for every interrupt signal. Both SIGINT and
 * SIGTERM route to the same function and it runs at most once, so a Ctrl-C
 * that is followed by a supervisor's SIGTERM cannot start a second teardown
 * over half-torn-down state.
 */
export function installSignalCleanup({
  cleanup,
  signals = SUPERVISOR_SIGNALS,
  target = process,
} = {}) {
  if (typeof cleanup !== "function") {
    throw new Error("process-supervisor: installSignalCleanup requires a cleanup function");
  }
  const handle = { invoked: false, uninstall };
  const handlers = new Map();

  function uninstall() {
    for (const [signal, handler] of handlers) target.off(signal, handler);
    handlers.clear();
  }

  for (const signal of signals) {
    const handler = () => {
      // The handlers deliberately stay installed. Removing them here would
      // restore Node's default disposition, so the SIGTERM that habitually
      // follows a Ctrl-C SIGINT would kill this process mid-teardown and
      // orphan exactly the child tree the cleanup was about to reap. Staying
      // registered absorbs every repeat; `invoked` keeps the work to once.
      if (handle.invoked) return;
      handle.invoked = true;
      handle.result = cleanup(signal);
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
  return handle;
}

/** Allocate an ephemeral loopback port. Inherently advisory: see spawnWithPortRetry. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("Could not allocate a free local port"));
      });
    });
  });
}

/**
 * Decide whether a managed child actually took the port it was given.
 *
 * A stray listener already holding the port answers every connect probe, so a
 * connect alone proves nothing about *this* child: it is exactly the case
 * where a naive readiness wait reports success and then times out against the
 * stranger. Two signals are therefore required together — the port answers,
 * and the child has stayed alive past `settleMs`. A process that lost the bind
 * race exits within milliseconds of starting, so its `EADDRINUSE` is always
 * observed inside that window and returned as `"bind_failed"`.
 */
export async function awaitPortBound({
  handle,
  port,
  host = "127.0.0.1",
  timeoutMs = 30_000,
  pollMs = 50,
  settleMs = 300,
}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (handle.spawnError) {
      throw handle.spawnError;
    }
    if (handle.exitResult) {
      return classifyExitedAttempt(handle);
    }
    if (Date.now() - started >= settleMs && (await canConnect(host, port))) {
      // Last re-check: the child may have died while the probe was in flight.
      if (handle.exitResult) return classifyExitedAttempt(handle);
      return "bound";
    }
    await delay(pollMs);
  }
  if (handle.exitResult) return classifyExitedAttempt(handle);
  throw new PortReadinessTimeoutError({ label: handle.label, port, timeoutMs });
}

function classifyExitedAttempt(handle) {
  if (ADDRESS_IN_USE.test(handle.logText())) return "bind_failed";
  throw new ManagedChildExitedError({
    label: handle.label,
    code: handle.exitResult?.code ?? null,
    signal: handle.exitResult?.signal ?? null,
  });
}

/**
 * Allocate-and-start with a bounded retry that fires only for an *observed*
 * bind conflict.
 *
 * `freePort()` is a probe: it binds port 0, reads the number, and closes. Any
 * other process may take that number in the window before the real child gets
 * there. This boundary reacts to that one condition — the child itself
 * reporting the port is taken — and to nothing else: an arbitrary product or
 * fixture failure propagates immediately instead of burning retries and
 * arriving as a misleading "could not bind".
 */
export async function spawnWithPortRetry({
  label = "managed child",
  attempts = 2,
  allocatePort = freePort,
  start,
  observeBind = awaitPortBound,
  graceMs = SUPERVISOR_DEFAULT_GRACE_MS,
}) {
  if (typeof start !== "function") {
    throw new Error("process-supervisor: spawnWithPortRetry requires a start function");
  }
  const ports = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await allocatePort();
    ports.push(port);
    const handle = await start({ port, attempt });
    let outcome;
    try {
      outcome = await observeBind({ handle, port, attempt });
    } catch (error) {
      await handle.stop({ graceMs }).catch(() => {});
      throw error;
    }
    if (outcome === "bound") {
      return { value: handle, port, attempt, attempts: attempt, ports: Object.freeze([...ports]) };
    }
    await handle.stop({ graceMs }).catch(() => {});
  }
  throw new PortBindExhaustedError({ label, attempts, ports });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
