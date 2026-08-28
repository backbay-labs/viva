// INTEGRATION-004 — the frozen Level 2 combined-gate runner, builders, and assembler.
//
// Task 4 splits across the freeze barrier: the runner, the builders that spell the plan's
// exact argv, and the assembler are TRACKED implementation prepared before the freeze; the
// battery itself is executed only after the coordinator freezes a clean SHA, because no
// pre-freeze command result is Level 2 evidence. Nothing in this module runs a command on
// import, and the runner refuses to run one whose frozen SHA it cannot confirm.
//
// The runner's contract is deliberately hostile to a comfortable green: it checks
// `git rev-parse HEAD` and worktree cleanliness before AND after every command, writes
// stdout and stderr to two exclusively-created files so an existing log can never be
// overwritten, hashes both, records argv as a literal array that never reaches a shell,
// redacts guarded environment values, and treats a signal, a timeout, a missing executable
// and a permission-denied skip as `FAIL` rather than as an excuse to skip.
//
// Two recorded decisions are load-bearing here. `D-04 = CONFIRM_DELETE` means Plan 09
// publishes no restore family, so the memory-backed retention filter replaces it and no
// restore command may be built at all. `D-09B` means a structured preview is non-certifying
// evidence: it is reported separately, exempt from the required product frames, and a
// harness-authored frame can never certify product behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  check,
  fail,
  git,
  isGuardedEnvironmentKey,
  isRecord,
  requireArray,
  requireInstant,
  requireSha,
  requireText,
  sha256,
} from "./integration-readiness-shared.mjs";
import { REDACTED_VALUE } from "./redaction-control.mjs";

/** The record's environment block: every guarded value replaced, never the value itself. */
export function renderCommandEnvironment(env) {
  const rendered = {};
  for (const [key, value] of Object.entries(env ?? {}).sort()) {
    rendered[key] = isGuardedEnvironmentKey(key) ? REDACTED_VALUE : String(value);
  }
  return rendered;
}

export const LEVEL_2_SCHEMA = "viva.integration_level_2.v1";
export const RECORDED_D04 = "CONFIRM_DELETE";
export const RECORDED_D09 = "D-09B";
export const DISCLOSURE_SCOPE = "all-live-content";

/** The production-shaped transport matrix every certifying browser story must execute. */
export const VOICE_TRANSPORT_MATRIX = Object.freeze({
  durations_seconds: Object.freeze([2, 10, 45]),
  source_sample_rates_hz: Object.freeze([44100, 48000]),
  max_serialized_frame_bytes: 65536,
});

/** Task 4 Step 8's control set, verbatim and in the plan's order. */
export const LEVEL_2_ADVERSARIAL_CONTROLS = Object.freeze([
  "missing rg and failing rg/git in shell gates",
  "old single-frame 2-second audio implementation",
  "wrong protocol size/version/close-reason fixture",
  "wrong deploy SHA or run ID",
  "unsigned bundle and signature downgrade",
  "missing sanitized field",
  "stale and future-dated evidence",
  "enabled failure-control harness",
  "hostile inherited auth/database/provider env",
  "monitor timeout before partial-evidence flush",
  "consecutive live-monitor failure count reaching two",
  "stale ETag or duplicate run attempting to overwrite hosted monitor state",
  "S3 transient retry then success and publish deadline failure",
  "grandchild/orphan process after normal exit and SIGTERM",
  "required product frame replaced by harness-authored HTML",
  "provider limiter proof test renamed or removed",
  "redaction marker split across Unicode normalization",
]);

/** Task 4 Step 4's preserved-behavior families, each of which must match a real test. */
export const PRESERVED_BEHAVIOR_FAMILIES = Object.freeze([
  { id: "public_bind_without_auth", owner: "SERVICE", filter: "public_bind" },
  { id: "session_token_nonce_admission", owner: "VOICE/SERVICE", filter: "session_token" },
  { id: "forged_browser_source_or_tool_frame", owner: "VOICE/SERVICE", filter: "forged" },
  { id: "live_provider_zdr_admission", owner: "ADAPTER", filter: "zdr" },
  { id: "redaction_marker_mutation", owner: "RELEASE", filter: "redaction" },
]);

const CARGO = Object.freeze(["cargo", "test", "--manifest-path", "agent/Cargo.toml"]);
const NO_SKIP = Object.freeze(["VIVA_ALLOW_LOOPBACK_TEST_SKIP"]);
const NIGHTLY = "nightly-2026-04-21";

