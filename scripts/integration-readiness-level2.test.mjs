// INTEGRATION-004 — the frozen Level 2 command runner, its builders, and the assembler.
//
// This file proves the TRACKED half of Task 4: the runner that will execute the combined
// gate battery after the coordinator freezes a SHA, the builders that spell the plan's
// exact argv, and the assembler that validates the result. It never runs the battery —
// that is post-freeze work and no pre-freeze command result is Level 2 evidence.
//
// The runner is driven through injected `spawn`/`head`/`worktreeClean` seams so signal,
// timeout, missing-executable and permission-denied outcomes are exercised for real
// instead of being asserted about. The log files are written to a real temporary
// directory, so the exclusive-create that makes them immutable is genuinely tested.
// Marker NAMES are spelled plainly and allowed to flag (A-39.2).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assembleLevelTwo,
  buildLevelTwoCommands,
  createFrozenCommandRunner,
  LEVEL_2_ADVERSARIAL_CONTROLS,
  LEVEL_2_SCHEMA,
  levelTwoCommand,
  PRESERVED_BEHAVIOR_FAMILIES,
  REQUIRED_LEVEL_2_COMMAND_IDS,
  renderCommandEnvironment,
  VOICE_TRANSPORT_MATRIX,
  validateBrowserStoryResult,
} from "./integration-readiness-level2.mjs";
import { REDACTED_VALUE } from "./redaction-control.mjs";

const FROZEN_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const RUN_ID = "20260823T180000Z-0123456789ab";
const hex = (length, seed) => createHash("sha256").update(seed).digest("hex").slice(0, length);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** The plan's own command specs, so no fixture below can invent an argv the plan never ran. */
const SPECS = new Map(
  buildLevelTwoCommands({ frozenSha: FROZEN_SHA, runId: RUN_ID }).map((spec) => [spec.id, spec]),
);

const withDirectory = async (body) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "viva-level2-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** A `spawnSync`-shaped result. */
const spawned = (overrides = {}) => ({
  status: 0,
  signal: null,
  stdout: "ok\n",
  stderr: "",
  error: undefined,
  ...overrides,
});

const runner = (directory, overrides = {}) =>
  createFrozenCommandRunner({
    frozenSha: FROZEN_SHA,
    artifactDir: directory,
    head: () => FROZEN_SHA,
    worktreeClean: () => true,
    now: () => new Date("2026-08-23T18:00:00.000Z"),
    spawn: () => spawned(),
    ...overrides,
  });

const forcedGraph = { id: "forced_ts_graph", argv: ["bunx", "turbo", "run", "build", "--force"] };

// --- The command runner ---

test("a command's stdout and stderr are captured to separate immutable files and hashed", async () => {
  await withDirectory(async (directory) => {
    const runs = runner(directory, {
      spawn: () => spawned({ stdout: "graph ok\n", stderr: "one warning\n" }),
    });
    const record = runs.run(forcedGraph);
    assert.equal(record.id, "forced_ts_graph");
    assert.deepEqual(record.argv, ["bunx", "turbo", "run", "build", "--force"]);
    assert.equal(record.exit_code, 0);
    assert.equal(record.status, "PASS");
    assert.equal(record.frozen_sha, FROZEN_SHA);
    assert.equal(record.cache_mode, "forced");
    const out = path.join(directory, "forced_ts_graph.stdout.log");
    const err = path.join(directory, "forced_ts_graph.stderr.log");
    assert.equal(await readFile(out, "utf8"), "graph ok\n");
    assert.equal(await readFile(err, "utf8"), "one warning\n");
    assert.equal(record.stdout_sha256, sha256("graph ok\n"));
    assert.equal(record.stderr_sha256, sha256("one warning\n"));
    assert.notEqual(record.stdout_sha256, record.stderr_sha256);
  });
});

test("argv is recorded verbatim and never handed to a shell", async () => {
  await withDirectory(async (directory) => {
    const calls = [];
    const runs = runner(directory, {
      spawn: (file, args, options) => {
        calls.push({ file, args, options });
        return spawned();
      },
    });
    const argv = ["bun", "run", "release:check", "--force; rm -rf /"];
    const record = runs.run({ id: "release_check", argv });
    assert.deepEqual(record.argv, argv);
    assert.equal(calls[0].file, "bun");
    assert.deepEqual(calls[0].args, argv.slice(1));
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.cwd, ".");
  });
});

