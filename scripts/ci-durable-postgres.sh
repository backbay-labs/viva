#!/bin/sh
#
# `RELEASE-027` / `DATA-001`: the durable PostgreSQL proof.
#
# The reviewed workflow ran, on `workflow_dispatch` only:
#
#     cargo test --manifest-path agent/Cargo.toml -p data optional_postgres
#     cargo test ... -p agent-service --test voice_ws optional_postgres
#
# The first command selects ZERO tests -- every `optional_postgres_*` name lives
# in `agent-service`, none in `data` -- and cargo exits 0 on a zero-test filter,
# so a required-looking proof proved nothing. The second selected one test that
# returns early when `DATABASE_URL` is unset, and the job additionally exported
# `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1`. Nothing durable was ever asserted.
#
# This script is that proof, and it fails closed at every point the old gate was
# silent: a zero-test filter, a skipped (ignored) test, an optional-database
# early return, a missing focused prefix, a missing external tool, or either
# Cargo command's non-zero status all end the run non-zero.
#
# The real durable suites are `#[ignore]`-gated and require-mode gated, so the
# invocation is the lane-09 harness shape:
#
#     DATA_POSTGRES_REQUIRED=1 DATABASE_URL=.../viva_data_test \
#       cargo test --manifest-path agent/Cargo.toml -p data postgres_ \
#         -- --ignored --test-threads=1 --nocapture
#
# CI may substitute its own disposable PostgreSQL 16 credentials/port through the
# `VIVA_CI_POSTGRES_*` variables below, but neither database name nor either
# required-mode flag is configurable.
#
# `--exact` is deliberately absent: a bare test name with `--exact` matches
# nothing the moment a test is renamed or moved, and still exits 0.
set -eu

# Not configurable: the durable proof owns exactly these two disposable databases.
DATA_DATABASE=viva_data_test
SERVICE_DATABASE=viva_service_test

MANIFEST_PATH=agent/Cargo.toml
TEST_FILTER=postgres_
CONFORMANCE_PREFIX=postgres_store_conformance_
# Recorded decision `D-04 CONFIRM_DELETE`: there is no restore path in this
# tree, so the focused restore prefix must be ABSENT from the executed set --
# absent, not skipped. Under `SOFT_DELETE_UNDO` this constant would become a
# required prefix instead; the selector is recorded, never inferred here.
RESTORE_PREFIX=postgres_study_set_restore_

fail() {
  echo "ci-durable-postgres: $*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "$1 is required for the durable proof but was not found on PATH"
}

require_tool pg_isready
require_tool psql
require_tool cargo

# The durable proof is exactly where an ambient skip authority would turn a
# required suite into a silent no-op, so it is cleared before anything runs and
# again for every child below.
unset VIVA_ALLOW_LOOPBACK_TEST_SKIP

postgres_host=${VIVA_CI_POSTGRES_HOST:-127.0.0.1}
postgres_port=${VIVA_CI_POSTGRES_PORT:-5432}
postgres_user=${VIVA_CI_POSTGRES_USER:-postgres}
postgres_password=${VIVA_CI_POSTGRES_PASSWORD:-postgres}
admin_database=${VIVA_CI_POSTGRES_ADMIN_DB:-postgres}
ready_attempts=${VIVA_CI_POSTGRES_READY_ATTEMPTS:-60}
ready_interval=${VIVA_CI_POSTGRES_READY_INTERVAL:-1}
log_dir=${VIVA_CI_POSTGRES_LOG_DIR:-}

# `A-32` / `SERVICE-013`: the fixture-seeding DEVELOPMENT command, named by the
# single variable that parameterizes it. Plan 08 lands the binary; its documented
# invocation is `VIVA_DEV_FIXTURE_SEED=1 DATABASE_URL=... cargo run -p
# agent-service --bin viva-dev-seed-fixture`.
#
# A-32 is recorded on `origin/review-remediation/integration` in
# `docs/decisions/2026-08-23-plan-amendments.md` (section "A-32 (2026-08-27)").
# This worktree's copy of that file predates the amendment by two sections, so
# grepping the tree alone will not find it.
#
# The seeder is LANE 08's deliverable and is not on this tree. The step is
# therefore gated on the target actually resolving: an unlanded binary records a
# pending obligation, while every other outcome — a build failure, a seeding
# failure, or a diagnostic about some other target — fails the durable proof.
# Nothing has to be flipped when lane 08 lands: the moment `--bin` resolves, the
# seed runs and is fail-closed. `VIVA_CI_POSTGRES_SEED_REQUIRED=1` refuses the
# pending path outright, which is how Plan 15 asserts the landed end state.
# Unset takes the default; SET-but-blank is a configuration error, not a silent
# fallback. The name is matched against cargo's own diagnostic with `grep -F`, so
# a blank or whitespace override would match every diagnostic line and downgrade
# the whole seeding proof to "pending" without anyone noticing.
seed_binary=${VIVA_CI_POSTGRES_SEED_BIN-viva-dev-seed-fixture}
case "$seed_binary" in
  '' | [!A-Za-z0-9]* | *[!A-Za-z0-9_.-]*)
    fail "VIVA_CI_POSTGRES_SEED_BIN must be a cargo target name; got '${seed_binary}'"
    ;;
