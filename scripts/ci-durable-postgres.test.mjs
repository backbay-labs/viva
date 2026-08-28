import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * `RELEASE-027`: behavioral tests for `scripts/ci-durable-postgres.sh`.
 *
 * The reviewed durable job ran `cargo test -p data optional_postgres`, which
 * selects zero tests (every `optional_postgres_*` name lives in `agent-service`,
 * not `data`) and still exits 0 — a required proof that proved nothing. Its
 * replacement can only be trusted if the orchestration itself is tested, so
 * every assertion below drives the real script with `pg_isready`, `psql`, and
 * `cargo` replaced by recording stubs. Nothing here contacts a database.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "scripts/ci-durable-postgres.sh");

const DATA_SUITE_LOG = [
  "     Running unittests src/lib.rs (target/debug/deps/data-0000000000000000)",
  "",
  "running 3 tests",
  "test memory::store_conformance::postgres_store_conformance_ingestion ... ok",
  "test migrations::tests::postgres_migrations_apply ... ok",
  "test migrations::tests::postgres_fixture_replay_and_negative_matrix ... ok",
  "",
  "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 68 filtered out; finished in 1.23s",
  "",
].join("\n");

const SERVICE_SUITE_LOG = [
  "     Running unittests src/lib.rs (target/debug/deps/agent_service-0000000000000000)",
  "",
  "running 1 test",
  "test config::postgres_startup_tests::postgres_startup_does_not_resurrect_fixture ... ok",
  "",
  "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 412 filtered out; finished in 0.42s",
  "",
].join("\n");

const ZERO_TEST_LOG = [
  "running 0 tests",
  "",
  "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 71 filtered out; finished in 0.00s",
  "",
].join("\n");

const SKIPPED_LOG = [
  "running 2 tests",
  "test memory::store_conformance::postgres_store_conformance_ingestion ... ok",
  "test migrations::tests::postgres_migrations_apply ... ignored",
  "",
  "test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 69 filtered out; finished in 0.10s",
  "",
].join("\n");

const MISSING_CONFORMANCE_LOG = [
  "running 1 test",
  "test migrations::tests::postgres_migrations_apply ... ok",
  "",
  "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 70 filtered out; finished in 0.11s",
  "",
].join("\n");

const RESTORE_PREFIX_LOG = [
  "running 2 tests",
  "test memory::store_conformance::postgres_store_conformance_ingestion ... ok",
  "test migrations::tests::postgres_study_set_restore_round_trips ... ok",
  "",
  "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 69 filtered out; finished in 0.31s",
  "",
].join("\n");

function writeExecutable(file, body) {
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
}

/**
 * The base utilities the script legitimately calls. The stub directory is the
 * script's ENTIRE PATH, so `omitTools` genuinely removes a tool: with the real
 * PATH still present, dropping the `cargo` stub would silently fall through to
 * the real cargo and the fail-closed prerequisite would never be exercised.
 */
const BASE_UTILITIES = ["mktemp", "mkdir", "sleep", "env", "cat", "grep", "sed", "awk", "cut"];

function resolveUtility(name) {
  const located = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  assert.equal(located.status, 0, `${name} is required to run the durable script tests`);
  return located.stdout.trim();
}

const BASE_UTILITY_PATHS = BASE_UTILITIES.map((name) => [name, resolveUtility(name)]);

/**
 * Builds an isolated PATH entry holding recording stubs for the three external
 * commands the script may call, then runs the script against it.
 */