test("a command id cannot be recorded twice and its log files cannot be overwritten", async () => {
  await withDirectory(async (directory) => {
    const runs = runner(directory);
    runs.run(forcedGraph);
    assert.throws(() => runs.run(forcedGraph), /command id is already recorded: forced_ts_graph/);
    assert.equal(runs.records().length, 1);
  });
});

test("the frozen SHA is checked before and after every command", async () => {
  await withDirectory(async (directory) => {
    const before = runner(directory, { head: () => OTHER_SHA });
    assert.throws(() => before.run(forcedGraph), /frozen SHA changed before forced_ts_graph/);
    let calls = 0;
    const after = runner(directory, {
      head: () => (++calls > 1 ? OTHER_SHA : FROZEN_SHA),
    });
    assert.throws(() => after.run(forcedGraph), /frozen SHA changed while forced_ts_graph ran/);
  });
});

test("a worktree that is dirty, or becomes dirty, fails the command", async () => {
  await withDirectory(async (directory) => {
    const dirty = runner(directory, { worktreeClean: () => false });
    assert.throws(() => dirty.run(forcedGraph), /worktree is not clean before forced_ts_graph/);
    let calls = 0;
    const became = runner(directory, { worktreeClean: () => ++calls <= 1 });
    assert.throws(() => became.run(forcedGraph), /worktree became dirty while forced_ts_graph ran/);
  });
});

test("signal, timeout, missing executable, and permission denied are each FAIL", async () => {
  const cases = [
    ["signalled", spawned({ status: null, signal: "SIGKILL" }), "terminated by signal SIGKILL"],
    ["timed_out", spawned({ status: null, signal: "SIGTERM", timedOut: true }), "timed out"],
    [
      "missing",
      spawned({ status: null, error: Object.assign(new Error("x"), { code: "ENOENT" }) }),
      "executable is missing",
    ],
    [
      "denied",
      spawned({ status: null, error: Object.assign(new Error("x"), { code: "EACCES" }) }),
      "permission denied",
    ],
  ];
  for (const [id, result, reason] of cases) {
    await withDirectory(async (directory) => {
      const runs = runner(directory, { spawn: () => result });
      const record = runs.run({ id, argv: ["bun", "run", id] });
      assert.equal(record.status, "FAIL", `${id} must be FAIL`);
      assert.equal(Number.isInteger(record.exit_code), true);
      assert.notEqual(record.exit_code, 0);
      const failure = runs.failures().find((entry) => entry.id === id);
      assert.match(failure.reason, new RegExp(reason));
    });
  }
});

test("a real timeout and a real missing executable are FAIL through the real spawn", async () => {
  await withDirectory(async (directory) => {
    const runs = createFrozenCommandRunner({
      frozenSha: FROZEN_SHA,
      artifactDir: directory,
      head: () => FROZEN_SHA,
      worktreeClean: () => true,
    });
    const slow = runs.run({
      id: "real_timeout",
      argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 250,
    });
    assert.equal(slow.status, "FAIL");
    assert.match(runs.failures().find((f) => f.id === "real_timeout").reason, /timed out/);
    const missing = runs.run({ id: "real_missing", argv: ["viva-not-an-executable-probe"] });
    assert.equal(missing.status, "FAIL");
    assert.match(
      runs.failures().find((f) => f.id === "real_missing").reason,
      /executable is missing/,
    );
    assert.equal(missing.exit_code, -1);
  });
});

test("an existing log file is never overwritten", async () => {
  await withDirectory(async (directory) => {
    const first = runner(directory);
    first.run(forcedGraph);
    const second = runner(directory);
    assert.throws(() => second.run(forcedGraph), /command log already exists and is immutable/);
  });
});

test("a guarded environment value is never recorded", async () => {
  await withDirectory(async (directory) => {
    const runs = runner(directory);
    const record = runs.run({
      id: "release_check",
      argv: ["bun", "run", "release:check"],
      env: {
        VIVA_RELEASE_DEPLOY_SHA: FROZEN_SHA,
        VIVA_RELEASE_BUNDLE_SIGNING_SECRET: "must-never-render",
        CARTESIA_API_KEY: "must-never-render",
        VIVA_SOURCE_CONTEXT: "must-never-render",
      },
    });
    assert.equal(record.environment.VIVA_RELEASE_DEPLOY_SHA, FROZEN_SHA);
    for (const key of [
      "VIVA_RELEASE_BUNDLE_SIGNING_SECRET",
      "CARTESIA_API_KEY",
      "VIVA_SOURCE_CONTEXT",
    ]) {
      assert.equal(record.environment[key], REDACTED_VALUE, `${key} must be redacted`);
    }
    assert.equal(JSON.stringify(record).includes("must-never-render"), false);
  });
});