// Task 4 Steps 3 and 4 do not merely invoke the toolchain; they COMPARE its output to a pin
// (`test "$(bun --version)" = "1.3.3"`, `rg -qx 'cargo-audit(-audit)? 0\.22\.0'`, ...). Those
// comparisons are shell, and this runner never reaches a shell, so each pin travels with its
// command as a declared expectation the runner evaluates itself: a drifted tool exits 0 and
// must still be FAIL, because the plan says missing or drifted tools are failure, not a skip.
const exact = (value) => Object.freeze([Object.freeze({ kind: "exact", value })]);
const word = (index, value) => Object.freeze([Object.freeze({ kind: "word", index, value })]);
const line = (value) => Object.freeze([Object.freeze({ kind: "line", value })]);
const contains = (value) => Object.freeze([Object.freeze({ kind: "contains", value })]);

// Task 4 Step 6 generates release evidence with an ephemeral local HMAC and an explicitly
// emptied environment. Rather than re-spelling the plan's nine key names, the policy drops a
// superset: every guarded key plus every database URL and failure-control switch. The signing
// secret is the one kept key — without it `release:check` self-signs, which Step 6 rejects.
const HERMETIC_RELEASE = Object.freeze({
  drop_guarded: true,
  drop_matching: Object.freeze(["^DATABASE_URL$", "_DATABASE_URL$", "^VIVA_FAILURE_CONTROL_"]),
  keep: Object.freeze(["VIVA_RELEASE_BUNDLE_SIGNING_SECRET"]),
});

const NODE_24 = 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)';
const RUNTIME_VALIDATION =
  'import("@viva/core/runtime-validation").then((m) => { if (typeof m.validateLearnerLoopContract !== "function" || typeof m.parseVivaServerFrame !== "function") process.exit(1); })';

/**
 * Task 4 Steps 3, 4, 5, 6 and 7, as literal argv. The order is the plan's execution order
 * and `REQUIRED_LEVEL_2_COMMAND_IDS` is derived from it, so a command that is added here
 * without being executed after the freeze fails the assembler rather than passing quietly.
 */
