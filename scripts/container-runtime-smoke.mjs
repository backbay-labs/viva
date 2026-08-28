#!/usr/bin/env node
// ROWS 365/529/685, RELEASE-026: Plan 12 Task 15 Step 6 ("Verify images
// behaviorally") is six shell commands in the plan text -- never scripted,
// never executed, never proven. scripts/container-supply-chain.test.mjs
// (Steps 1-5) only parses the two Dockerfiles as text; it can never observe
// what a *built, running* container actually does. This is the repeatable
// runner for that residual behavioral half: build both images, then prove
// each runs as its declared fixed non-root identity, can write only its
// declared paths, and survives `--read-only` with only a tmpfs to write
// into. It is a local, built-image proof -- not hosted deployment
// provenance (that's `container_provenance.deployment_outputs`, Plan 15's
// `INTEGRATION-009`).
//
// Not part of `node --test scripts/*.test.mjs`: a cold agent image is a full
// `cargo build --release`, and the monitor image pulls Playwright's ~1GB
// base image plus a `bun install` -- minutes, not milliseconds, and this
// lane's own `bun run validate` chain must stay fast. This script is the
// dedicated, bounded, timed, re-runnable entrypoint for that slower proof
// instead, invoked explicitly (`node scripts/container-runtime-smoke.mjs`)
// the same way `scripts/release-check.mjs` is.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoForbiddenEvidenceMarkers } from "./redaction-control.mjs";

export const REPORT_SCHEMA = "viva.container_runtime_smoke.v1";
const AGENT_IMAGE_TAG = "viva-agent-supply-chain-test";
const MONITOR_IMAGE_TAG = "viva-monitor-supply-chain-test";
const MAX_OUTPUT_CHARS = 4_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The exact six commands from the plan's Task 15 Step 6, as data: each a
 * named step with the binary/args to spawn, a bounded timeout, and the label
 * this report records it under. Builds default to a generous 20-minute
 * bound (a cold `cargo build --release` or a ~1GB base-image pull can
 * legitimately take minutes); the four run/probe steps -- no build, no
 * network fetch -- default to 60s.
 */
export function containerRuntimeSmokeSteps({
  buildTimeoutMs = 20 * 60_000,
  runTimeoutMs = 60_000,
} = {}) {
  return [
    {
      // Repo-root context, not `agent`: agent-domain's include_str! of
      // packages/core/src/learner-loop-contract.json reaches outside an
      // agent-only build context (see agent/Dockerfile's own comment).
      id: "agent_image_build",
      command: "docker",
      args: ["build", "-f", "agent/Dockerfile", ".", "-t", AGENT_IMAGE_TAG],
      timeoutMs: buildTimeoutMs,
    },
    {
      id: "agent_non_root_uid",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        AGENT_IMAGE_TAG,
        "-c",
        'test "$(id -u)" = 10001 && test "$(id -g)" = 10001',
      ],
      timeoutMs: runTimeoutMs,
    },
    {
      id: "monitor_image_build",
      command: "docker",
      args: ["build", "-f", "Dockerfile.monitor", ".", "-t", MONITOR_IMAGE_TAG],
      timeoutMs: buildTimeoutMs,
    },
    {
      id: "monitor_non_root_bun_evidence_paths",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        MONITOR_IMAGE_TAG,
        "-c",
        'test "$(id -u)" != 0 && test "$(bun --version)" = 1.3.3 && test -r /app/evidence/live-smoke-answer.pcm && test -w /app/evidence',
      ],
      timeoutMs: runTimeoutMs,
    },
    {
      id: "agent_read_only_root",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--entrypoint",
        "sh",
        AGENT_IMAGE_TAG,
        "-c",
        'test "$(id -u)" = 10001 && touch /tmp/agent-write-probe',
      ],
      timeoutMs: runTimeoutMs,
    },
    {
      // ROW 365/529/685 LIVE DEFECT (fixed here): the plan's own Task 15
      // Step 6 text hardcodes uid=1000,gid=1000 for this tmpfs mount. Never
      // executed until this script existed, so nothing had ever checked it
      // against the real image: mcr.microsoft.com/playwright:v1.61.0-noble's
      // `pwuser` (Dockerfile.monitor's own USER) is actually uid=1001,
      // gid=1001 -- confirmed by running `id pwuser` in the built image.
      // uid=1000,gid=1000,mode=0750 owns the mount as neither pwuser's user
      // nor its group, and mode 0750 grants "other" nothing, so every write
      // fails closed with Permission denied before the probe ever reaches
      // its own assertions.
      id: "monitor_read_only_root",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/app/evidence:rw,uid=1001,gid=1001,mode=0750",
        "--entrypoint",
        "sh",
        MONITOR_IMAGE_TAG,
        "-c",
        'test "$(id -u)" != 0 && touch /tmp/monitor-write-probe && touch /app/evidence/monitor-write-probe',
      ],
      timeoutMs: runTimeoutMs,
    },
  ];
}