test("the spec's unset list and env reach the child process, not just the record", async () => {
  await withDirectory(async (directory) => {
    const calls = [];
    const runs = runner(directory, {
      processEnv: {
        PATH: "/usr/bin",
        VIVA_ALLOW_LOOPBACK_TEST_SKIP: "1",
        VIVA_E2E_DEPLOY_SHA: OTHER_SHA,
      },
      spawn: (_file, _args, options) => {
        calls.push(options);
        return spawned();
      },
    });
    const record = runs.run({
      id: "browser_synthetic",
      argv: ["bun", "run", "e2e:browser"],
      unset: ["VIVA_ALLOW_LOOPBACK_TEST_SKIP"],
      env: { VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX: "1", VIVA_E2E_DEPLOY_SHA: FROZEN_SHA },
    });
    const childEnv = calls[0].env;
    assert.equal(
      Object.hasOwn(childEnv, "VIVA_ALLOW_LOOPBACK_TEST_SKIP"),
      false,
      "the skip authority must be removed from the child environment",
    );
    assert.equal(childEnv.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX, "1");
    assert.equal(childEnv.VIVA_E2E_DEPLOY_SHA, FROZEN_SHA, "the spec env must win over inheritance");
    assert.equal(childEnv.PATH, "/usr/bin", "unrelated inherited keys survive");
    assert.deepEqual(record.unset, ["VIVA_ALLOW_LOOPBACK_TEST_SKIP"]);
    assert.equal(record.environment.VIVA_E2E_DEPLOY_SHA, FROZEN_SHA);
  });
});

test("a real child process truly cannot see an unset key", async () => {
  await withDirectory(async (directory) => {
    const probe = "process.exit(process.env.VIVA_ALLOW_LOOPBACK_TEST_SKIP ? 3 : 0)";
    const base = {
      frozenSha: FROZEN_SHA,
      artifactDir: directory,
      head: () => FROZEN_SHA,
      worktreeClean: () => true,
      processEnv: { ...process.env, VIVA_ALLOW_LOOPBACK_TEST_SKIP: "1" },
    };
    const removed = createFrozenCommandRunner(base).run({
      id: "ws_replay",
      argv: ["node", "-e", probe],
      unset: ["VIVA_ALLOW_LOOPBACK_TEST_SKIP"],
    });
    assert.equal(removed.exit_code, 0, "the child must not inherit the skip authority");
    assert.equal(removed.status, "PASS");
    // Control: without the unset the same child sees it, so the assertion above is real.
    const inherited = createFrozenCommandRunner(base).run({
      id: "ws_replay_control",
      argv: ["node", "-e", probe],
    });
    assert.equal(inherited.exit_code, 3);
    assert.equal(inherited.status, "FAIL");
  });
});

test("the release commands drop every guarded key, database URL, and failure switch", async () => {
  await withDirectory(async (directory) => {
    const calls = [];
    const runs = runner(directory, {
      processEnv: {
        PATH: "/usr/bin",
        DATABASE_URL: "postgres://x",
        VIVA_AGENT_DATABASE_URL: "postgres://y",
        CARTESIA_API_KEY: "live",
        GEMINI_API_KEY: "live",
        VIVA_VOICE_SESSION_TOKEN_SECRET: "live",
        VIVA_VOICE_WS_BEARER_TOKEN: "live",
        VIVA_AGENT_REST_BEARER_TOKEN: "live",
        VIVA_FAILURE_CONTROL_ENABLED: "1",
        VIVA_FAILURE_CONTROL_SECRET: "live",
        VIVA_RELEASE_BUNDLE_SIGNING_SECRET: "ephemeral-local-hmac",
      },
      spawn: (_file, _args, options) => {
        calls.push(options);
        return spawned();
      },
    });
    const spec = SPECS.get("release_check");
    assert.ok(spec.hermetic, "the release check must declare the plan's hermetic environment");
    runs.run(spec);
    const childEnv = calls[0].env;
    for (const key of [
      "DATABASE_URL",
      "VIVA_AGENT_DATABASE_URL",
      "CARTESIA_API_KEY",
      "GEMINI_API_KEY",
      "VIVA_VOICE_SESSION_TOKEN_SECRET",
      "VIVA_VOICE_WS_BEARER_TOKEN",
      "VIVA_AGENT_REST_BEARER_TOKEN",
      "VIVA_FAILURE_CONTROL_ENABLED",
      "VIVA_FAILURE_CONTROL_SECRET",
    ]) {
      assert.equal(Object.hasOwn(childEnv, key), false, `${key} must not reach release:check`);
    }
    assert.equal(
      childEnv.VIVA_RELEASE_BUNDLE_SIGNING_SECRET,
      "ephemeral-local-hmac",
      "the ephemeral signing secret is the one kept guarded key; without it evidence self-signs",
    );
    assert.equal(childEnv.PATH, "/usr/bin");
    assert.equal(childEnv.VIVA_AGENT_PROVIDER, "fake_cartesia_gemini");
  });
});

