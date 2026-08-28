// INTEGRATION-005 — Level 3 disposable real-PostgreSQL evidence validation.
//
// The tracked half of Task 5: the validator that will accept or refuse the two-container
// proof after the coordinator freezes a SHA. Starting containers and running the suites is
// post-freeze work and is deliberately absent from this file. The negative controls are the
// ones the plan enumerates: two passes that share a container, a port, a server system
// identifier or a composite database identity; a pass missing its mandatory `*_REQUIRED=1`
// environment; a failed first pass; a password reaching the JSON; a missing or zero-match
// canary; and a migration chain that disagrees with the merged files and the `MIGRATIONS`
// ledger. The migration count is DERIVED from the repository, never hardcoded to 18.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveDatabaseIdentity,
  deriveMigrationChain,
  DISPOSABLE_POSTGRES_PASSWORD,
  FORBIDDEN_D04_RESTORE_CANARIES,
  LEVEL_3_CANARY_KEYS,
  levelThreeCommand,
  POSTGRES_IMAGE_REFERENCE,
  POSTGRES_PROOF_SCHEMA,
  REQUIRED_POSTGRES_CANARIES,
  REQUIRED_POSTGRES_FAMILIES,
  RESERVED_MIGRATIONS,
  validatePostgresProof,
} from "./integration-readiness-level3.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN_SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "20260823T180000Z-0123456789ab";
// The plan's own Step 5 disposable value. The validator carries it as a constant so the gate
// fires under the plan's Step 8 invocation instead of waiting for a flag nobody passes.
const PASSWORD = DISPOSABLE_POSTGRES_PASSWORD;
const hex = (length, seed) => createHash("sha256").update(seed).digest("hex").slice(0, length);

const database = (pass, name, oid) => ({
  database_name_sha256: hex(64, name),
  database_oid: oid,
  database_identity_sha256: hex(64, `${pass}-${name}-${oid}`),
  required_env:
    name === "viva_data_test" ? "DATA_POSTGRES_REQUIRED=1" : "SERVICE_POSTGRES_REQUIRED=1",
  matched_tests: 42,
  status: "PASS",
});

const suitePass = (pass) => ({
  pass,
  container_id: hex(64, `container-${pass}`),
  host_port: 55431 + pass,
  server_system_identifier: `74${pass}0000000000000000`,
  data: database(pass, "viva_data_test", 16384),
  service: database(pass, "viva_service_test", 16385),
});

const migrationChain = () => {
  const derived = deriveMigrationChain({
    migrationsSource: readFileSync(
      path.join(repoRoot, "agent/crates/data/src/migrations.rs"),
      "utf8",
    ),
    migrationFiles: readdirSync(path.join(repoRoot, "agent/migrations")),
  });
  return {
    expected: derived.expected,
    applied: derived.expected,
    all_success: true,
    replay_clean: true,
  };
};

const proof = (overrides = {}) => ({
  schema: POSTGRES_PROOF_SCHEMA,
  run_id: RUN_ID,
  frozen_sha: FROZEN_SHA,
  postgres: {
    major: 16,
    server_version: "PostgreSQL 16.4 on aarch64-unknown-linux-gnu",
    image_reference: POSTGRES_IMAGE_REFERENCE,
    image_id: `sha256:${hex(64, "image")}`,
  },
  suite_passes: [suitePass(1), suitePass(2)],
  migration_chain: migrationChain(),
  canary_tests: REQUIRED_POSTGRES_CANARIES.map((name) => ({ name, matched: 1 })),
  test_families: REQUIRED_POSTGRES_FAMILIES.map((filter) => ({ filter, matched: 3 })),
  canaries: Object.fromEntries(LEVEL_3_CANARY_KEYS.map((key) => [key, "PASS"])),
  sanitized: true,
  status: "PASS",
  ...overrides,
});

const validate = (document) => validatePostgresProof(document);
const rejects = (document, message) =>
  assert.throws(
    () => validate(document),
    (error) => error.message.includes(message),
  );
