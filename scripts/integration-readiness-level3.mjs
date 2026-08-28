// INTEGRATION-005 — Level 3 disposable real-PostgreSQL proof, made mandatory and repeatable.
//
// The tracked half of Task 5. Starting two throwaway PostgreSQL 16 servers and running the
// Plan 09 data and service suites twice is post-freeze work; what lives here is the
// validator that decides whether the result the executor produced actually proves anything.
//
// The property it defends is that the two passes ran against two genuinely different fresh
// servers. Container id, host port, PostgreSQL system identifier and the composite
// `(system_identifier, database name, database OID)` identity must all differ between the
// passes, because every cheap way to fake this proof — reusing a container, reconnecting to
// a surviving database, running the same suite twice against one server — collapses one of
// those four. `DATA_POSTGRES_REQUIRED=1`/`SERVICE_POSTGRES_REQUIRED=1` must be recorded on
// every pass, since without them a missing database silently degrades into a skipped test.
//
// The migration count is DERIVED from the merged migration files and the `MIGRATIONS`
// ledger, never hardcoded: the reviewed chain ended at `0014` and Plan 09 reserved
// `0015`-`0018`, so the validator rejects both a missing reserved migration and an extra
// unledgered file rather than pinning a number that goes stale.
//
// D-04 is recorded as CONFIRM_DELETE, so Plan 09 publishes no restore family: the four
// `postgres_study_set_restore_*` canaries must be ABSENT and their presence is failure.
import path from "node:path";

import {
  check,
  isRecord,
  requireArray,
  requireHex64,
  requireSha,
  requireText,
  sha256,
} from "./integration-readiness-shared.mjs";

export const POSTGRES_PROOF_SCHEMA = "viva.integration_postgres_proof.v1";
export const POSTGRES_IMAGE_REFERENCE =
  "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5";
export const RECORDED_D04 = "CONFIRM_DELETE";
export const RESERVED_MIGRATIONS = Object.freeze(["0015", "0016", "0017", "0018"]);
// Task 5 Step 5's own disposable value, published by the plan and destroyed with the
// container at Step 7. It is a constant rather than a flag because the plan's Step 8
// invocation passes no flag, and a leak gate nobody arms is not a gate.
export const DISPOSABLE_POSTGRES_PASSWORD = "viva_test_only";

/** Task 5 Step 3's exact Plan 09 canary list, in the plan's order. */
export const REQUIRED_POSTGRES_CANARIES = Object.freeze([
  "postgres_selected_d05_policy_removes_exact_canary_fields",
  "postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction",
  "postgres_repeated_delete_is_idempotent_and_content_free",
  "postgres_delete_canary_scan_covers_every_learner_text_table",
  "postgres_delete_serializes_against_every_artifact_writer",
  "postgres_store_conformance_all_owned_ports",
  "postgres_full_migration_chain_runs_from_empty_schema_twice_via_ledger",
  "postgres_upgrade_0014_to_latest_preserves_rows_and_applies_cleanup",
]);

/** Legal only under `D-04 = SOFT_DELETE_UNDO`, which is not the recorded branch. */
export const FORBIDDEN_D04_RESTORE_CANARIES = Object.freeze([
  "postgres_study_set_restore_survives_store_reconstruction",
  "postgres_study_set_restore_is_visible_to_second_instance",
  "postgres_study_set_restore_and_expiry_purge_have_one_legal_winner",
  "postgres_study_set_restore_expired_finalizes_selected_d05_policy_and_canary",
]);

/** The two-instance authorization and concurrency families; a source string is not proof. */
export const REQUIRED_POSTGRES_FAMILIES = Object.freeze([
  "postgres_*_authorization_*",
  "postgres_record_answer_*",
  "postgres_voice_usage_and_*",
]);

export const LEVEL_3_CANARY_KEYS = Object.freeze([
  "application_restart",
  "two_instances",
  "concurrent_replay",
  "deletion_purge",
  "restart_non_resurrection",
  "privacy_schema",
]);

const REQUIRED_ENV = Object.freeze({
  data: "DATA_POSTGRES_REQUIRED=1",
  service: "SERVICE_POSTGRES_REQUIRED=1",
});
const CREDENTIALED_URL = /postgres(?:ql)?:\/\/[^\s/@]+:[^\s/@]+@/;
const LEDGER_ENTRY = /"(\d{4}_[A-Za-z0-9_]+\.sql)"/g;
const LEDGER_DECLARATION = "pub const MIGRATIONS: &[(&str, &str)] = &[";

/**
 * Hashes the `(system_identifier, database name, database OID)` tuple into one composite
 * identity. Two passes against two fresh servers cannot collide; a second suite run against
 * the same server reuses the identity and is refused.
 */
export function deriveDatabaseIdentity({ systemIdentifier, databaseName, databaseOid }) {
  requireText(systemIdentifier, "systemIdentifier");
  requireText(databaseName, "databaseName");
  check(Number.isInteger(databaseOid), "databaseOid must be an integer");
  return {
    database_name_sha256: sha256(databaseName),
    database_oid: databaseOid,
    database_identity_sha256: sha256(`${systemIdentifier}\n${databaseName}\n${databaseOid}`),
  };
}