function levelTwoCommandTable({ frozenSha, runId }) {
  const artifacts = (leaf) => `artifacts/integration-readiness/${runId}/level-2/${leaf}`;
  const browser = (id, provider, leaf) => ({
    id,
    argv: ["bun", "run", "e2e:browser"],
    unset: [...NO_SKIP],
    disclosure_scope: DISCLOSURE_SCOPE,
    env: {
      VIVA_E2E_AGENT_PROVIDER: provider,
      VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1",
      VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX: "1",
      VIVA_E2E_DEPLOY_SHA: frozenSha,
      VIVA_E2E_ARTIFACT_DIR: artifacts(leaf),
    },
  });
  return [
    { id: "node_major_24", argv: ["node", "-e", NODE_24] },
    { id: "bun_version", argv: ["bun", "--version"], expect: exact("1.3.3") },
    { id: "rustc_version", argv: ["rustc", "--version"], expect: word(1, "1.94.1") },
    { id: "frozen_install", argv: ["bun", "install", "--frozen-lockfile"] },
    {
      id: "forced_ts_graph",
      argv: ["bunx", "turbo", "run", "typecheck", "lint", "test", "build", "--force"],
    },
    { id: "script_tests", argv: ["node", "--test", "scripts/*.test.mjs"] },
    { id: "runtime_validation_exports", argv: ["node", "-e", RUNTIME_VALIDATION] },
    { id: "module_concentration", argv: ["bun", "run", "module:concentration"] },
    { id: "redaction_check", argv: ["bun", "run", "redaction:check"] },
    { id: "release_hygiene", argv: ["bun", "run", "release:hygiene"] },
    {
      id: "cargo_audit_version",
      argv: ["cargo", "audit", "--version"],
      // `cargo audit` prints `cargo-audit-audit 0.22.0` through the cargo subcommand, which
      // is why the plan's own `rg -qx` alternation accepts both spellings.
      expect: line("^cargo-audit(-audit)? 0\\.22\\.0$"),
    },
    {
      id: "nightly_rustc_version",
      argv: ["rustup", "run", NIGHTLY, "rustc", "--version"],
      expect: contains("nightly"),
    },
    {
      id: "udeps_version",
      argv: ["cargo", `+${NIGHTLY}`, "udeps", "--version"],
      expect: exact("cargo-udeps 0.1.60"),
    },
    {
      id: "mutants_version",
      argv: ["cargo", "mutants", "--version"],
      expect: exact("cargo-mutants 25.3.1"),
    },
    {
      id: "rust_fmt",
      argv: ["cargo", "fmt", "--manifest-path", "agent/Cargo.toml", "--all", "--", "--check"],
    },
    {
      id: "rust_clippy",
      argv: [
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
    },
    {
      id: "rust_workspace_tests",
      argv: [...CARGO, "--workspace", "--all-targets", "--all-features", "--no-fail-fast"],
      unset: [...NO_SKIP],
    },
    {
      id: "rust_build",
      argv: [
        "cargo",
        "build",
        "--manifest-path",
        "agent/Cargo.toml",
        "--workspace",
        "--all-targets",
        "--all-features",
      ],
    },
    { id: "ws_replay", argv: ["bun", "run", "agent:replay:ws"], unset: [...NO_SKIP] },
    { id: "deps_unused", argv: ["bun", "run", "agent:deps:unused"] },
    { id: "domain_mutants", argv: ["bun", "run", "agent:domain:mutants"] },
    {
      id: "pdf_fails_closed",
      argv: [...CARGO, "-p", "data", "pdf_ingestion_fails_closed_", "--", "--nocapture"],
    },
    // D-04 CONFIRM_DELETE: no `study_set_restore_` family exists, so Plan 09 Task 9's
    // memory-backed retention/finalization filter is the required command in its place.
    {
      id: "selected_d05_retention",
      argv: [...CARGO, "-p", "data", "selected_d05", "--", "--nocapture"],
    },
    {
      id: "browser_audio_negative",
      argv: ["bun", "run", "e2e:browser:audio:negative"],
      unset: [...NO_SKIP],
    },
    { id: "browser_audio", argv: ["bun", "run", "e2e:browser:audio"], unset: [...NO_SKIP] },
    browser("browser_synthetic", "synthetic", "browser-synthetic"),
    browser("browser_fake_provider", "fake_cartesia_gemini", "browser-fake-provider"),
    {
      id: "release_check",
      argv: ["bun", "run", "release:check"],
      hermetic: HERMETIC_RELEASE,
      env: {
        VIVA_RELEASE_RUN_ID: runId,
        VIVA_RELEASE_DEPLOY_SHA: frozenSha,
        VIVA_AGENT_PROVIDER: "fake_cartesia_gemini",
        VIVA_RELEASE_ARTIFACT_DIR: artifacts("release-check"),
      },
    },
    {
      id: "release_verify",
      argv: ["bun", "run", "release:verify", "--", artifacts("release-check/evidence.json")],
      hermetic: HERMETIC_RELEASE,
    },
    { id: "bun_audit", argv: ["bun", "audit"] },
    {
      id: "cargo_audit",
      argv: ["cargo", "audit", "--file", "agent/Cargo.lock", "--no-fetch", "--deny", "warnings"],
    },
  ];
}

export function buildLevelTwoCommands({ frozenSha, runId, d04 = RECORDED_D04 }) {
  requireSha(frozenSha, "frozenSha");
  requireText(runId, "runId");
  // Rule: only the recorded branch is ever built. A different D-04 needs a coordinator
  // amendment first, because its command set is a different published test family.
  check(d04 === RECORDED_D04, `D-04 is recorded as ${RECORDED_D04}, not ${d04}`);
  return levelTwoCommandTable({ frozenSha, runId });
}

export const REQUIRED_LEVEL_2_COMMAND_IDS = Object.freeze(
  levelTwoCommandTable({
    frozenSha: "0".repeat(40),
    runId: "00000000T000000Z-000000000000",
  }).map((command) => command.id),
);

// --- The frozen command runner ---

const defaultHead = () => git(["rev-parse", "HEAD"], "utf8").trim();
const defaultWorktreeClean = () => git(["status", "--porcelain=v1"], "utf8").trim() === "";

/** Exclusive create: an existing log file is never silently overwritten. */
function writeImmutable(file, contents) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  try {
    writeFileSync(file, contents, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") fail(`command log already exists and is immutable: ${file}`);
    throw error;
  }
}

/**
 * The child's environment, built from the parent's: `unset` keys removed (the plan's
 * `env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP`), the hermetic policy applied, then `env` written
 * last so the spec always wins over inheritance. Building it here is the point: a spec whose
 * environment is only rendered into the record describes a process that never had it.
 */
export function childEnvironment(spec, processEnv) {
  const environment = { ...processEnv };
  for (const key of spec.unset ?? []) delete environment[key];
  const hermetic = spec.hermetic;
  if (hermetic) {
    const patterns = hermetic.drop_matching.map((source) => new RegExp(source));
    for (const key of Object.keys(environment)) {
      if (hermetic.keep.includes(key)) continue;
      const guarded = hermetic.drop_guarded === true && isGuardedEnvironmentKey(key);
      if (guarded || patterns.some((pattern) => pattern.test(key))) delete environment[key];
    }
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) environment[key] = String(value);
  return environment;
}

/** Null when the pin holds, otherwise the reason the recorded output is not the pinned one. */
function expectationFailure(expectation, stdout) {
  const trimmed = stdout.trim();
  const { kind, value } = expectation;
  if (kind === "exact") return trimmed === value ? null : `expected stdout to equal ${value}`;
  if (kind === "word") {
    const observed = trimmed.split(/\s+/)[expectation.index];
    return observed === value ? null : `expected stdout word ${expectation.index} to be ${value}`;
  }
  if (kind === "line") {
    const pattern = new RegExp(value);
    const matched = stdout.split("\n").some((entry) => pattern.test(entry.trim()));
    return matched ? null : `expected a stdout line matching ${value}`;
  }
  if (kind === "contains") {
    return stdout.includes(value) ? null : `expected stdout to contain ${value}`;
  }
  return fail(`unknown expectation kind: ${kind}`);
}

function expectationsFailure(spec, stdout) {
  for (const expectation of spec.expect ?? []) {
    const reason = expectationFailure(expectation, stdout);
    // The observed head is a tool version line by construction; it is truncated anyway.
    if (reason) return `${reason}; observed "${stdout.trim().split("\n")[0].slice(0, 120)}"`;
  }
  return null;
}

function failureReason(result) {
  if (result.error?.code === "ENOENT") return "the executable is missing";
  if (result.error?.code === "EACCES") return "permission denied";
  // `spawnSync` reports a timeout as an ETIMEDOUT error plus the kill signal, so the
  // timeout branch has to precede the generic spawn-failure branch to stay honest.
  if (result.timedOut || result.error?.code === "ETIMEDOUT") return "the command timed out";
  if (result.error) return `spawn failed: ${result.error.code ?? result.error.message}`;
  if (result.signal) return `the command was terminated by signal ${result.signal}`;
  if (result.status !== 0) return `the command exited non-zero (${result.status})`;
  return null;
}

export function createFrozenCommandRunner(options) {
  const { frozenSha, artifactDir } = options;
  const { spawn = spawnSync, head = defaultHead, worktreeClean = defaultWorktreeClean } = options;
  const { now = () => new Date(), writeLog = writeImmutable, processEnv = process.env } = options;
  requireSha(frozenSha, "frozenSha");
  requireText(artifactDir, "artifactDir");
  const records = [];
  const failures = [];
  const seen = new Set();

  const run = (spec) => {
    const id = requireText(spec?.id, "command id");
    check(!seen.has(id), `command id is already recorded: ${id}`);
    const argv = requireArray(spec.argv, `${id} argv`);
    const literal = argv.length > 0 && argv.every((t) => typeof t === "string" && t !== "");
    check(literal, `${id} argv must be a non-empty array of literal strings`);
    check(head() === frozenSha, `frozen SHA changed before ${id}`);
    check(worktreeClean(), `worktree is not clean before ${id}`);
    seen.add(id);
    const cwd = spec.cwd ?? ".";
    const startedAt = now();
    const result = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      encoding: "utf8",
      env: childEnvironment(spec, processEnv),
      timeout: spec.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
    const finishedAt = now();
    check(head() === frozenSha, `frozen SHA changed while ${id} ran`);
    check(worktreeClean(), `worktree became dirty while ${id} ran`);
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    writeLog(path.join(artifactDir, `${id}.stdout.log`), stdout);
    writeLog(path.join(artifactDir, `${id}.stderr.log`), stderr);
    const expectationReason = expectationsFailure(spec, stdout);
    const reason = failureReason(result) ?? expectationReason;
    if (reason) failures.push({ id, reason });
    const record = {
      id,
      argv: [...argv],
      cwd,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      // A signal, timeout, or spawn error has no exit code; -1 records that honestly and
      // can never be mistaken for the zero the assembler requires.
      exit_code: Number.isInteger(result.status) ? result.status : -1,
      status: reason ? "FAIL" : "PASS",
      frozen_sha: frozenSha,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      cache_mode: spec.cache_mode ?? "forced",
      unset: [...(spec.unset ?? [])],
      environment: renderCommandEnvironment(spec.env),
      hermetic: spec.hermetic ?? null,
      expect: structuredClone(spec.expect ?? []),
      expect_satisfied: expectationReason === null,
    };
    records.push(record);
    return record;
  };

  return { run, records: () => [...records], failures: () => [...failures] };
}

// --- Browser story results ---

export function validateBrowserStoryResult(result, { frozenSha }) {
  check(isRecord(result), "browser story result must be an object");
  check(result.deploy_sha === frozenSha, "browser story deploy_sha is not the frozen SHA");
  const transport = result.voice_transport;
  check(isRecord(transport), "browser story voice_transport is required");
  const durations = requireArray(transport.durations_seconds, "durations_seconds");
  const matched = VOICE_TRANSPORT_MATRIX.durations_seconds.every((s) => durations.includes(s));
  check(matched, "voice_transport durations_seconds must execute 2, 10, and 45 seconds");
  const rates = requireArray(transport.source_sample_rates_hz, "source_sample_rates_hz");
  const both = VOICE_TRANSPORT_MATRIX.source_sample_rates_hz.every((hz) => rates.includes(hz));
  check(both, "voice_transport source_sample_rates must execute 44100 and 48000 Hz");
  const cap =
    transport.max_serialized_frame_bytes === VOICE_TRANSPORT_MATRIX.max_serialized_frame_bytes;
  check(cap, "voice_transport max_serialized_frame_bytes must be 65536");
  check(transport.oversized_frames === 0, "voice_transport oversized_frames must be 0");
  for (const field of [
    "explicit_turn_end",
    "transcript_received",
    "evaluation_received",
    "recap_received",
  ]) {
    check(transport[field] === true, `voice_transport ${field} must be true`);
  }
  check(result.console_errors === 0, "browser story console_errors must be 0");
  check(result.page_errors === 0, "browser story page_errors must be 0");
  check(result.sanitized === true, "browser story sanitized must be true");
  return result;
}

// --- The Level 2 assembler ---

/** Object-key-insensitive, array-order-sensitive: argv order matters, key order does not. */
const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)))
      : entry,
  );