const patched = (patches) => {
  const document = proof();
  for (const [dotted, value] of Object.entries(patches)) {
    const keys = dotted.split(".");
    let cursor = document;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    cursor[keys.at(-1)] = value;
  }
  return document;
};

// --- The contract ---

test("the Level 3 schema, canaries, and image reference are exactly the plan's", () => {
  assert.equal(POSTGRES_PROOF_SCHEMA, "viva.integration_postgres_proof.v1");
  assert.equal(
    POSTGRES_IMAGE_REFERENCE,
    "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5",
  );
  assert.deepEqual(REQUIRED_POSTGRES_CANARIES, [
    "postgres_selected_d05_policy_removes_exact_canary_fields",
    "postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction",
    "postgres_repeated_delete_is_idempotent_and_content_free",
    "postgres_delete_canary_scan_covers_every_learner_text_table",
    "postgres_delete_serializes_against_every_artifact_writer",
    "postgres_store_conformance_all_owned_ports",
    "postgres_full_migration_chain_runs_from_empty_schema_twice_via_ledger",
    "postgres_upgrade_0014_to_latest_preserves_rows_and_applies_cleanup",
  ]);
  assert.deepEqual(REQUIRED_POSTGRES_FAMILIES, [
    "postgres_*_authorization_*",
    "postgres_record_answer_*",
    "postgres_voice_usage_and_*",
  ]);
  assert.deepEqual(LEVEL_3_CANARY_KEYS, [
    "application_restart",
    "two_instances",
    "concurrent_replay",
    "deletion_purge",
    "restart_non_resurrection",
    "privacy_schema",
  ]);
  assert.equal(FORBIDDEN_D04_RESTORE_CANARIES.length, 4);
});

test("a complete two-container proof validates", () => {
  assert.equal(validate(proof()).status, "PASS");
});

// --- Two fresh servers ---

test("equal container ids, ports, system identifiers, or database identities all fail", () => {
  rejects(
    patched({ "suite_passes.1.container_id": proof().suite_passes[0].container_id }),
    "container_id",
  );
  rejects(patched({ "suite_passes.1.host_port": proof().suite_passes[0].host_port }), "host_port");
  rejects(
    patched({
      "suite_passes.1.server_system_identifier": proof().suite_passes[0].server_system_identifier,
    }),
    "server_system_identifier",
  );
  rejects(
    patched({
      "suite_passes.1.data.database_identity_sha256":
        proof().suite_passes[0].data.database_identity_sha256,
    }),
    "database_identity_sha256",
  );
  rejects(
    patched({
      "suite_passes.1.service.database_identity_sha256":
        proof().suite_passes[0].service.database_identity_sha256,
    }),
    "database_identity_sha256",
  );
});

test("a composite database identity is derived from the server, name, and OID", () => {
  const one = deriveDatabaseIdentity({
    systemIdentifier: "7410000000000000000",
    databaseName: "viva_data_test",
    databaseOid: 16384,
  });
  const two = deriveDatabaseIdentity({
    systemIdentifier: "7420000000000000000",
    databaseName: "viva_data_test",
    databaseOid: 16384,
  });
  assert.match(one.database_identity_sha256, /^[0-9a-f]{64}$/);
  assert.equal(one.database_name_sha256, two.database_name_sha256);
  assert.notEqual(one.database_identity_sha256, two.database_identity_sha256);
  assert.equal(one.database_oid, 16384);
});

test("only two passes are legal and both must be present", () => {
  rejects(proof({ suite_passes: [suitePass(1)] }), "exactly two fresh PostgreSQL passes");
  rejects(proof({ suite_passes: [suitePass(1), suitePass(2), suitePass(3)] }), "exactly two");
  rejects(
    proof({ suite_passes: [suitePass(2), suitePass(1)] }),
    "suite_passes must be pass 1 then",
  );
});

