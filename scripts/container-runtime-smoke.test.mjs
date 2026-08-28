import assert from "node:assert/strict";
import test from "node:test";
import {
  containerRuntimeSmokeSteps,
  REPORT_SCHEMA,
  runContainerRuntimeSmoke,
  runContainerSmokeStep,
} from "./container-runtime-smoke.mjs";

test("ROWS 365/529/685, RELEASE-026: the six steps are exactly Plan 12 Task 15 Step 6's build/probe sequence, in order", () => {
  const steps = containerRuntimeSmokeSteps();
  assert.deepEqual(
    steps.map((step) => step.id),
    [
      "agent_image_build",
      "agent_non_root_uid",
      "monitor_image_build",
      "monitor_non_root_bun_evidence_paths",
      "agent_read_only_root",
      "monitor_read_only_root",
    ],
  );
  for (const step of steps) {
    assert.equal(step.command, "docker");
    assert(Number.isInteger(step.timeoutMs) && step.timeoutMs > 0);
  }
  // The exact plan-text probe predicates, unmodified.
  const shellCommandFor = (id) => steps.find((step) => step.id === id).args.at(-1);
  assert.equal(
    shellCommandFor("agent_non_root_uid"),
    'test "$(id -u)" = 10001 && test "$(id -g)" = 10001',
  );
  assert.equal(
    shellCommandFor("monitor_non_root_bun_evidence_paths"),
    'test "$(id -u)" != 0 && test "$(bun --version)" = 1.3.3 && test -r /app/evidence/live-smoke-answer.pcm && test -w /app/evidence',
  );
  assert.equal(
    shellCommandFor("agent_read_only_root"),
    'test "$(id -u)" = 10001 && touch /tmp/agent-write-probe',
  );
  assert.equal(
    shellCommandFor("monitor_read_only_root"),
    'test "$(id -u)" != 0 && touch /tmp/monitor-write-probe && touch /app/evidence/monitor-write-probe',
  );
  const readOnlyStep = steps.find((step) => step.id === "agent_read_only_root");
  assert(readOnlyStep.args.includes("--read-only"));
  assert(readOnlyStep.args.includes("--tmpfs"));
  const monitorReadOnly = steps.find((step) => step.id === "monitor_read_only_root");
  // uid=1001,gid=1001 -- Dockerfile.monitor's `pwuser`'s real identity in
  // mcr.microsoft.com/playwright:v1.61.0-noble (confirmed by running `id
  // pwuser` in the built image), not the plan text's uid=1000,gid=1000.
  assert(monitorReadOnly.args.includes("/app/evidence:rw,uid=1001,gid=1001,mode=0750"));
});

test("runContainerSmokeStep reports a bounded timeout as a distinct, non-crashing failure", () => {
  const fakeTimeoutSpawn = () => ({
    status: null,
    signal: "SIGKILL",
    error: undefined,
    stdout: "",
    stderr: "",
  });
  const result = runContainerSmokeStep(
    { id: "fake_step", command: "docker", args: ["run"], timeoutMs: 1_000 },
    { spawnImpl: fakeTimeoutSpawn },
  );
  assert.equal(result.passed, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.spawn_failed, false);
});

test("runContainerSmokeStep reports a spawn failure (docker missing) as a distinct, non-crashing failure", () => {
  const fakeMissingDockerSpawn = () => ({
    status: null,
    signal: null,
    error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
    stdout: "",
    stderr: "",
  });
  const result = runContainerSmokeStep(
    { id: "fake_step", command: "docker", args: ["version"], timeoutMs: 1_000 },
    { spawnImpl: fakeMissingDockerSpawn },
  );
  assert.equal(result.passed, false);
  assert.equal(result.spawn_failed, true);
  assert.equal(result.timed_out, false);
  assert.match(result.stderr_tail, /ENOENT/);
});

test("runContainerSmokeStep passes only on a real exit code 0, and truncates unbounded output", () => {
  const passing = runContainerSmokeStep(
    { id: "ok", command: "docker", args: [], timeoutMs: 1_000 },
    { spawnImpl: () => ({ status: 0, signal: null, error: undefined, stdout: "ok", stderr: "" }) },
  );
  assert.equal(passing.passed, true);

  const huge = "x".repeat(10_000);
  const overflowing = runContainerSmokeStep(
    { id: "loud", command: "docker", args: [], timeoutMs: 1_000 },
    { spawnImpl: () => ({ status: 1, signal: null, error: undefined, stdout: huge, stderr: "" }) },
  );
  assert.equal(overflowing.passed, false);
  assert(overflowing.stdout_tail.length < huge.length);
  assert.match(overflowing.stdout_tail, /truncated/);
});

test("runContainerRuntimeSmoke stops after a failed image build instead of running probes against an image that never built, but still runs every probe when both builds succeed", () => {
  const calls = [];
  const buildFailsSpawn = (command, args) => {
    calls.push(args[0] === "build" ? "build" : "run");
    if (args[0] === "build" && args.includes("agent/Dockerfile")) {
      return { status: 1, signal: null, error: undefined, stdout: "", stderr: "build failed" };
    }
    return { status: 0, signal: null, error: undefined, stdout: "", stderr: "" };
  };
  const report = runContainerRuntimeSmoke({ spawnImpl: buildFailsSpawn });
  assert.equal(report.all_passed, false);
  assert.deepEqual(calls, ["build"]);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].id, "agent_image_build");

  const allPassSpawn = () => ({ status: 0, signal: null, error: undefined, stdout: "", stderr: "" });
  const fullReport = runContainerRuntimeSmoke({ spawnImpl: allPassSpawn });
  assert.equal(fullReport.all_passed, true);
  assert.equal(fullReport.steps.length, 6);
  assert.equal(fullReport.schema, REPORT_SCHEMA);
  assert.equal(fullReport.sanitized, true);
  assert(Number.isInteger(fullReport.total_duration_ms));
});

test("runContainerRuntimeSmoke runs every probe even when one probe (not a build) fails, so a second independent regression is never hidden", () => {
  const calls = [];
  const oneProbeFailsSpawn = (command, args) => {
    calls.push(args.join(" "));
    // The non-root UID probe fails; everything else (including the other
    // probes) still succeeds.
    if (args.at(-1)?.includes('test "$(id -u)" = 10001 && test "$(id -g)" = 10001')) {
      return { status: 1, signal: null, error: undefined, stdout: "", stderr: "" };
    }
    return { status: 0, signal: null, error: undefined, stdout: "", stderr: "" };
  };
  const report = runContainerRuntimeSmoke({ spawnImpl: oneProbeFailsSpawn });
  assert.equal(report.all_passed, false);
  assert.equal(report.steps.length, 6, "every step must still run despite one probe failure");
  assert.equal(
    report.steps.find((step) => step.id === "agent_non_root_uid").passed,
    false,
  );
  assert.equal(
    report.steps.find((step) => step.id === "monitor_read_only_root").passed,
    true,
  );
});