esac

# The requirement lever fails CLOSED: only these exact spellings turn it off, and
# anything else -- `true`, `yes`, `on`, or a typo -- arms it. An equality test
# against the literal `1` would read `VIVA_CI_POSTGRES_SEED_REQUIRED=true` as
# "not required" and hand back a green pending run, which is the opposite of what
# the variable is for.
seed_required=1
case "${VIVA_CI_POSTGRES_SEED_REQUIRED:-}" in
  '' | 0 | [fF][aA][lL][sS][eE] | [nN][oO] | [oO][fF][fF]) seed_required=0 ;;
esac

if [ -z "$log_dir" ]; then
  log_dir=$(mktemp -d)
fi
mkdir -p "$log_dir"

export PGPASSWORD="$postgres_password"

echo "ci-durable-postgres: waiting for PostgreSQL at ${postgres_host}:${postgres_port}"
ready_attempt=1
while :; do
  if pg_isready --host "$postgres_host" --port "$postgres_port" \
    --username "$postgres_user" >/dev/null 2>&1; then
    break
  fi
  if [ "$ready_attempt" -ge "$ready_attempts" ]; then
    fail "PostgreSQL at ${postgres_host}:${postgres_port} was not ready after ${ready_attempts} attempts"
  fi
  ready_attempt=$((ready_attempt + 1))
  sleep "$ready_interval"
done

admin_statement() {
  psql --host "$postgres_host" --port "$postgres_port" --username "$postgres_user" \
    --dbname "$admin_database" --no-password --quiet \
    --set ON_ERROR_STOP=1 --command "$1" >/dev/null ||
    fail "administrative statement failed: $1"
}

recreate_database() {
  admin_statement "DROP DATABASE IF EXISTS $1"
  admin_statement "CREATE DATABASE $1"
}

database_url() {
  printf 'postgresql://%s:%s@%s:%s/%s' \
    "$postgres_user" "$postgres_password" "$postgres_host" "$postgres_port" "$1"
}

# Sums every libtest summary line in a captured log. Multiple test targets each
# print their own summary, so a single-target parse would miss the rest.
summarize_log() {
  awk '
    /^test result:/ {
      for (i = 1; i < NF; i++) {
        if ($(i + 1) == "passed;")  passed  += $i
        if ($(i + 1) == "failed;")  failed  += $i
        if ($(i + 1) == "ignored;") ignored += $i
      }
      summaries++
    }
    END { printf "%d %d %d %d", summaries + 0, passed + 0, failed + 0, ignored + 0 }
  ' "$1"
}

# libtest writes `test <name> ... ` at the start of a line even under
# `--nocapture`, where the trailing `ok` may share the line with test output.
executed_test_names() {
  sed -n 's/^test \([^ ][^ ]*\) \.\.\..*/\1/p' "$1"
}