test("a drifted pinned toolchain version is FAIL even when the tool exits zero", async () => {
  const cases = [
    [{ kind: "exact", value: "1.3.3" }, "1.3.3\n", "1.3.2\n", "stdout to equal"],
    [{ kind: "word", index: 1, value: "1.94.1" }, "rustc 1.94.1 (aaa)\n", "rustc 1.93.0 (a)\n", "word 1"],
    [
      { kind: "line", value: "^cargo-audit(-audit)? 0\\.22\\.0$" },
      "cargo-audit-audit 0.22.0\n",
      "cargo-audit-audit 0.21.0\n",
      "line matching",
    ],
    [{ kind: "contains", value: "nightly" }, "rustc 1.9-nightly\n", "rustc 1.94.1\n", "to contain"],
  ];
  for (const [expectation, good, drifted, needle] of cases) {
    await withDirectory(async (directory) => {
      const id = `pin_${expectation.kind}`;
      const spec = { id, argv: ["cargo", "--version"], expect: [expectation] };
      const ok = runner(directory, { spawn: () => spawned({ stdout: good }) }).run(spec);
      assert.equal(ok.status, "PASS", `${expectation.kind} must accept its pinned output`);
      assert.equal(ok.expect_satisfied, true);
      assert.deepEqual(ok.expect, [expectation]);
      const bad = runner(directory, { spawn: () => spawned({ stdout: drifted }) });
      const record = bad.run({ ...spec, id: `${id}_drift` });
      assert.equal(record.exit_code, 0, "the drifted tool still exits zero; only the pin catches it");
      assert.equal(record.status, "FAIL", `a drifted ${expectation.kind} pin must be FAIL`);
      assert.equal(record.expect_satisfied, false);
      assert.match(bad.failures().at(-1).reason, new RegExp(needle));
    });
  }
});

// --- The command builders ---

/** Task 4 Steps 3-7, transcribed from the plan, in the plan's execution order. */
const NODE_24 = 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)';
const RUNTIME_VALIDATION =
  'import("@viva/core/runtime-validation").then((m) => { if (typeof m.validateLearnerLoopContract !== "function" || typeof m.parseVivaServerFrame !== "function") process.exit(1); })';
const CARGO_TEST = ["cargo", "test", "--manifest-path", "agent/Cargo.toml"];
const PLAN_COMMANDS = [
  ["node_major_24", ["node", "-e", NODE_24]],
  ["bun_version", ["bun", "--version"]],
  ["rustc_version", ["rustc", "--version"]],
  ["frozen_install", ["bun", "install", "--frozen-lockfile"]],
  ["forced_ts_graph", ["bunx", "turbo", "run", "typecheck", "lint", "test", "build", "--force"]],
  ["script_tests", ["node", "--test", "scripts/*.test.mjs"]],
  ["runtime_validation_exports", ["node", "-e", RUNTIME_VALIDATION]],
  ["module_concentration", ["bun", "run", "module:concentration"]],
  ["redaction_check", ["bun", "run", "redaction:check"]],
  ["release_hygiene", ["bun", "run", "release:hygiene"]],
  ["cargo_audit_version", ["cargo", "audit", "--version"]],
  ["nightly_rustc_version", ["rustup", "run", "nightly-2026-04-21", "rustc", "--version"]],
  ["udeps_version", ["cargo", "+nightly-2026-04-21", "udeps", "--version"]],
  ["mutants_version", ["cargo", "mutants", "--version"]],
  ["rust_fmt", ["cargo", "fmt", "--manifest-path", "agent/Cargo.toml", "--all", "--", "--check"]],
  [
    "rust_clippy",
    [
      "cargo",
      "clippy",
      "--manifest-path",
      "agent/Cargo.toml",
      "--workspace",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ],
  ],
  [
    "rust_workspace_tests",
    [...CARGO_TEST, "--workspace", "--all-targets", "--all-features", "--no-fail-fast"],
  ],
  [
    "rust_build",
    [
      "cargo",
      "build",
      "--manifest-path",
      "agent/Cargo.toml",
      "--workspace",
      "--all-targets",
      "--all-features",
    ],
  ],
  ["ws_replay", ["bun", "run", "agent:replay:ws"]],
  ["deps_unused", ["bun", "run", "agent:deps:unused"]],
  ["domain_mutants", ["bun", "run", "agent:domain:mutants"]],
  ["pdf_fails_closed", [...CARGO_TEST, "-p", "data", "pdf_ingestion_fails_closed_", "--", "--nocapture"]],
  ["selected_d05_retention", [...CARGO_TEST, "-p", "data", "selected_d05", "--", "--nocapture"]],
  ["browser_audio_negative", ["bun", "run", "e2e:browser:audio:negative"]],
  ["browser_audio", ["bun", "run", "e2e:browser:audio"]],
  ["browser_synthetic", ["bun", "run", "e2e:browser"]],
  ["browser_fake_provider", ["bun", "run", "e2e:browser"]],
  ["release_check", ["bun", "run", "release:check"]],
  [
    "release_verify",
    [
      "bun",
      "run",
      "release:verify",
      "--",
      `artifacts/integration-readiness/${RUN_ID}/level-2/release-check/evidence.json`,
    ],
  ],
  ["bun_audit", ["bun", "audit"]],
  [
    "cargo_audit",
    ["cargo", "audit", "--file", "agent/Cargo.lock", "--no-fetch", "--deny", "warnings"],
  ],
];

