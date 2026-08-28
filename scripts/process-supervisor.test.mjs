import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { childEnvironmentFor } from "./child-environment.mjs";
import {
  awaitPortBound,
  freePort,
  installSignalCleanup,
  PortBindExhaustedError,
  spawnManaged,
  spawnWithPortRetry,
} from "./process-supervisor.mjs";

const nodeBinary = process.execPath;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// RELEASE-015: a child that spawns its own grandchild listener and then dies
// on SIGTERM *without* forwarding anything. Killing only this pid leaves the
// grandchild holding its port; only a process-group signal reaches both.
const WRAPPER_FIXTURE = `
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [grandchildScript, reportPath] = process.argv.slice(2);
const child = spawn(process.execPath, [grandchildScript, reportPath], {
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write(\`wrapper-ready \${process.pid} \${child.pid}\\n\`);
await writeFile(\`\${reportPath}.wrapper\`, JSON.stringify({ pid: process.pid }));
// Deliberately no SIGTERM forwarding: an orphaned grandchild is the defect.
setInterval(() => {}, 1_000);
`;

const GRANDCHILD_FIXTURE = `
import { writeFile } from "node:fs/promises";
import net from "node:net";

const [reportPath] = process.argv.slice(2);
const server = net.createServer((socket) => socket.end());
server.listen(0, "127.0.0.1", async () => {
  await writeFile(reportPath, JSON.stringify({ pid: process.pid, port: server.address().port }));
});
setInterval(() => {}, 1_000);
`;

// `A-43(c)` (amended): the readiness marker is written only AFTER
// `process.on("SIGTERM", ...)` returns, never before. See the comment above
// the two SIGTERM-handling tests below for why this order — not a retry —
// is what makes the parent's wait for the marker a structural guarantee
// that the handler is already armed.
const GRACEFUL_FIXTURE = `
process.on("SIGTERM", () => {
  process.stdout.write("graceful-term-received\\n");
  setTimeout(() => process.exit(0), 40);
});
process.stdout.write("graceful-started\\n");
setInterval(() => {}, 1_000);
`;

const STUBBORN_FIXTURE = `
process.on("SIGTERM", () => {
  process.stdout.write("stubborn-ignored-term\\n");
});
process.stdout.write("stubborn-started\\n");
setInterval(() => {}, 1_000);
`;

// A listener that fails closed on a taken port with the real bind diagnostic,
// exactly as a product server does.
const LISTENER_FIXTURE = `
import net from "node:net";

const port = Number(process.argv[2]);
const server = net.createServer((socket) => socket.end());
server.once("error", (error) => {
  process.stderr.write(\`listener bind failed: \${error.code}\\n\`);
  process.exit(98);
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(\`listener-bound \${port}\\n\`);
});
setInterval(() => {}, 1_000);
`;

// A harness that adopts the supervisor exactly as the release scripts do and
// proves one idempotent cleanup runs for whichever signal arrives.
const SIGNAL_HARNESS_FIXTURE = `
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { installSignalCleanup, spawnManaged } from "SUPERVISOR_URL";
import { childEnvironmentFor } from "CHILD_ENV_URL";

const [grandchildScript, reportPath, markerPath, logDir] = process.argv.slice(2);
const child = spawnManaged({
  command: process.execPath,
  args: [grandchildScript, reportPath],
  cwd: process.cwd(),
  env: childEnvironmentFor("dev-agent", { parentEnv: process.env, explicit: {} }),
  stdoutPath: path.join(logDir, "harness.stdout.log"),
  stderrPath: path.join(logDir, "harness.stderr.log"),
});
await child.ready;

installSignalCleanup({
  cleanup: async () => {
    await appendFile(markerPath, "cleanup\\n");
    await child.stop({ graceMs: 2_000 });
    process.exit(0);
  },
});
// Written only once the handlers are installed: a signal delivered before
// this point would take the default disposition, not the contract under test.
await writeFile(\`\${markerPath}.pid\`, String(process.pid));
setInterval(() => {}, 1_000);
`;

async function fixtureDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-supervisor-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeFixture(dir, name, source) {
  const file = path.join(dir, name);
  await writeFile(file, source, "utf8");
  return file;
}