/**
 * Binds a recorded command to the plan's own spec. Matching the ID alone proves only that a
 * label appeared: a battery of `true` invocations wearing the required IDs would otherwise
 * assemble to PASS, and this is the single gate that is supposed to prove the plan's exact
 * combined battery ran on the frozen tree.
 */
function assertCommandMatchesSpec(command, spec) {
  const id = spec.id;
  const same = (recorded, planned) => canonical(recorded) === canonical(planned);
  check(
    same(command.argv, spec.argv),
    `Level 2 command ${id} did not run the plan's command; it recorded ${JSON.stringify(command.argv)}`,
  );
  check(
    same(command.unset ?? [], spec.unset ?? []),
    `Level 2 command ${id} did not remove the plan's environment keys before running`,
  );
  check(
    same(command.environment ?? {}, renderCommandEnvironment(spec.env)),
    `Level 2 command ${id} did not run with the plan's environment`,
  );
  check(
    same(command.hermetic ?? null, spec.hermetic ?? null),
    `Level 2 command ${id} did not run in the plan's hermetic environment`,
  );
  check(
    same(command.expect ?? [], spec.expect ?? []),
    `Level 2 command ${id} did not assert the plan's expected output`,
  );
  check(
    command.expect_satisfied === true,
    `Level 2 command ${id} did not satisfy its expected output`,
  );
}