test("the builder emits the plan's Step 3-7 commands, in order, with nothing invented", () => {
  const commands = buildLevelTwoCommands({ frozenSha: FROZEN_SHA, runId: RUN_ID });
  assert.deepEqual(
    commands.map((command) => command.id),
    PLAN_COMMANDS.map(([id]) => id),
    "the command table must be the plan's commands in the plan's order",
  );
  for (const [id, argv] of PLAN_COMMANDS) {
    const command = commands.find((entry) => entry.id === id);
    assert.deepEqual(command.argv, argv, `${id} argv must be the plan's, verbatim`);
  }
  assert.deepEqual(REQUIRED_LEVEL_2_COMMAND_IDS, PLAN_COMMANDS.map(([id]) => id));
});

test("every pinned tool version is compared against its pin, not merely invoked", () => {
  const byId = new Map(
    buildLevelTwoCommands({ frozenSha: FROZEN_SHA, runId: RUN_ID }).map((c) => [c.id, c]),
  );
  assert.deepEqual(byId.get("bun_version").expect, [{ kind: "exact", value: "1.3.3" }]);
  assert.deepEqual(byId.get("rustc_version").expect, [
    { kind: "word", index: 1, value: "1.94.1" },
  ]);
  assert.deepEqual(byId.get("cargo_audit_version").expect, [
    { kind: "line", value: "^cargo-audit(-audit)? 0\\.22\\.0$" },
  ]);
  assert.deepEqual(byId.get("udeps_version").expect, [
    { kind: "exact", value: "cargo-udeps 0.1.60" },
  ]);
  assert.deepEqual(byId.get("mutants_version").expect, [
    { kind: "exact", value: "cargo-mutants 25.3.1" },
  ]);
  assert.deepEqual(byId.get("nightly_rustc_version").expect, [
    { kind: "contains", value: "nightly" },
  ]);
  // The plan's own pinned literals must appear in the builder; a bare `--version` call that
  // compares nothing is exactly the drift this gate exists to catch.
  // Backslashes stripped so a regex-escaped pin (`0\.22\.0`) reads as its literal version.
  const rendered = JSON.stringify([...byId.values()]).replaceAll("\\", "");
  for (const pin of ["1.3.3", "1.94.1", "0.22.0", "0.1.60", "25.3.1", "nightly-2026-04-21"]) {
    assert.ok(rendered.includes(pin), `the builder must carry the pinned ${pin}`);
  }
});