function runDurableScript({
  readyFailures = 0,
  dataLog = DATA_SUITE_LOG,
  serviceLog = SERVICE_SUITE_LOG,
  dataStatus = 0,
  serviceStatus = 0,
  seedStatus = 0,
  seedTargetPresent = true,
  seedBuildStatus = 0,
  seedMissingTargetName = null,
  psqlStatus = 0,
  omitTools = [],
  env: extraEnv = {},
} = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "viva-durable-postgres-"));
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir);
  for (const [name, target] of BASE_UTILITY_PATHS) {
    symlinkSync(target, path.join(binDir, name));
  }
  const record = path.join(workspace, "record.log");
  const readyCounter = path.join(workspace, "ready.count");
  writeFileSync(record, "", "utf8");
  writeFileSync(readyCounter, "0", "utf8");
  writeFileSync(path.join(workspace, "data.log"), dataLog, "utf8");
  writeFileSync(path.join(workspace, "service.log"), serviceLog, "utf8");

  const recorder = [
    "{",
    '  echo "### $0"',
    '  echo "ARGV: $*"',
    '  echo "DATABASE_URL=${DATABASE_URL-<unset>}"',
    '  echo "DATA_POSTGRES_REQUIRED=${DATA_POSTGRES_REQUIRED-<unset>}"',
    '  echo "SERVICE_POSTGRES_REQUIRED=${SERVICE_POSTGRES_REQUIRED-<unset>}"',
    '  echo "VIVA_ALLOW_LOOPBACK_TEST_SKIP=${VIVA_ALLOW_LOOPBACK_TEST_SKIP-<unset>}"',
    '  echo "VIVA_DEV_FIXTURE_SEED=${VIVA_DEV_FIXTURE_SEED-<unset>}"',
    `} >> "${record}"`,
  ].join("\n");

  if (!omitTools.includes("pg_isready")) {
    writeExecutable(
      path.join(binDir, "pg_isready"),
      [
        "#!/bin/sh",
        recorder,
        `count=$(cat "${readyCounter}")`,
        `echo $((count + 1)) > "${readyCounter}"`,
        `if [ "$count" -lt ${readyFailures} ]; then exit 2; fi`,
        "exit 0",
        "",
      ].join("\n"),
    );
  }

  if (!omitTools.includes("psql")) {
    writeExecutable(
      path.join(binDir, "psql"),
      ["#!/bin/sh", recorder, `exit ${psqlStatus}`, ""].join("\n"),
    );
  }

  if (!omitTools.includes("cargo")) {
    // Real cargo resolves `--bin` before it compiles anything: an unknown target
    // exits non-zero in ~0.2s with a stable diagnostic. `seedTargetPresent:false`
    // reproduces exactly that shape (pinned against real cargo by the last test
    // in this file) so the pending path is driven by cargo's own contract.
    const missingTarget = seedMissingTargetName ?? (extraEnv.VIVA_CI_POSTGRES_SEED_BIN ?? "viva-dev-seed-fixture");
    writeExecutable(
      path.join(binDir, "cargo"),
      [
        "#!/bin/sh",
        recorder,
        'case " $* " in',
        "  *' build '*)",
        ...(seedTargetPresent
          ? [`    exit ${seedBuildStatus}`]
          : [
              `    echo 'error: no bin target named \`${missingTarget}\` in \`agent-service\` package' >&2`,
              "    echo 'help: available bin targets:' >&2",
              "    echo '    agent-service' >&2",
              "    exit 101",
            ]),
        "    ;;",
        "  *' run '*)",
        `    exit ${seedStatus}`,
        "    ;;",
        "  *' -p data '*)",
        `    cat "${path.join(workspace, "data.log")}"`,
        `    exit ${dataStatus}`,
        "    ;;",
        "  *' -p agent-service '*)",
        `    cat "${path.join(workspace, "service.log")}"`,
        `    exit ${serviceStatus}`,
        "    ;;",
        "esac",
        "echo 'unexpected cargo invocation' >&2",
        "exit 99",
        "",
      ].join("\n"),
    );
  }

  const result = spawnSync("/bin/sh", [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: binDir,
      VIVA_ALLOW_LOOPBACK_TEST_SKIP: "1",
      VIVA_CI_POSTGRES_READY_INTERVAL: "0",
      VIVA_CI_POSTGRES_READY_ATTEMPTS: "5",
      VIVA_CI_POSTGRES_LOG_DIR: path.join(workspace, "logs"),
      ...extraEnv,
    },
  });

  const recorded = readFileSync(record, "utf8");
  rmSync(workspace, { force: true, recursive: true });
  return { ...result, recorded, invocations: parseInvocations(recorded) };
}

function parseInvocations(recorded) {
  return recorded
    .split("### ")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const entry = { command: path.basename(lines[0].trim()) };
      for (const line of lines.slice(1)) {
        const separator = line.indexOf("=");
        if (line.startsWith("ARGV: ")) {
          entry.argv = line.slice("ARGV: ".length);
        } else if (separator > 0) {
          entry[line.slice(0, separator)] = line.slice(separator + 1);
        }
      }
      return entry;
    });
}

function cargoInvocations(invocations) {
  return invocations.filter((entry) => entry.command === "cargo");
}

function createdDatabases(invocations) {
  return invocations
    .filter((entry) => entry.command === "psql")
    .flatMap((entry) => [...entry.argv.matchAll(/CREATE DATABASE (\S+)/g)].map((m) => m[1]));
}