run_durable_suite() {
  suite_label=$1
  suite_package=$2
  suite_required_variable=$3
  suite_database=$4
  suite_log="$log_dir/${suite_label}.log"

  echo "ci-durable-postgres: ${suite_label} durable suite against ${suite_database}"
  suite_status=0
  env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
    "${suite_required_variable}=1" \
    "DATABASE_URL=$(database_url "$suite_database")" \
    cargo test --manifest-path "$MANIFEST_PATH" -p "$suite_package" "$TEST_FILTER" \
    -- --ignored --test-threads=1 --nocapture >"$suite_log" 2>&1 || suite_status=$?
  cat "$suite_log"

  [ "$suite_status" -eq 0 ] ||
    fail "${suite_label} durable suite (-p ${suite_package}) failed with status ${suite_status}"

  suite_summary=$(summarize_log "$suite_log")
  suite_summaries=$(echo "$suite_summary" | cut -d' ' -f1)
  suite_passed=$(echo "$suite_summary" | cut -d' ' -f2)
  suite_failed=$(echo "$suite_summary" | cut -d' ' -f3)
  suite_ignored=$(echo "$suite_summary" | cut -d' ' -f4)

  [ "$suite_summaries" -gt 0 ] ||
    fail "${suite_label} durable suite printed no cargo test summary"
  [ "$suite_passed" -gt 0 ] ||
    fail "${suite_label} durable suite matched zero tests; a zero-test filter is not a durable proof"
  [ "$suite_failed" -eq 0 ] ||
    fail "${suite_label} durable suite reported ${suite_failed} failed tests"
  [ "$suite_ignored" -eq 0 ] ||
    fail "${suite_label} durable suite reported ${suite_ignored} ignored tests; a skipped durable proof is not a proof"

  if grep -q 'optional_postgres' "$suite_log"; then
    fail "${suite_label} durable suite executed an optional-database test instead of the required-mode suite"
  fi
  if grep -q 'POSTGRES_REQUIRED' "$suite_log"; then
    fail "${suite_label} durable suite reported an optional-database skip"
  fi
}

recreate_database "$DATA_DATABASE"
recreate_database "$SERVICE_DATABASE"

run_durable_suite data data DATA_POSTGRES_REQUIRED "$DATA_DATABASE"

data_names=$(executed_test_names "$log_dir/data.log")
echo "$data_names" | grep -q "$CONFORMANCE_PREFIX" ||
  fail "the data durable suite never executed the focused ${CONFORMANCE_PREFIX} prefix"
if echo "$data_names" | grep -q "$RESTORE_PREFIX"; then
  fail "the recorded D-04 CONFIRM_DELETE branch has no restore path, yet ${RESTORE_PREFIX} executed"
fi

run_durable_suite service agent-service SERVICE_POSTGRES_REQUIRED "$SERVICE_DATABASE"

# `A-32`/`SERVICE-013`: prove the fixture-seeding development command itself
# works against real PostgreSQL 16. It runs last, into a freshly recreated data
# database, so it can neither perturb nor be perturbed by either required suite.
#
# Cargo resolves `--bin` before it compiles anything, so the build below is the
# target-resolution probe as well as the compile the seed run needs: an unknown
# target costs a fraction of a second and never touches a database.
echo "ci-durable-postgres: resolving the fixture-seeding development command (${seed_binary})"
seed_build_log="$log_dir/seed-build.log"
seed_build_status=0
cargo build --manifest-path "$MANIFEST_PATH" -p agent-service \
  --bin "$seed_binary" >"$seed_build_log" 2>&1 || seed_build_status=$?
cat "$seed_build_log"

# Only cargo's own target-resolution diagnostic FOR THIS BINARY counts as "not
# landed yet". A diagnostic naming a different target, or any other non-zero
# status, is a real failure.
seed_target_missing=0
if [ "$seed_build_status" -ne 0 ] &&
  grep -F 'no bin target named' "$seed_build_log" | grep -qF "$seed_binary"; then
  seed_target_missing=1
fi

if [ "$seed_target_missing" -eq 1 ]; then
  [ "$seed_required" -eq 0 ] ||
    fail "VIVA_CI_POSTGRES_SEED_REQUIRED is set, but the A-32 fixture-seeding development command (${seed_binary}) does not resolve"
  echo "ci-durable-postgres: PENDING A-32 — the fixture-seeding development command (${seed_binary}) is lane 08's deliverable and has not landed on this tree; it seeds automatically once --bin resolves. Set VIVA_CI_POSTGRES_SEED_REQUIRED=1 to refuse this pending state." >&2
else
  [ "$seed_build_status" -eq 0 ] ||
    fail "building the A-32 fixture-seeding development command (${seed_binary}) failed with status ${seed_build_status}"

  echo "ci-durable-postgres: fixture-seeding development command (${seed_binary})"
  recreate_database "$DATA_DATABASE"
  seed_log="$log_dir/seed.log"
  seed_status=0
  env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
    VIVA_DEV_FIXTURE_SEED=1 \
    "DATABASE_URL=$(database_url "$DATA_DATABASE")" \
    cargo run --manifest-path "$MANIFEST_PATH" -p agent-service \
    --bin "$seed_binary" >"$seed_log" 2>&1 || seed_status=$?
  cat "$seed_log"
  [ "$seed_status" -eq 0 ] ||
    fail "the A-32 fixture-seeding development command (${seed_binary}) failed with status ${seed_status}"
fi

echo "ci-durable-postgres: durable PostgreSQL proof complete"
