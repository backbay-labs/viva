import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

/**
 * Plan 06 Task 7 (`DOMAIN-002`, `DOMAIN-010`): the unused-dependency and focused
 * mutation gates must be *required CI work*, not documentation.
 *
 * A source-string test would pass on a commented-out step, a step in a job that
 * never runs, or a command whose exit status is swallowed. So this file parses
 * `package.json` and `.github/workflows/validate.yml` into objects and asserts
 * against the parsed structure: which scripts exist, what they invoke, which
 * workflow steps install the pinned tools, which steps run the commands, and
 * whether any step is allowed to fail.
 *
 * Plan 12 owns both owner files, the `yaml` dev dependency, the pinned tool
 * installs, and the lockfile. This file only states what those must contain.
 *
 * One assertion in here is RED on purpose until Plan 12 lands those contents. See
 * the merge-ordering constraint above `the checked-in package.json and validate
 * workflow carry both required gates` at the end of this file before merging the
 * commit that adds it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGE_JSON_RELATIVE_PATH = "package.json";
export const VALIDATE_WORKFLOW_RELATIVE_PATH = ".github/workflows/validate.yml";

/** The nightly toolchain `cargo-udeps` requires, pinned so CI cannot drift. */
export const RUST_NIGHTLY_TOOLCHAIN = "nightly-2026-04-21";
export const CARGO_UDEPS_VERSION = "0.1.60";
export const CARGO_MUTANTS_VERSION = "25.3.1";

export const UNUSED_DEPENDENCY_SCRIPT = "agent:deps:unused";
export const DOMAIN_MUTANTS_SCRIPT = "agent:domain:mutants";

/**
 * The domain invariants the focused mutation run must cover. Each name is a
 * function whose behavior a Plan 06 task pinned: dropping one from the filter
 * would silently stop proving that its tests kill mutants.
 */
export const DOMAIN_MUTATION_INVARIANTS = Object.freeze([
  "response_id",
  "can_transition_to",
  "restart_after_cancellation",
  "terminate",
  "terminal_reason",
  "require_failure",
  "sanitize_stage_token",
  "sanitize_stage_metadata",
  "is_durability",
  "pending_answer_attempts_for_session",
  "record_voice_session",
  "study_session_durable_counts",
  "answer_attempt_was_recorded",
  "close_voice_session",
  "active_question",
  "record_voice_usage",
  "record_turn_outcome",
  "session_learning_evidence",
  "record_challenge_resolution",
  "select_next_question",
  "authenticated_study_projection",
  "restore_study_set",
  "finalize_expired_study_set_deletions",
  "try_new",
  "validate_fail_closed",
  "pcm16_base64",
  "from_base64",
]);

/** The exact commands Plan 06 Task 7 Step 3 hands to Plan 12. */
export const UNUSED_DEPENDENCY_COMMAND = `cargo +${RUST_NIGHTLY_TOOLCHAIN} udeps --manifest-path agent/Cargo.toml --workspace --all-targets`;
export const DOMAIN_MUTANTS_COMMAND = `cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -p agent-domain -F '${DOMAIN_MUTATION_INVARIANTS.join(
  "|",
)}' --timeout 120`;

/** Shell forms that turn a failing command into a passing step. */
const SWALLOWED_EXIT_PATTERNS = Object.freeze([
  /\|\|\s*true\b/,
  /\|\|\s*:/,
  /;\s*true\s*$/m,
  /\bset\s+\+e\b/,
  /\bcontinue-on-error\b/,
]);

function fail(message) {
  throw new Error(`rust domain quality policy: ${message}`);
}

function jobsOf(workflow) {
  if (!workflow || typeof workflow !== "object") {
    fail("the validate workflow did not parse into an object");
  }
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object") {
    fail("the validate workflow declares no jobs");
  }
  return Object.entries(jobs);
}

/**
 * Every step in the workflow, tagged with the job that owns it. Parsing rather
 * than grepping is the whole point: a commented-out step is not in this list.
 */