test("the durable script waits for PostgreSQL before it creates anything", () => {
  const result = runDurableScript({ readyFailures: 2 });

  assert.equal(result.status, 0, result.stderr);
  const readiness = result.invocations.filter((entry) => entry.command === "pg_isready");
  assert.equal(readiness.length, 3, "the script must retry until PostgreSQL answers");

  const firstPsql = result.invocations.findIndex((entry) => entry.command === "psql");
  const lastReady = result.invocations.map((entry) => entry.command).lastIndexOf("pg_isready");
  assert.ok(firstPsql > lastReady, "no database may be created before PostgreSQL is ready");
});

test("the durable script creates only the two named CI databases", () => {
  const result = runDurableScript();

  assert.equal(result.status, 0, result.stderr);
  const created = createdDatabases(result.invocations);
  assert.ok(created.length > 0, "the script must create its CI databases");
  assert.deepEqual(
    [...new Set(created)].sort(),
    ["viva_data_test", "viva_service_test"],
    "the durable proof owns exactly two disposable databases",
  );
});

test("the durable script clears ambient skip authority for every child it runs", () => {
  const result = runDurableScript();

  assert.equal(result.status, 0, result.stderr);
  const children = result.invocations.filter((entry) => entry.command !== "pg_isready");
  assert.ok(children.length > 0);
  for (const entry of children) {
    assert.equal(
      entry.VIVA_ALLOW_LOOPBACK_TEST_SKIP,
      "<unset>",
      `${entry.command} inherited the ambient loopback skip authority`,
    );
  }
});

test("each required-mode filter runs against its own database with --ignored --test-threads=1", () => {
  const result = runDurableScript();

  assert.equal(result.status, 0, result.stderr);
  const suites = cargoInvocations(result.invocations).filter((entry) =>
    entry.argv.startsWith("test "),
  );
  assert.equal(suites.length, 2, "exactly the data and service durable suites run");

  const [data, service] = suites;

  assert.match(data.argv, /-p data postgres_ -- --ignored --test-threads=1/);
  assert.equal(data.DATA_POSTGRES_REQUIRED, "1");
  assert.equal(data.SERVICE_POSTGRES_REQUIRED, "<unset>");
  assert.match(data.DATABASE_URL, /\/viva_data_test$/);
  assert.ok(!data.DATABASE_URL.includes("viva_service_test"));

  assert.match(service.argv, /-p agent-service postgres_ -- --ignored --test-threads=1/);
  assert.equal(service.SERVICE_POSTGRES_REQUIRED, "1");
  assert.equal(service.DATA_POSTGRES_REQUIRED, "<unset>");
  assert.match(service.DATABASE_URL, /\/viva_service_test$/);
  assert.ok(!service.DATABASE_URL.includes("viva_data_test"));

  for (const suite of suites) {
    assert.ok(!suite.argv.includes("--exact"), "a bare-name --exact filter selects zero tests");
    assert.match(suite.argv, /--manifest-path agent\/Cargo\.toml/);
  }
});

test("the durable script propagates a failing data suite and never reaches the service suite", () => {
  const result = runDurableScript({ dataStatus: 7 });

  assert.notEqual(result.status, 0, "a failing durable suite must fail the job");
  const suites = cargoInvocations(result.invocations).filter((entry) =>
    entry.argv.startsWith("test "),
  );
  assert.equal(suites.length, 1);
  assert.match(suites[0].argv, /-p data /);
});

test("the durable script propagates a failing service suite", () => {
  const result = runDurableScript({ serviceStatus: 3 });

  assert.notEqual(result.status, 0, "a failing durable suite must fail the job");
  assert.match(result.stderr, /agent-service|service/i);
});

test("a zero-test filter fails instead of passing on cargo's exit code", () => {
  const result = runDurableScript({ dataLog: ZERO_TEST_LOG });

  assert.notEqual(result.status, 0, "cargo exits 0 on a zero-test filter; the script must not");
  assert.match(result.stderr, /zero tests/i);
});

test("an optional-database skip inside a required suite fails the durable proof", () => {
  const result = runDurableScript({ dataLog: SKIPPED_LOG });

  assert.notEqual(result.status, 0, "a skipped durable test is not a durable proof");
  assert.match(result.stderr, /ignored|skip/i);
});

test("the data suite must report the focused store-conformance prefix", () => {
  const result = runDurableScript({ dataLog: MISSING_CONFORMANCE_LOG });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /postgres_store_conformance_/);
});