function devAgentEnv() {
  return childEnvironmentFor("dev-agent", { parentEnv: process.env, explicit: {} });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForFile(file, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for fixture report ${file}`);
}

async function waitForLogMatch(file, pattern, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(file, "utf8");
      if (pattern.test(text)) return text;
    } catch {
      /* not written yet */
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${pattern} in ${file}`);
}

async function waitUntilGone(pid, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true;
    await delay(25);
  }
  return !isAlive(pid);
}

function occupyPort(t, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(server);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("stopping a managed wrapper leaves no grandchild listener alive", async (t) => {
  const dir = await fixtureDir(t);
  const grandchild = await writeFixture(dir, "grandchild.mjs", GRANDCHILD_FIXTURE);
  const wrapper = await writeFixture(dir, "wrapper.mjs", WRAPPER_FIXTURE);
  const reportPath = path.join(dir, "grandchild.json");

  const child = spawnManaged({
    command: nodeBinary,
    args: [wrapper, grandchild, reportPath],
    cwd: dir,
    env: devAgentEnv(),
    stdoutPath: path.join(dir, "wrapper.stdout.log"),
    stderrPath: path.join(dir, "wrapper.stderr.log"),
  });
  await child.ready;
  const report = await waitForFile(reportPath);
  const wrapperReport = await waitForFile(`${reportPath}.wrapper`);

  assert.equal(isAlive(report.pid), true, "grandchild listener should be running before stop");

  await child.stop({ graceMs: 2_000 });

  assert.equal(child.state, "exited");
  assert.equal(await waitUntilGone(wrapperReport.pid), true, "wrapper process must be gone");
  assert.equal(await waitUntilGone(report.pid), true, "grandchild process must be gone");

  // The port the grandchild held is bindable again: nothing survived the stop.
  const rebound = await occupyPort(t, report.port);
  assert.equal(rebound.address().port, report.port);
});

/**
 * `A-43(c)`: both SIGTERM-handling tests below spawn a child, wait for its
 * *own* startup line, then signal it almost immediately. Delivering that
 * signal and the child's `process.on('SIGTERM', ...)` registration are each
 * real, independent OS-scheduled operations on the child's process; under
 * extreme scheduler contention (many-way parallel test runs oversubscribing
 * the machine well beyond its core count) the OS can still occasionally
 * deliver the signal under SIGTERM's *default* disposition and kill the
 * child outright, before an already-issued `process.on` registration call
 * has taken effect. That is a fact about signal-delivery timing on an
 * overloaded machine, not a defect in `process-supervisor.mjs`.
 *
 * A first pass at this fix (reverted, adversarial-review-rejected) retried
 * the whole spawn-signal-verify cycle up to 5 times whenever an attempt's
 * outcome matched the race's signature. That is flake *tolerance*, not
 * determinism: the exact same signature — an unescalated SIGTERM exit whose
 * handler-written log line never appeared — is also what a genuine
 * regression in this contract (e.g. `stop()` resolving before the child's
 * own SIGTERM-handler output has flushed) would produce, so a bounded retry
 * over that signature cannot tell the harmless environmental race apart
 * from a real break in "its logs finish after exit"; a regression that hits
 * that signature with probability p on each attempt would still pass with
 * probability `1 - p^5` — for p≈0.3 that is a ~99.8% chance of a silently
 * green suite over a genuinely broken contract.
 *
 * The actual fix needs no retry at all: `GRACEFUL_FIXTURE`/`STUBBORN_FIXTURE`
 * now call `process.on("SIGTERM", ...)` *before* writing their readiness
 * marker (previously the reverse). `process.on` is synchronous — it has
 * fully registered the handler before that call even returns — so ordering
 * the marker write after it makes "the marker reached the log" imply "the
 * handler is already armed" a structural fact about the child's own
 * single-threaded execution order, true regardless of how long the OS
 * suspends the child between statements, not a probabilistic one. Proof, in
 * this unit's evidence: with the OLD marker-before-handler order (and the
 * retry already removed, to isolate order as the cause) the race still
 * reproduced 3 times over 144 runs across six 24-way-parallel batches
 * (`artifacts/sdd/evidence/r12-reviewfix-f1-red-order-still-races.txt`) with
 * the exact same two failure signatures as the original `r12c-red-24way-*`
 * reproduction; with the handler-first order below, 20/20 sequential plus
 * repeated 24-way-parallel runs total zero failures
 * (`artifacts/sdd/evidence/r12-reviewfix-f1-green-*`), and a genuine mutation
 * of the handler's own contract is still caught on every single run — never
 * masked — because there is no retry left to hide behind
 * (`artifacts/sdd/evidence/r12-reviewfix-f1-mutation-still-caught.txt`).
 */
test("a graceful child is SIGTERMed, awaited, never escalated, and its logs finish after exit", async (t) => {
  const dir = await fixtureDir(t);
  const script = await writeFixture(dir, "graceful.mjs", GRACEFUL_FIXTURE);
  const stdoutPath = path.join(dir, "graceful.stdout.log");

  const child = spawnManaged({
    command: nodeBinary,
    args: [script],
    cwd: dir,
    env: devAgentEnv(),
    stdoutPath,
    stderrPath: path.join(dir, "graceful.stderr.log"),
  });
  await child.ready;
  // The marker is written only once the fixture's SIGTERM handler is
  // already armed (fixture statement order, see the comment above the
  // fixture literals), so observing it here is a structural guarantee that
  // the handler is registered — never merely a likely one.
  await waitForLogMatch(stdoutPath, /graceful-started/);
  const stopped = await child.stop({ graceMs: 5_000 });
  // stop() resolves only after the log streams themselves finished, so the
  // handler's final line is already on disk with no extra polling.
  const written = await readFile(stdoutPath, "utf8");

  assert.equal(stopped.escalated, false, "a graceful child must never be SIGKILLed");
  assert.equal(stopped.signal, "SIGTERM");
  assert.equal(child.state, "exited");
  assert.match(written, /graceful-term-received/);
});

test("a child that ignores SIGTERM is SIGKILLed after the bounded grace only", async (t) => {
  const dir = await fixtureDir(t);
  const script = await writeFixture(dir, "stubborn.mjs", STUBBORN_FIXTURE);
  const stdoutPath = path.join(dir, "stubborn.stdout.log");

  const child = spawnManaged({
    command: nodeBinary,
    args: [script],
    cwd: dir,
    env: devAgentEnv(),
    stdoutPath,
    stderrPath: path.join(dir, "stubborn.stderr.log"),
  });
  await child.ready;
  await waitForLogMatch(stdoutPath, /stubborn-started/);
  const pid = child.pid;
  const startedAt = Date.now();
  const stopped = await child.stop({ graceMs: 400 });
  const elapsed = Date.now() - startedAt;

  assert.equal(stopped.escalated, true);
  assert.equal(stopped.signal, "SIGKILL");
  assert.equal(child.state, "exited");
  assert.ok(
    elapsed >= 400,
    `escalation must wait out the grace window, waited ${elapsed}ms`,
  );
  assert.equal(await waitUntilGone(pid), true);
});

test("a spawn error rejects through the managed promise instead of escaping cleanup", async (t) => {
  const dir = await fixtureDir(t);
  const missing = path.join(dir, "viva-not-a-real-binary");

  const child = spawnManaged({
    command: missing,
    args: [],
    cwd: dir,
    env: devAgentEnv(),
    stdoutPath: path.join(dir, "missing.stdout.log"),
    stderrPath: path.join(dir, "missing.stderr.log"),
  });

  await assert.rejects(child.ready, /ENOENT|spawn/i);
  assert.equal(child.state, "failed");

  // The caller's own cleanup path must stay safe: stop() resolves rather than
  // rethrowing the spawn error out of a finally block.
  const stopped = await child.stop({ graceMs: 200 });
  assert.equal(stopped.state, "failed");
  assert.equal(child.state, "failed");
});

test("spawnManaged refuses a missing, null, or ambient environment", async (t) => {
  const dir = await fixtureDir(t);
  const script = await writeFixture(dir, "graceful.mjs", GRACEFUL_FIXTURE);
  const base = {
    command: nodeBinary,
    args: [script],
    cwd: dir,
    stdoutPath: path.join(dir, "env.stdout.log"),
    stderrPath: path.join(dir, "env.stderr.log"),
  };

  assert.throws(() => spawnManaged({ ...base }), /explicit frozen environment/);
  assert.throws(() => spawnManaged({ ...base, env: null }), /explicit frozen environment/);
  assert.throws(() => spawnManaged({ ...base, env: process.env }), /explicit frozen environment/);
  assert.throws(
    () => spawnManaged({ ...base, env: { ...process.env } }),
    /explicit frozen environment/,
  );
});

test("SIGINT and SIGTERM both route through one idempotent cleanup", () => {
  const target = new EventEmitter();
  let invocations = 0;
  const handle = installSignalCleanup({
    target,
    cleanup: () => {
      invocations += 1;
    },
  });

  target.emit("SIGINT", "SIGINT");
  target.emit("SIGTERM", "SIGTERM");
  target.emit("SIGINT", "SIGINT");

  assert.equal(invocations, 1);
  assert.equal(handle.invoked, true);
  // Still listening after the first signal: a follow-up SIGTERM must be
  // absorbed by this handler, not by Node's process-killing default.
  assert.equal(target.listenerCount("SIGTERM"), 1);
  handle.uninstall();
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});

test("a real SIGINT runs the harness cleanup exactly once and reaps the grandchild", async (t) => {
  const dir = await fixtureDir(t);
  const grandchild = await writeFixture(dir, "grandchild.mjs", GRANDCHILD_FIXTURE);
  const harnessSource = SIGNAL_HARNESS_FIXTURE.replace(
    "SUPERVISOR_URL",
    new URL("./process-supervisor.mjs", import.meta.url).href,
  ).replace("CHILD_ENV_URL", new URL("./child-environment.mjs", import.meta.url).href);
  const harness = await writeFixture(dir, "signal-harness.mjs", harnessSource);
  const reportPath = path.join(dir, "signal-grandchild.json");
  const markerPath = path.join(dir, "cleanup.log");

  const harnessProcess = spawn(nodeBinary, [harness, grandchild, reportPath, markerPath, dir], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      harnessProcess.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  const report = await waitForFile(reportPath);
  await waitForFile(`${markerPath}.pid`);

  const exited = new Promise((resolve) => harnessProcess.once("exit", resolve));
  harnessProcess.kill("SIGINT");
  harnessProcess.kill("SIGTERM");
  await exited;

  const marker = await readFile(markerPath, "utf8");
  assert.equal(marker.trim().split("\n").length, 1, `cleanup ran more than once: ${marker}`);
  assert.equal(await waitUntilGone(report.pid), true, "grandchild must not outlive the signal");
});

test("dev-agent.mjs killed directly does not orphan its cargo grandchild", async (t) => {
  const dir = await fixtureDir(t);
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const grandchild = await writeFixture(dir, "grandchild.mjs", GRANDCHILD_FIXTURE);
  const reportPath = path.join(dir, "cargo-grandchild.json");
  const fakeCargo = await writeFixture(
    dir,
    "fake-cargo.mjs",
    `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(grandchild)}, ${JSON.stringify(reportPath)}], {
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write(\`fake-cargo \${child.pid}\\n\`);
setInterval(() => {}, 1_000);
`,
  );
  await writeFile(
    path.join(binDir, "cargo"),
    `#!/bin/sh\nexec ${JSON.stringify(nodeBinary)} ${JSON.stringify(fakeCargo)} "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );

  const devAgent = spawn(nodeBinary, [path.join(repoRoot, "scripts/dev-agent.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      devAgent.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  const report = await waitForFile(reportPath, 20_000);
  assert.equal(isAlive(report.pid), true);

  const exited = new Promise((resolve) => devAgent.once("exit", resolve));
  devAgent.kill("SIGTERM");
  await exited;

  assert.equal(
    await waitUntilGone(report.pid),
    true,
    "the cargo/agent grandchild must die with dev-agent",
  );
});

test("a close-then-bind collision costs exactly one bounded retry on a different port", async (t) => {
  const dir = await fixtureDir(t);
  const listener = await writeFixture(dir, "listener.mjs", LISTENER_FIXTURE);
  const collidedPort = await freePort();
  // Force the classic freePort() race: something else binds the just-closed
  // probe port before the child gets there.
  await occupyPort(t, collidedPort);
  const replacementPort = await freePort();

  const offered = [];
  const attemptedPorts = [];
  const outcome = await spawnWithPortRetry({
    label: "collision fixture",
    attempts: 2,
    allocatePort: async () => {
      const port = offered.length === 0 ? collidedPort : replacementPort;
      offered.push(port);
      return port;
    },
    start: ({ port }) => {
      attemptedPorts.push(port);
      return spawnManaged({
        command: nodeBinary,
        args: [listener, String(port)],
        cwd: dir,
        env: devAgentEnv(),
        stdoutPath: path.join(dir, `listener-${port}.stdout.log`),
        stderrPath: path.join(dir, `listener-${port}.stderr.log`),
      });
    },
    observeBind: ({ handle, port }) => awaitPortBound({ handle, port, timeoutMs: 10_000 }),
  });
  t.after(() => outcome.value.stop({ graceMs: 1_000 }));

  assert.equal(outcome.attempts, 2, "exactly one reallocation/retry");
  assert.equal(attemptedPorts.length, 2);
  assert.notEqual(attemptedPorts[0], attemptedPorts[1], "the retry must use a different port");
  assert.equal(outcome.port, replacementPort);
  assert.equal(outcome.value.state, "running");
});

test("port exhaustion is a typed bind failure, never a readiness timeout against a stray listener", async (t) => {
  const dir = await fixtureDir(t);
  const listener = await writeFixture(dir, "listener.mjs", LISTENER_FIXTURE);
  const collidedPort = await freePort();
  // The stray listener answers every connect probe, so a naive readiness wait
  // would "succeed" and then time out on the product protocol instead.
  await occupyPort(t, collidedPort);

  const handles = [];
  await assert.rejects(
    spawnWithPortRetry({
      label: "exhaustion fixture",
      attempts: 2,
      allocatePort: async () => collidedPort,
      start: ({ port }) => {
        const handle = spawnManaged({
          command: nodeBinary,
          args: [listener, String(port)],
          cwd: dir,
          env: devAgentEnv(),
          stdoutPath: path.join(dir, `exhausted-${handles.length}.stdout.log`),
          stderrPath: path.join(dir, `exhausted-${handles.length}.stderr.log`),
        });
        handles.push(handle);
        return handle;
      },
      observeBind: ({ handle, port }) => awaitPortBound({ handle, port, timeoutMs: 10_000 }),
    }),
    (error) => {
      assert.ok(error instanceof PortBindExhaustedError, `wrong error type: ${error?.name}`);
      assert.equal(error.code, "port_bind_exhausted");
      assert.equal(error.attempts, 2);
      assert.deepEqual(error.ports, [collidedPort, collidedPort]);
      assert.doesNotMatch(error.message, /timed out|readiness/i);
      return true;
    },
  );

  for (const handle of handles) {
    assert.equal(handle.state, "exited", "every failed attempt must be stopped, not leaked");
  }
});

test("a non-bind child failure is never retried as a port collision", async (t) => {
  const dir = await fixtureDir(t);
  const crashing = await writeFixture(
    dir,
    "crashing.mjs",
    `process.stderr.write("fixture refused to start for its own reasons\\n");\nprocess.exit(3);\n`,
  );
  let attempts = 0;

  await assert.rejects(
    spawnWithPortRetry({
      label: "crash fixture",
      attempts: 3,
      allocatePort: freePort,
      start: ({ port }) => {
        attempts += 1;
        return spawnManaged({
          command: nodeBinary,
          args: [crashing, String(port)],
          cwd: dir,
          env: devAgentEnv(),
          stdoutPath: path.join(dir, `crash-${attempts}.stdout.log`),
          stderrPath: path.join(dir, `crash-${attempts}.stderr.log`),
        });
      },
      observeBind: ({ handle, port }) => awaitPortBound({ handle, port, timeoutMs: 5_000 }),
    }),
    (error) => {
      assert.equal(error instanceof PortBindExhaustedError, false);
      assert.match(error.message, /exited/i);
      return true;
    },
  );

  assert.equal(attempts, 1, "an arbitrary product failure must not consume the bind retries");
});