function stepsOf(workflow) {
  const steps = [];
  for (const [jobName, job] of jobsOf(workflow)) {
    if (!job || typeof job !== "object") {
      fail(`job "${jobName}" did not parse into an object`);
    }
    if (!Array.isArray(job.steps)) {
      continue;
    }
    for (const [index, step] of job.steps.entries()) {
      if (!step || typeof step !== "object") {
        fail(`job "${jobName}" step ${index} did not parse into an object`);
      }
      steps.push({ jobName, index, job, step });
    }
  }
  if (steps.length === 0) {
    fail("the validate workflow declares no steps");
  }
  return steps;
}

function runBody(step) {
  return typeof step.run === "string" ? step.run : "";
}

/** `cargo install <tool> --version <v>` or an install-action pinned `tool@v`. */
function installsPinnedTool(step, tool, version) {
  const run = runBody(step);
  if (run.includes(`cargo install ${tool}`) && run.includes(version)) {
    return true;
  }
  const withTool = step.with && typeof step.with === "object" ? step.with.tool : undefined;
  return typeof withTool === "string" && withTool.includes(`${tool}@${version}`);
}

function assertStepCannotFailSilently(where, entry) {
  const { job, step } = entry;
  if (step["continue-on-error"] === true || step["continue-on-error"] === "true") {
    fail(`${where} sets continue-on-error, so a failure would not block the job`);
  }
  if (job["continue-on-error"] === true || job["continue-on-error"] === "true") {
    fail(`${where} runs in a job that sets continue-on-error`);
  }
  const run = runBody(step);
  for (const pattern of SWALLOWED_EXIT_PATTERNS) {
    if (pattern.test(run)) {
      fail(`${where} swallows the command's exit status (matched ${pattern})`);
    }
  }
}

/**
 * The whole policy, asserted against parsed objects.
 *
 * @param {{ packageJson: unknown, workflow: unknown }} input
 */