test("the builders spell the plan's exact frozen commands for the recorded decisions", () => {
  const commands = buildLevelTwoCommands({ frozenSha: FROZEN_SHA, runId: RUN_ID });
  const byId = new Map(commands.map((command) => [command.id, command]));
  for (const id of REQUIRED_LEVEL_2_COMMAND_IDS) {
    assert.ok(byId.has(id), `the builder must emit the required command ${id}`);
  }
  assert.deepEqual(byId.get("forced_ts_graph").argv, [
    "bunx",
    "turbo",
    "run",
    "typecheck",
    "lint",
    "test",
    "build",
    "--force",
  ]);
  assert.deepEqual(byId.get("frozen_install").argv, ["bun", "install", "--frozen-lockfile"]);
  assert.deepEqual(byId.get("bun_audit").argv, ["bun", "audit"]);
  assert.deepEqual(byId.get("cargo_audit").argv, [
    "cargo",
    "audit",
    "--file",
    "agent/Cargo.lock",
    "--no-fetch",
    "--deny",
    "warnings",
  ]);
  // D-04 CONFIRM_DELETE: Plan 09 publishes no restore family, so the memory-backed
  // retention filter is required in its place and no restore command may exist.
  assert.ok(byId.has("selected_d05_retention"));
  assert.equal(
    [...byId.keys()].some((id) => id.includes("restore")),
    false,
  );
  assert.equal(
    commands.every((command) => command.argv.every((token) => typeof token === "string")),
    true,
  );
});

test("the browser matrix commands carry the transport matrix, deploy SHA, and D-08A scope", () => {
  const commands = buildLevelTwoCommands({ frozenSha: FROZEN_SHA, runId: RUN_ID });
  const byId = new Map(commands.map((command) => [command.id, command]));
  for (const [id, provider] of [
    ["browser_synthetic", "synthetic"],
    ["browser_fake_provider", "fake_cartesia_gemini"],
  ]) {
    const command = byId.get(id);
    assert.deepEqual(command.argv, ["bun", "run", "e2e:browser"]);
    assert.equal(command.env.VIVA_E2E_AGENT_PROVIDER, provider);
    assert.equal(command.env.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX, "1");
    assert.equal(command.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO, "1");
    assert.equal(command.env.VIVA_E2E_DEPLOY_SHA, FROZEN_SHA);
    assert.match(command.env.VIVA_E2E_ARTIFACT_DIR, new RegExp(`${RUN_ID}/level-2/browser-`));
    assert.deepEqual(command.unset, ["VIVA_ALLOW_LOOPBACK_TEST_SKIP"]);
  }
  assert.equal(byId.get("browser_synthetic").disclosure_scope, "all-live-content");
});

test("an unrecorded D-04 branch is refused rather than silently built", () => {
  assert.throws(
    () => buildLevelTwoCommands({ frozenSha: FROZEN_SHA, runId: RUN_ID, d04: "SOFT_DELETE_UNDO" }),
    /D-04 is recorded as CONFIRM_DELETE/,
  );
});

// --- The browser story result ---

const browserResult = (overrides = {}) => ({
  deploy_sha: FROZEN_SHA,
  voice_transport: {
    durations_seconds: [2, 10, 45],
    source_sample_rates_hz: [44100, 48000],
    max_serialized_frame_bytes: 65536,
    oversized_frames: 0,
    explicit_turn_end: true,
    transcript_received: true,
    evaluation_received: true,
    recap_received: true,
  },
  console_errors: 0,
  page_errors: 0,
  sanitized: true,
  ...overrides,
});

test("the required browser result fields are exactly the plan's", () => {
  assert.deepEqual(VOICE_TRANSPORT_MATRIX.durations_seconds, [2, 10, 45]);
  assert.deepEqual(VOICE_TRANSPORT_MATRIX.source_sample_rates_hz, [44100, 48000]);
  assert.equal(VOICE_TRANSPORT_MATRIX.max_serialized_frame_bytes, 65536);
  validateBrowserStoryResult(browserResult(), { frozenSha: FROZEN_SHA });
  const rejects = (overrides, message) =>
    assert.throws(
      () => validateBrowserStoryResult(browserResult(overrides), { frozenSha: FROZEN_SHA }),
      (error) => error.message.includes(message),
    );
  rejects({ deploy_sha: OTHER_SHA }, "deploy_sha is not the frozen SHA");
  rejects({ console_errors: 1 }, "console_errors must be 0");
  rejects({ page_errors: 2 }, "page_errors must be 0");
  rejects({ sanitized: false }, "sanitized must be true");
  const short = browserResult().voice_transport;
  rejects({ voice_transport: { ...short, durations_seconds: [2, 10] } }, "durations_seconds");
  rejects({ voice_transport: { ...short, source_sample_rates_hz: [48000] } }, "sample_rates");
  rejects({ voice_transport: { ...short, oversized_frames: 1 } }, "oversized_frames must be 0");
  rejects({ voice_transport: { ...short, evaluation_received: false } }, "evaluation_received");
});

// --- The Level 2 assembler ---