function validateArtifactBinding(artifact, { frozenSha, runId }) {
  const id = requireText(artifact?.id, "artifact id");
  check(artifact.frozen_sha === frozenSha, `artifact ${id} is not bound to the frozen SHA`);
  check(artifact.run_id === runId, `artifact ${id} is not bound to the run ID`);
  check(artifact.sanitized === true, `artifact ${id} sanitized must be true`);
  check(artifact.forbidden_hits === 0, `artifact ${id} forbidden_hits must be 0`);
}

export function assembleLevelTwo(document) {
  check(document?.schema === LEVEL_2_SCHEMA, `schema must be ${LEVEL_2_SCHEMA}`);
  const frozenSha = requireSha(document.frozen_sha, "frozen_sha");
  const runId = requireText(document.run_id, "run_id");
  requireInstant(document.generated_at, "generated_at");
  const byId = new Map();
  for (const command of requireArray(document.commands, "commands")) {
    const id = requireText(command?.id, "command id");
    check(!byId.has(id), `Level 2 command appears more than once: ${id}`);
    byId.set(id, command);
    check(command.frozen_sha === frozenSha, `command ${id} is not bound to the frozen SHA`);
    check(command.cache_mode === "forced", `command ${id} recorded a cache-only result`);
  }
  const expected = new Map(
    buildLevelTwoCommands({ frozenSha, runId }).map((spec) => [spec.id, spec]),
  );
  for (const id of REQUIRED_LEVEL_2_COMMAND_IDS) {
    check(byId.has(id), `required Level 2 command is missing: ${id}`);
    const command = byId.get(id);
    check(command.exit_code === 0, `Level 2 command exited non-zero: ${id}`);
    check(command.status === "PASS", `Level 2 command did not pass: ${id}`);
    assertCommandMatchesSpec(command, expected.get(id));
  }
  for (const artifact of requireArray(document.artifacts, "artifacts")) {
    validateArtifactBinding(artifact, { frozenSha, runId });
  }
  const cached = document.turbo_cached_tasks;
  check(cached === 0, `the forced Turbo graph reported ${cached} cached tasks; it must report 0`);
  const hits = document.redaction_forbidden_hits;
  check(hits === 0, `redaction forbidden hits must be zero, not ${hits}`);
  const controls = new Map(
    requireArray(document.adversarial_controls, "adversarial_controls").map((c) => [c?.id, c]),
  );
  for (const id of LEVEL_2_ADVERSARIAL_CONTROLS) {
    check(controls.has(id), `adversarial control was not executed: ${id}`);
    check(controls.get(id).status === "PASS", `adversarial control did not pass: ${id}`);
  }
  const families = new Map(
    requireArray(document.preserved_behavior_families, "preserved_behavior_families").map((f) => [
      f?.id,
      f,
    ]),
  );
  for (const family of PRESERVED_BEHAVIOR_FAMILIES) {
    check(families.has(family.id), `preserved-behavior family was not executed: ${family.id}`);
    const executed = families.get(family.id);
    check(
      Number.isInteger(executed.matched) && executed.matched > 0,
      `preserved-behavior family matched zero tests: ${family.id} (${executed.filter})`,
    );
  }
  const stories = requireArray(document.browser_stories, "browser_stories");
  for (const provider of ["synthetic", "fake_cartesia_gemini"]) {
    const story = stories.find((entry) => entry?.provider === provider);
    check(Boolean(story), `the required ${provider} browser story is missing`);
    check(
      story.certifying === true,
      `${story.id}: harness-authored frames cannot certify product behavior (D-09B)`,
    );
    validateBrowserStoryResult(story.result, { frozenSha });
  }
  const preview = document.structured_preview;
  if (preview !== null) {
    check(isRecord(preview), "structured_preview must be an object or null");
    check(
      preview.certifying === false,
      `${RECORDED_D09}: the structured preview is non-certifying evidence and is reported separately`,
    );
    if (preview.artifact) validateArtifactBinding(preview.artifact, { frozenSha, runId });
  }
  check(document.status === "PASS", `Level 2 status must be PASS, not ${document.status}`);
  return document;
}

/** `level-2` — Task 4 Step 9. Validates an already-executed battery; runs nothing. */
export function levelTwoCommand(flags, io) {
  const { flag, readJson, writeJson } = io;
  const artifactDir = flag(flags, "artifact-dir");
  const input = flags.get("input") ?? path.join(artifactDir, "level-2-input.json");
  const document = readJson(input);
  const frozenSha = requireSha(flag(flags, "frozen-sha"), "--frozen-sha");
  // The executor's own recorded SHA is the evidence; the flag confirms it and never
  // overwrites it, or a run against the wrong tree would relabel itself into a PASS.
  check(
    document.frozen_sha === frozenSha,
    `the recorded Level 2 frozen_sha ${document.frozen_sha} is not --frozen-sha ${frozenSha}`,
  );
  assembleLevelTwo(document);
  writeJson(flag(flags, "output"), document);
  process.stdout.write(`Level 2 PASS for ${document.frozen_sha}.\n`);
}