export function assertRustDomainQualityPolicy({ packageJson, workflow }) {
  if (!packageJson || typeof packageJson !== "object") {
    fail("package.json did not parse into an object");
  }
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== "object") {
    fail("package.json declares no scripts");
  }

  // 1. The unused-dependency command is the pinned nightly cargo-udeps run over
  //    the whole workspace, including test targets.
  const unused = scripts[UNUSED_DEPENDENCY_SCRIPT];
  if (typeof unused !== "string") {
    fail(`package.json declares no "${UNUSED_DEPENDENCY_SCRIPT}" script`);
  }
  for (const fragment of [
    `cargo +${RUST_NIGHTLY_TOOLCHAIN}`,
    "udeps",
    "--manifest-path agent/Cargo.toml",
    "--workspace",
    "--all-targets",
  ]) {
    if (!unused.includes(fragment)) {
      fail(`"${UNUSED_DEPENDENCY_SCRIPT}" must invoke ${fragment}, got: ${unused}`);
    }
  }
  if (unused !== UNUSED_DEPENDENCY_COMMAND) {
    fail(
      `"${UNUSED_DEPENDENCY_SCRIPT}" must be the exact handed-off command\n  expected: ${UNUSED_DEPENDENCY_COMMAND}\n  actual:   ${unused}`,
    );
  }

  // 2. The mutation command is cargo-mutants over the named domain invariants.
  const mutants = scripts[DOMAIN_MUTANTS_SCRIPT];
  if (typeof mutants !== "string") {
    fail(`package.json declares no "${DOMAIN_MUTANTS_SCRIPT}" script`);
  }
  for (const fragment of [
    "cargo mutants",
    "--manifest-path agent/crates/agent-domain/Cargo.toml",
    "-p agent-domain",
    "--timeout 120",
  ]) {
    if (!mutants.includes(fragment)) {
      fail(`"${DOMAIN_MUTANTS_SCRIPT}" must invoke ${fragment}, got: ${mutants}`);
    }
  }
  for (const invariant of DOMAIN_MUTATION_INVARIANTS) {
    if (!mutants.includes(invariant)) {
      fail(`"${DOMAIN_MUTANTS_SCRIPT}" must mutate the ${invariant} invariant`);
    }
  }
  if (mutants !== DOMAIN_MUTANTS_COMMAND) {
    fail(
      `"${DOMAIN_MUTANTS_SCRIPT}" must be the exact handed-off command\n  expected: ${DOMAIN_MUTANTS_COMMAND}\n  actual:   ${mutants}`,
    );
  }

  // 3. Both tools are installed at their pinned versions, and both commands run.
  const steps = stepsOf(workflow);
  const required = [
    {
      where: `the ${CARGO_UDEPS_VERSION} cargo-udeps install step`,
      match: (step) => installsPinnedTool(step, "cargo-udeps", CARGO_UDEPS_VERSION),
    },
    {
      where: `the "${UNUSED_DEPENDENCY_SCRIPT}" gate step`,
      match: (step) => runBody(step).includes(`bun run ${UNUSED_DEPENDENCY_SCRIPT}`),
    },
    {
      where: `the ${CARGO_MUTANTS_VERSION} cargo-mutants install step`,
      match: (step) => installsPinnedTool(step, "cargo-mutants", CARGO_MUTANTS_VERSION),
    },
    {
      where: `the "${DOMAIN_MUTANTS_SCRIPT}" gate step`,
      match: (step) => runBody(step).includes(`bun run ${DOMAIN_MUTANTS_SCRIPT}`),
    },
  ];

  const found = [];
  for (const { where, match } of required) {
    const entry = steps.find(({ step }) => match(step));
    if (!entry) {
      fail(`the validate workflow is missing ${where}`);
    }
    assertStepCannotFailSilently(where, entry);
    found.push({ where, ...entry });
  }

  // 4. The gates are required work: they may not sit behind an advisory job, and
  //    nothing anywhere in the workflow may declare continue-on-error.
  for (const [jobName, job] of jobsOf(workflow)) {
    if (job?.["continue-on-error"]) {
      fail(`job "${jobName}" sets continue-on-error`);
    }
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (step?.["continue-on-error"]) {
        fail(`job "${jobName}" has a step that sets continue-on-error`);
      }
    }
  }

  return {
    unusedDependencyCommand: unused,
    domainMutantsCommand: mutants,
    steps: found.map(({ where, jobName, index }) => ({ where, jobName, index })),
  };
}

// ---------------------------------------------------------------------------
// A compliant in-memory pair. The mutation controls below start from these and
// remove exactly one required fact at a time.
// ---------------------------------------------------------------------------

function compliantPackageJson() {
  return {
    name: "viva",
    scripts: {
      "agent:purity": "scripts/check-agent-domain-purity.sh",
      [UNUSED_DEPENDENCY_SCRIPT]: UNUSED_DEPENDENCY_COMMAND,
      [DOMAIN_MUTANTS_SCRIPT]: DOMAIN_MUTANTS_COMMAND,
    },
    devDependencies: { yaml: "2.8.2" },
  };
}

function compliantWorkflow() {
  return {
    name: "Validate",
    on: { pull_request: null },
    jobs: {
      validate: {
        name: "No-secret validation",
        "runs-on": "ubuntu-latest",
        steps: [
          { name: "Checkout", uses: "actions/checkout@v4" },
          {
            name: "Set up Rust",
            uses: "dtolnay/rust-toolchain@1.94.1",
            with: { components: "rustfmt, clippy" },
          },
          {
            name: "Set up pinned nightly",
            uses: `dtolnay/rust-toolchain@${RUST_NIGHTLY_TOOLCHAIN}`,
          },
          { name: "Validate TypeScript, Rust, and purity gates", run: "bun run validate" },
          {
            name: "Install cargo-udeps",
            run: `cargo install cargo-udeps --version ${CARGO_UDEPS_VERSION} --locked`,
          },
          { name: "Unused dependency gate", run: `bun run ${UNUSED_DEPENDENCY_SCRIPT}` },
          {
            name: "Install cargo-mutants",
            run: `cargo install cargo-mutants --version ${CARGO_MUTANTS_VERSION} --locked`,
          },
          { name: "Focused domain mutation gate", run: `bun run ${DOMAIN_MUTANTS_SCRIPT}` },
        ],
      },
    },
  };
}