test("a missing mandatory required-environment flag fails the pass", () => {
  rejects(patched({ "suite_passes.0.data.required_env": "" }), "DATA_POSTGRES_REQUIRED=1");
  rejects(
    patched({ "suite_passes.1.service.required_env": "SERVICE_POSTGRES_REQUIRED=0" }),
    "SERVICE_POSTGRES_REQUIRED=1",
  );
});

test("a failed first pass prevents a PASS summary", () => {
  rejects(patched({ "suite_passes.0.data.status": "FAIL" }), "pass 1 data suite did not pass");
  rejects(
    patched({ "suite_passes.1.service.status": "FAIL" }),
    "pass 2 service suite did not pass",
  );
  rejects(patched({ "suite_passes.0.data.matched_tests": 0 }), "matched zero tests");
});

// --- Redaction ---

test("neither the JSON nor an attached log may contain the database password", () => {
  // No caller opts in: the gate is armed by default, so the plan's own Step 8 invocation
  // exercises it. A validator that only fires when handed a flag nobody passes is inert.
  rejects(
    proof({ postgres: { ...proof().postgres, server_version: `PostgreSQL 16 ${PASSWORD}` } }),
    "must never contain the database password",
  );
  assert.throws(
    () =>
      validatePostgresProof(proof(), {
        logs: [`connecting to postgresql://viva:${PASSWORD}@127.0.0.1:55432/viva_data_test`],
      }),
    /must never contain the database password/,
  );
  assert.throws(
    () => validatePostgresProof(proof(), { logs: ["postgresql://viva:pw@h/db"] }),
    /must never contain a credentialed connection string/,
  );
  rejects(proof({ sanitized: false }), "sanitized must be true");
});

// --- Canaries and families ---

test("a missing or zero-match canary fails", () => {
  rejects(
    proof({
      canary_tests: REQUIRED_POSTGRES_CANARIES.slice(1).map((name) => ({ name, matched: 1 })),
    }),
    "required Plan 09 canary is missing: postgres_selected_d05_policy_removes_exact_canary_fields",
  );
  rejects(
    proof({
      canary_tests: REQUIRED_POSTGRES_CANARIES.map((name, index) => ({
        name,
        matched: index === 2 ? 0 : 1,
      })),
    }),
    "matched zero tests",
  );
  rejects(
    proof({
      test_families: REQUIRED_POSTGRES_FAMILIES.slice(1).map((filter) => ({ filter, matched: 3 })),
    }),
    "required Plan 09 test family is missing",
  );
  rejects(
    proof({
      test_families: REQUIRED_POSTGRES_FAMILIES.map((filter, index) => ({
        filter,
        matched: index === 1 ? 0 : 3,
      })),
    }),
    "required Plan 09 test family matched zero tests: postgres_record_answer_*",
  );
  rejects(
    proof({ canaries: { ...proof().canaries, deletion_purge: "FAIL" } }),
    "Level 3 canary did not pass: deletion_purge",
  );
  rejects(proof({ canaries: { application_restart: "PASS" } }), "Level 3 canary is missing");
});

test("D-04 CONFIRM_DELETE forbids the restore canary family outright", () => {
  const withRestore = proof();
  withRestore.canary_tests.push({ name: FORBIDDEN_D04_RESTORE_CANARIES[0], matched: 1 });
  rejects(withRestore, "D-04 is recorded as CONFIRM_DELETE");
});

// --- Migration chain ---