/** Runs one step with a bounded timeout; never throws -- always returns a result. */
export function runContainerSmokeStep(step, { spawnImpl = spawnSync, cwd = root } = {}) {
  const startedAt = Date.now();
  const result = spawnImpl(step.command, step.args, {
    cwd,
    encoding: "utf8",
    timeout: step.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL";
  const spawnFailed = result.error !== undefined && result.error !== null && !timedOut;
  const passed = !timedOut && !spawnFailed && result.status === 0;
  return {
    id: step.id,
    command: [step.command, ...step.args].join(" "),
    passed,
    timed_out: timedOut,
    spawn_failed: spawnFailed,
    exit_code: typeof result.status === "number" ? result.status : null,
    duration_ms: durationMs,
    timeout_ms: step.timeoutMs,
    stdout_tail: truncate(result.stdout ?? ""),
    stderr_tail: truncate(
      spawnFailed && !result.stderr ? String(result.error.message) : (result.stderr ?? ""),
    ),
  };
}

function truncate(text) {
  const value = String(text);
  return value.length > MAX_OUTPUT_CHARS
    ? `${value.slice(-MAX_OUTPUT_CHARS)}\n[truncated to last ${MAX_OUTPUT_CHARS} chars]`
    : value;
}

/**
 * Runs every step in order, stopping at the first failure only for the two
 * build steps (a probe against an image that never built proves nothing);
 * every probe step still runs even if an earlier probe failed, so one bad
 * probe cannot hide a second, independent regression in the same report.
 */
export function runContainerRuntimeSmoke(options = {}) {
  const steps = containerRuntimeSmokeSteps(options);
  const results = [];
  for (const step of steps) {
    const result = runContainerSmokeStep(step, options);
    results.push(result);
    const isBuildStep = step.id.endsWith("_build");
    if (isBuildStep && !result.passed) break;
  }
  const allPassed = results.length === steps.length && results.every((entry) => entry.passed);
  const report = {
    schema: REPORT_SCHEMA,
    generated_at: new Date().toISOString(),
    image_tags: { agent: AGENT_IMAGE_TAG, monitor: MONITOR_IMAGE_TAG },
    steps: results,
    total_duration_ms: results.reduce((sum, entry) => sum + entry.duration_ms, 0),
    all_passed: allPassed,
    sanitized: true,
  };
  assertNoForbiddenEvidenceMarkers(report, { context: "container runtime smoke report" });
  return report;
}

async function cleanupTestImages({ spawnImpl = spawnSync } = {}) {
  for (const tag of [AGENT_IMAGE_TAG, MONITOR_IMAGE_TAG]) {
    spawnImpl("docker", ["rmi", "-f", tag], { cwd: root, encoding: "utf8", timeout: 30_000 });
  }
}

async function main() {
  const outputDir = path.join(root, "artifacts/container-runtime-smoke");
  await mkdir(outputDir, { recursive: true });
  const report = runContainerRuntimeSmoke();
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const step of report.steps) {
    console.log(
      `${step.passed ? "PASS" : "FAIL"} ${step.id} (${step.duration_ms}ms)${
        step.timed_out ? " [TIMED OUT]" : ""
      }`,
    );
  }
  if (process.env.VIVA_CONTAINER_SMOKE_KEEP_IMAGES !== "1") {
    await cleanupTestImages();
  }
  if (!report.all_passed) {
    console.error("container runtime smoke failed; see artifacts/container-runtime-smoke/report.json");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