const artifact = (id, relative) => ({
  id,
  path: `artifacts/integration-readiness/${RUN_ID}/level-2/${relative}`,
  media_type: "application/json",
  sha256: hex(64, id),
  bytes: 4096,
  created_at: "2026-08-23T18:05:00.000Z",
  frozen_sha: FROZEN_SHA,
  run_id: RUN_ID,
  sanitized: true,
  forbidden_hits: 0,
});

/**
 * A record shaped exactly as the runner would emit it for the plan's own command. Deriving
 * it from the builder is deliberate: a fixture that invented its own argv would let the
 * assembler pass a battery that never ran the plan's commands.
 */
const commandRecord = (id) => {
  const spec = SPECS.get(id);
  assert.ok(spec, `no builder spec for ${id}`);
  return {
    id,
    argv: [...spec.argv],
    cwd: ".",
    started_at: "2026-08-23T18:00:00.000Z",
    finished_at: "2026-08-23T18:01:00.000Z",
    duration_ms: 60000,
    exit_code: 0,
    status: "PASS",
    frozen_sha: FROZEN_SHA,
    stdout_sha256: hex(64, `${id}-out`),
    stderr_sha256: hex(64, `${id}-err`),
    cache_mode: "forced",
    unset: [...(spec.unset ?? [])],
    environment: renderCommandEnvironment(spec.env),
    hermetic: spec.hermetic ?? null,
    expect: structuredClone(spec.expect ?? []),
    expect_satisfied: true,
  };
};

const levelTwo = (overrides = {}) => ({
  schema: LEVEL_2_SCHEMA,
  run_id: RUN_ID,
  frozen_sha: FROZEN_SHA,
  generated_at: "2026-08-23T18:30:00.000Z",
  commands: REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord),
  artifacts: [artifact("level_2_release_bundle", "release-check/evidence.json")],
  adversarial_controls: LEVEL_2_ADVERSARIAL_CONTROLS.map((id) => ({ id, status: "PASS" })),
  preserved_behavior_families: PRESERVED_BEHAVIOR_FAMILIES.map((family) => ({
    id: family.id,
    filter: family.filter,
    matched: 3,
  })),
  browser_stories: [
    { id: "browser_synthetic", provider: "synthetic", certifying: true, result: browserResult() },
    {
      id: "browser_fake_provider",
      provider: "fake_cartesia_gemini",
      certifying: true,
      result: browserResult(),
    },
  ],
  structured_preview: null,
  turbo_cached_tasks: 0,
  redaction_forbidden_hits: 0,
  status: "PASS",
  ...overrides,
});

const assemble = (document) => assembleLevelTwo(document);
const rejectsLevel = (overrides, message) =>
  assert.throws(
    () => assemble(levelTwo(overrides)),
    (error) => error.message.includes(message),
  );

test("a complete Level 2 document assembles to PASS", () => {
  assert.equal(assemble(levelTwo()).status, "PASS");
});

test("a missing command, a non-zero exit, and a cached task each fail Level 2", () => {
  rejectsLevel(
    { commands: REQUIRED_LEVEL_2_COMMAND_IDS.slice(1).map(commandRecord) },
    "required Level 2 command is missing: ",
  );
  const twice = [...REQUIRED_LEVEL_2_COMMAND_IDS, REQUIRED_LEVEL_2_COMMAND_IDS[0]];
  rejectsLevel({ commands: twice.map(commandRecord) }, "appears more than once");
  const failed = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  failed[2] = { ...failed[2], exit_code: 1, status: "FAIL" };
  rejectsLevel({ commands: failed }, "exited non-zero");
  rejectsLevel({ turbo_cached_tasks: 1 }, "forced Turbo graph reported 1 cached task");
});

test("a battery wearing the required ids but running other commands is refused", () => {
  // The exact shape the review reproduced: every required id present, every exit code zero,
  // every status PASS, forced cache mode — and not one of the plan's commands actually run.
  const trivial = REQUIRED_LEVEL_2_COMMAND_IDS.map((id) => ({
    ...commandRecord(id),
    argv: ["true"],
  }));
  rejectsLevel({ commands: trivial }, "did not run the plan's command");
  const oneWrong = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  const clippy = oneWrong.find((command) => command.id === "rust_clippy");
  clippy.argv = clippy.argv.filter((token) => token !== "-D");
  rejectsLevel({ commands: oneWrong }, "rust_clippy did not run the plan's command");
});

