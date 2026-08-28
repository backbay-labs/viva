// RELEASE-030 E2E extraction: behavioral tests for the Playwright/local-service
// lifecycle primitives moved out of `e2e-browser.mjs` into
// `e2e-browser-runtime.mjs`. Process-tree, port-race, and signal-cleanup
// behavior is proven once, against real fixtures, in
// `process-supervisor.test.mjs`; this file proves this module's own thin
// wiring over that supervisor -- role dispatch, artifact-relative log paths,
// and the shared managed-child bookkeeping every local spawn site depends on.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authenticatedHostedFetchOptions,
  delay,
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