function withoutStepMatching(workflow, predicate) {
  const copy = structuredClone(workflow);
  for (const job of Object.values(copy.jobs)) {
    if (Array.isArray(job.steps)) {
      job.steps = job.steps.filter((step) => !predicate(step));
    }
  }
  return copy;
}

function findStep(workflow, predicate) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (predicate(step)) {
        return step;
      }
    }
  }
  throw new Error("fixture is missing the step the mutation targets");
}

const isUdepsInstall = (step) => runBody(step).includes("cargo install cargo-udeps");
const isMutantsInstall = (step) => runBody(step).includes("cargo install cargo-mutants");
const isUdepsRun = (step) => runBody(step).includes(`bun run ${UNUSED_DEPENDENCY_SCRIPT}`);
const isMutantsRun = (step) => runBody(step).includes(`bun run ${DOMAIN_MUTANTS_SCRIPT}`);

// ---------------------------------------------------------------------------
// Fixture-level behavior
// ---------------------------------------------------------------------------

test("accepts a package.json and workflow that carry both required gates", () => {
  const report = assertRustDomainQualityPolicy({
    packageJson: compliantPackageJson(),
    workflow: compliantWorkflow(),
  });

  assert.equal(report.unusedDependencyCommand, UNUSED_DEPENDENCY_COMMAND);
  assert.equal(report.domainMutantsCommand, DOMAIN_MUTANTS_COMMAND);
  assert.equal(report.steps.length, 4);
});

test("pins the tool versions and the invariant list the plan hands to Plan 12", () => {
  assert.equal(RUST_NIGHTLY_TOOLCHAIN, "nightly-2026-04-21");
  assert.equal(CARGO_UDEPS_VERSION, "0.1.60");
  assert.equal(CARGO_MUTANTS_VERSION, "25.3.1");
  assert.equal(DOMAIN_MUTATION_INVARIANTS.length, 27);
  assert.equal(new Set(DOMAIN_MUTATION_INVARIANTS).size, DOMAIN_MUTATION_INVARIANTS.length);
});

// ---------------------------------------------------------------------------
// Mutation controls: remove exactly one required fact and require a rejection.
// ---------------------------------------------------------------------------

test("rejects a package.json missing either command", () => {
  for (const script of [UNUSED_DEPENDENCY_SCRIPT, DOMAIN_MUTANTS_SCRIPT]) {
    const packageJson = compliantPackageJson();
    delete packageJson.scripts[script];
    assert.throws(
      () => assertRustDomainQualityPolicy({ packageJson, workflow: compliantWorkflow() }),
      new RegExp(`declares no "${script}" script`),
    );
  }
});

test("rejects an unused-dependency command that drops its pin or its scope", () => {
  const weakened = {
    "cargo udeps --manifest-path agent/Cargo.toml --workspace --all-targets":
      /must invoke cargo \+nightly-2026-04-21/,
    "cargo +nightly-2026-04-21 udeps --manifest-path agent/Cargo.toml --all-targets":
      /must invoke --workspace/,
    "cargo +nightly-2026-04-21 udeps --manifest-path agent/Cargo.toml --workspace":
      /must invoke --all-targets/,
    "cargo +nightly-2026-04-21 udeps --manifest-path agent/crates/agent-domain/Cargo.toml --workspace --all-targets":
      /must invoke --manifest-path agent\/Cargo\.toml/,
    // Every required fragment is present, so only the exact-command check can
    // catch this one.
    "cargo +nightly-2026-04-21 udeps --workspace --all-targets --manifest-path agent/Cargo.toml --quiet":
      /must be the exact handed-off command/,
  };

  for (const [command, expected] of Object.entries(weakened)) {
    const packageJson = compliantPackageJson();
    packageJson.scripts[UNUSED_DEPENDENCY_SCRIPT] = command;
    assert.throws(
      () => assertRustDomainQualityPolicy({ packageJson, workflow: compliantWorkflow() }),
      expected,
    );
  }
});

