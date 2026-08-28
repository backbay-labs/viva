import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildProductionReleaseGateEvidence,
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
} from "./production-release-gate.mjs";
import {
  auditReleaseEvidence,
  buildReleaseGateEvidence,
  createCommandRunner,
  providerReadinessChildEnv,
  providerReadinessLogPaths,
} from "./release-check-core.mjs";

const releaseCheck = fs.readFileSync(new URL("./release-check.mjs", import.meta.url), "utf8");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release check runs the exact provider limiter admission test target and binds evidence to its parsed, executed proof", () => {
  assert.match(releaseCheck, /provider_limiter_behavior_tests/);
  // The exact test target -- package, integration-test binary, --exact
  // filter -- lives only in the shared PROVIDER_LIMITER_ADMISSION_TEST_ARGS
  // constant (scripts/provider-limiter-evidence.mjs), not duplicated here.
  assert.match(releaseCheck, /PROVIDER_LIMITER_ADMISSION_TEST_ARGS/);
  assert.match(
    releaseCheck,
    /run\(\s*"provider_limiter_behavior_tests",\s*"cargo",\s*PROVIDER_LIMITER_ADMISSION_TEST_ARGS,?\s*\)/,
  );
  // The old inline, unbounded cargo filter (no --test binary scope, no
  // --exact match -- the exact bug a zero-test or multi-test filter could
  // hide behind) must be gone.
  assert.doesNotMatch(releaseCheck, /"provider_limiter_behavior_tests",\s*"cargo",\s*\[\s*"test",/);
  // A zero-test Cargo filter must not silently pass: the command's own log
  // is parsed and asserted to report exactly one passed execution before
  // evidence can be built from it.
  assert.match(releaseCheck, /parseProviderLimiterAdmissionProof\(/);
  assert.match(releaseCheck, /providerLimiterReleaseEvidence\(\{\s*env:\s*process\.env,\s*proof:/);
});

test("RELEASE-026: release check reads both real Dockerfiles and binds sanitized container_provenance into the evidence draft", () => {
  assert.match(
    releaseCheck,
    /import \{[^}]*buildContainerProvenanceEvidence[^}]*\} from "\.\/production-release-gate\.mjs";/s,
  );
  assert.match(releaseCheck, /agent\/Dockerfile/);
  assert.match(releaseCheck, /Dockerfile\.monitor/);
  assert.match(releaseCheck, /container_provenance:/);
  // The evidence draft carries container_provenance -- not a second,
  // independently-drifting inline object literal duplicating what
  // buildContainerProvenanceEvidence already computes.
  assert.match(releaseCheck, /buildContainerProvenanceEvidence\(\{/);
});

test("release check imports executed hosted monitor matrix results before finalizing", () => {
  assert.match(releaseCheck, /readHostedMonitorEvidence/);
  assert.match(releaseCheck, /hostedMonitorMatrixResults/);
  assert.match(releaseCheck, /results: hostedMonitorMatrixResults/);
});

test("RELEASE-005/009: release-check.mjs runs each named command exactly once (no duplicate provider_gate_tests invocation)", () => {
  const matches = releaseCheck.match(/"provider_gate_tests"/g) ?? [];
  assert.equal(
    matches.length,
    1,
    "provider_gate_tests must be registered exactly once -- a second invocation would silently clobber the first run's logs",
  );
});

test("RELEASE-006/010/011: release-check.mjs's command execution, evidence auditing, and release-gate summary construction are the extracted release-check-core.mjs primitives, not local duplicates", () => {
  assert.match(
    releaseCheck,
    /import \{[^}]*createCommandRunner[^}]*\} from "\.\/release-check-core\.mjs";/s,
  );
  assert.match(releaseCheck, /createCommandRunner\(\{/);
  assert.match(releaseCheck, /providerReadinessChildEnv\(/);
  assert.match(releaseCheck, /auditReleaseEvidence\(/);
  assert.match(releaseCheck, /buildReleaseGateEvidence\(/);
  // The old locally-defined command runner, ad-hoc evidence audit, and
  // ad-hoc release-gate builder must all be gone -- not left behind as
  // parallel, drifting implementations alongside the imported ones.
  assert.doesNotMatch(releaseCheck, /async function run\(name, command, args/);
  assert.doesNotMatch(releaseCheck, /function auditSanitizedEvidence\(/);
  assert.doesNotMatch(releaseCheck, /function buildReleaseGateEvidence\(/);
  assert.doesNotMatch(releaseCheck, /env:\s*childEnvironmentFor\(/);
});

test("release-check-core: two distinct command names map one-to-one to their own stdout/stderr log paths, and every command is fully explicit-environment isolated from a hostile, ambient parent", async () => {
  const dir = await withTempDir();
  try {
    const { run } = createCommandRunner({
      artifactDir: dir,
      root: dir,
      parentEnv: hostileParentEnv(),
    });
    const first = await run("first_step", process.execPath, [
      "-e",
      "console.log('first-out'); console.error('first-err'); console.log(JSON.stringify(process.env))",
    ]);
    const second = await run("second_step", process.execPath, ["-e", "console.log('second-out')"]);

    assert.equal(first.stdout_log, "first_step.stdout.log");
    assert.equal(first.stderr_log, "first_step.stderr.log");
    assert.equal(second.stdout_log, "second_step.stdout.log");
    assert.equal(second.stderr_log, "second_step.stderr.log");
    assert.notEqual(first.stdout_log, second.stdout_log);

    const firstStdout = await readFile(path.join(dir, "first_step.stdout.log"), "utf8");
    assert.match(firstStdout, /first-out/);
    const firstStderr = await readFile(path.join(dir, "first_step.stderr.log"), "utf8");
    assert.match(firstStderr, /first-err/);

    // No sentinel value from the hostile parent -- database credentials,
    // session secrets, provider keys, live/production release flags, or
    // the NODE_OPTIONS/BUN_OPTIONS injection vectors -- ever reached the
    // child, whether under its own key or any other.
    const childEnv = JSON.parse(firstStdout.split("\n").find((line) => line.startsWith("{")));
    assertNoHostileValuesLeaked(childEnv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release-check-core: a duplicate command name is rejected before the second spawn, and the first run's logs are never overwritten", async () => {
  const dir = await withTempDir();
  try {
    const { run, commands } = createCommandRunner({ artifactDir: dir, root: dir, parentEnv: {} });
    await run("dup_step", process.execPath, ["-e", "console.log('original-output')"]);

    // The duplicate call targets a nonexistent command on purpose: if the
    // implementation ever spawned before checking uniqueness, this would
    // fail with a spawn/ENOENT-flavored error instead of the duplicate-name
    // error, proving the check truly runs before any second spawn attempt.
    await assert.rejects(
      () => run("dup_step", "definitely-does-not-exist-viva-release-check-fixture", []),
      /duplicate release command name: dup_step/,
    );

    const stdout = await readFile(path.join(dir, "dup_step.stdout.log"), "utf8");
    assert.match(stdout, /original-output/);
    assert.equal(commands.filter((record) => record.name === "dup_step").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release-check-core: stdout/stderr streams are fully flushed to disk before the command record resolves", async () => {
  const dir = await withTempDir();
  try {
    const { run } = createCommandRunner({ artifactDir: dir, root: dir, parentEnv: {} });
    const payload = "x".repeat(65_536);
    await run("flush_step", process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(payload)})`,
    ]);

    // Read the file immediately -- no delay, no retry loop. If run()
    // resolved before the write stream's own buffered data had actually
    // been flushed, this read could observe a short/partial file.
    const written = await readFile(path.join(dir, "flush_step.stdout.log"), "utf8");
    assert.equal(written, payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release-check-core: a spawn failure (ENOENT) rejects run() into the caller's own cleanup path instead of hanging or escaping as an uncaught exception", async () => {
  const dir = await withTempDir();
  try {
    const { run } = createCommandRunner({ artifactDir: dir, root: dir, parentEnv: {} });
    await assert.rejects(
      () =>
        run("missing_binary_step", "definitely-does-not-exist-viva-release-check-fixture", [
          "--flag",
        ]),
      /missing_binary_step failed to spawn/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RELEASE-005/006: release-check.mjs's own top-level catch quarantines the releasable artifact directory and writes sanitized failure.json when a real command fails to spawn (ENOENT)", async () => {
  // The prior test proves createCommandRunner's run() rejects on a spawn
  // ENOENT. It says nothing about what release-check.mjs itself -- the
  // top-level script that calls run() -- does with that rejection. This
  // spawns the real script (never imported directly: it executes its whole
  // pipeline at module top level) with a broken PATH so its very first
  // command ("generated_artifact_hygiene", via `bun`) fails to spawn before
  // any real release work starts, and inspects the resulting quarantine.
  const artifactDir = await withTempDir();
  const emptyPathDir = await withTempDir();
  const failureArtifactDir = path.resolve(repoRoot, "artifacts/release-check-failures");
  await writeFile(path.join(artifactDir, "pre-existing-partial-evidence.txt"), "must not survive");

  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/release-check.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      VIVA_RELEASE_ARTIFACT_DIR: artifactDir,
      PATH: emptyPathDir,
    },
  });

  try {
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /generated_artifact_hygiene failed to spawn/);

    // The releasable artifact directory this failed run had begun to
    // populate is deleted -- never left around to be mistakenly attached
    // or published as if it were real, complete evidence.
    await assert.rejects(() => stat(artifactDir), /ENOENT/);

    const failureJson = JSON.parse(
      await readFile(path.join(failureArtifactDir, "failure.json"), "utf8"),
    );
    assert.equal(failureJson.unsafe_to_attach, true);
    assert.match(failureJson.error, /generated_artifact_hygiene failed to spawn/);
    assert.equal(failureJson.releasable_artifact_dir_deleted, path.relative(repoRoot, artifactDir));
    assert.deepEqual(failureJson.commands, []);
    // The sanitized failure record carries only the caught error message,
    // the (empty) command log, and the deleted-directory path -- never a
    // raw environment value, credential, or unrelated ambient secret.
    assert.doesNotMatch(
      JSON.stringify(failureJson),
      /DATABASE_URL|SECRET|session_token|postgres:\/\//i,
    );
  } finally {
    await rm(failureArtifactDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});

test("ROW 332/RELEASE-002: release-check.mjs's independent failure-control throw fires before any command runs -- a real defense-in-depth layer, not merely source text a caller could delete unnoticed", async () => {
  // scripts/failure-control-harness.mjs's own BAC-528 comment documents this
  // as a *second, separate* layer from `enabled_for_release`: even if that
  // evidence field were ever wrong, this in-process guard must independently
  // refuse to build release evidence at all while the harness plan is
  // enabled. Deleting the throw at release-check.mjs:116-118 left every
  // other test green, because nothing actually executed this exact script
  // with an enabled plan -- so this spawns the real script (never imported
  // directly: it runs its whole pipeline at module top level), the same
  // pattern the ENOENT quarantine test above uses.
  const artifactDir = await withTempDir();
  const emptyPathDir = await withTempDir();
  const failureArtifactDir = path.resolve(repoRoot, "artifacts/release-check-failures");
  try {
    // PATH is deliberately empty, exactly like the ENOENT quarantine test
    // above: the throw must fire before release-check.mjs ever tries to
    // spawn `bun`/`cargo` at all, so this run stays fast and hermetic
    // (no real command, provider, or build ever runs) regardless of what
    // is or isn't installed in the test environment.
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/release-check.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        VIVA_RELEASE_ARTIFACT_DIR: artifactDir,
        PATH: emptyPathDir,
        VIVA_FAILURE_CONTROL_ENABLED: "1",
        VIVA_FAILURE_CONTROL_SCENARIO: "provider_rate_limited",
        VIVA_FAILURE_CONTROL_SECRET: "release-check-test-failure-control-secret",
        VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: "synthetic-user-1",
        VIVA_FAILURE_CONTROL_STUDY_SET_IDS: "synthetic-study-set-1",
        VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: "https://viva.test",
        VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY: "3",
      },
      timeout: 15_000,
    });

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /failure-control harness must be disabled for release evidence generation/,
    );

    const failureJson = JSON.parse(
      await readFile(path.join(failureArtifactDir, "failure.json"), "utf8"),
    );
    assert.match(
      failureJson.error,
      /failure-control harness must be disabled for release evidence generation/,
    );
    // The throw fires before the very first command (generated_artifact_hygiene)
    // is even registered -- proving this is release-check.mjs's own
    // independent, in-process guard, not something a spawned command's
    // (evidence-derived) exit status merely happens to report.
    assert.deepEqual(failureJson.commands, []);
  } finally {
    await rm(failureArtifactDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});

test("release-check-core: providerReadinessChildEnv builds the readiness child's environment from the explicit target config only, never a hostile, ambient parent", () => {
  const target = {
    provider: "cartesia_gemini",
    env: Object.freeze({
      CARTESIA_API_KEY: "viva-release-check-cartesia-placeholder-key",
      GEMINI_API_KEY: "viva-release-check-gemini-placeholder-key",
    }),
  };
  const env = providerReadinessChildEnv({ target, port: 45123, parentEnv: hostileParentEnv() });

  assert.equal(env.CARTESIA_API_KEY, "viva-release-check-cartesia-placeholder-key");
  assert.equal(env.GEMINI_API_KEY, "viva-release-check-gemini-placeholder-key");
  assert.equal(env.VIVA_AGENT_BIND_ADDR, "127.0.0.1:45123");
  assert.equal(env.VIVA_AGENT_PROVIDER, "cartesia_gemini");
  assertNoHostileValuesLeaked(env);
});

test("RELEASE-011: marker-bearing evidence throws from auditReleaseEvidence's real data-driven check, regardless of what call the caller's own source text merely mentions", () => {
  assert.doesNotThrow(() =>
    auditReleaseEvidence({ status: "ok", note: "clean evidence" }, { env: {} }),
  );
  assert.throws(
    () => auditReleaseEvidence({ leaked: "session_token" }, { env: {} }),
    /forbidden payload marker/,
  );
  // A gate-only marker (RELEASE-002/020's raw_prompt/provider_prompt) --
  // meaningful specifically in release/gate evidence, not the general
  // redaction-control.mjs canonical list -- is also rejected.
  assert.throws(
    () => auditReleaseEvidence({ leaked: "raw_prompt payload" }, { env: {} }),
    /forbidden payload marker/,
  );
});

test("RELEASE-011: auditReleaseEvidence's secret-value scan is controlled by the caller's injected env, not process.env", () => {
  const envWithLeakedValue = { SOME_RELEASE_TOKEN: "distinctive-test-sentinel-value" };
  assert.throws(
    () =>
      auditReleaseEvidence(
        { note: "distinctive-test-sentinel-value" },
        { env: envWithLeakedValue },
      ),
    /includes secret value from SOME_RELEASE_TOKEN/,
  );
  assert.equal("SOME_RELEASE_TOKEN" in process.env, false);
  assert.doesNotThrow(() =>
    auditReleaseEvidence({ note: "distinctive-test-sentinel-value" }, { env: {} }),
  );
});

test("RELEASE-011: release_gate's max age (max_age_seconds) is parsed by the exact same VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS logic the production gate summary uses, not a hardcoded literal", () => {
  const generatedAt = new Date("2026-06-25T00:00:00.000Z");
  const defaultGate = buildReleaseGateEvidence({
    browserResult: { skipped: false },
    browserSkipShortcut: false,
    env: {},
    generatedAt,
  });
  assert.equal(defaultGate.max_age_seconds, DEFAULT_MAX_EVIDENCE_AGE_SECONDS);

  const overrideEnv = { VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS: "3600" };
  const overriddenGate = buildReleaseGateEvidence({
    browserResult: { skipped: false },
    browserSkipShortcut: false,
    env: overrideEnv,
    generatedAt,
  });
  assert.equal(overriddenGate.max_age_seconds, 3600);

  const productionGate = buildProductionReleaseGateEvidence({
    evidence: { generated_at: generatedAt.toISOString() },
    env: overrideEnv,
    now: generatedAt,
  });
  assert.equal(overriddenGate.max_age_seconds, productionGate.max_age_seconds);
});

function withTempDir() {
  return mkdtemp(path.join(tmpdir(), "viva-release-check-core-"));
}

function hostileParentEnv() {
  return {
    PATH: process.env.PATH ?? "",
    DATABASE_URL: "postgres://hostile-parent/db",
    VIVA_AGENT_DATABASE_URL: "postgres://hostile-parent/agent",
    CARTESIA_API_KEY: "hostile-cartesia-key-value",
    GEMINI_API_KEY: "hostile-gemini-key-value",
    VIVA_VOICE_SESSION_TOKEN_SECRET: "hostile-session-signing-secret",
    VIVA_VOICE_WS_BEARER_TOKEN: "hostile-ws-bearer-token",
    VIVA_FAILURE_CONTROL_SECRET: "hostile-failure-control-secret",
    VIVA_PRODUCTION_RELEASE: "1",
    VIVA_RELEASE_BUNDLE_SIGNING_SECRET: "hostile-bundle-signing-secret",
    VIVA_RELEASE_CHECK_SKIP_BROWSER: "1",
    NODE_OPTIONS: "--require /tmp/viva-hostile-parent.cjs",
    BUN_OPTIONS: "--hostile",
  };
}

function assertNoHostileValuesLeaked(env) {
  const hostileValues = Object.entries(hostileParentEnv())
    .filter(([key]) => key !== "PATH")
    .map(([, value]) => value);
  for (const [key, value] of Object.entries(env)) {
    assert.equal(
      hostileValues.includes(value),
      false,
      `hostile parent value leaked into child env key ${key}`,
    );
  }
}

// RELEASE-015: release-check's provider-readiness children are real
// agent-service processes bound to a `freePort()`-probed port. Both defects
// live here: the probe closes the port before the child binds it (a race an
// unretried allocation turns into a readiness timeout against a stranger),
// and a locally-killed pid can leave the bound process behind.
test("RELEASE-015: release-check spawns its readiness children through the shared supervisor with a bounded port retry", () => {
  assert.match(
    releaseCheck,
    /import \{[^}]*spawnManaged[^}]*\} from "\.\/process-supervisor\.mjs";/s,
  );
  assert.match(
    releaseCheck,
    /import \{[^}]*spawnWithPortRetry[^}]*\} from "\.\/process-supervisor\.mjs";/s,
  );
  assert.match(releaseCheck, /awaitPortBound/);
  assert.match(releaseCheck, /spawnWithPortRetry\(\{/);
  // The local, unsupervised primitives this replaces are gone: no private
  // freePort(), no private stopChild(), no direct spawn() of the readiness
  // binary, and no `net` import that only existed to serve them.
  assert.doesNotMatch(releaseCheck, /function freePort\(\)/);
  assert.doesNotMatch(releaseCheck, /async function stopChild\(/);
  assert.doesNotMatch(releaseCheck, /spawn\(agentServiceBinary/);
  assert.doesNotMatch(releaseCheck, /import net from "node:net"/);
});

// RELEASE-015: `spawnManaged` opens its log paths with `createWriteStream`,
// which TRUNCATES. A bind-conflict retry that reuses the first attempt's paths
// therefore destroys the EADDRINUSE diagnostic that justified the retry --
// exactly the evidence an operator needs to tell a real bind conflict from a
// child that died for its own reasons.
test("RELEASE-015: each provider-readiness bind attempt writes to its own log pair", () => {
  const first = providerReadinessLogPaths({
    artifactDir: "artifacts/release-check",
    provider: "synthetic",
    attempt: 1,
  });
  const second = providerReadinessLogPaths({
    artifactDir: "artifacts/release-check",
    provider: "synthetic",
    attempt: 2,
  });

  assert.notEqual(first.stdoutPath, second.stdoutPath);
  assert.notEqual(first.stderrPath, second.stderrPath);
  assert.notEqual(first.stdoutPath, first.stderrPath);
  // A second provider's attempt 1 collides with neither.
  const otherProvider = providerReadinessLogPaths({
    artifactDir: "artifacts/release-check",
    provider: "fake_cartesia_gemini",
    attempt: 1,
  });
  assert.notEqual(first.stdoutPath, otherProvider.stdoutPath);
  assert.equal(
    new Set([
      first.stdoutPath,
      first.stderrPath,
      second.stdoutPath,
      second.stderrPath,
      otherProvider.stdoutPath,
      otherProvider.stderrPath,
    ]).size,
    6,
  );
  // The first attempt keeps the stable, documented name so an operator reading
  // a single-attempt run finds the file the runbook names.
  assert.equal(
    first.stdoutPath,
    path.join("artifacts/release-check", "readiness-agent-synthetic.stdout.log"),
  );
  assert.equal(
    second.stdoutPath,
    path.join("artifacts/release-check", "readiness-agent-synthetic.attempt-2.stdout.log"),
  );
});

// The retry boundary hands `start` its attempt number; the paths must be
// derived from it rather than captured once outside the callback.
test("RELEASE-015: release-check derives its readiness log paths inside the retried start callback", () => {
  assert.match(releaseCheck, /start: \(\{ port, attempt \}\)/);
  assert.match(releaseCheck, /providerReadinessLogPaths\(\{[^}]*attempt[^}]*\}\)/s);
  assert.doesNotMatch(releaseCheck, /const stdoutPath = path\.join\(artifactDir, `readiness-agent/);
});

test("RELEASE-015: release-check tears its readiness children down through one idempotent supervised stop", () => {
  assert.match(releaseCheck, /\.stop\(\{ graceMs/);
  assert.match(releaseCheck, /installSignalCleanup\(/);
});