test("the migration chain is derived from the merged files and the MIGRATIONS ledger", () => {
  const source = readFileSync(path.join(repoRoot, "agent/crates/data/src/migrations.rs"), "utf8");
  const files = readdirSync(path.join(repoRoot, "agent/migrations"));
  const derived = deriveMigrationChain({ migrationsSource: source, migrationFiles: files });
  assert.equal(derived.expected, derived.ledger_names.length);
  assert.equal(derived.expected > 14, true, "the reviewed chain ended at 0014");
  for (const reserved of RESERVED_MIGRATIONS) {
    assert.ok(
      derived.ledger_names.some((name) => name.startsWith(reserved)),
      `Plan 09 reserved ${reserved} and it must be in the ledger`,
    );
  }
  assert.throws(
    () =>
      deriveMigrationChain({
        migrationsSource: source,
        migrationFiles: [...files, "0099_rogue.sql"],
      }),
    /migration file is not in the MIGRATIONS ledger: 0099_rogue.sql/,
  );
  const withoutFile = files.filter((name) => !name.startsWith("0017"));
  assert.throws(
    () => deriveMigrationChain({ migrationsSource: source, migrationFiles: withoutFile }),
    /MIGRATIONS names a migration with no file: 0017/,
  );
  // Dropping a reserved migration from BOTH sides is the case the count alone cannot see:
  // ledger and files still agree, and only the reserved-range check catches it.
  const trimmed = source.replaceAll('"0018_learning_turn_outcomes.sql"', '"noop_0000.sql"');
  assert.throws(
    () =>
      deriveMigrationChain({
        migrationsSource: trimmed,
        migrationFiles: files.filter((name) => !name.startsWith("0018")),
      }),
    /reserved migration is missing from the MIGRATIONS ledger: 0018/,
  );
  // The parse is scoped to the const: the 8,000 lines of tests below it also spell
  // migration filenames, and counting those would let a fixture inflate the chain.
  const inflated = `${source}\nconst FIXTURE: &str = "0042_not_a_migration.sql";\n`;
  assert.equal(
    deriveMigrationChain({ migrationsSource: inflated, migrationFiles: files }).expected,
    derived.expected,
  );
});

test("a migration count mismatch or an unsuccessful ledger row fails", () => {
  const chain = migrationChain();
  rejects(proof({ migration_chain: { ...chain, applied: chain.expected - 1 } }), "applied");
  rejects(proof({ migration_chain: { ...chain, all_success: false } }), "all_success must be true");
  rejects(
    proof({ migration_chain: { ...chain, replay_clean: false } }),
    "replay_clean must be true",
  );
  const source = readFileSync(path.join(repoRoot, "agent/crates/data/src/migrations.rs"), "utf8");
  const files = readdirSync(path.join(repoRoot, "agent/migrations"));
  // Self-consistent but wrong: expected and applied agree with each other and disagree
  // with the repository, which is exactly the case a hardcoded 18 would have missed.
  const inflated = { ...chain, expected: chain.expected + 1, applied: chain.expected + 1 };
  assert.throws(
    () =>
      validatePostgresProof(proof({ migration_chain: inflated }), {
        migrationsSource: source,
        migrationFiles: files,
      }),
    /migration_chain expected does not match the merged migration files/,
  );
});

// --- Postgres identity ---

const LOG_DIR = `artifacts/integration-readiness/${RUN_ID}/level-3-postgres`;
const MIGRATION_SOURCE = "agent/crates/data/src/migrations.rs";

/**
 * The plan's Step 8 CLI, with the repository reads and the run-scoped command-log directory
 * distinguished by path — the executor passes only `--command-log-dir`, so the sanitization
 * scan has to find the logs itself.
 */
const cliIo = (document, written, logs = { "pass-1-database-identities.tsv": "viva_data_test\t16384\n" }) => {
  const source = readFileSync(path.join(repoRoot, MIGRATION_SOURCE), "utf8");
  const files = readdirSync(path.join(repoRoot, "agent/migrations"));
  return {
    flag: (flags, name) => {
      const value = flags.get(name);
      assert.ok(value !== undefined, `missing --${name}`);
      return value;
    },
    readFileSync: (file) => {
      if (file === MIGRATION_SOURCE) return source;
      const name = path.relative(LOG_DIR, file);
      assert.ok(Object.hasOwn(logs, name), `unexpected read of ${file}`);
      return logs[name];
    },
    readdirSync: (directory) => (directory === LOG_DIR ? Object.keys(logs) : files),
    readJson: () => structuredClone(document),
    writeJson: (file, value) => written.push({ file, value }),
  };
};