/**
 * Derives the expected migration chain from the merged `agent/migrations` files and the
 * `MIGRATIONS` ledger in `agent/crates/data/src/migrations.rs`. Neither side may carry an
 * entry the other lacks, and every migration Plan 09 reserved must be present.
 */
export function deriveMigrationChain({ migrationsSource, migrationFiles }) {
  requireText(migrationsSource, "migrationsSource");
  // Scope the parse to the `MIGRATIONS` const itself. The rest of the file is 8,000 lines
  // of tests that also spell migration filenames, and counting those would let a test
  // fixture inflate the expected chain.
  const declaration = migrationsSource.indexOf(LEDGER_DECLARATION);
  check(declaration >= 0, "agent/crates/data/src/migrations.rs declares no MIGRATIONS ledger");
  const start = declaration + LEDGER_DECLARATION.length;
  const end = migrationsSource.indexOf("\n];", start);
  check(end > start, "the MIGRATIONS ledger is not terminated");
  const block = migrationsSource.slice(start, end);
  const ledgerNames = [...new Set([...block.matchAll(LEDGER_ENTRY)].map((m) => m[1]))];
  check(ledgerNames.length > 0, "the MIGRATIONS ledger names no migrations");
  const files = requireArray(migrationFiles, "migrationFiles").filter((n) => n.endsWith(".sql"));
  const fileSet = new Set(files);
  for (const name of ledgerNames) {
    check(fileSet.has(name), `MIGRATIONS names a migration with no file: ${name}`);
  }
  const ledgerSet = new Set(ledgerNames);
  for (const name of files) {
    check(ledgerSet.has(name), `migration file is not in the MIGRATIONS ledger: ${name}`);
  }
  for (const reserved of RESERVED_MIGRATIONS) {
    const present = ledgerNames.some((name) => name.startsWith(`${reserved}_`));
    check(present, `reserved migration is missing from the MIGRATIONS ledger: ${reserved}`);
  }
  return { expected: ledgerNames.length, ledger_names: ledgerNames.sort(), files: files.sort() };
}

// --- Proof validation ---

function validateSuiteDatabase(pass, role, entry) {
  const at = `pass ${pass.pass} ${role} suite`;
  check(isRecord(entry), `${at} record is required`);
  requireHex64(entry.database_name_sha256, `${at} database_name_sha256`);
  requireHex64(entry.database_identity_sha256, `${at} database_identity_sha256`);
  check(Number.isInteger(entry.database_oid), `${at} database_oid must be an integer`);
  const required = entry.required_env === REQUIRED_ENV[role];
  check(required, `${at} must record ${REQUIRED_ENV[role]}; without it a missing database skips`);
  const matched = Number.isInteger(entry.matched_tests) && entry.matched_tests > 0;
  check(matched, `${at} matched zero tests`);
  check(entry.status === "PASS", `${at} did not pass`);
}

function validateSuitePasses(passes) {
  requireArray(passes, "suite_passes");
  check(passes.length === 2, "Level 3 requires exactly two fresh PostgreSQL passes");
  for (const [index, pass] of passes.entries()) {
    check(pass?.pass === index + 1, "suite_passes must be pass 1 then pass 2");
    requireHex64(pass.container_id, `pass ${pass.pass} container_id`);
    check(Number.isInteger(pass.host_port), `pass ${pass.pass} host_port must be an integer`);
    requireText(pass.server_system_identifier, `pass ${pass.pass} server_system_identifier`);
    validateSuiteDatabase(pass, "data", pass.data);
    validateSuiteDatabase(pass, "service", pass.service);
  }
  const [first, second] = passes;
  for (const field of ["container_id", "host_port", "server_system_identifier"]) {
    const shared = first[field] === second[field];
    check(!shared, `both passes recorded the same ${field}; they were not two fresh servers`);
  }
  for (const role of ["data", "service"]) {
    const shared = first[role].database_identity_sha256 === second[role].database_identity_sha256;
    check(!shared, `both passes recorded the same ${role} database_identity_sha256`);
  }
}

function validateCanaries(document) {
  const canaryTests = requireArray(document.canary_tests, "canary_tests");
  const byName = new Map(canaryTests.map((entry) => [entry?.name, entry]));
  for (const name of REQUIRED_POSTGRES_CANARIES) {
    check(byName.has(name), `required Plan 09 canary is missing: ${name}`);
    const matched = byName.get(name).matched;
    const ran = Number.isInteger(matched) && matched > 0;
    check(ran, `required Plan 09 canary matched zero tests: ${name}`);
  }
  for (const name of FORBIDDEN_D04_RESTORE_CANARIES) {
    const present = byName.has(name);
    check(
      !present,
      `D-04 is recorded as ${RECORDED_D04}; the restore canary ${name} must not exist`,
    );
  }
  const families = new Map(
    requireArray(document.test_families, "test_families").map((entry) => [entry?.filter, entry]),
  );
  for (const filter of REQUIRED_POSTGRES_FAMILIES) {
    check(families.has(filter), `required Plan 09 test family is missing: ${filter}`);
    const matched = families.get(filter).matched;
    const ran = Number.isInteger(matched) && matched > 0;
    check(ran, `required Plan 09 test family matched zero tests: ${filter}`);
  }
  const canaries = document.canaries;
  check(isRecord(canaries), "canaries must be an object");
  for (const key of LEVEL_3_CANARY_KEYS) {
    check(Object.hasOwn(canaries, key), `Level 3 canary is missing: ${key}`);
    check(canaries[key] === "PASS", `Level 3 canary did not pass: ${key}`);
  }
  for (const key of Object.keys(canaries)) {
    check(LEVEL_3_CANARY_KEYS.includes(key), `Level 3 canary is unrecorded: ${key}`);
  }
}

