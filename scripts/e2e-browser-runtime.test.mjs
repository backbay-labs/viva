// RELEASE-030 E2E extraction: behavioral tests for the Playwright/local-service
// lifecycle primitives moved out of `e2e-browser.mjs` into
// `e2e-browser-runtime.mjs`. Process-tree, port-race, and signal-cleanup
// behavior is proven once, against real fixtures, in
// `process-supervisor.test.mjs`; this file proves this module's own thin
// wiring over that supervisor -- role dispatch, artifact-relative log paths,
// and the shared managed-child bookkeeping every local spawn site depends on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authenticatedHostedFetchOptions,
  delay,
  LOCAL_WEB_BUILD_TIMEOUT_MS,
  runManagedChildToCompletion,
  spawnLocalChild,
  stopLocalChildren,
} from "./e2e-browser-runtime.mjs";

test("spawnLocalChild refuses a role name no local spawn site uses", () => {
  assert.throws(
    () =>
      spawnLocalChild({
        name: "not-a-real-role",
        command: "true",
        args: [],
        artifactDir: "/tmp",
      }),
    /unknown local child "not-a-real-role"/,
  );
});

test("a real spawned child, for each of this lane's three local-spawn roles, writes its stdout under the caller's artifact directory, and stopLocalChildren reaps it cleanly even after it has already exited", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "viva-e2e-runtime-test-"));
  try {
    for (const name of ["agent", "web", "audio"]) {
      const child = spawnLocalChild({
        name,
        command: "node",
        args: ["-e", "console.log('runtime-fixture-ready');"],
        artifactDir,
        logName: `runtime-fixture-${name}`,
      });
      await child.exit;
      const stdout = await readFile(
        path.join(artifactDir, `runtime-fixture-${name}.stdout.log`),
        "utf8",
      );
      assert.match(stdout, /runtime-fixture-ready/, `role ${name} must log under artifactDir`);
      // The real harness's teardown runs unconditionally in a `finally`, so an
      // already-exited child must be reaped without error, never awaited a
      // second time incorrectly.
      await stopLocalChildren();
      assert.equal(child.state, "exited", `role ${name} must be exited after stopLocalChildren`);
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("authenticatedHostedFetchOptions carries exactly one bearer Authorization header", () => {
  const options = authenticatedHostedFetchOptions("hosted-rest-bearer-value");
  assert.equal(options.headers.get("Authorization"), "Bearer hosted-rest-bearer-value");
  assert.equal([...options.headers.keys()].length, 1);
});

test("delay resolves no earlier than its requested duration", async () => {
  const startedAt = Date.now();
  await delay(20);
  assert.ok(Date.now() - startedAt >= 20);
});

// W07-PROD-WEB (A-44.2): the local web child now builds `apps/web`'s
// production bundle to completion before it is started, replacing `next
// dev` (Level 2's own "production-shaped" mandate; A-44.2's ruling that the
// shipping configuration serves zero CSP violations of any directive, so the
// browser story must measure it, not dev-mode devtools scaffolding).
// `runManagedChildToCompletion` is the bounded one-shot primitive that makes
// this real rather than merely awaited: it proves the same "orphaned
// grandchildren" and "never abandon a promise instead of actually killing
// the child" guarantees `spawnLocalChild`/`spawnManaged` already give a
// long-running child extend to a one-shot build too. `bun run --cwd apps/web
// build` itself is exercised for real only by the live `bun run e2e:browser`
// matrix -- these tests prove the bounded-completion primitive in isolation,
// fast and deterministically, with disposable fixture children standing in
// for it.

test("LOCAL_WEB_BUILD_TIMEOUT_MS is a positive, finite, sensible bound -- not disabled, not unbounded", () => {
  assert.equal(typeof LOCAL_WEB_BUILD_TIMEOUT_MS, "number");
  assert.ok(Number.isFinite(LOCAL_WEB_BUILD_TIMEOUT_MS));
  assert.ok(LOCAL_WEB_BUILD_TIMEOUT_MS > 0);
  // Generous relative to this app's own observed cold-build time (~16s,
  // measured directly with `bun run --cwd apps/web build`), but still a real
  // bound: strictly under the far heavier cold `cargo run` compile's own
  // 600s bound (`spawnLocalAgent`'s `observeBind` timeout) in this same file.
  assert.ok(LOCAL_WEB_BUILD_TIMEOUT_MS <= 600_000);
});

test("runManagedChildToCompletion resolves with the exited handle once a real child exits zero", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "viva-e2e-runtime-test-"));
  try {
    const handle = await runManagedChildToCompletion({
      name: "web",
      command: "node",
      args: ["-e", "process.exit(0);"],
      artifactDir,
      logName: "runtime-fixture-completion-ok",
      timeoutMs: 10_000,
      label: "test fixture build",
    });
    assert.equal(handle.state, "exited");
    assert.equal(handle.exitResult.code, 0);
  } finally {
    await stopLocalChildren();
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("runManagedChildToCompletion throws naming the exit code when a real child exits non-zero", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "viva-e2e-runtime-test-"));
  try {
    await assert.rejects(
      runManagedChildToCompletion({
        name: "web",
        command: "node",
        args: ["-e", "process.exit(3);"],
        artifactDir,
        logName: "runtime-fixture-completion-fail",
        timeoutMs: 10_000,
        label: "test fixture build",
      }),
      /test fixture build failed \(code=3/,
    );
  } finally {
    await stopLocalChildren();
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("runManagedChildToCompletion kills the whole process group -- not merely abandons the promise -- when a real child outlives its deadline", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "viva-e2e-runtime-test-"));
  try {
    await assert.rejects(
      runManagedChildToCompletion({
        name: "web",
        command: "node",
        args: ["-e", "let i = 0; setInterval(() => { console.log(`tick-${i++}`); }, 30);"],
        artifactDir,
        logName: "runtime-fixture-completion-hang",
        timeoutMs: 200,
        label: "test fixture build",
      }),
      /test fixture build did not finish within 200ms/,
    );
    // The rejection above only resolves once `handle.stop()` has fully
    // awaited real process exit (proven by `process-supervisor.test.mjs`'s
    // own coverage of `spawnManaged`'s stop()), so the child is already dead
    // by this point. Confirm it stays dead: if the timeout path only
    // stopped awaiting the child instead of actually signalling its process
    // group, the interval would keep appending "tick-N" lines here.
    const logPath = path.join(artifactDir, "runtime-fixture-completion-hang.stdout.log");
    const afterRejection = await readFile(logPath, "utf8");
    await delay(300);
    const afterGraceWindow = await readFile(logPath, "utf8");
    assert.equal(
      afterGraceWindow,
      afterRejection,
      "the child must have stopped writing once killed, not merely lost its awaiter",
    );
  } finally {
    await stopLocalChildren();
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// Adversarial review (W07-PROD-WEB amendment): racing `handle.exit` against a
// bare, un-cancelled `delay(timeoutMs)` never cancels the loser, so on the
// success path the deadline's own `setTimeout` kept the Node event loop alive
// for the rest of `timeoutMs` -- `e2e-browser.mjs` has no `process.exit(0)`
// on success, so a GREEN `bun run e2e:browser` would print its result and
// then idle for up to `LOCAL_WEB_BUILD_TIMEOUT_MS` (300s in production)
// before actually exiting. That is invisible to a test that only awaits the
// function's own return value inside the shared `node --test` process (other
// pending handles from the test runner mask it), so this test spawns a real,
// independent Node process that calls `runManagedChildToCompletion` and then
// intentionally never calls `process.exit()` itself -- proving the event
// loop drains on its own once the call resolves, the same way `main()` in
// `e2e-browser.mjs` relies on it to.
test("runManagedChildToCompletion clears its own deadline timer once the race settles -- a caller process must exit promptly on success, not idle for the rest of the deadline", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "viva-e2e-runtime-test-"));
  const scriptPath = path.join(artifactDir, "leak-regression.mjs");
  try {
    const runtimeModuleUrl = new URL("./e2e-browser-runtime.mjs", import.meta.url).href;
    const timeoutMs = 5_000;
    await writeFile(
      scriptPath,
      `import { runManagedChildToCompletion } from ${JSON.stringify(runtimeModuleUrl)};
await runManagedChildToCompletion({
  name: "web",
  command: "node",
  args: ["-e", "process.exit(0)"],
  artifactDir: ${JSON.stringify(artifactDir)},
  logName: "leak-regression-inner",
  timeoutMs: ${timeoutMs},
  label: "leak regression fixture",
});
// Deliberately no process.exit() call: the whole point of this regression is
// proving the event loop drains on its own, not idling on a leaked timer.
`,
      "utf8",
    );

    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, "exit");
    const elapsedMs = Date.now() - spawnedAt;

    assert.equal(code, 0, `the wrapper script must exit zero; stderr: ${stderr}`);
    // The inner fixture child exits in well under a second; a wrapper
    // process that idles anywhere near the full `timeoutMs` deadline before
    // actually exiting proves the deadline timer leaked.
    assert.ok(
      elapsedMs < timeoutMs / 2,
      `the wrapper process took ${elapsedMs}ms to exit against a ${timeoutMs}ms deadline and a near-instant inner child -- a leaked deadline timer would hold it open for close to the full deadline`,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