test("rejects a mutation command that drops any named domain invariant", () => {
  for (const invariant of DOMAIN_MUTATION_INVARIANTS) {
    const remaining = DOMAIN_MUTATION_INVARIANTS.filter((name) => name !== invariant);
    const packageJson = compliantPackageJson();
    packageJson.scripts[DOMAIN_MUTANTS_SCRIPT] =
      `cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -p agent-domain -F '${remaining.join("|")}' --timeout 120`;

    assert.throws(
      () => assertRustDomainQualityPolicy({ packageJson, workflow: compliantWorkflow() }),
      new RegExp(`must mutate the ${invariant} invariant`),
      `dropping ${invariant} must be rejected`,
    );
  }
});

test("rejects a mutation command that drops its scope or timeout", () => {
  const weakened = {
    "cargo mutants -p agent-domain --timeout 120": /must invoke --manifest-path/,
    [`cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -F '${DOMAIN_MUTATION_INVARIANTS.join("|")}' --timeout 120`]:
      /must invoke -p agent-domain/,
    [`cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -p agent-domain -F '${DOMAIN_MUTATION_INVARIANTS.join("|")}'`]:
      /must invoke --timeout 120/,
  };

  for (const [command, expected] of Object.entries(weakened)) {
    const packageJson = compliantPackageJson();
    packageJson.scripts[DOMAIN_MUTANTS_SCRIPT] = command;
    assert.throws(
      () => assertRustDomainQualityPolicy({ packageJson, workflow: compliantWorkflow() }),
      expected,
    );
  }
});

test("rejects a workflow with either install step removed", () => {
  const cases = [
    [isUdepsInstall, /missing the 0\.1\.60 cargo-udeps install step/],
    [isMutantsInstall, /missing the 25\.3\.1 cargo-mutants install step/],
  ];

  for (const [predicate, expected] of cases) {
    assert.throws(
      () =>
        assertRustDomainQualityPolicy({
          packageJson: compliantPackageJson(),
          workflow: withoutStepMatching(compliantWorkflow(), predicate),
        }),
      expected,
    );
  }
});

test("rejects a workflow with either gate command removed", () => {
  const cases = [
    [isUdepsRun, new RegExp(`missing the "${UNUSED_DEPENDENCY_SCRIPT}" gate step`)],
    [isMutantsRun, new RegExp(`missing the "${DOMAIN_MUTANTS_SCRIPT}" gate step`)],
  ];

  for (const [predicate, expected] of cases) {
    assert.throws(
      () =>
        assertRustDomainQualityPolicy({
          packageJson: compliantPackageJson(),
          workflow: withoutStepMatching(compliantWorkflow(), predicate),
        }),
      expected,
    );
  }
});

test("rejects an install step pinned to a different tool version", () => {
  const workflow = compliantWorkflow();
  findStep(workflow, isUdepsInstall).run = "cargo install cargo-udeps --version 0.1.59 --locked";
  assert.throws(
    () => assertRustDomainQualityPolicy({ packageJson: compliantPackageJson(), workflow }),
    /missing the 0\.1\.60 cargo-udeps install step/,
  );

  const other = compliantWorkflow();
  findStep(other, isMutantsInstall).run = "cargo install cargo-mutants --version 25.3.0 --locked";
  assert.throws(
    () => assertRustDomainQualityPolicy({ packageJson: compliantPackageJson(), workflow: other }),
    /missing the 25\.3\.1 cargo-mutants install step/,
  );
});

test("rejects a gate step whose failure would not block the job", () => {
  for (const predicate of [isUdepsRun, isMutantsRun]) {
    const swallowed = compliantWorkflow();
    findStep(swallowed, predicate).run += " || true";
    assert.throws(
      () =>
        assertRustDomainQualityPolicy({ packageJson: compliantPackageJson(), workflow: swallowed }),
      /swallows the command's exit status/,
    );

    const advisory = compliantWorkflow();
    findStep(advisory, predicate)["continue-on-error"] = true;
    assert.throws(
      () =>
        assertRustDomainQualityPolicy({ packageJson: compliantPackageJson(), workflow: advisory }),
      /continue-on-error/,
    );
  }
});