test("under the recorded D-04 CONFIRM_DELETE branch the restore prefix must be absent, not skipped", () => {
  const result = runDurableScript({ dataLog: RESTORE_PREFIX_LOG });

  assert.notEqual(result.status, 0, "CONFIRM_DELETE has no restore path to execute");
  assert.match(result.stderr, /postgres_study_set_restore_/);
});

test("the durable script runs the A-32 fixture-seeding development command and propagates its failure", () => {
  const passing = runDurableScript();
  assert.equal(passing.status, 0, passing.stderr);

  const seed = cargoInvocations(passing.invocations).find((entry) => entry.argv.startsWith("run "));
  assert.ok(seed, "the durable job must exercise the fixture-seeding development command");
  assert.match(seed.argv, /--bin viva-dev-seed-fixture/);
  assert.equal(seed.VIVA_DEV_FIXTURE_SEED, "1");
  assert.match(seed.DATABASE_URL, /\/viva_data_test$/);

  const failing = runDurableScript({ seedStatus: 4 });
  assert.notEqual(failing.status, 0, "a failing fixture seed must fail the job");
  assert.match(failing.stderr, /seed/i);
});

test("the fixture-seeding binary name is parameterized by exactly one environment variable", () => {
  const result = runDurableScript({ env: { VIVA_CI_POSTGRES_SEED_BIN: "viva-alternate-seed" } });

  assert.equal(result.status, 0, result.stderr);
  const cargo = cargoInvocations(result.invocations);
  const seed = cargo.find((entry) => entry.argv.startsWith("run "));
  assert.match(seed.argv, /--bin viva-alternate-seed/);
  const probe = cargo.find((entry) => entry.argv.startsWith("build "));
  assert.match(probe.argv, /--bin viva-alternate-seed/, "the probe resolves the same target");
});

/**
 * `A-32` names the fixture-seeding development command as work for the LANE 08
 * unit; the binary is not on this tree yet. Shipping the step unconditionally
 * made `scripts/ci-durable-postgres.sh` — and therefore the required
 * `durable-postgres` job and the `required-validation` aggregate — red by
 * construction, which is the very class of dead gate `RELEASE-027` exists to
 * remove. The step is now gated on the target actually resolving, and it becomes
 * mandatory automatically the moment lane 08's binary lands: no manual flip, no
 * standing skip.
 */
test("an absent A-32 seed target records a pending obligation instead of failing the durable proof", () => {
  const result = runDurableScript({ seedTargetPresent: false });

  assert.equal(result.status, 0, `an unlanded lane-08 binary must not fail the durable proof\n${result.stderr}`);

  const cargo = cargoInvocations(result.invocations);
  const probe = cargo.find((entry) => entry.argv.startsWith("build "));
  assert.ok(probe, "the script must resolve the seed target before it seeds");
  assert.match(probe.argv, /--bin viva-dev-seed-fixture/);
  assert.equal(
    cargo.some((entry) => entry.argv.startsWith("run ")),
    false,
    "an unresolvable target must never be run",
  );

  // Both required durable suites still ran: the pending seed is additive proof,
  // never a substitute for the two commands Task 17 Step 4 item 3 mandates.
  const suites = cargo.filter((entry) => entry.argv.startsWith("test "));
  assert.equal(suites.length, 2);

  // The obligation is announced, not swallowed, and it names what is missing.
  assert.match(result.stderr, /PENDING/);
  assert.match(result.stderr, /A-32/);
  assert.match(result.stderr, /viva-dev-seed-fixture/);
  assert.match(result.stderr, /VIVA_CI_POSTGRES_SEED_REQUIRED/);
});

test("VIVA_CI_POSTGRES_SEED_REQUIRED=1 refuses the pending path outright", () => {
  const result = runDurableScript({
    seedTargetPresent: false,
    env: { VIVA_CI_POSTGRES_SEED_REQUIRED: "1" },
  });

  assert.notEqual(result.status, 0, "required mode must not accept an unresolvable seed target");
  assert.match(result.stderr, /VIVA_CI_POSTGRES_SEED_REQUIRED/);
  assert.match(result.stderr, /viva-dev-seed-fixture/);
});

/**
 * `VIVA_CI_POSTGRES_SEED_REQUIRED` is the lever Plan 15 sets to hard-assert the
 * landed A-32 end state, and the failure mode of an equality test against the
 * literal `1` is silent and backwards: `true`, `yes`, or `TRUE` would read as
 * "not required" and hand back a green pending run. A refusal lever has to fail
 * closed on anything it does not recognise as off.
 */