const cliFlags = (imageId) =>
  new Map([
    ["command-log-dir", LOG_DIR],
    ["frozen-sha", FROZEN_SHA],
    ["postgres-image-id", imageId],
    ["output", `artifacts/integration-readiness/${RUN_ID}/level-3.json`],
  ]);

test("the level-3 verb confirms the recorded frozen SHA and image id, never relabels them", () => {
  const base = proof();
  const flags = cliFlags(base.postgres.image_id);
  const written = [];
  levelThreeCommand(flags, cliIo(base, written));
  assert.equal(written.at(-1).value.status, "PASS");
  assert.throws(
    () => levelThreeCommand(flags, cliIo(proof({ frozen_sha: "f".repeat(40) }), [])),
    /the recorded Level 3 frozen_sha .* is not --frozen-sha/,
  );
  const wrongImage = proof();
  wrongImage.postgres = { ...wrongImage.postgres, image_id: `sha256:${hex(64, "other-image")}` };
  assert.throws(
    () => levelThreeCommand(flags, cliIo(wrongImage, [])),
    /the recorded PostgreSQL image id is not --postgres-image-id/,
  );
});

test("the level-3 verb scans the command log directory the plan's own invocation names", () => {
  const base = proof();
  const flags = cliFlags(base.postgres.image_id);
  // A password that only ever reached a log file, never the JSON, is still a leak. Before
  // this the CLI read nothing but `postgres-proof.json`, so this log passed unseen.
  assert.throws(
    () =>
      levelThreeCommand(flags, cliIo(base, [], {
        "pass-1-database-identities.tsv": "viva_data_test\t16384\n",
        "data-suite.log": `PGPASSWORD=${PASSWORD} running the data suite\n`,
      })),
    /must never contain the database password/,
  );
  assert.throws(
    () =>
      levelThreeCommand(flags, cliIo(base, [], {
        "service-suite.log": "DATABASE_URL=postgresql://viva:hunter2@127.0.0.1:55433/viva_service_test\n",
      })),
    /must never contain a credentialed connection string/,
  );
  // An empty directory would make the scan vacuously clean, which is not proof of anything.
  assert.throws(
    () => levelThreeCommand(flags, cliIo(base, [], {})),
    /command log directory is empty/,
  );
  // A nested directory is walked, not silently skipped.
  const nested = cliIo(base, [], { "pass-1-database-identities.tsv": "ok\n" });
  const readdir = nested.readdirSync;
  nested.readdirSync = (directory) =>
    directory === LOG_DIR ? ["nested", "pass-1-database-identities.tsv"] : readdir(directory);
  const readFile = nested.readFileSync;
  nested.readFileSync = (file) => {
    if (file === path.join(LOG_DIR, "nested")) {
      throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    }
    if (file === path.join(LOG_DIR, "nested", "deep.log")) return `secret ${PASSWORD}\n`;
    return readFile(file);
  };
  const walk = nested.readdirSync;
  nested.readdirSync = (directory) =>
    directory === path.join(LOG_DIR, "nested") ? ["deep.log"] : walk(directory);
  assert.throws(
    () => levelThreeCommand(flags, nested),
    /must never contain the database password/,
  );
});

test("the server must really be PostgreSQL 16 from the pinned immutable image", () => {
  rejects(patched({ "postgres.major": 15 }), "PostgreSQL major must be 16");
  rejects(
    patched({ "postgres.image_reference": "postgres:16" }),
    "image_reference must be the pinned",
  );
  rejects(patched({ "postgres.image_id": "" }), "image_id");
  rejects(patched({ "postgres.server_version": "" }), "server_version");
  rejects(proof({ frozen_sha: "not-a-sha" }), "frozen_sha");
  rejects(proof({ status: "FAIL" }), "Level 3 status must be PASS");
});