test("rejects continue-on-error anywhere in the workflow, not only on the gates", () => {
  const workflow = compliantWorkflow();
  workflow.jobs.validate.steps[0]["continue-on-error"] = true;
  assert.throws(
    () => assertRustDomainQualityPolicy({ packageJson: compliantPackageJson(), workflow }),
    /continue-on-error/,
  );

  const advisoryJob = compliantWorkflow();
  advisoryJob.jobs.validate["continue-on-error"] = true;
  assert.throws(
    () =>
      assertRustDomainQualityPolicy({
        packageJson: compliantPackageJson(),
        workflow: advisoryJob,
      }),
    /continue-on-error/,
  );
});

test("a commented-out gate step is not a gate", () => {
  // The parsed-object contract in one case: this workflow mentions both commands
  // in its source text, and a grep would accept it.
  const source = [
    "name: Validate",
    "on:",
    "  pull_request:",
    "jobs:",
    "  validate:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    `      # - name: Install cargo-udeps`,
    `      #   run: cargo install cargo-udeps --version ${CARGO_UDEPS_VERSION} --locked`,
    `      # - name: Unused dependency gate`,
    `      #   run: bun run ${UNUSED_DEPENDENCY_SCRIPT}`,
    "",
  ].join("\n");

  assert.ok(source.includes(`bun run ${UNUSED_DEPENDENCY_SCRIPT}`));
  assert.throws(
    () =>
      assertRustDomainQualityPolicy({
        packageJson: compliantPackageJson(),
        workflow: parse(source),
      }),
    /missing the 0\.1\.60 cargo-udeps install step/,
  );
});

test("fails closed on unparseable owner files", () => {
  assert.throws(
    () => assertRustDomainQualityPolicy({ packageJson: null, workflow: compliantWorkflow() }),
    /package\.json did not parse/,
  );
  assert.throws(
    () => assertRustDomainQualityPolicy({ packageJson: compliantPackageJson(), workflow: null }),
    /did not parse into an object/,
  );
  assert.throws(
    () =>
      assertRustDomainQualityPolicy({
        packageJson: compliantPackageJson(),
        workflow: { name: "Validate" },
      }),
    /declares no jobs/,
  );
});

// ---------------------------------------------------------------------------
// The checked-in tree. This is the assertion that stays RED until Plan 12's
// `12b` node lands the commands and the workflow steps.
//
// MERGE-ORDERING CONSTRAINT — binding, and not enforceable from inside this file.
// Root `test:scripts` globs `scripts/*.test.mjs`, so from the moment this file is
// committed, `bun run validate` is red on whatever tip carries it. Plan 06 Task 7
// Step 5 therefore requires the commit that adds it to land only in the second
// integration PR, "which merges in the same integration wave as `12b` (or later)".
// Merging it into an earlier wave corrupts the Level-1/Level-2 evidence of every
// lane merged in between — the exact harm that step was written to prevent.
//
// The red is a sequencing fact, not a defect in the policy: the 13 fixture and
// mutation-control cases below all pass, and only the checked-in-tree case fails.
// Do not "fix" it by relaxing, skipping, or conditioning the assertions; the only
// correct resolutions are Plan 12 landing the gates, or the coordinator sequencing
// this PR after `12b`.
// ---------------------------------------------------------------------------

test("the checked-in package.json and validate workflow carry both required gates", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(REPO_ROOT, PACKAGE_JSON_RELATIVE_PATH), "utf8"),
  );
  const workflow = parse(
    readFileSync(path.join(REPO_ROOT, VALIDATE_WORKFLOW_RELATIVE_PATH), "utf8"),
  );

  const report = assertRustDomainQualityPolicy({ packageJson, workflow });

  assert.equal(report.steps.length, 4);
});