function validateMigrationChain(chain, options) {
  check(isRecord(chain), "migration_chain must be an object");
  check(Number.isInteger(chain.expected) && chain.expected > 0, "migration_chain expected");
  check(chain.applied === chain.expected, "migration_chain applied does not equal expected");
  check(chain.all_success === true, "migration_chain all_success must be true");
  check(chain.replay_clean === true, "migration_chain replay_clean must be true");
  if (!options.migrationsSource) return;
  const derived = deriveMigrationChain(options);
  const matches = chain.expected === derived.expected;
  check(matches, "migration_chain expected does not match the merged migration files and ledger");
}

function assertSanitized(document, logs) {
  const rendered = [JSON.stringify(document), ...logs].join("\n");
  const leaked = rendered.includes(DISPOSABLE_POSTGRES_PASSWORD);
  check(!leaked, "Level 3 evidence must never contain the database password");
  const credentialed = CREDENTIALED_URL.test(rendered);
  check(!credentialed, "Level 3 evidence must never contain a credentialed connection string");
}

export function validatePostgresProof(document, options = {}) {
  check(document?.schema === POSTGRES_PROOF_SCHEMA, `schema must be ${POSTGRES_PROOF_SCHEMA}`);
  requireText(document.run_id, "run_id");
  requireSha(document.frozen_sha, "frozen_sha");
  const postgres = document.postgres;
  check(isRecord(postgres), "postgres must be an object");
  check(postgres.major === 16, "PostgreSQL major must be 16");
  requireText(postgres.server_version, "postgres.server_version");
  const pinned = postgres.image_reference === POSTGRES_IMAGE_REFERENCE;
  check(pinned, "postgres.image_reference must be the pinned immutable digest");
  requireText(postgres.image_id, "postgres.image_id");
  validateSuitePasses(document.suite_passes);
  validateMigrationChain(document.migration_chain, options);
  validateCanaries(document);
  check(document.sanitized === true, "Level 3 sanitized must be true");
  assertSanitized(document, options.logs ?? []);
  check(document.status === "PASS", `Level 3 status must be PASS, not ${document.status}`);
  return document;
}

/**
 * Every file the executor left under `--command-log-dir`, walked into subdirectories. Step 1
 * requires that the LOGS never contain the password, and Step 8 passes only this directory —
 * so a validator that reads nothing but `postgres-proof.json` never tests that requirement.
 */
function readCommandLogs(directory, io, depth = 0) {
  check(depth < 8, `the Level 3 command log directory nests too deeply: ${directory}`);
  const logs = [];
  for (const name of [...io.readdirSync(directory)].sort()) {
    const file = path.join(directory, name);
    try {
      logs.push(`${file}\n${io.readFileSync(file, "utf8")}`);
    } catch (error) {
      if (error.code !== "EISDIR") throw error;
      logs.push(...readCommandLogs(file, io, depth + 1));
    }
  }
  return logs;
}

/** `level-3` — Task 5 Step 8. Validates an already-executed proof; starts nothing. */
export function levelThreeCommand(flags, io) {
  const { flag, readFileSync, readJson, writeJson } = io;
  const logDir = flag(flags, "command-log-dir");
  const input = flags.get("input") ?? path.join(logDir, "postgres-proof.json");
  const document = readJson(input);
  const frozenSha = requireSha(flag(flags, "frozen-sha"), "--frozen-sha");
  // The executor's own recorded identities are the evidence; the flags confirm them and
  // never overwrite them, or a proof captured on another tree or image would relabel itself.
  check(
    document.frozen_sha === frozenSha,
    `the recorded Level 3 frozen_sha ${document.frozen_sha} is not --frozen-sha ${frozenSha}`,
  );
  const imageId = flags.get("postgres-image-id");
  check(
    imageId === undefined || document.postgres?.image_id === imageId,
    `the recorded PostgreSQL image id is not --postgres-image-id ${imageId}`,
  );
  const logs = readCommandLogs(logDir, io);
  check(
    logs.length > 0,
    `the Level 3 command log directory is empty: ${logDir}; the sanitization scan would be vacuous`,
  );
  validatePostgresProof(document, {
    logs,
    migrationsSource: readFileSync("agent/crates/data/src/migrations.rs", "utf8"),
    migrationFiles: io.readdirSync("agent/migrations"),
  });
  writeJson(flag(flags, "output"), document);
  process.stdout.write(`Level 3 PASS for ${document.frozen_sha}.\n`);
}