test("a required command's recorded environment, unset list, and pins must be the plan's", () => {
  const withSkip = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  const replay = withSkip.find((command) => command.id === "ws_replay");
  replay.unset = [];
  rejectsLevel({ commands: withSkip }, "ws_replay did not remove the plan's environment keys");

  const noMatrix = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  const browser = noMatrix.find((command) => command.id === "browser_synthetic");
  browser.environment = {
    ...browser.environment,
    VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX: "0",
  };
  rejectsLevel({ commands: noMatrix }, "browser_synthetic did not run with the plan's environment");

  const noPin = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  const bun = noPin.find((command) => command.id === "bun_version");
  bun.expect = [];
  rejectsLevel({ commands: noPin }, "bun_version did not assert the plan's expected output");

  const unchecked = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  unchecked.find((command) => command.id === "mutants_version").expect_satisfied = false;
  rejectsLevel({ commands: unchecked }, "mutants_version did not satisfy its expected output");

  const leaky = REQUIRED_LEVEL_2_COMMAND_IDS.map(commandRecord);
  leaky.find((command) => command.id === "release_check").hermetic = null;
  rejectsLevel({ commands: leaky }, "release_check did not run in the plan's hermetic environment");
});

test("an unbound artifact and a forbidden redaction hit each fail Level 2", () => {
  rejectsLevel(
    { artifacts: [{ ...artifact("a", "b.json"), frozen_sha: OTHER_SHA }] },
    "is not bound to the frozen SHA",
  );
  rejectsLevel(
    { artifacts: [{ ...artifact("a", "b.json"), forbidden_hits: 2 }] },
    "forbidden_hits must be 0",
  );
  rejectsLevel({ redaction_forbidden_hits: 1 }, "redaction forbidden hits must be zero");
});

test("every adversarial control and preserved-behavior family must be executed", () => {
  rejectsLevel(
    {
      adversarial_controls: LEVEL_2_ADVERSARIAL_CONTROLS.slice(1).map((id) => ({
        id,
        status: "PASS",
      })),
    },
    "adversarial control was not executed: ",
  );
  rejectsLevel(
    {
      adversarial_controls: LEVEL_2_ADVERSARIAL_CONTROLS.map((id, index) => ({
        id,
        status: index === 0 ? "FAIL" : "PASS",
      })),
    },
    "adversarial control did not pass: ",
  );
  rejectsLevel(
    {
      preserved_behavior_families: PRESERVED_BEHAVIOR_FAMILIES.map((family, index) => ({
        id: family.id,
        filter: family.filter,
        matched: index === 0 ? 0 : 3,
      })),
    },
    "matched zero tests",
  );
  assert.equal(
    LEVEL_2_ADVERSARIAL_CONTROLS.includes(
      "required product frame replaced by harness-authored HTML",
    ),
    true,
  );
  assert.equal(PRESERVED_BEHAVIOR_FAMILIES.length, 5);
});

test("the level-2 verb confirms the recorded frozen SHA instead of relabelling it", () => {
  const io = (document, written) => ({
    flag: (flags, name) => {
      const value = flags.get(name);
      assert.ok(value !== undefined, `missing --${name}`);
      return value;
    },
    readJson: () => structuredClone(document),
    writeJson: (file, value) => written.push({ file, value }),
  });
  const flags = new Map([
    ["artifact-dir", `artifacts/integration-readiness/${RUN_ID}/level-2`],
    ["frozen-sha", FROZEN_SHA],
    ["output", `artifacts/integration-readiness/${RUN_ID}/level-2.json`],
  ]);
  const written = [];
  levelTwoCommand(flags, io(levelTwo(), written));
  assert.equal(written.at(-1).value.status, "PASS");
  assert.throws(
    () => levelTwoCommand(flags, io(levelTwo({ frozen_sha: OTHER_SHA }), [])),
    /the recorded Level 2 frozen_sha .* is not --frozen-sha/,
  );
});

test("D-09B keeps the structured preview non-certifying and outside the required frames", () => {
  const preview = {
    id: "structured_preview",
    certifying: false,
    artifact: artifact("p", "p.json"),
  };
  assert.equal(assemble(levelTwo({ structured_preview: preview })).status, "PASS");
  rejectsLevel(
    { structured_preview: { ...preview, certifying: true } },
    "D-09B: the structured preview is non-certifying evidence",
  );
  rejectsLevel(
    {
      browser_stories: [
        {
          id: "browser_synthetic",
          provider: "synthetic",
          certifying: false,
          result: browserResult(),
        },
        {
          id: "browser_fake_provider",
          provider: "fake_cartesia_gemini",
          certifying: true,
          result: browserResult(),
        },
      ],
    },
    "harness-authored frames cannot certify product behavior",
  );
});