test("the seed requirement arms on any truthy spelling and disarms only on recognised off values", () => {
  for (const value of ["1", "true", "TRUE", "True", "yes", "YES", "on", "required", "0.0"]) {
    const result = runDurableScript({
      seedTargetPresent: false,
      env: { VIVA_CI_POSTGRES_SEED_REQUIRED: value },
    });
    assert.notEqual(
      result.status,
      0,
      `VIVA_CI_POSTGRES_SEED_REQUIRED=${value} must refuse the pending path, not fall through it`,
    );
  }

  for (const value of ["", "0", "false", "FALSE", "no", "off"]) {
    const result = runDurableScript({
      seedTargetPresent: false,
      env: { VIVA_CI_POSTGRES_SEED_REQUIRED: value },
    });
    assert.equal(
      result.status,
      0,
      `VIVA_CI_POSTGRES_SEED_REQUIRED=${value} is off and must leave the pending path available`,
    );
    assert.match(result.stderr, /PENDING/);
  }
});

test("a blank or malformed seed-binary override is refused, never silently defaulted", () => {
  // The override is matched against cargo's diagnostic with `grep -F`, so a
  // blank or whitespace value would match EVERY diagnostic line and read any
  // missing target as this binary's absence — a silent downgrade of the whole
  // seeding proof to "pending". Defaulting a set-but-blank override would hide
  // the misconfiguration just as effectively as accepting it.
  for (const value of ["", " ", "\t", "viva seed", "--bin"]) {
    const result = runDurableScript({ env: { VIVA_CI_POSTGRES_SEED_BIN: value } });
    assert.notEqual(
      result.status,
      0,
      `VIVA_CI_POSTGRES_SEED_BIN=${JSON.stringify(value)} must be refused`,
    );
    assert.match(result.stderr, /VIVA_CI_POSTGRES_SEED_BIN/);
  }
});

test("only cargo's target-resolution diagnostic for this exact binary counts as absence", () => {
  // A diagnostic about some other missing target must not be read as "the A-32
  // seeder has not landed"; nor may an ordinary compile failure.
  const otherTarget = runDurableScript({
    seedTargetPresent: false,
    seedMissingTargetName: "viva-some-other-bin",
  });
  assert.notEqual(otherTarget.status, 0, "a diagnostic naming another target is not this absence");

  const compileFailure = runDurableScript({ seedBuildStatus: 2 });
  assert.notEqual(compileFailure.status, 0, "a seed build failure must fail the durable proof");
  assert.match(compileFailure.stderr, /viva-dev-seed-fixture/);
});

test("an absent seed target cannot mask a failing durable suite", () => {
  const result = runDurableScript({ seedTargetPresent: false, serviceStatus: 3 });

  assert.notEqual(result.status, 0, "the pending seed path must not rescue a red suite");
  assert.match(result.stderr, /agent-service|service/i);
});

test("real cargo still emits the target-resolution diagnostic the pending path keys on", () => {
  // The tests above stub `cargo`. This one pins the stub to reality: it asks the
  // REAL cargo for a target that can never exist, so it never compiles or runs
  // anything, and asserts the diagnostic still carries the requested name on the
  // same line as the phrase the script matches. If cargo ever rewords this, the
  // pending path silently becomes unreachable — and this test goes red first.
  const probe = spawnSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      "agent/Cargo.toml",
      "-p",
      "agent-service",
      "--bin",
      "viva-durable-postgres-target-that-cannot-exist",
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, RUSTUP_TOOLCHAIN: "1.94.1" } },
  );

  assert.notEqual(probe.error?.code, "ENOENT", "cargo is a prerequisite for the durable script tests");
  assert.notEqual(probe.status, 0, "an unknown --bin target must not resolve");
  const diagnostic = `${probe.stdout}\n${probe.stderr}`
    .split("\n")
    .find((line) => line.includes("no bin target named"));
  assert.ok(diagnostic, `cargo no longer reports an unknown --bin target the same way:\n${diagnostic}`);
  assert.ok(
    diagnostic.includes("viva-durable-postgres-target-that-cannot-exist"),
    "the diagnostic must name the requested target on the same line",
  );
});

test("a missing external tool fails closed with a named prerequisite", () => {
  for (const tool of ["pg_isready", "psql", "cargo"]) {
    const result = runDurableScript({ omitTools: [tool] });
    assert.notEqual(result.status, 0, `${tool} must be a hard prerequisite`);
    assert.match(result.stderr, new RegExp(tool));
  }
});
