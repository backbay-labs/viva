# Persistence, Postgres, and Privacy Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Viva's in-memory and Postgres stores behaviorally equivalent, replay-safe, restart-safe, deletion-safe, and continuously proven against a real disposable Postgres 16 instance, while making observe evidence sanitized by construction.

**Architecture:** `StudyMemoryStore` remains the only persistence port. Plan 04 owns the canonical learning types and authenticated study projection; Plan 06 owns port outcomes and error taxonomy. This lane implements those published contracts in `memory.rs` and `postgres.rs`, persists durable authorization digests and canonical learning records through the only new SQL migrations, serializes every learner-data mutation against deletion, and replaces process-local or untyped state with typed, tested behavior. The Postgres proof uses a required `DATABASE_URL`, one isolated schema per test, and two complete fresh-container runs; absence of Postgres is explicit failure for the durable command, never a passing skip.

**Tech Stack:** Rust 1.94.1, Tokio, SQLx 0.8, PostgreSQL 16, serde/serde_json, SHA-256, Docker, Cargo.

**Spec:** Program Plan 09 implements `DATA-001` through `DATA-016` from the review-remediation program and the cited review inputs below, while consuming the published Plan 04 and Plan 06 contracts verbatim.

- `docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md`
- `docs/superpowers/plans/2026-08-23-expedited-critical-path.md` (first-merged selected D-01 v1 persistence seam)
- `docs/superpowers/plans/2026-08-23-learning-core-authority.md` (Plan 04 contract producer)
- `docs/superpowers/plans/2026-08-23-rust-domain-integrity.md` (Plan 06 contract producer)
- `docs/superpowers/reviews/2026-08-23-rust-data-observe.md`
- `docs/superpowers/reviews/2026-08-23-security.md`
- `docs/superpowers/reviews/2026-08-23-security-review.md`
- `docs/superpowers/reviews/2026-08-23-correctness-review.md`
- `docs/superpowers/reviews/2026-08-23-quality-and-tests-review.md`
- `docs/superpowers/reviews/2026-08-23-project-state.md`
- `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`
- `docs/superpowers/reviews/index.md`

---

## Global Constraints

### Ownership, coverage, and non-negotiable boundaries

This is program Plan 09 on branch `review-remediation/09-data-privacy`.

**Exclusive production ownership after the expedited critical-path merge:**

- `agent/crates/data/src/postgres.rs`
- `agent/crates/data/src/postgres/**`
- `agent/crates/data/src/memory.rs`
- `agent/crates/data/src/memory/**`
- `agent/crates/data/src/migrations.rs`
- `agent/migrations/**`
- `agent/crates/observe/**`

The expedited critical path is the sole earlier exception: it merges the selected D-01 v1 seam and migration `0015`, then relinquishes these data files. After that merge, Plan 09 is the sole migration-number allocator. It does not edit Plan 04 domain/core types, Plan 06 domain ports, Plan 08 service startup, Plan 11 deletion UI/API copy, Plan 12 CI, or Plan 15 public governance documentation. Those owners consume the handoffs defined below.

| Canonical ID | Required result |
| --- | --- |
| `DATA-001` | Isolated, required Postgres 16 tests cannot collide through the sqlx ledger or shared fixtures. |
| `DATA-002` | Concurrent envelope/evaluation writes converge idempotently without a duplicate-key adapter error. |
| `DATA-003` | Replaying an open session returns `IdempotentReplay`, leaves one row, and increments no count. |
| `DATA-004` | The selected `D-05 DATA_RETENTION` branch is enforced row-by-row, across restart, seed replay, export/read projection, and deletion races. |
| `DATA-005` | Evaluation, concept-status, and recap authorization digests survive process restart and work across two store instances without a process-local vector. |
| `DATA-006` | Unicode cannot split a forbidden marker that the ASCII filter later reassembles. |
| `DATA-007` | Public construction and JSON deserialization cannot create an unsanitized `VoiceEvidenceEvent`. |
| `DATA-008` | Nonces remain through token validity plus the published 60-second skew, then are pruned in both backends without weakening live replay rejection. |
| `DATA-009` | Migration chain removes the superseded recap payload index and proves a large valid recap is accepted. |
| `DATA-010` | Usage insertion and session/study deletion serialize on the session row; final deleted state contains no usage row. |
| `DATA-011` | Both backends return Plan 04's `AuthenticatedStudyProjectionV1` and identical deterministic recency ordering. |
| `DATA-012` | Every in-memory check-and-mutate path uses one write lock; close/start cannot reopen a closed session. |
| `DATA-013` | Every proven-unwritten `answer_attempts` column is dropped unless an already-published Plan 04/06 typed writer and durable test justify that specific field. |
| `DATA-014` | `COR-04` PDF uploads fail closed with typed `InvalidInput`/`unsupported_pdf` evidence until real bounded page-aware extraction exists; no PDF byte path reaches lossy UTF-8 normalization or persists learning artifacts. |
| `DATA-015` | `ARC-05`/`QLT-09`/`REL-07` store concentration is reduced behind a shared memory/Postgres conformance suite and invariant-owned ingestion, learning, authorization, and privacy modules without semantic drift. |
| `DATA-016` | If D-04 selects bounded undo, study-set/session deletion, restore, expiry purge, replay, restart, and two-instance races obey one durable 30-second server-time contract and then finalize through selected D-05 semantics. |

This plan also owns the data-side closure for `COR-03`/`SEC-03` (fixture seeding cannot resurrect deleted material), `COR-04` (PDF ingestion fails closed), `QLT-03` (Postgres proof is mandatory rather than silently skipped), `ARC-05`/`QLT-09`/`REL-07` (store decomposition after characterization), the data portion of Plan 04's atomic `TurnOutcome` persistence, and Plan 06's `StudyStoreWriteOutcome`, `StudyStoreWriteCounts.voice_usage`, and structured `PortErrorKind` contracts.

### Contract dependencies

Do not begin contract-dependent GREEN work until the producer commit is merged into `review-remediation/integration` and this branch is rebased.

Plan 04 produces these canonical inputs; Plan 09 must not create parallel versions:

```rust
async fn record_turn_outcome(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    outcome: TurnOutcome,
) -> Result<PersistedTurnOutcome, PortError>

async fn session_learning_evidence(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<SessionLearningEvidence, PortError>

async fn record_challenge_resolution(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    resolution: ChallengeResolution,
) -> Result<ChallengeResolution, PortError>

async fn select_next_question(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    policy: ProgressionPolicyId,
) -> Result<QuestionProgressionResult, PortError>

async fn authenticated_study_projection(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<AuthenticatedStudyProjectionV1, PortError>
```

The final Plan 04 serde contract is exact:

```rust
CriterionAssessment {
    criterion_id: String,
    assessment: CriterionAssessmentKind, // satisfied | contradicted | not_demonstrated
    confidence: f32,
}

ConceptStatusTransition {
    concept_id: String,
    from_status: ConceptStatus,
    to_status: ConceptStatus,
    criterion_ids: Vec<String>,
}

QuestionDisposition::Advance
QuestionDisposition::RetryCurrent
QuestionDisposition::Deferred

TurnResolution::Evaluated {
    label: String,
    confidence: f32,
    assessments: Vec<CriterionAssessment>,
    concept_transitions: Vec<ConceptStatusTransition>,
    concise_feedback: String,
    retry_prompt: Option<String>,
    disposition: QuestionDisposition,
}

TurnResolution::Deferred {
    reason: EvaluationDeferralReason,
    can_retry_same_question: bool,
    disposition: QuestionDisposition,
}

TurnOutcome {
    schema: "viva.turn_outcome.v1",
    response_id: String,
    question_id: String,
    rubric_policy_version: String,
    recorded_at: RFC3339 UTC,
    source_ids: Vec<String>,
    supersedes_response_id: Option<String>,
    resolution: TurnResolution,
}
```

`TurnResolution` is internally tagged with JSON field `kind`, whose only values are `evaluated` and `deferred`; there is no `resolution` discriminator inside the resolution object. `SessionLearningEvidence` contains exact `user_id`, `study_set_id`, `voice_session_id`, ordered `outcomes`, `concept_labels: Vec<{ concept_id, label }>`, and `review_decisions: Vec<{ concept_id, due_at, authority }>`. Review authority is exactly `server_persisted_fsrs` or `core_fsrs_read_time`. No answer text is present in any canonical persistence type.

`PersistedTurnOutcome` contains exactly `{ turn_outcome: TurnOutcome, record: TurnOutcomeRecordReceipt }`. The receipt has schema `viva.turn_outcome_record.v1`, copies the validated `response_id`, and sets `replayed` from actual insert versus identical idempotent replay truth; data never fabricates that bit from caller input or prose.

`ChallengeResolution` is the exact Plan 04 type with schema `viva.challenge_resolution.v1`, `correction_id`, `challenged_response_id`, canonical `source_id`, `disposition: ChallengeDisposition::{SourceConfirmed, ReevaluationRequired, Deferred}`, and optional `replacement_response_id`. Data persists that type verbatim; it does not create a second challenge model.

Plan 04 also owns the progression cursor/result types, `AuthenticatedStudyProjectionV1`, and the fixtures under `agent/fixtures/learning-core/*.json`. For `D-01`, the only allowed types are:

- Branch A: `PersistedFsrsCardV1` plus `ReviewScheduleDecisionV1`.
- Branch B: `ReviewHistoryEventV1` plus non-persisted `ReadTimeReviewProjectionV1`.

The expedited critical-path plan merges first and creates exactly one selected D-01 v1 migration at `0015`: `0015_review_schedule_decisions_v1.sql` for Branch A or `0015_review_history_events_v1.sql` for Branch B. Plan 09 rebases on that merge, consumes and transactionally extends its published Rust/store seam, and must not create a second schedule/history table, rename the selected v1 schema, or reinterpret historical v1 rows.

Plan 06 produces these canonical data-facing contracts:

```rust
#[must_use]
enum StudyStoreWriteOutcome {
    Inserted,
    IdempotentReplay,
}

async fn record_voice_session(&self, config: &SessionConfig)
    -> Result<StudyStoreWriteOutcome, PortError>

async fn record_voice_usage(&self, event: VoiceUsageRecord)
    -> Result<StudyStoreWriteOutcome, PortError>
```

`StudyStoreWriteCounts` gains `voice_usage`. Session writes can return either outcome; accepted usage records have no stable event identity and therefore always return `Inserted` and increment `voice_usage` exactly once. Plan 09 must not report a usage replay that it cannot identify. SQL/pool failures map to `PortErrorKind::Durability`, duplicate nonce claims map to `Conflict`, malformed input maps to `InvalidInput`, and no truth-bearing method returns an `Ok(default)` fallback.

### Hard decision checkpoints

`D-01 SCHEDULING_AUTHORITY_EXAM` blocks only the selected schedule-storage task. `D-05 DATA_RETENTION` and `D-04 DELETION_UX` block deletion GREEN code. Characterization tests, branch-neutral tombstone schema, atomicity, sanitation, and the Postgres harness may proceed while those decisions remain open.

No worker selects a product/policy branch. The coordinator records Connor's selection in the central coverage ledger before production code for that branch is written.

#### `D-04 DELETION_UX` data alternatives

- Branch A `CONFIRM_DELETE`: Task 10 is skipped. After explicit confirmation owned by the frontend/API lanes, Task 9 immediately finalizes the selected D-05 policy.
- Branch B `SOFT_DELETE_UNDO`: Task 10 marks the study set inaccessible and supplies authoritative restore; its expiry path invokes Task 9's permanent D-05 finalizer. The server window is exactly 30 seconds: restore is legal only while `database_now < undo_expires_at`; equality is expired. No client clock or retry extends the deadline.

#### `D-05 DATA_RETENTION` executable alternatives

| Branch | Required database result after study-set deletion | Export/read result | Governance statement |
| --- | --- | --- | --- |
| A — `HARD_PURGE_TEXT` | Hard-delete documents, spans, concepts, questions, outcomes, schedule state/history, recaps, review rows, answer attempts, status events, authorization digests, usage, and nonces. Retain only the `study_sets` row scrubbed to a constant title with `deleted_at`, and content-free deleted `voice_sessions` tombstones. | No active/authenticated/library projection contains the set, session artifacts, learner-authored text, learner-derived text, or the canary. The deletion response reports policy `hard_purge_text`; a privacy export returns only the content-free tombstone identifiers, timestamps, and constants enumerated below. | Deletion permanently removes learner-authored and learner-derived text; only content-free idempotency/audit tombstones remain. |
| B — `ENUMERATED_DERIVED_RETENTION` | Hard-delete documents/spans and all session artifacts. Scrub set title/course/exam/error. Of authored/derived fields, retain only `concepts.public_id`, `concepts.label`, `concepts.status`, `study_questions.question_id`, `study_questions.prompt`, `study_questions.expected_terms`, and `study_questions.follow_up`; source links become `NULL`, questions become inactive, and every other authored/derived field is removed. Required content-free relational metadata also remains: concept `id`, `study_set_id`, `updated_at`; question `id`, `study_set_id`, `active = false`, `created_at`. The enumerated fields remain indefinitely after learner deletion unless a later, separately approved administrative-purge policy removes them. | Ordinary/authenticated/library projections exclude the deleted set. The deletion response reports policy `enumerated_derived_retention` and the exact seven retained authored/derived column names. A privacy export includes those retained values under `retained_after_deletion`; no verbatim source, document name, session-derived record, digest, or canary outside those enumerated derived columns remains. | Deletion removes source and session data but indefinitely retains the named generated concept/question fields; the policy must state that this is retention, not purge. |

Both branches retain the deleted set/session tombstones only to keep repeated delete calls idempotent and to prevent fixture seeding or reconnects from recreating data. The scrubbed `study_sets` tombstone contains only `id`, `user_id`, constant title `[deleted]`, `created_at`, `updated_at`, `deleted_at`, constant ingestion status `deleted`, and — only when D-04 selects `SOFT_DELETE_UNDO` — the content-free `deletion_id` UUID linking the tombstone to its deletion operation; nullable course, exam, and error fields are `NULL`. A deleted `voice_sessions` tombstone contains only `id`, `user_id`, `study_set_id`, constant mode/status/terminal reason `deleted`, and `started_at`/first `ended_at`. These IDs, timestamps, and constants are content-free idempotency/audit metadata. Neither branch permits `source_spans.excerpt`, document display names, study-set title/course, recap arrays, answer-evaluation labels, or authorization digests to survive deletion.

Under D-04 `SOFT_DELETE_UNDO`, “after deletion” and the permanent governance result in this D-05 table mean after the exact 30-second undo interval expires and the D-05 finalizer commits. During the pending interval, the original rows remain inaccessible and excluded from every export/read projection solely to permit authoritative restore; the only new row is the content-free deletion operation. A successful restore before expiry cancels finalization. Equality with `undo_expires_at` is expired, and no client clock or retry extends the pending retention interval.

#### `DATA-SCHEMA-UNWRITTEN` deterministic rule

This is an implementation precondition, not decision `D-09` and not worker discretion. `D-09` is reserved for `STRUCTURED_PREVIEW_EVIDENCE`.

Before migration `0017`, prove field-by-field whether production Rust binds each column. The deterministic default is to drop it:

| `answer_attempts` column | Current source evidence | Default |
| --- | --- | --- |
| `provider_attempt_id` | Added by 0011; neither INSERT/UPDATE binds it. | Drop. |
| `terminal_reason` | Added by 0011; terminal reason is carried through sanitized evidence/session state, not this table. | Drop. |
| `failure_class` | Added by 0011; failure class is carried through sanitized evidence, not this table. | Drop. |
| `stage` | Added by 0011; stage is carried through sanitized evidence, not this table. | Drop. |
| `retry_eligible` | Added by 0011; retry eligibility is carried through sanitized evidence, not this table. | Drop. |
| `concept_id` | Added by 0001; neither answer-attempt writer binds it. | Drop. |

A field may be retained only if Plan 04 or Plan 06 has already merged a typed writer for that exact field and Plan 09 adds a real Postgres insert/read/replay/deletion test for it before creating `0017`. A prose intention, evidence field with the same name, or future consumer is insufficient.

### Migration allocation

Before Plan 09 executes, the rebased chain must end at exactly one selected D-01 migration numbered `0015`. Task 2 reports the selected `0015` filename and current maximum to the integration coordinator, who records them in the central ledger; Plan 09 then reserves every subsequent number. If the rebased maximum is not `0015`, stop before creating a migration and amend this allocation through the coordinator; workers do not guess or renumber around an unrecorded file.

| Number | Filename | Purpose |
| ---: | --- | --- |
| `0015` | Upstream selected `0015_review_schedule_decisions_v1.sql` **or** `0015_review_history_events_v1.sql` | First-merged critical-path v1 scheduling/history seam; consumed read-only as migration history. |
| `0016` | `0016_durable_event_authorization_digests.sql` | Durable, deduplicated authorization digests for evaluation, concept-status, and recap browser events. |
| `0017` | `0017_privacy_tombstone_and_schema_cleanup.sql` | Study-set `deleted_at` tombstone, dead recap index removal, and deterministic unwritten-column removal. |
| `0018` | `0018_learning_turn_outcomes.sql` | Canonical Plan 04 `TurnOutcome`, challenge-resolution, and progression persistence; no competing D-01 storage. |

If the coordinator records `D-04 = SOFT_DELETE_UNDO`, Task 10 additionally creates one decision-gated undo migration allocated the next free number after `0018` (`0019_study_set_deletion_undo.sql` under the current allocation), reporting the allocation to the coordinator for the ledger; under `CONFIRM_DELETE` no such migration exists.

Every migration is append-only after merge. Never rewrite 0001–0015. Every Plan 09 file must be added to `MIGRATIONS` in `migrations.rs` in exact lexical order and must pass both sqlx-ledger replay and the raw historical-backfill path in an isolated schema.

---

### Task 1: Replace silent optional Postgres tests with an isolated required harness (`DATA-001`, `QLT-03`)

**Files:**
- Modify: `agent/crates/data/src/migrations.rs`

**Interfaces:**
- Produces: the exact durable test command consumed by Plan 12 and Plan 15
- Does not modify: `.github/workflows/validate.yml` (Plan 12 owns it)

- [ ] **Step 1: Write the failing harness contract tests**

Add tests named exactly:

```rust
#[test]
fn postgres_required_environment_never_silently_skips();

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_each_case_uses_an_isolated_schema();

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_sqlx_ledger_and_raw_backfill_do_not_share_schema_state();
```

`postgres_required_environment_never_silently_skips` calls a pure environment-contract parser with `required=true` and `database_url=None`, then asserts `Err("DATA_POSTGRES_REQUIRED=1 requires a non-empty DATABASE_URL")`. The process-environment wrapper supplies the real `DATA_POSTGRES_REQUIRED` and `DATABASE_URL` values to that parser. Every ignored Postgres test calls `required_postgres_url()` first; it never returns `Option` and never returns early.

- [ ] **Step 2: Run the RED test without a database**

```bash
DATA_POSTGRES_REQUIRED=1 cargo test --manifest-path agent/Cargo.toml -p data postgres_required_environment_never_silently_skips -- --exact --nocapture
```

Expected: FAIL because the current optional helper represents the missing URL as `None`/skip and has no required environment-contract parser. The named test itself must execute; a pass caused by zero selected tests or early return is not acceptable. After Step 3, the same command passes by asserting the exact error value rather than attempting a connection.

- [ ] **Step 3: Introduce one isolated schema fixture per Postgres test**

Replace `optional_postgres_pool() -> Option<PgPool>` with a required helper that:

1. Connects an administrative pool to `DATABASE_URL`.
2. Creates a schema name by formatting `viva_data_test_{}` with `Uuid::new_v4().simple()` and quotes that generated identifier.
3. Creates a test pool whose `after_connect` runs `SET search_path` using the quoted identifier stored in that fixture's `schema_name`; the callback never reconstructs or truncates the name.
4. Runs either `sqlx::migrate!` or raw historical migration SQL only inside that schema.
5. Closes the test pool, drops exactly that schema by first asserting `fixture.schema_name` matches `^viva_data_test_[0-9a-f]{32}$`, then executing `format!("DROP SCHEMA \"{}\" CASCADE", fixture.schema_name)` (sqlx 0.8 has no `QueryBuilder::push_identifier`; the regex assertion plus double-quoting is the identifier-safety mechanism, and the name is always self-generated), and closes the administrative pool.

Do not share seeded IDs, `_sqlx_migrations`, whole-table row counters, or question activity across tests. Rename every `optional_postgres_*_when_database_url_is_set` test to `postgres_*`, mark it with the explicit ignore reason above, and make every path acquire its own schema fixture.

- [ ] **Step 4: Make cleanup failure visible**

The fixture exposes `async fn cleanup(self) -> Result<(), sqlx::Error>`. Each test calls it after assertions. A failed schema drop fails the test; `Drop` may perform best-effort logging but must not be the only cleanup path.

While editing `migrations.rs`, also complete Plan 05's legacy-fixture handoff: migrate or remove the `include_str!("../../../fixtures/voice-protocol/count-truth-table.json")` reference (currently `migrations.rs` line 1694). If the data assertions are still needed, request a Plan 05 fixture amendment adding a v5 manifest row and import that v5 path; do not keep importing the unversioned root path — Plan 05 deletes the eleven legacy root fixtures under `agent/fixtures/voice-protocol/` after Plans 06/07/08/09/10 confirm their migrations.

- [ ] **Step 5: Run the GREEN harness against Postgres 16**

Provision the disposable database first (same recipe Task 14 uses): `docker run --detach --rm --name viva-data-postgres-dev --publish 127.0.0.1:55432:5432 --env POSTGRES_USER=viva --env POSTGRES_PASSWORD=viva_test_only --env POSTGRES_DB=viva_data_test postgres:16-alpine`, then `until docker exec viva-data-postgres-dev pg_isready --username viva --dbname viva_data_test; do sleep 1; done`; remove it with `docker rm --force viva-data-postgres-dev` when the lane session ends. All later tasks reuse this container or an equivalent.

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
```

Expected: all selected Postgres tests execute; output contains no `ignored because DATABASE_URL`, no early-return skip, no relation collision, and no fixture cross-test count drift.

- [ ] **Step 6: Commit the harness**

```bash
git add agent/crates/data/src/migrations.rs
git commit -m "test(data): require isolated postgres proof"
```

---

### Task 2: Add the durable authorization and cleanup migrations (`DATA-005`, `DATA-009`, `DATA-013`)

**Files:**
- Create: `agent/migrations/0016_durable_event_authorization_digests.sql`
- Create: `agent/migrations/0017_privacy_tombstone_and_schema_cleanup.sql`
- Modify: `agent/crates/data/src/migrations.rs`

- [ ] **Step 1: Write final-schema RED tests before creating migrations**

Add real Postgres tests named exactly:

```rust
postgres_final_schema_has_durable_authorization_and_deletion_tombstone
postgres_final_schema_drops_obsolete_recap_index
postgres_final_schema_enforces_data_schema_unwritten_rule
postgres_large_recap_does_not_hit_obsolete_payload_index_limit
```

Use `pg_indexes` and `information_schema.columns`, not a source-string assertion, for final-state proof. The unwritten-column test checks the exact six-column inventory after applying all migrations. `postgres_final_schema_has_durable_authorization_and_deletion_tombstone` asserts only `event_authorization_digests` and `study_sets.deleted_at` unconditionally; the `study_set_deletions`/`study_sets.deletion_id` assertions live in Task 10's decision-gated tests.

- [ ] **Step 2: Run the RED final-schema tests**

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_final_schema_ -- --ignored --test-threads=1 --nocapture
```

Expected: FAIL because `event_authorization_digests` and `study_sets.deleted_at` do not exist, the payload index remains, and the six unwritten columns remain.

- [ ] **Step 3: Verify the upstream allocation and create migration 0016 with this SQL shape**

After rebase, run:

```bash
find agent/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -print | sort
test "$(find agent/migrations -maxdepth 1 -type f -name '0015_*.sql' | wc -l | tr -d ' ')" = 1
test -f agent/migrations/0015_review_schedule_decisions_v1.sql || test -f agent/migrations/0015_review_history_events_v1.sql
test -z "$(find agent/migrations -maxdepth 1 -type f -name '001[6-9]_*.sql' -print -quit)"
```

Expected: the coordinator has recorded the one selected `0015` filename and next free migration number `0016` in the ledger; verify by reading, never writing, that file. No Plan 09 migration exists yet. A different result blocks allocation and goes to the coordinator.

```sql
CREATE TABLE event_authorization_digests (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN ('answer_evaluation', 'concept_status', 'study_session_recap')
    ),
    payload_sha256 CHAR(64) NOT NULL CHECK (
        payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (
        user_id,
        study_set_id,
        voice_session_id,
        response_id,
        event_kind,
        payload_sha256
    )
);

CREATE INDEX event_authorization_digests_session_lookup_idx
    ON event_authorization_digests (
        voice_session_id,
        response_id,
        event_kind,
        payload_sha256
    );
```

The table stores no raw event JSON. The digest is still learner-derived and must be removed by session/study deletion under both `D-05` branches.

- [ ] **Step 4: Re-run the field-by-field unwritten-column evidence command**

```bash
rg -n 'provider_attempt_id|terminal_reason|failure_class|retry_eligible|concept_id|\bstage\b' agent/crates --glob '*.rs'
rg -n 'INSERT INTO answer_attempts|UPDATE answer_attempts' agent/crates/data/src/postgres.rs
```

Expected at the reviewed contract: no production bind for any of the six `answer_attempts` fields. If Plan 04/06 has merged a typed writer, retain only the proven field and add its durable test in this task; otherwise apply the exact default SQL below.

- [ ] **Step 5: Create migration 0017 with this common SQL**

```sql
ALTER TABLE study_sets
    ADD COLUMN deleted_at TIMESTAMPTZ;

DROP INDEX IF EXISTS session_recaps_voice_session_payload_idx;

ALTER TABLE answer_attempts
    DROP COLUMN IF EXISTS provider_attempt_id,
    DROP COLUMN IF EXISTS terminal_reason,
    DROP COLUMN IF EXISTS failure_class,
    DROP COLUMN IF EXISTS stage,
    DROP COLUMN IF EXISTS retry_eligible,
    DROP COLUMN IF EXISTS concept_id;
```

Do not overload `ingestion_status` as the deletion authority. Active reads require `study_sets.deleted_at IS NULL`; the timestamp is the durable tombstone used by deletion, seed refusal, and idempotent repeated deletes.

Migration `0017` is decision-independent: it contains no `study_set_deletions` table, no pending/expiry partial index, and no `study_sets.deletion_id` column. That undo schema has a writer only under `D-04 = SOFT_DELETE_UNDO`, so per the `DATA-SCHEMA-UNWRITTEN` rule it is created only by Task 10's decision-gated migration.

- [ ] **Step 6: Add 0016 and 0017 to `MIGRATIONS` after selected 0015 and run migration-order tests**

```bash
cargo test --manifest-path agent/Cargo.toml -p data migration_include_list_matches_directory_order -- --exact --nocapture
cargo test --manifest-path agent/Cargo.toml -p data migrations_keep_raw_payload_columns_out_of_postgres -- --exact --nocapture
```

Expected: PASS with exact directory/include parity and no new raw payload column.

- [ ] **Step 7: Run the GREEN final-schema tests**

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_final_schema_ -- --ignored --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_large_recap_does_not_hit_obsolete_payload_index_limit -- --ignored --exact --nocapture
```

Expected: PASS. The large recap must be inserted through `PostgresStudyStore::record_recap`, not raw SQL alone.

- [ ] **Step 8: Commit the migrations**

```bash
git add agent/migrations/0016_durable_event_authorization_digests.sql agent/migrations/0017_privacy_tombstone_and_schema_cleanup.sql agent/crates/data/src/migrations.rs
git commit -m "feat(data): add durable authorization and cleanup schema"
```

---

### Task 3: Fail closed for every PDF until page-aware extraction exists (`DATA-014`, `COR-04`)

**Files:**
- Modify: `agent/crates/data/src/memory.rs`

**Classification:** `TESTED_FIX`

**Interfaces:**
- Consumes: Plan 06 `PortError::invalid_input` and `PortErrorKind::InvalidInput`
- Produces for Plan 08: a typed, bounded unsupported-PDF error; Plan 08 alone owns HTTP mapping and HTTP tests
- Does not add: a PDF parser, OCR, `UnsupportedMedia` error kind, service-route change, or claim of PDF support

- [ ] **Step 1: Replace fake-PDF success tests with real generated fixture RED tests**

Add test-only PDF builders inside `memory.rs` and tests named exactly:

```rust
pdf_ingestion_fails_closed_text_page_without_artifacts
pdf_ingestion_fails_closed_flate_compressed_text_without_artifacts
pdf_ingestion_fails_closed_scanned_image_only_without_artifacts
pdf_ingestion_fails_closed_standard_encrypted_without_artifacts
pdf_ingestion_fails_closed_malformed_without_artifacts
pdf_ingestion_fails_closed_magic_prefixed_plaintext_without_artifacts
pdf_ingestion_fails_closed_magic_even_without_pdf_name_or_mime
pdf_ingestion_fails_closed_retry_without_state_mutation
non_pdf_utf8_file_still_ingests_and_becomes_ready
non_pdf_invalid_utf8_fails_without_lossy_replacement
```

`generated_text_pdf()` builds a minimal catalog/pages/page/font/content document with a valid xref table whose byte offsets are calculated from the emitted objects. `generated_flate_pdf()` encodes the page content as a valid zlib-wrapped DEFLATE stored block and declares `/Filter /FlateDecode`. `generated_scanned_pdf()` uses an image XObject page with no text operators. `generated_encrypted_pdf()` uses the PDF Standard Security Handler revision 2 with deterministic test passwords, MD5 document key derivation, RC4-encrypted content, a referenced `/Encrypt` dictionary, and 32-byte `/O` and `/U` entries. Keep the necessary MD5 and RC4 routines test-only inside `memory.rs`, validate them against the RFC 1321 empty/`abc` MD5 vectors and the RC4 `Key`/`Plaintext` vector, and do not widen Cargo ownership for a fixture-only dependency. The fixture builders assert their own header, xref offsets, `startxref`, trailer/root, stream length, and selected compressed/image/encryption structure before passing bytes to ingestion. The malformed fixture truncates the xref/trailer; the false fixture is UTF-8 study prose prefixed by `%PDF-1.7` but has no PDF objects.

Each PDF test snapshots the store, calls `create_file_study_set`, asserts the exact typed error below, then proves the snapshot is unchanged: no study set or document became ready and no source span, concept, question, session, or token was created. The retry test first creates an ordinary UTF-8 text set, snapshots every row, submits PDF bytes to `retry_file_study_set`, and proves byte-equivalent state after rejection.

- [ ] **Step 2: Run RED against the current lossy decoder**

```bash
cargo test --manifest-path agent/Cargo.toml -p data pdf_ingestion_fails_closed_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data non_pdf_ -- --nocapture
```

Expected: the real text/compressed and `%PDF`-plus-plaintext cases can become `Ready` or create artifacts because the current path calls `String::from_utf8_lossy`; the new rejection tests fail. The non-PDF UTF-8 positive control remains green.

- [ ] **Step 3: Classify PDF before any text decoding**

Add a private `UploadedFileKind::{Pdf, Utf8Text}` classifier. It returns `Pdf` when any one of these is true:

- the case-insensitive filename ends in `.pdf`;
- the content type, trimmed before its first `;`, equals `application/pdf` case-insensitively;
- after an optional UTF-8 BOM and leading ASCII whitespace, the byte prefix starts with `%PDF`.

Run this classifier before normalization, source derivation, ID generation, or a state write. Every `Pdf` result immediately returns:

```rust
PortError::invalid_input(
    "study_store.file_ingestion",
    "unsupported_pdf",
    "PDF ingestion requires page-aware extraction",
)
```

The error contract is exact: `kind() == PortErrorKind::InvalidInput`, `port() == "study_store.file_ingestion"`, `id() == "unsupported_pdf"`, and the reason is the bounded literal above. Do not add a new `PortErrorKind`; do not branch on reason text.

- [ ] **Step 4: Remove lossy file decoding and retain honest UTF-8 support**

Replace `normalize_file_bytes(bytes: &[u8]) -> String` with a fallible supported-text path based on `std::str::from_utf8`. Valid non-PDF UTF-8 continues through the existing bounded normalization/source generation and may become `Ready`. Invalid UTF-8 returns `PortErrorKind::InvalidInput` with safe ID `invalid_utf8_file` and creates no record; it is never repaired with Unicode replacement characters. Remove every `String::from_utf8_lossy` call from file ingestion.

Rewrite the current fake-PDF success tests: the authorized-tool flow uses `notes.txt` plus `text/plain`; the retry-success fixture uses UTF-8 text plus `text/plain`; all PDF-named/content-typed/magic-prefixed inputs assert fail-closed behavior.

- [ ] **Step 5: Run GREEN and the lossy-decoder negative control**

```bash
cargo test --manifest-path agent/Cargo.toml -p data pdf_ingestion_fails_closed_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data file_ingestion -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data non_pdf_ -- --nocapture
test -z "$(rg -n 'from_utf8_lossy' agent/crates/data/src/memory.rs || true)"
```

Expected: every PDF shape returns the exact `InvalidInput` error with an unchanged store; valid UTF-8 non-PDF ingestion remains `Ready`; invalid UTF-8 persists nothing; the source scan is empty.

- [ ] **Step 6: Publish the Plan 08 HTTP handoff without editing service code**

Plan 08 consumes `PortErrorKind::InvalidInput` uniformly and maps it to sanitized HTTP 400 with fixed public message `"uploaded content is invalid or unsupported"` and the route's coarse `file_ingestion_failed` or `file_retry_failed` code. Its handler test must submit the generated text/compressed/scanned/encrypted/malformed/magic-plus-plaintext matrix, assert no raw bytes/error internals in the response, and verify zero persisted artifacts through the store. Plan 08 must inspect `kind()`, not substring-match `reason()` or add a data-specific route escape hatch.

- [ ] **Step 7: Commit the tested fix**

```bash
git add agent/crates/data/src/memory.rs
git commit -m "fix(data): reject unsupported PDF ingestion"
```

---

### Task 4: Make session, evaluation, usage, and counts atomic (`DATA-002`, `DATA-003`, `DATA-010`)

**Files:**
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/migrations.rs`

**Interfaces:**
- Consumes: Plan 06 `StudyStoreWriteOutcome`, `StudyStoreWriteCounts.voice_usage`, and `PortErrorKind`

- [ ] **Step 1: Write concurrent RED tests**

Add tests named exactly:

```rust
postgres_record_voice_session_replay_is_idempotent_and_count_exact
postgres_record_answer_evaluation_concurrent_compat_replay_is_atomic
postgres_record_answer_envelope_and_evaluation_converge_in_either_order
postgres_conflicting_evaluation_replay_returns_conflict_without_mutation
postgres_voice_usage_and_session_delete_serialize_to_no_usage_row
postgres_voice_usage_and_study_delete_serialize_to_no_usage_row
```

Use two independently constructed `PostgresStudyStore` values over the same isolated-schema pool and `tokio::sync::Barrier` to release both operations together. Assert return variants, final rows, final values, each instance's count delta, the sum of instance deltas, and `PortErrorKind`; for idempotent writes, the summed count delta must equal the one physical inserted row. Do not accept only “no panic.”

- [ ] **Step 2: Run the RED concurrency tests**

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_voice_session_replay_is_idempotent_and_count_exact -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_answer_ -- --ignored --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_conflicting_evaluation_replay_returns_conflict_without_mutation -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_voice_usage_and_ -- --ignored --test-threads=1 --nocapture
```

Expected: session count is 2 for one row, one evaluation replay surfaces duplicate key or mutates, and the forced usage/deletion interleaving can leave a usage row.

- [ ] **Step 3: Return insert truth from the session upsert**

Use one statement:

```sql
INSERT INTO voice_sessions (id, user_id, study_set_id, mode, status)
VALUES ($1, $2, $3, $4, 'open')
ON CONFLICT (id) DO UPDATE
SET mode = voice_sessions.mode
WHERE voice_sessions.user_id = EXCLUDED.user_id
  AND voice_sessions.study_set_id = EXCLUDED.study_set_id
  AND voice_sessions.status = 'open'
  AND voice_sessions.mode = EXCLUDED.mode
RETURNING (xmax = '0'::xid) AS inserted;
```

`fetch_optional` returning `None` is `Conflict`. `inserted=true` increments `sessions` and returns `Inserted`; `inserted=false` returns `IdempotentReplay` without incrementing.

- [ ] **Step 4: Replace evaluation check-then-insert with one conflict-safe upsert**

The evaluation compatibility write uses this single conflict-safe shape (the idempotency key bound at `$5` is the canonical `voice_session_id:question_id:1:response_id:compat` string):

```sql
INSERT INTO answer_attempts (
    id,
    voice_session_id,
    response_id,
    question_id,
    submission_sequence,
    idempotency_key,
    capture_mode,
    capture_status,
    answer_content_policy,
    pre_provider_state,
    evaluation_label,
    concept_status,
    confidence_score,
    source_span_id
)
VALUES (
    $1, $2, $3, $4, 1, $5,
    'typed', 'accepted', 'none', 'evaluation_only_compat',
    $6, $7, $8, $9
)
ON CONFLICT (voice_session_id, response_id) DO UPDATE
SET evaluation_label = EXCLUDED.evaluation_label,
    concept_status = EXCLUDED.concept_status,
    confidence_score = EXCLUDED.confidence_score,
    source_span_id = EXCLUDED.source_span_id
WHERE answer_attempts.question_id = EXCLUDED.question_id
  AND (
      (
          answer_attempts.evaluation_label IS NULL
          AND answer_attempts.concept_status IS NULL
          AND answer_attempts.confidence_score IS NULL
          AND answer_attempts.source_span_id IS NULL
      )
      OR (
          answer_attempts.evaluation_label IS NOT DISTINCT FROM EXCLUDED.evaluation_label
          AND answer_attempts.concept_status IS NOT DISTINCT FROM EXCLUDED.concept_status
          AND answer_attempts.confidence_score IS NOT DISTINCT FROM EXCLUDED.confidence_score
          AND answer_attempts.source_span_id IS NOT DISTINCT FROM EXCLUDED.source_span_id
      )
  )
RETURNING (xmax = '0'::xid) AS inserted;
```

A zero-row `RETURNING` becomes `PortErrorKind::Conflict`; it never leaks SQLSTATE 23505.

The envelope writer upgrades only the envelope columns of an `evaluation_only_compat` row when its question matches. It does not clear evaluation columns. This makes both races converge:

1. Envelope first: evaluation fills the empty evaluation columns.
2. Evaluation first: envelope replaces compat capture metadata while preserving evaluation columns.

After the statement, select and compare the complete envelope/evaluation tuple. A divergent replay returns `Conflict` and leaves the first tuple unchanged. Increment `answer_attempts` only when the physical row was inserted.

Replace the fallible `Arc<RwLock<StudyStoreWriteCounts>>` post-commit update with `Arc<PostgresWriteCounters>`, where each published count is an `AtomicUsize`. `write_counts()` loads a snapshot; a true inserted row performs one `fetch_add(1, Ordering::Relaxed)` after successful commit, while replay/conflict/rollback performs none. This prevents a poisoned local count lock from converting an already-committed usage row into a returned error that callers would retry without a stable usage ID.

- [ ] **Step 5: Serialize usage and deletion on locked session rows**

`record_voice_usage` begins a transaction and runs:

```sql
SELECT status
FROM voice_sessions
WHERE id = $1
FOR UPDATE;
```

If the row is `deleted`, commit without inserting and return `PortErrorKind::Conflict`; never return `Inserted`. Otherwise insert the usage row in the same transaction, commit, increment `voice_usage`, and return `Inserted`.

Both deletion methods lock affected session rows with `FOR UPDATE` before status mutation and artifact deletion. `delete_study_set` locks them in `ORDER BY id` to avoid lock-order deadlocks. This produces only two legal serial orders:

- usage commits first, then delete removes it;
- delete commits first, then usage observes `deleted` and inserts nothing.

Apply the same locked-open-session helper to new Plan 04 outcome/schedule writes in Task 6 so deletion cannot be followed by a late learning artifact.

- [ ] **Step 6: Run the GREEN concurrency tests ten times**

```bash
for pass in 1 2 3 4 5 6 7 8 9 10; do DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_answer_ -- --ignored --test-threads=1 --nocapture || exit 1; done
for pass in 1 2 3 4 5 6 7 8 9 10; do DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_voice_usage_and_ -- --ignored --test-threads=1 --nocapture || exit 1; done
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_conflicting_evaluation_replay_returns_conflict_without_mutation -- --ignored --exact --nocapture
```

Expected: 21 command passes; every fresh per-test schema ends with exact rows/counts and no duplicate-key text.

- [ ] **Step 7: Commit the atomic writes**

```bash
git add agent/crates/data/src/postgres.rs agent/crates/data/src/migrations.rs
git commit -m "fix(data): make postgres writes and counts atomic"
```

---

### Task 5: Persist authorization digests across restart and instances (`DATA-005`)

**Files:**
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/migrations.rs`

- [ ] **Step 1: Write restart, two-instance, and forgery RED tests**

Add tests named exactly:

```rust
postgres_answer_evaluation_authorization_survives_store_reconstruction
postgres_concept_status_authorization_is_visible_to_second_instance
postgres_recap_authorization_is_visible_to_second_instance
postgres_authorization_digest_rejects_wrong_response_kind_payload_and_tenant
postgres_authorization_digest_is_deleted_with_session_and_study_set
memory_authorization_replay_is_deduplicated_and_bounded
```

For reconstruction, write with store A, drop store A, construct store B from the same pool, and authorize with store B. For two-instance proof, construct A and B before the write. Each negative test changes exactly one of user, set, session, response, kind, or payload and asserts `Conflict` without a browser-safe payload becoming authoritative.

- [ ] **Step 2: Run the RED tests**

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_authorization_replay_is_deduplicated_and_bounded -- --exact --nocapture
```

Expected: Postgres restart/two-instance authorization fails because the digest exists only in `Arc<RwLock<Vec<EventAuthorizationRecord>>>`; memory grows on identical replay.

- [ ] **Step 3: Make canonical digest bytes shared and typed**

Keep one crate-private canonical encoder used by both backends. It hashes, in order, UTF-8 event-kind bytes, NUL, response ID bytes, NUL, and `serde_json::to_vec` of the exact Plan 04/agent-domain type. The output is exactly 64 lowercase hexadecimal characters. Do not hash ad hoc maps or backend-specific projections.

- [ ] **Step 4: Insert the digest in the same transaction as its authoritative write**

For evaluation, concept status, recap, and Plan 04 outcome-derived browser events:

```sql
INSERT INTO event_authorization_digests (
    user_id,
    study_set_id,
    voice_session_id,
    response_id,
    event_kind,
    payload_sha256
)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT DO NOTHING;
```

The domain row and digest commit together or roll back together. Authorization runs an exact `SELECT EXISTS` over all six key fields. Remove `PostgresStudyStore.event_authorizations`; durable mode must not retain a process-local shadow cache. `close_voice_session` deletes that session's digest rows in the same close transaction, while privacy deletion removes them with all other session artifacts. An open session may therefore resume across process restart or instances; a closed/deleted session cannot replay browser authority.

- [ ] **Step 5: Bound the in-memory equivalent**

Change `InMemoryStudyState.event_authorizations` from `Vec<EventAuthorizationRecord>` to `HashSet<EventAuthorizationRecord>`, deriving `Hash` for its members. Insertions deduplicate. Session close and both privacy deletes remove the exact session/set subset under the same state write lock.

- [ ] **Step 6: Run GREEN and digest differential controls**

```bash
cargo test --manifest-path agent/Cargo.toml -p data authorization_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
```

Expected: both backends produce the same digest for each Plan 04 fixture; restart and two-instance positives pass; every one-field mutation fails; deletion leaves zero digest rows.

- [ ] **Step 7: Commit durable authorization**

```bash
git add agent/crates/data/src/postgres.rs agent/crates/data/src/memory.rs agent/crates/data/src/migrations.rs
git commit -m "feat(data): persist event authorization digests"
```

---

### Task 6: Implement Plan 04's atomic learning persistence and selected schedule authority

**Files:**
- Create: `agent/migrations/0018_learning_turn_outcomes.sql`
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/migrations.rs`

**Interfaces:**
- Consumes: Plan 04 `TurnOutcome`, `ChallengeResolution`, `SessionLearningEvidence`, progression cursor/result types, `AuthenticatedStudyProjectionV1`, and `agent/fixtures/learning-core/*.json`
- Consumes: selected `D-01` and `D-02` branches from the coordinator ledger
- Consumes: the selected D-01 v1 table and store helpers already merged by the expedited critical path at migration `0015`
- Produces: atomic typed backend implementations; no new domain type

- [ ] **Step 1: Rebase on the published Plan 04 and Plan 06 contracts**

```bash
git fetch --all --prune
git rebase review-remediation/integration
test -f docs/superpowers/plans/2026-08-23-learning-core-authority.md
test -f docs/superpowers/plans/2026-08-23-rust-domain-integrity.md
```

Expected: the exact port methods/types described in this plan compile from `agent-domain`; no lane-local copies exist in `data`.

- [ ] **Step 2: Write backend-conformance RED tests from canonical fixtures**

Add tests named exactly:

```rust
memory_record_turn_outcome_is_atomic_and_replay_safe
postgres_record_turn_outcome_is_atomic_and_replay_safe
postgres_record_turn_outcome_rolls_back_every_transition_on_failure
postgres_record_challenge_resolution_binds_existing_outcome_and_source
postgres_select_next_question_reconnect_and_replay_share_one_cursor
memory_learning_ports_override_fail_closed_defaults
postgres_learning_ports_override_fail_closed_defaults
postgres_memory_backend_session_learning_evidence_matches_fixture_bytes
postgres_memory_backend_progression_cursor_matches_selected_d02_contract
postgres_memory_backend_review_authority_matches_selected_d01_contract
```

Deserialize Plan 04 fixtures directly. An identical replay must make no new row/transition/count; a one-field mutation under the same response identity must return `Conflict`; an injected invalid transition must leave outcome, transitions, progression, schedule, and authorization digest unchanged.

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p data record_turn_outcome -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_turn_outcome -- --ignored --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_challenge_resolution_binds_existing_outcome_and_source -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_select_next_question_reconnect_and_replay_share_one_cursor -- --ignored --exact --nocapture
```

Expected: FAIL because the port has no data implementation or durable schema.

- [ ] **Step 4: Create 0018 as canonical typed-object storage, not a second outcome model**

Use the exact Plan 04 `TurnOutcome` serialization as the stored value:

```sql
CREATE TABLE learning_turn_outcomes (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    supersedes_response_id TEXT,
    outcome_version SMALLINT NOT NULL CHECK (outcome_version = 1),
    outcome_json JSONB NOT NULL CHECK (
        jsonb_typeof(outcome_json) = 'object'
        AND outcome_json ->> 'schema' = 'viva.turn_outcome.v1'
        AND outcome_json ->> 'response_id' = response_id
        AND outcome_json ->> 'question_id' = question_id
        AND outcome_json -> 'resolution' ->> 'kind' IN ('evaluated', 'deferred')
    ),
    payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, study_set_id, voice_session_id, response_id),
    FOREIGN KEY (study_set_id, question_id)
        REFERENCES study_questions (study_set_id, question_id)
        ON DELETE CASCADE
);

CREATE INDEX learning_turn_outcomes_session_order_idx
    ON learning_turn_outcomes (voice_session_id, recorded_at, response_id);

CREATE TABLE learning_challenge_resolutions (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    correction_id TEXT NOT NULL,
    challenged_response_id TEXT NOT NULL,
    replacement_response_id TEXT,
    resolution_version SMALLINT NOT NULL CHECK (resolution_version = 1),
    resolution_json JSONB NOT NULL CHECK (
        jsonb_typeof(resolution_json) = 'object'
        AND resolution_json ->> 'schema' = 'viva.challenge_resolution.v1'
        AND resolution_json ->> 'correction_id' = correction_id
        AND resolution_json ->> 'challenged_response_id' = challenged_response_id
    ),
    payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, study_set_id, voice_session_id, correction_id),
    FOREIGN KEY (user_id, study_set_id, voice_session_id, challenged_response_id)
        REFERENCES learning_turn_outcomes (
            user_id,
            study_set_id,
            voice_session_id,
            response_id
        )
        ON DELETE CASCADE
);

CREATE TABLE question_progression_cursors (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    policy_id TEXT NOT NULL CHECK (policy_id IN ('ordered_v1', 'adaptive_v1')),
    progression_version SMALLINT NOT NULL CHECK (progression_version = 1),
    progression_json JSONB NOT NULL CHECK (jsonb_typeof(progression_json) = 'object'),
    revision BIGINT NOT NULL CHECK (revision >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, study_set_id, voice_session_id)
);

ALTER TABLE study_questions
    ADD COLUMN ingestion_ordinal BIGINT;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY study_set_id
               ORDER BY created_at ASC, id ASC
           ) AS ordinal
    FROM study_questions
)
UPDATE study_questions AS questions
SET ingestion_ordinal = ranked.ordinal
FROM ranked
WHERE questions.id = ranked.id;

ALTER TABLE study_questions
    ALTER COLUMN ingestion_ordinal SET NOT NULL;

CREATE UNIQUE INDEX study_questions_ingestion_ordinal_idx
    ON study_questions (study_set_id, ingestion_ordinal);

CREATE TABLE study_question_ingestion_cursors (
    study_set_id UUID PRIMARY KEY REFERENCES study_sets(id) ON DELETE CASCADE,
    next_ordinal BIGINT NOT NULL CHECK (next_ordinal >= 1)
);

INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
SELECT sets.id, COALESCE(MAX(questions.ingestion_ordinal) + 1, 1)
FROM study_sets AS sets
LEFT JOIN study_questions AS questions ON questions.study_set_id = sets.id
GROUP BY sets.id;
```

`outcome_json` and `resolution_json` are the canonical Plan 04 types; do not split, rename, or reinterpret their fields in data. Bind `recorded_at` from the validated RFC3339 UTC value inside `TurnOutcome`, and bind `supersedes_response_id` from the canonical optional field. Every later generated-question INSERT allocates its one-based ordinal in the same transaction with:

```sql
INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
VALUES ($1, 2)
ON CONFLICT (study_set_id) DO UPDATE
SET next_ordinal = study_question_ingestion_cursors.next_ordinal + 1
RETURNING next_ordinal - 1 AS allocated_ordinal;
```

The question INSERT binds that returned ordinal; memory stores the equivalent committed insertion ordinal. `assert_schema_has_no_raw_payload_columns` gains a runtime serialization test proving canonical outcomes and challenges contain none of the forbidden raw learner payload field names before Postgres accepts them.

- [ ] **Step 5: Persist outcome, transitions, progression, authorization, and schedule in one transaction**

The Postgres sequence is:

1. Lock the exact tenant-owned open session:

   ```sql
   SELECT id
   FROM voice_sessions
   WHERE id = $1
     AND user_id = $2
     AND study_set_id = $3
     AND status = 'open'
   FOR UPDATE;
   ```

2. Validate every referenced question/concept/source against the same tenant.
3. Attempt the immutable outcome insert:

   ```sql
   INSERT INTO learning_turn_outcomes (
       user_id,
       study_set_id,
       voice_session_id,
       response_id,
       question_id,
       supersedes_response_id,
       outcome_version,
       outcome_json,
       payload_sha256,
       recorded_at
   )
   VALUES ($2, $3, $1, $4, $5, $6, 1, $7, $8, $9)
   ON CONFLICT (user_id, study_set_id, voice_session_id, response_id)
   DO NOTHING
   RETURNING payload_sha256, outcome_json;
   ```
4. On replay, compare `payload_sha256` and the canonical deserialized value; identical returns `PersistedTurnOutcome` with the existing outcome and `record.replayed = true`, while a divergent payload returns `Conflict`. A true insert returns the same wrapper with `record.replayed = false`; both receipts use schema `viva.turn_outcome_record.v1` and the outcome's response ID.
5. On true insert, lock the one session cursor with `SELECT progression_json, revision FROM question_progression_cursors WHERE user_id = $2 AND study_set_id = $3 AND voice_session_id = $1 FOR UPDATE`, apply the selected D-02 rule, and insert revision `0` or update only from the loaded revision. Persisted `revision` must equal `progression_json.revision`; replay does not advance it.
6. For `Evaluated`, apply every `ConceptStatusTransition` and invoke the selected merged D-01 v1 transaction helper against the existing `0015` table. For `Deferred`, require an empty transition list and perform no schedule/history write.
7. Insert required browser authorization digest(s).
8. Commit once.

Any failure rolls back all eight effects. The in-memory backend performs the same validations and mutations under one write lock against canonical typed records. `select_next_question` locks/reads that same cursor and orders eligible questions by `ingestion_ordinal ASC, question_id ASC` for `OrderedV1`; `AdaptiveV1` uses Plan 04's pure ranker and its published stable tie-break, then writes one revision.

- [ ] **Step 6: Extend the selected upstream D-01 seam without another schema**

Assert exactly one selected upstream migration exists and the other does not:

```bash
test "$(find agent/migrations -maxdepth 1 -type f \( -name '0015_review_schedule_decisions_v1.sql' -o -name '0015_review_history_events_v1.sql' \) | wc -l | tr -d ' ')" = 1
if test -f agent/migrations/0015_review_schedule_decisions_v1.sql; then
  test ! -e agent/migrations/0015_review_history_events_v1.sql
  cargo test --manifest-path agent/Cargo.toml -p data review_schedule_decision -- --nocapture
else
  test -f agent/migrations/0015_review_history_events_v1.sql
  test ! -e agent/migrations/0015_review_schedule_decisions_v1.sql
  cargo test --manifest-path agent/Cargo.toml -p data review_history_event -- --nocapture
fi
```

Do not add a schedule/history table in `0018`. Refactor only the selected merged Postgres writer into a public transaction-owning wrapper and a crate-private helper that accepts `&mut sqlx::Transaction<'_, Postgres>`; the outcome transaction calls the helper. Refactor the selected memory writer into an equivalent `_locked` helper over `&mut InMemoryStudyState`. Both standalone and outcome calls preserve the upstream v1 replay key, schema/version checks, exam policy, CAS/sequence behavior, and conformance fixture bytes. If the merged `0015` schema cannot serialize the final Plan 04 selected v1 type exactly, stop and return the concrete schema/type mismatch to the coordinator; do not create a parallel table or silently widen JSON meaning.

- Branch A continues storing only the upstream `PersistedFsrsCardV1`/`ReviewScheduleDecisionV1` seam and returns `server_persisted_fsrs` summaries.
- Branch B continues appending only the upstream `ReviewHistoryEventV1` seam; `ReadTimeReviewProjectionV1` remains non-persisted and returns `core_fsrs_read_time` summaries.

- [ ] **Step 7: Persist and validate challenge resolutions**

`record_challenge_resolution` locks the tenant-owned open session and selects the challenged `learning_turn_outcomes` row plus every canonical source ID. It rejects a missing/cross-tenant outcome or source. Insert the exact `ChallengeResolution` JSON and digest with `ON CONFLICT (user_id, study_set_id, voice_session_id, correction_id) DO NOTHING`; identical replay returns the stored typed value, and any changed field is `Conflict`. A later `TurnOutcome.supersedes_response_id` may apply replacement mastery only when it references that challenged response and the stored challenge disposition permits reevaluation; otherwise the entire outcome transaction rolls back.

- [ ] **Step 8: Apply canonical fixtures to both backends**

For each fixture under `agent/fixtures/learning-core/*.json`, assert typed equality of:

- stored/replayed `TurnOutcome`;
- stored/replayed `ChallengeResolution` and supersession validation;
- `SessionLearningEvidence`;
- selected `D-02` progression cursor/result;
- selected `D-01` card/decision or history/read-time projection;
- `SessionLearningEvidence.concept_labels` as exact `(concept_id, label)` pairs and `review_decisions` with exact `server_persisted_fsrs` or `core_fsrs_read_time` authority;
- exact write counts and durable row counts;
- conflict behavior after one-field mutation.

The two exact fail-closed-default override tests seed a canonical owned session/question/outcome/challenge/progression/projection, invoke all five Plan 06 learning methods on the production memory/Postgres stores, assert none returns `PortErrorKind::Unavailable`, and compare the complete semantic fixture values. They assert both inserted and replayed `PersistedTurnOutcome` values, including the full receipt and row/count deltas.

Both backends return `SessionLearningEvidence.outcomes` by `recorded_at ASC, response_id ASC`, `concept_labels` by `concept_id ASC`, and `review_decisions` by `due_at ASC, concept_id ASC`. The canonical fixture comparison is over the typed values and their serialized bytes, so an order-only drift fails.

- [ ] **Step 9: Run GREEN**

```bash
cargo test --manifest-path agent/Cargo.toml -p data learning_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_learning_ports_override_fail_closed_defaults -- --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_turn_outcome -- --ignored --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_record_challenge_resolution_binds_existing_outcome_and_source -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_select_next_question_reconnect_and_replay_share_one_cursor -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_learning_ports_override_fail_closed_defaults -- --ignored --exact --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_memory_backend_ -- --ignored --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_final_schema_ -- --ignored --test-threads=1 --nocapture
```

Expected: PASS under the recorded `D-01`/`D-02` selections; no raw answer/transcript/source payload is present in stored JSON.

- [ ] **Step 10: Commit canonical learning persistence**

```bash
git add agent/migrations/0018_learning_turn_outcomes.sql agent/crates/data/src/postgres.rs agent/crates/data/src/memory.rs agent/crates/data/src/migrations.rs
git commit -m "feat(data): persist canonical learning outcomes atomically"
```

---

### Task 7: Make all in-memory mutations atomic (`DATA-012`)

**Files:**
- Modify: `agent/crates/data/src/memory.rs`

**Interfaces:**
- Consumes: Plan 06 `StudyStoreWriteOutcome` and error kinds
- Consumes: Plan 04 canonical learning types from Task 6

- [ ] **Step 1: Add deterministic interleaving RED tests**

Add a test-only mutation hook placed after validation but before mutation. The hook signals a barrier and waits for release. Add tests named exactly:

```rust
memory_close_and_session_replay_cannot_reopen_closed_session
memory_delete_and_answer_evaluation_cannot_leave_late_artifact
memory_delete_and_turn_outcome_cannot_leave_late_artifact
memory_voice_usage_and_session_delete_serialize_to_no_usage_record
memory_voice_usage_and_study_delete_serialize_to_no_usage_record
memory_concurrent_identical_replays_keep_every_count_exact
```

For the session race, pause `record_voice_session`, start `close_voice_session`, release the paused writer, and assert final status `closed`. Under the pre-fix read-lock-then-`save` flow, close wins first and `save` reopens the session; the RED test must witness that state.

- [ ] **Step 2: Run RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p data memory_close_and_session_replay_cannot_reopen_closed_session -- --exact --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_delete_and_ -- --nocapture
```

Expected: at least the session race ends `open`, and one paused check-then-write path can append after deletion.

- [ ] **Step 3: Use one state write lock for each logical mutation**

Remove the validation-read-lock then mutation-write-lock pattern from:

- `record_voice_session`;
- `record_answer_attempt_envelope`;
- `record_answer_evaluation`;
- `record_concept_status`;
- `schedule_review_item`;
- `record_recap`;
- `record_voice_usage`;
- `record_turn_outcome` and schedule/progression writes;
- `delete_session_history` and `delete_study_set`.

Each method acquires `self.inner.write()` once, validates against that state, performs the complete mutation, computes `StudyStoreWriteOutcome`/return value from that mutation, and releases the lock. Do not call async methods or reacquire the same lock while holding it. Keep synchronous `_locked` helpers for validation and mutation.

`record_voice_session` replaces an existing open row only as `IdempotentReplay`; it never calls the separately locking `SessionStore::save`. A closed/deleted row returns `Conflict` and remains unchanged. An `IdempotentReplay` updates the existing element in place; it must not remove-and-push the record, so the committed insertion position (Task 8's recency ordinal) is preserved exactly as Postgres preserves `started_at` on replay.

- [ ] **Step 4: Make counters derive from committed state**

`write_counts()` continues to derive sessions, attempts, transitions, review records, and recaps from the state collections. Add the Plan 06 usage collection/count; accepted usage returns `Inserted` and appends exactly one record while holding the same lock used to confirm the session is not deleted. A deletion that obtains the lock second removes it; a usage write that obtains the lock second sees `deleted`, returns `Conflict`, and appends nothing. Identical outcome/session replays do not grow collections.

- [ ] **Step 5: Run GREEN and repeat the deterministic races**

```bash
for pass in 1 2 3 4 5 6 7 8 9 10; do cargo test --manifest-path agent/Cargo.toml -p data memory_close_and_session_replay_cannot_reopen_closed_session -- --exact --nocapture || exit 1; done
cargo test --manifest-path agent/Cargo.toml -p data memory_delete_and_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_concurrent_identical_replays_keep_every_count_exact -- --exact --nocapture
```

Expected: all runs end closed/deleted with zero late artifacts and exact counts.

- [ ] **Step 6: Commit in-memory atomicity**

```bash
git add agent/crates/data/src/memory.rs
git commit -m "fix(data): make in-memory mutations atomic"
```

---

### Task 8: Enforce typed backend parity and true recency ordering (`DATA-011`)

**Files:**
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/migrations.rs`

**Interfaces:**
- Consumes only: Plan 04 `AuthenticatedStudyProjectionV1`
- Does not add: a data-local `StudyContext`, a new `VoiceSessionRecord` timestamp, or untyped `serde_json::Value` return shape

- [ ] **Step 1: Write typed differential RED tests**

Add tests named exactly:

```rust
postgres_memory_backend_authenticated_study_projection_is_identical
postgres_memory_backend_library_sessions_use_true_recency_order
postgres_memory_backend_tie_breaks_library_order_by_session_id
```

Create two non-lexical session IDs in order `ffffffff-ffff-4fff-8fff-ffffffffffff` then `11111111-1111-4111-8111-111111111110`, close both as completed, and assert the second insertion is first in memory exactly as the later `started_at` row is first in Postgres. Between the two inserts and the closes, replay the first session's `record_voice_session` and assert the ordering is unchanged in both backends, so a remove-and-push replay implementation fails this test. For the tie test, set equal Postgres `started_at` values and assert descending session ID, then arrange the equivalent stable in-memory insertion order required by the published projection contract.

- [ ] **Step 2: Run RED**

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_memory_backend_ -- --ignored --test-threads=1 --nocapture
```

Expected: compile/shape failure while `study_context` returns `Value`, plus ordering failure because memory sorts UUID text rather than insertion recency.

- [ ] **Step 3: Build one typed projection in each backend**

Implement Plan 04's `AuthenticatedStudyProjectionV1` directly. Both backends must populate the same fields, omit tombstoned/deleted sets and sources, use the same concept/question ordering, and preserve the same public/logical IDs. Postgres must stop building a backend-specific `jsonb_build_object`; memory must stop serializing internal `*Record` structs as its public shape.

- [ ] **Step 4: Fix recency without inventing a timestamp field**

Plan 06 explicitly does not add a timestamp to `VoiceSessionRecord`. The in-memory session vector's committed insertion position is its recency ordinal. Project completed sessions by reverse insertion position and use session ID only as the documented tie-break. Postgres keeps `ORDER BY started_at DESC, id DESC`.

- [ ] **Step 5: Run GREEN on both backends**

```bash
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_memory_backend_authenticated_study_projection_is_identical -- --ignored --exact --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_memory_backend_library_sessions_use_true_recency_order -- --ignored --exact --test-threads=1 --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
```

Expected: typed equality for every Plan 04 fixture and identical session ordering.

- [ ] **Step 6: Commit typed parity**

```bash
git add agent/crates/data/src/postgres.rs agent/crates/data/src/memory.rs agent/crates/data/src/migrations.rs
git commit -m "fix(data): align typed backend projections and ordering"
```

---

### Task 9: Enforce the selected retention policy, canary purge, and seed non-resurrection (`DATA-004`, `COR-03`, `SEC-03`)

**Files:**
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/migrations.rs`

**Interfaces:**
- Requires: coordinator-recorded `D-05 DATA_RETENTION` and `D-04 DELETION_UX`
- Produces handoff: Plan 08 removes normal-startup seeding; Plan 11 and Plan 15 publish exact selected semantics

- [ ] **Step 1: Stop if D-05 or D-04 is unresolved**

Read both coordinator decision rows. If either is `DECISION_BLOCKED`, execute no production deletion entry/finalization branch. Report that Tasks 9–10 alone remain blocked; continue decision-independent tasks.

- [ ] **Step 2: Write canary/restart/race RED tests before GREEN**

Use a unique canary containing only test text, for example `VIVA_LEARNER_DELETE_CANARY_8F6A`, across title, course, document name, excerpt, concept label, question prompt/terms/follow-up, evaluation label, recap arrays, and the selected Plan 04 canonical fields. Add tests named exactly:

```rust
memory_selected_d05_policy_removes_exact_canary_fields
postgres_selected_d05_policy_removes_exact_canary_fields
postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction
postgres_repeated_delete_is_idempotent_and_content_free
postgres_delete_canary_scan_covers_every_learner_text_table
postgres_delete_serializes_against_every_artifact_writer
```

The Postgres canary scan enumerates these tables explicitly and evaluates `to_jsonb(row)::text` for scoped rows: `study_sets`, `study_documents`, `source_spans`, `concepts`, `study_questions`, `voice_sessions`, `answer_attempts`, `review_items`, `session_recaps`, `concept_status_events`, `event_authorization_digests`, `learning_turn_outcomes`, `learning_challenge_resolutions`, `question_progression_cursors`, `study_question_ingestion_cursors`, and the one selected upstream 0015 schedule/history table. It also queries `voice_usage_events` and `voice_session_token_nonces` by affected session IDs. Branch A requires zero row containing the canary. Branch B additionally scans each text/array/JSON column separately: a hit is legal only in the seven enumerated concept/question fields, and every other column must return zero hits.

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p data selected_d05 -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_selected_d05_policy_removes_exact_canary_fields -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_repeated_delete_is_idempotent_and_content_free -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_delete_ -- --ignored --test-threads=1 --nocapture
```

Expected: source/document canary survives in tombstoned rows and `seed_postgres_fixture` clears tombstones/repopulates content.

- [ ] **Step 4: Make permanent D-05 finalization one locked transaction**

The permanent finalizer for both D-05 branches begins with:

```sql
SELECT id
FROM study_sets
WHERE id = $1 AND user_id = $2
FOR UPDATE;

SELECT id
FROM voice_sessions
WHERE user_id = $2 AND study_set_id = $1
ORDER BY id
FOR UPDATE;
```

Select `study_sets.deleted_at` in the first statement; under D-04 `SOFT_DELETE_UNDO` also select `deletion_id`. Branch-A finalization operates on a schema without `deletion_id`, while Branch-B finalization retains `deletion_id` as enumerated content-free audit metadata. Under D-04 `CONFIRM_DELETE`, invoke this finalizer immediately. Under D-04 `SOFT_DELETE_UNDO`, only Task 10 invokes it for an expired pending deletion while holding the matching `study_set_deletions` row. If the row is already a finalized selected-branch tombstone, perform no `ensure_study_set`, seed, session update, or child mutation and return the existing idempotent result. A malformed tombstone is `PortErrorKind::Durability`, not an excuse to rehydrate or rescrub it.

Set `study_sets.deleted_at = COALESCE(deleted_at, clock_timestamp())`. Scrub each locked session with `mode = 'deleted'`, `status = 'deleted'`, `terminal_reason = 'deleted'`, and `ended_at = COALESCE(ended_at, clock_timestamp())`, preserving identifiers and the original `started_at`. Then delete all session-scoped recaps, status events, review rows, attempts, usage, nonces, authorization digests, outcomes, challenge resolutions, progression, and selected D-01 schedule/history rows. Delete the set's `study_question_ingestion_cursors` row under both branches before commit.

For Branch A `HARD_PURGE_TEXT`, execute:

```sql
DELETE FROM study_questions WHERE study_set_id = $1;
DELETE FROM concepts WHERE study_set_id = $1;
DELETE FROM study_documents WHERE study_set_id = $1;

UPDATE study_sets
SET title = '[deleted]',
    course = NULL,
    exam_date = NULL,
    ingestion_status = 'deleted',
    ingestion_error = NULL,
    updated_at = clock_timestamp()
WHERE id = $1 AND user_id = $2;
```

Deleting documents cascades source spans; explicit question/concept deletes make the intended text purge auditable rather than relying on `ON DELETE SET NULL`.

For Branch B `ENUMERATED_DERIVED_RETENTION`, execute:

```sql
DELETE FROM study_documents WHERE study_set_id = $1;

UPDATE study_questions
SET active = FALSE,
    source_span_id = NULL
WHERE study_set_id = $1;

UPDATE concepts
SET source_span_id = NULL,
    updated_at = clock_timestamp()
WHERE study_set_id = $1;

UPDATE study_sets
SET title = '[deleted]',
    course = NULL,
    exam_date = NULL,
    ingestion_status = 'deleted',
    ingestion_error = NULL,
    updated_at = clock_timestamp()
WHERE id = $1 AND user_id = $2;
```

The Branch B test asserts the canary may remain only in the enumerated concept/question derived columns and nowhere else. Both branches exclude deleted sets in active question, source, authenticated projection, and library queries.

Change the ordinary ownership guard to require `study_sets.deleted_at IS NULL`; it returns `Unavailable` for a tombstone and is used by session, nonce, outcome, challenge, progression, and projection paths. Usage keeps the Task 4 locked-session rule so a deleted session returns `Conflict`. Deletion itself must not call the ordinary guard: it executes the locked tombstone-aware query above so a repeated delete can return idempotently without treating the tombstone as active.

- [ ] **Step 5: Make fixture seeding insert-only and non-resurrecting**

`seed_postgres_fixture` acquires its advisory lock, checks all known fixture IDs, and returns a typed `FixtureSeedError::ExistingFixture` when any fixture root/tombstone already exists. It never executes `ON CONFLICT DO UPDATE`, never clears `deleted_at`, never reactivates questions, and never overwrites concept status. A clean isolated schema still accepts one seed.

Send Plan 08 this exact handoff: normal durable startup must call `run_migrations` only; fixture seeding is allowed only from an explicit development/test entrypoint. Plan 09's restart test reconstructs `PostgresStudyStore` after delete and separately invokes the seed function to prove refusal.

- [ ] **Step 6: Mirror the selected policy in memory**

Under one state write lock, remove/scrub exactly the same categories. Branch A removes documents/spans/concepts/questions from maps and scrubs the set. If Branch B is selected, change `ConceptRecord.source_span_id` to `Option<String>` and set it to `None`; replace each active `StudyQuestionRecord` with an internal `RetainedDeletedQuestionRecord { study_set_id, question_id, prompt, expected_terms, follow_up }` that has no source object or excerpt. Store those retained records in a dedicated map excluded from active/authenticated/library projection. This is the exact in-memory counterpart of the retained SQL columns, not an active question type. Both branches remove all session artifacts, digests, nonces, outcomes, challenge resolutions, progression and ingestion cursors, selected D-01 schedule/history records, and usage.

- [ ] **Step 7: Run GREEN, including restart and canary proof**

```bash
cargo test --manifest-path agent/Cargo.toml -p data selected_d05 -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_selected_d05_policy_removes_exact_canary_fields -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_repeated_delete_is_idempotent_and_content_free -- --ignored --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_delete_ -- --ignored --test-threads=1 --nocapture
```

Expected: exact selected policy, no resurrection, no late artifact, idempotent repeated delete, and no unenumerated canary occurrence.

- [ ] **Step 8: Commit privacy semantics**

```bash
git add agent/crates/data/src/postgres.rs agent/crates/data/src/memory.rs agent/crates/data/src/migrations.rs
git commit -m "fix(data): enforce restart-safe privacy deletion"
```

---

### Task 10: Implement D-04 Branch B durable soft delete and bounded undo (`DATA-016`)

**Decision gate:** Execute this task if and only if the coordinator records `D-04 = SOFT_DELETE_UNDO`. If `D-04 = CONFIRM_DELETE`, skip the task and retain Task 9's immediate finalization path.

**Files:**
- Create: `agent/migrations/0019_study_set_deletion_undo.sql` (decision-gated; the next free number after `0018` per the Migration allocation section)
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/migrations.rs`

**Interfaces:**
- Consumes: Plan 06's selected-`SOFT_DELETE_UNDO` conditional `deletion.rs` types and exact port methods below
- Produces: typed store result/error and expiry-finalizer handoffs consumed by Plan 08; Plan 11 independently owns any browser-capability/BFF contract
- Does not persist: a raw restore token, browser capability, learner text, title, or content in `study_set_deletions`

Under `CONFIRM_DELETE`, Plan 06 publishes no restore/finalizer API, this task is skipped, and Task 9 uses only immediate selected-D-05 finalization. Do not add compatibility restore methods or dormant types for Branch A.

- [ ] **Step 1: Publish and consume the exact typed store contract**

Rebase on Plan 06 and import its private, validated types and constants; do not mirror them in data. The published contract is exactly:

```rust
pub const SOFT_DELETE_RECEIPT_SCHEMA_V1: &str = "viva.soft_delete_receipt.v1";
pub const SOFT_DELETE_POLICY_V1: &str = "soft_delete_undo";
pub const RESTORE_STUDY_SET_OUTCOME_SCHEMA_V1: &str =
    "viva.restore_study_set_outcome.v1";
pub const SOFT_DELETE_UNDO_WINDOW_SECONDS: i64 = 30;
pub const MAX_DELETION_FINALIZE_BATCH: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SoftDeleteReceiptV1 {
    schema: &'static str,
    deletion_id: String,
    study_set_id: String,
    deleted_at: String,
    undo_expires_at: String,
    policy: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RestoreStudySetInputV1 {
    user_id: String,
    study_set_id: String,
    deletion_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStudySetOutcomeKindV1 {
    Restored,
    AlreadyRestored,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RestoreStudySetOutcomeV1 {
    schema: &'static str,
    deletion_id: String,
    study_set_id: String,
    restored_at: String,
    outcome: RestoreStudySetOutcomeKindV1,
}

async fn restore_study_set(
    &self,
    input: RestoreStudySetInputV1,
) -> Result<RestoreStudySetOutcomeV1, PortError>;

async fn finalize_expired_study_set_deletions(
    &self,
    limit: usize,
) -> Result<usize, PortError>;
```

Every field above is private. Plan 09 constructs receipts/inputs/outcomes only through Plan 06's `try_new` constructors and reads them through borrowed accessors. `deletion_id` must parse, be non-nil, and reserialize in canonical lowercase hyphenated UUID form. `user_id` and `study_set_id` are non-empty, trimmed, control-free subject identifiers; data does not impose a second UUID rule on them. All time strings parse and round-trip as canonical RFC3339 UTC `Z` with `SecondsFormat::AutoSi`, and the receipt constructor enforces exactly 30 seconds. Invalid construction/deserialization never reaches backend access.

The internal restore input is exactly `{ user_id, study_set_id, deletion_id }`; Plan 08 derives all three fields from authenticated identity, the route path, and its bounded request rather than accepting `user_id` or `study_set_id` from HTTP JSON. The durable subject tuple is exactly `(user_id, study_set_id, deletion_id, undo_expires_at, restored_at, purged_at)`. `deletion_id` is an opaque server-generated UUID used for generation binding and idempotence, not a bearer credential. A repeated pending delete returns the byte-identical receipt; a repeated successful restore returns `AlreadyRestored` with the originally persisted `restored_at`, never the retry time. The existing branch-neutral `delete_study_set -> serde_json::Value` implementation must serialize a validated `SoftDeleteReceiptV1`; it must not hand-build JSON or add a parallel typed delete port. Plan 11 owns a separate hashed one-time browser restore capability; no raw capability enters the store.

Both backend overrides apply the `1..=MAX_DELETION_FINALIZE_BATCH` guard before state/SQL access, return `InvalidInput` for `0` or `101`, and return a count no larger than `limit`. They must never fall through to Plan 06's intentional `Unavailable` defaults.

- [ ] **Step 2: Write clock, replay, restart, two-instance, and D-05 RED tests**

Add tests named exactly:

```rust
study_set_restore_soft_delete_receipt_has_exact_thirty_second_server_window
study_set_restore_before_expiry_is_atomic_and_replay_idempotent
study_set_restore_at_expiry_fails_and_finalizes_selected_d05_policy
study_set_restore_finalizer_rejects_zero_and_101_before_backend_access
postgres_study_set_restore_soft_delete_replay_returns_same_generation_and_deadline
postgres_study_set_restore_survives_store_reconstruction
postgres_study_set_restore_is_visible_to_second_instance
postgres_study_set_restore_and_expiry_purge_have_one_legal_winner
postgres_study_set_restore_wrong_user_study_or_deletion_generation_fails_closed
postgres_study_set_restore_expired_finalizes_selected_d05_policy_and_canary
postgres_study_set_restore_record_contains_only_content_free_subject_fields
postgres_study_set_restore_finalizer_returns_at_most_requested_limit
```

Use a fixed memory clock and the same private Postgres transaction helper used by production after it captures database time. At `deleted_at = 2031-04-05T12:00:00Z`, assert `undo_expires_at = 2031-04-05T12:00:30Z`; restore at `12:00:29.999999Z` succeeds, while restore at exactly `12:00:30Z` is expired. Deserialize the existing `delete_study_set` `Value` result through Plan 06's public `SoftDeleteReceiptV1` parser and assert byte-semantic equality with the typed fixture; no hand-built extra field is allowed. The Postgres boundary test obtains each fixed `TIMESTAMPTZ` through SQL and passes it only to the crate-private locked helper; the public port always obtains `database_now` from `SELECT clock_timestamp()` and exposes no caller-controlled clock. Repeated delete while pending returns the same `deletion_id` and timestamps without extending the window. Repeated restore returns `AlreadyRestored` with the original `restored_at`. Store reconstruction and a second preconstructed Postgres instance observe the same outcome. The bound tests call the production overrides with `0`, `1`, `100`, and `101`: invalid bounds fail before access, valid calls never return `Unavailable`, and the returned count is at most the requested limit.

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p data study_set_restore_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_study_set_restore_ -- --ignored --test-threads=1 --nocapture
```

Expected: FAIL because deletion immediately purges/scrubs data and there is no durable generation/deadline or restore port.

- [ ] **Step 4: Make soft delete one database-time transaction**

First create the decision-gated undo migration `agent/migrations/0019_study_set_deletion_undo.sql`, add it to `MIGRATIONS` in exact lexical order, and report the allocation to the coordinator for the ledger. It contains exactly the schema deliberately kept out of decision-independent `0017`:

```sql
CREATE TABLE study_set_deletions (
    deletion_id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ NOT NULL,
    undo_expires_at TIMESTAMPTZ NOT NULL,
    restored_at TIMESTAMPTZ,
    purged_at TIMESTAMPTZ,
    CHECK (undo_expires_at = deleted_at + INTERVAL '30 seconds'),
    CHECK (restored_at IS NULL OR purged_at IS NULL),
    UNIQUE (user_id, study_set_id, deletion_id)
);

CREATE UNIQUE INDEX study_set_deletions_one_pending_idx
    ON study_set_deletions (user_id, study_set_id)
    WHERE restored_at IS NULL AND purged_at IS NULL;

CREATE INDEX study_set_deletions_expiry_idx
    ON study_set_deletions (undo_expires_at, deletion_id)
    WHERE restored_at IS NULL AND purged_at IS NULL;

ALTER TABLE study_sets
    ADD COLUMN deletion_id UUID REFERENCES study_set_deletions(deletion_id);
```

Add Task 2's deferred `study_set_deletions`/`study_sets.deletion_id` final-schema assertions (table, columns, and both partial indexes, via `pg_indexes` and `information_schema.columns`) to this task's tests. This migration exists only under `D-04 = SOFT_DELETE_UNDO`; under `CONFIRM_DELETE` neither the table nor the column exists.

Lock the owned active study set. If it already references a pending deletion, return that operation's identical `SoftDeleteReceiptV1`. Otherwise capture database time once and create the generation:

```sql
WITH authoritative_time AS (
    SELECT clock_timestamp() AS deleted_at
)
INSERT INTO study_set_deletions (
    deletion_id,
    user_id,
    study_set_id,
    deleted_at,
    undo_expires_at,
    restored_at,
    purged_at
)
SELECT $1, $2, $3, deleted_at, deleted_at + INTERVAL '30 seconds', NULL, NULL
FROM authoritative_time
RETURNING deletion_id, deleted_at, undo_expires_at;

UPDATE study_sets
SET deleted_at = $4,
    deletion_id = $1,
    updated_at = $4
WHERE id = $3 AND user_id = $2 AND deleted_at IS NULL;
```

Both statements run under one transaction and use the returned `deleted_at` bound as `$4`; zero updated rows is replay/conflict resolution under the same lock. Pending deletion hides the set from ordinary/authenticated/library reads and makes session, nonce, usage, outcome, challenge, progression, scheduling, and question writes fail closed. It does not scrub or delete child content before expiry because that content is required for authoritative restore.

- [ ] **Step 5: Restore atomically before the half-open deadline**

Lock the matching `study_set_deletions` and `study_sets` rows by exact user, set, and deletion ID, and capture `clock_timestamp()` once. The public method passes that database-returned value to a crate-private `restore_study_set_locked_at` helper operating on the same transaction; only boundary tests can call the helper, and production has no injectable/client clock. Apply this order:

1. `restored_at IS NOT NULL`: return the original typed outcome with `AlreadyRestored`.
2. `purged_at IS NOT NULL`: return `PortErrorKind::Conflict`, ID `deletion_undo_expired`.
3. `database_now >= undo_expires_at`: invoke the selected D-05 finalizer, set `purged_at = database_now`, and return `deletion_undo_expired`.
4. Otherwise clear `study_sets.deleted_at` and `study_sets.deletion_id`, set `study_set_deletions.restored_at = database_now`, and return `Restored`.

A wrong user/set is `Unavailable` with no existence leak. A nonmatching deletion generation is `Conflict` with ID `deletion_generation_mismatch`. Invalid identifiers are `InvalidInput`. Restore never re-seeds, reconstructs, or accepts learner content from the request.

- [ ] **Step 6: Finalize expired operations with lazy and scheduled proof**

The Postgres finalizer claims at most the validated caller limit (never more than 100) per call:

```sql
SELECT deletion_id
FROM study_set_deletions
WHERE restored_at IS NULL
  AND purged_at IS NULL
  AND undo_expires_at <= clock_timestamp()
ORDER BY undo_expires_at, deletion_id
FOR UPDATE SKIP LOCKED
LIMIT $1;
```

For each claimed generation, run Task 9's selected D-05 finalizer and set `purged_at` in the same transaction. The override rejects limits outside `1..=100` before opening a transaction, applies the caller's smaller valid limit rather than always claiming 100, and returns the exact committed generation count. Restore itself performs the same expiry check/finalization, so a stale request never wins merely because the scheduled sweep has not run. Plan 08 calls the batch finalizer with `100` at durable startup, every five seconds while running, and before delete/restore/library responses. Thus the logical deadline is exact; physical purge occurs on the first post-deadline transaction and no later than the next five-second tick in a running service.

The memory implementation stores the same content-free operation tuple, uses a private injected-clock `_at` helper for tests, and applies restore/finalize under one state write lock.

- [ ] **Step 7: Prove D-05 interaction and tombstone minimization**

During the 30-second pending interval, learner content remains only in its original inaccessible rows to make restore possible; `study_set_deletions` contains only the six-field subject tuple plus `deleted_at`. Restore exposes no content. At expiry:

- D-05 `HARD_PURGE_TEXT` removes all learner-authored/derived text and retains only the content-free D-04/D-05 audit tombstones.
- D-05 `ENUMERATED_DERIVED_RETENTION` removes everything except its explicitly enumerated seven derived fields and content-free relational/audit metadata.

The canary test scans pending visibility, successful restore, expired Branch A purge, and expired Branch B enumerated retention. Seed replay refuses pending, restored-operation, and purged tombstone generations; it never resurrects a finalized set.

- [ ] **Step 8: Publish the typed restore handoff without owning HTTP**

Plan 09 publishes only the exact data input/output, half-open deadline, stable `PortErrorKind` plus safe error ID, and `finalize_expired_study_set_deletions(limit = 100)` scheduling requirement. It owns no HTTP route, request DTO, response mapping, browser capability, or service test.

The downstream contract is: Plan 08 alone owns `POST /v1/study-sets/{study_set_id}/restore`, whose HTTP JSON body contains only `{"deletion_id":"<uuid>"}`. Plan 08 derives internal `{ user_id, study_set_id, deletion_id }`; on success it returns the exact `RestoreStudySetOutcomeV1` body without collapsing `Restored` and `AlreadyRestored`, with HTTP `200` for either outcome. Only failures use Plan 08's coarse sanitized error mapping, without inspecting reason strings. Plan 11 alone owns any same-origin BFF and hashed, single-use browser restore capability. No capability/token is stored or interpreted by data.

- [ ] **Step 9: Run GREEN and concurrency repetition**

```bash
cargo test --manifest-path agent/Cargo.toml -p data study_set_restore_ -- --nocapture
for pass in 1 2 3 4 5 6 7 8 9 10; do DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_study_set_restore_and_expiry_purge_have_one_legal_winner -- --ignored --exact --test-threads=1 --nocapture || exit 1; done
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_study_set_restore_ -- --ignored --test-threads=1 --nocapture
```

Expected: exact deadline, idempotence, restart/two-instance visibility, one legal restore/purge winner, selected D-05 final state, and content-free deletion records.

- [ ] **Step 10: Commit bounded undo**

```bash
git add agent/migrations/0019_study_set_deletion_undo.sql agent/crates/data/src/postgres.rs agent/crates/data/src/memory.rs agent/crates/data/src/migrations.rs
git commit -m "feat(data): add durable bounded deletion undo"
```

---

### Task 11: Bound nonce retention without weakening replay defense (`DATA-008`)

**Files:**
- Modify: `agent/crates/data/src/postgres.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/migrations.rs`

- [ ] **Step 1: Write clock-boundary RED tests**

Add tests named exactly:

```rust
memory_nonce_prune_keeps_token_skew_boundary_and_rejects_live_replay
postgres_nonce_prune_keeps_token_skew_boundary_and_rejects_live_replay
postgres_nonce_prune_uses_existing_expiry_index
```

At `now=10_000`, prove:

- `expires_at=9_939` is pruned because `9_939 + 60 < 10_000`;
- `expires_at=9_940` is retained at the exact validity boundary;
- `expires_at=10_001` is retained;
- replay of either retained nonce is rejected;
- session/study deletion removes retained and expired nonce rows immediately.

- [ ] **Step 2: Run RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p data nonce_prune -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_nonce_prune_ -- --ignored --test-threads=1 --nocapture
```

Expected: the first command witnesses the memory backend's expired rows remaining; the second witnesses the Postgres backend's expired rows remaining.

- [ ] **Step 3: Prune opportunistically before an atomic claim**

Use the published 60-second session-token skew. Compute `exclusive_cutoff = now.saturating_sub(60)` once and perform the indexed prune, then the claim, inside the claim transaction.

Statement 1 — prune, bind `$1 = exclusive_cutoff`:

```sql
DELETE FROM voice_session_token_nonces
WHERE expires_at < $1;
```

Statement 2 — claim, binds `$1..$5 = user_id, study_set_id, voice_session_id, nonce, expires_at`:

```sql
INSERT INTO voice_session_token_nonces (
    user_id,
    study_set_id,
    voice_session_id,
    nonce,
    expires_at
)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT DO NOTHING;
```

Execute them as two prepared statements inside the same claim transaction; a zero-rows-affected claim insert (`ON CONFLICT DO NOTHING`) is the duplicate-nonce case and returns `PortErrorKind::Conflict`.

The in-memory public method obtains current epoch seconds once, calls a deterministic private `claim_session_token_nonce_at(claim, now)` under one write lock, retains rows whose `expires_at.saturating_add(60) >= now`, and then checks/inserts the new claim. Do not prune at `expires_at` alone because service verification permits the 60-second skew.

- [ ] **Step 4: Run GREEN and query-plan proof**

```bash
cargo test --manifest-path agent/Cargo.toml -p data nonce_prune -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_nonce_prune_ -- --ignored --test-threads=1 --nocapture
```

Expected: boundary behavior passes. The plan test loads enough expired/live rows to make index selection meaningful, runs `ANALYZE`, disables sequential scan only for the `EXPLAIN` assertion, and confirms `voice_session_token_nonces_expiry_idx` supports the exact `expires_at < $1` predicate.

- [ ] **Step 5: Commit nonce retention**

```bash
git add agent/crates/data/src/postgres.rs agent/crates/data/src/memory.rs agent/crates/data/src/migrations.rs
git commit -m "fix(data): prune expired nonce claims safely"
```

---

### Task 12: Make observe sanitation invariant under Unicode and deserialization (`DATA-006`, `DATA-007`)

**Files:**
- Modify: `agent/crates/observe/src/lib.rs`
- Modify: `agent/crates/observe/tests/evidence_detail.rs`

- [ ] **Step 1: Write hostile Unicode and JSON RED tests**

Add tests named exactly:

```rust
unicode_split_forbidden_marker_is_redacted_after_filtering
voice_evidence_event_deserialize_sanitizes_detail
voice_evidence_event_round_trip_preserves_only_sanitized_detail
provider_stage_failure_deserialize_keeps_kind_specific_cap
safe_unicode_filter_positive_control_is_not_redacted
```

Use at least:

```text
answer\u{200b}_text=NADH
session\u{2060}_token=viva1.payload.signature
source\u{feff}_excerpt_text=chapter
```

The safe positive control contains non-ASCII punctuation without a forbidden marker and must produce the filtered safe ASCII detail, not a false redaction.

- [ ] **Step 2: Run RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p observe --test evidence_detail -- --nocapture
```

Expected: the split marker is reassembled into current output, and raw JSON deserialization bypasses `VoiceEvidenceEvent::new`.

- [ ] **Step 3: Scan both raw and post-filter forms**

After preserving exact safe literals, build the allowed-character string, then run forbidden-marker and field-assignment detection against both the raw normalized form and the filtered normalized form. Return `redacted_evidence_detail` if either scan hits. Apply the per-kind character cap only after the second scan.

- [ ] **Step 4: Make the detail type sanitized by construction**

Keep `SanitizedEvidenceDetail`'s inner `String` private. Implement custom `Deserialize` for `VoiceEvidenceEvent` through a private raw helper:

```rust
#[derive(Deserialize)]
struct RawVoiceEvidenceEvent {
    kind: VoiceEvidenceEventKind,
    voice_session_id: Option<String>,
    detail: String,
}
```

`Deserialize` must call `VoiceEvidenceEvent::new(raw.kind, raw.voice_session_id, raw.detail)`. Keep `kind` and `voice_session_id` public for wire compatibility. Change public `detail` from `String` to `SanitizedEvidenceDetail`, keep its inner `String` private, implement transparent `Serialize`, `Deref<Target = str>`, `AsRef<str>`, and the required string `PartialEq` implementations so current read-only consumers compile, and expose no unchecked constructor. `VoiceEvidenceEvent::new` is the only kind-aware constructor and applies the 240/384 cap. Preserve the existing JSON field names and JSON string representation.

- [ ] **Step 5: Run GREEN plus downstream compile**

```bash
cargo test --manifest-path agent/Cargo.toml -p observe -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service --lib --no-run
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --no-run
```

Expected: hostile strings redact, safe controls filter, serialized shape is unchanged, and consumers compile against read-only access.

- [ ] **Step 6: Commit observe hardening**

```bash
git add agent/crates/observe/src/lib.rs agent/crates/observe/tests/evidence_detail.rs
git commit -m "fix(observe): enforce sanitation on every construction path"
```

---

### Task 13: Characterize once, then decompose both stores by invariant (`DATA-015`, `ARC-05`, `QLT-09`, `REL-07`)

**Order:** Begin only after Tasks 3–12 have completed and committed their correctness, privacy, and sanitation fixes on this lane. This task is a behavior-preserving refactor; it must not be used to smuggle in a fix, schema change, new port, new error, changed SQL, or changed lock order.

**Files:**
- Create: `agent/crates/data/src/memory/store_conformance.rs`
- Create: `agent/crates/data/src/memory/ingestion.rs`
- Create: `agent/crates/data/src/memory/learning.rs`
- Create: `agent/crates/data/src/memory/authorization.rs`
- Create: `agent/crates/data/src/memory/privacy.rs`
- Create: `agent/crates/data/src/postgres/ingestion.rs`
- Create: `agent/crates/data/src/postgres/learning.rs`
- Create: `agent/crates/data/src/postgres/authorization.rs`
- Create: `agent/crates/data/src/postgres/privacy.rs`
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/postgres.rs`

The shared test module lives under `memory/` only so `memory.rs` can declare it under `#[cfg(test)]` without changing `lib.rs`; it imports both crate-private backend types and is the single semantic suite. Production child modules are declared by their existing facade file. Public exports remain byte-for-byte where they are today.

- [ ] **Step 1: Record the pre-refactor concentration and method inventory**

Run from the repository root after all earlier tasks are green:

```bash
wc -l agent/crates/data/src/memory.rs agent/crates/data/src/postgres.rs agent/crates/data/src/migrations.rs
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+' agent/crates/data/src/memory.rs agent/crates/data/src/postgres.rs
rg -n 'impl StudyMemoryStore for|SELECT |INSERT INTO|UPDATE |DELETE FROM|transaction\(|write\(\)\.await' agent/crates/data/src/memory.rs agent/crates/data/src/postgres.rs
cargo test --manifest-path agent/Cargo.toml -p data -- --nocapture
```

Attach the raw output to the PR as the baseline. The reviewed snapshot was approximately 5,145 lines in `memory.rs` and 2,480 in `postgres.rs`, but execution records fresh counts after upstream Plans 03/04/06 and Tasks 1–12; the fresh numbers, not this planning estimate, are authoritative.

- [ ] **Step 2: Build one backend-parameterized characterization suite before moving code**

`memory/store_conformance.rs` defines one test-only scenario runner used by both adapters:

```rust
enum ConformanceBackend<'a> {
    Memory(&'a InMemoryStudyStore),
    Postgres(&'a PostgresStudyStore),
}

struct CanonicalStoreTrace {
    write_outcomes: Vec<StudyStoreWriteOutcome>,
    write_counts: StudyStoreWriteCounts,
    learning_evidence: SessionLearningEvidence,
    progression: Vec<QuestionProgressionResult>,
    projection: AuthenticatedStudyProjectionV1,
    error_kinds: Vec<PortErrorKind>,
    ordered_ids: Vec<String>,
}

async fn exercise_store_scenario(
    backend: ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
) -> CanonicalStoreTrace;
```

`CanonicalStoreFixture` is assembled from `agent/fixtures/learning-core/*.json`, fixed UUIDs, fixed RFC3339 memory time, and Postgres-returned times normalized only at the asserted time-policy boundary. Do not normalize away IDs, order, receipt `replayed`, `StudyStoreWriteOutcome`, counts, `PortErrorKind`, selected scheduling authority, D-04 generation/deadline state, or D-05 retained fields.

Add these exact tests:

```rust
store_conformance_harness_rejects_inverted_replay_outcome
memory_store_conformance_ingestion
memory_store_conformance_learning_and_progression
memory_store_conformance_authorization_and_nonces
memory_store_conformance_privacy_and_delete
memory_store_conformance_all_owned_ports
postgres_store_conformance_ingestion
postgres_store_conformance_learning_and_progression
postgres_store_conformance_authorization_and_nonces
postgres_store_conformance_privacy_and_delete
postgres_store_conformance_all_owned_ports
```

The same scenario functions cover: valid UTF-8 ingestion and all `pdf_ingestion_fails_closed_` cases; session insert/replay, usage insertion, exact counts, evaluation replay; all five Plan 06 learning overrides and complete `PersistedTurnOutcome` receipt; selected D-01 schedule/history behavior; deterministic authenticated projection and ordering; digest allow/deny across reconstruction; nonce claim/conflict/retention; deletion/write serialization; selected D-04 delete/restore/expiry behavior when Branch B is selected; selected D-05 canary retention, export/read exclusion, seed refusal, and idempotent tombstones. Postgres tests are `#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and DATABASE_URL"]` and call the Task 1 required harness; they never return early.

`store_conformance_harness_rejects_inverted_replay_outcome` passes a trace whose second session result is deliberately changed from `IdempotentReplay` to `Inserted` into the same comparison function and asserts an exact mismatch at `write_outcomes[1]`. This permanent self-test proves the suite detects semantic drift instead of merely exercising methods.

- [ ] **Step 3: Prove characterization GREEN on both unchanged facades and commit tests alone**

```bash
cargo test --manifest-path agent/Cargo.toml -p data memory_store_conformance_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data store_conformance_harness_rejects_inverted_replay_outcome -- --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_store_conformance_ -- --ignored --test-threads=1 --nocapture
git diff --check
git add agent/crates/data/src/memory.rs agent/crates/data/src/memory/store_conformance.rs
git commit -m "test(data): characterize shared store semantics"
```

Expected: both adapters produce the same canonical semantics before any extraction. If a difference appears, stop: repair it in the owning earlier correctness task and its own `fix(data): ...` commit, rerun all earlier acceptance tests, then regenerate this clean baseline. Do not weaken or conditionalize the shared expectation.

- [ ] **Step 4: Extract the ingestion subsystem without semantic edits**

Move file create/retry/classification, document/source-span derivation, ingestion cursor, concept/question generation, and ready/error state transitions into `memory/ingestion.rs` and `postgres/ingestion.rs`. The facades retain their existing `StudyMemoryStore` method signatures and delegate to crate-private helpers. The PDF classifier remains before decoding; SQL text, bind order, transaction boundary, ordering, error IDs, and returned records are copied unchanged.

```bash
cargo test --manifest-path agent/Cargo.toml -p data pdf_ingestion_fails_closed_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_store_conformance_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_store_conformance_ -- --ignored --test-threads=1 --nocapture
git diff --check
git add agent/crates/data/src/memory.rs agent/crates/data/src/memory/ingestion.rs agent/crates/data/src/postgres.rs agent/crates/data/src/postgres/ingestion.rs
git commit -m "refactor(data): extract ingestion store subsystem"
```

- [ ] **Step 5: Extract learner outcomes and progression without semantic edits**

Move canonical outcome plus transitions, challenge resolution, progression cursor, selected D-01 scheduling/history helper, learning evidence, and `AuthenticatedStudyProjectionV1` assembly into both `learning.rs` modules. Transaction-owning facade methods still call the existing transaction/locked helpers; do not split atomic outcome plus transition/disposition/cursor writes or add a parallel JSON schema.

```bash
cargo test --manifest-path agent/Cargo.toml -p data learning_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_learning_ports_override_fail_closed_defaults -- --exact --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_store_conformance_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_store_conformance_ -- --ignored --test-threads=1 --nocapture
git diff --check
git add agent/crates/data/src/memory.rs agent/crates/data/src/memory/learning.rs agent/crates/data/src/postgres.rs agent/crates/data/src/postgres/learning.rs
git commit -m "refactor(data): extract learning store subsystem"
```

- [ ] **Step 6: Extract authorization and nonce lifecycle without semantic edits**

Move digest canonicalization/hash/persist/check and nonce claim/prune/read logic into both `authorization.rs` modules. Keep the exact durable digest key, no raw payload, duplicate-nonce `Conflict`, expiry plus 60-second skew boundary, index predicate, and reconstruction/two-instance behavior.

```bash
cargo test --manifest-path agent/Cargo.toml -p data authorization -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data nonce -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_store_conformance_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_store_conformance_ -- --ignored --test-threads=1 --nocapture
git diff --check
git add agent/crates/data/src/memory.rs agent/crates/data/src/memory/authorization.rs agent/crates/data/src/postgres.rs agent/crates/data/src/postgres/authorization.rs
git commit -m "refactor(data): extract authorization store subsystem"
```

- [ ] **Step 7: Extract privacy, deletion, and restore without semantic edits**

Move ownership/deleted-state guards, usage/delete serialization, selected D-05 finalizer, canary inventory, seed/tombstone refusal helpers, and selected D-04 soft-delete/restore/expiry finalizer into both `privacy.rs` modules. Preserve the global lock order, database-time comparison, `FOR UPDATE SKIP LOCKED LIMIT 100`, exact retained-field inventory, and no-content tombstones. Facade methods remain the port boundary.

```bash
cargo test --manifest-path agent/Cargo.toml -p data selected_d05 -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data study_set_restore_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data memory_store_conformance_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_store_conformance_ -- --ignored --test-threads=1 --nocapture
git diff --check
git add agent/crates/data/src/memory.rs agent/crates/data/src/memory/privacy.rs agent/crates/data/src/postgres.rs agent/crates/data/src/postgres/privacy.rs
git commit -m "refactor(data): extract privacy store subsystem"
```

- [ ] **Step 8: Measure the result and account for every remaining concentration**

Re-run Step 1's measurements and attach a before/after table containing, for each facade and child module: lines, private/trait method count, SQL statement count, state-write/transaction entry count, and owned invariant. Mandatory ingestion, learning/progression, authorization/nonces, and privacy/delete extraction cannot be marked `DEFERRED`.

Any additional measured sub-split may be recorded `DEFERRED` only when the four mandatory extractions and shared suite are complete and the PR gives all of: exact remaining methods and line count, a concrete invariant-preservation reason, the dependency that makes moving them unsafe in this no-semantic-change task, the owning follow-up plan/issue, and the acceptance command. Allowed examples are keeping the public record/type declarations in `memory.rs` for export stability or keeping a transaction-owning trait facade together because Rust requires one trait impl block; “file still large,” “time,” and “future cleanup” are not reasons. No facade may retain the SQL or state-mutation implementation of one of the four extracted invariants.

Run the full ordinary data suite and one required Postgres conformance pass after the final move; Task 14 then runs every Postgres test twice from fresh containers.

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml -p data --all-targets -- -D warnings
cargo test --manifest-path agent/Cargo.toml -p data -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_store_conformance_ -- --ignored --test-threads=1 --nocapture
git diff --check review-remediation/integration...HEAD
```

Expected: the shared trace is unchanged, every mandatory subsystem has an invariant-owned memory/Postgres module, facade methods are thin delegates, and each refactor commit contains no behavioral or schema change.

---

### Task 14: Prove the full migration chain, backend conformance, and data-governance handoff

**Files:**
- Modify: `agent/crates/data/src/migrations.rs`
- Verify: all Plan 09-owned files
- Read-only handoff targets: Plan 08, Plan 11, Plan 12, Plan 15

- [ ] **Step 1: Add full-chain and historical-upgrade tests**

Add tests named exactly:

```rust
postgres_full_migration_chain_runs_from_empty_schema_twice_via_ledger
postgres_upgrade_0014_to_latest_preserves_rows_and_applies_cleanup
postgres_latest_schema_matches_migration_directory_and_privacy_inventory
postgres_memory_backend_full_store_conformance_matches
```

The 0014 upgrade test applies 0001–0014 with the raw helper in its isolated schema, inserts:

- duplicate/replayed historical records allowed by that point in the chain;
- values in all six unwritten columns;
- a recap large enough to exceed the obsolete multi-array index ceiling if it remained;
- live/deleted/canary rows covering both D-05 behavior and nonce/authorization tables.

Then apply `0015` through the final allocated migration once (`0018`, plus Task 10's decision-gated undo migration when `D-04 = SOFT_DELETE_UNDO`), assert final rows/indexes/columns — including, only when `D-04 = SOFT_DELETE_UNDO`, the content-free `study_set_deletions` inventory and its pending/expiry indexes — and run `sqlx::migrate!` twice against a separate empty schema to prove ledger idempotence. `postgres_memory_backend_full_store_conformance_matches` invokes the one Task 13 runner; it must not duplicate a second expectation table. Task 13's existing `postgres_store_conformance_all_owned_ports` is re-run, not re-added, as part of this task's full-chain proof.

- [ ] **Step 2: Run focused local Level 1 checks**

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml -p data -p observe --all-targets -- -D warnings
cargo test --manifest-path agent/Cargo.toml -p observe -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data -- --nocapture
git diff --check
```

Expected: PASS. Postgres tests appear as explicitly ignored in the ordinary unit invocation and are executed by the required durable command below.

- [ ] **Step 3: Run the entire real disposable Postgres suite twice**

Run this exact block from the repository root. The two passes use distinct containers, ports, databases, and per-test schemas.

```bash
set -euo pipefail

cleanup_viva_data_postgres() {
  docker rm --force viva-data-postgres-pass-1 >/dev/null 2>&1 || true
  docker rm --force viva-data-postgres-pass-2 >/dev/null 2>&1 || true
}
trap cleanup_viva_data_postgres EXIT

docker run --detach --rm \
  --name viva-data-postgres-pass-1 \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=viva \
  --env POSTGRES_PASSWORD=viva_test_only \
  --env POSTGRES_DB=viva_data_test \
  postgres:16-alpine

until docker exec viva-data-postgres-pass-1 pg_isready --username viva --dbname viva_data_test; do sleep 1; done

DATA_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test \
cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture

docker rm --force viva-data-postgres-pass-1

docker run --detach --rm \
  --name viva-data-postgres-pass-2 \
  --publish 127.0.0.1:55433:5432 \
  --env POSTGRES_USER=viva \
  --env POSTGRES_PASSWORD=viva_test_only \
  --env POSTGRES_DB=viva_data_test \
  postgres:16-alpine

until docker exec viva-data-postgres-pass-2 pg_isready --username viva --dbname viva_data_test; do sleep 1; done

DATA_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55433/viva_data_test \
cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture

docker rm --force viva-data-postgres-pass-2
trap - EXIT
```

Expected: both full executions PASS. The proof includes empty migration, 0014 upgrade, session/evaluation/outcome replay, exact counts, two-instance digest authorization, nonce boundary, usage/delete serialization, selected D-04 restore/expiry behavior when applicable, selected D-05 deletion, canary scan, restart, seed refusal, the shared decomposed-store conformance trace, typed parity/order, and large recap insertion. PDF rejection remains in the ordinary data suite because it is a memory ingestion boundary; its exact filter is reported alongside this durable evidence. If Docker or `DATABASE_URL` is unavailable, Plan 09 remains open; do not relabel the gate passed or skipped.

- [ ] **Step 4: Produce the exact owner handoffs**

Report these facts in the Plan 09 PR and central-ledger handoff; do not edit the other owners' files:

| Consumer | Exact handoff |
| --- | --- |
| Plan 08 | Normal Postgres startup runs migrations only; fixture seed is explicit test/dev-only. Consume Plan 06 outcomes/error kinds and never translate durability failure into success. PDF contract: run `pdf_ingestion_fails_closed_` and map typed `InvalidInput`/`unsupported_pdf` uniformly without reason matching. Under D-04 B, derive internal restore `{ user_id, study_set_id, deletion_id }`, return the exact success receipt/result without collapsing `Restored` versus `AlreadyRestored`, apply coarse mapping only to failures, consume both `study_set_restore_` and required-Postgres `postgres_study_set_restore_`, and invoke the bounded expiry finalizer with `100` at durable startup, every five seconds, and before delete/restore/library operations. Under D-04 A, import no restore type and start no finalizer. Plan 09 owns none of Plan 08's HTTP code. |
| Plan 11 | Consume the selected D-04/D-05 receipt and governance semantics through Plan 08. Under D-04 B, any BFF owns its hashed single-use browser capability; only `deletion_id` crosses to Plan 08 and no capability reaches data. Repeated pending delete returns the identical receipt; repeated completed restore returns `AlreadyRestored` with original `restored_at`; deleted/pending sessions and sets cannot accept new usage/outcomes. |
| Plan 12 | Required Postgres 16 job command is `DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture`; CI may substitute its own explicit disposable-Postgres URL, but an absent URL is failure. |
| Plan 15 | Governance/public docs must enumerate retained categories, nonce `expiry + 60s` retention, durable digest retention until close/delete, the selected D-04 pending-retention window and D-05 permanent result, canary proof, shared-store decomposition evidence, and the two-pass disposable Postgres evidence. |

If D-04 Branch B is selected, prepend this governance sentence: `For exactly 30 seconds after deletion, learner content remains inaccessible and excluded from reads/exports solely so the learner can undo; restore is legal only before the server-recorded deadline, and expiry makes deletion permanent under the selected retention policy.`

For `D-05` Branch A, the permanent-result governance sentence is: `Permanent study-set deletion removes learner-authored and learner-derived text; Viva retains only a scrubbed study-set tombstone and content-free deleted-session tombstones for idempotence and audit; when bounded undo is selected, its content-free deletion-operation tombstone also remains.`

For `D-05` Branch B, the permanent-result governance sentence is: `Permanent study-set deletion removes source and session data but indefinitely retains generated concepts (public_id, label, status) and inactive generated questions (question_id, prompt, expected_terms, follow_up); these fields are excluded from ordinary learner projections, and no administrative purge is part of the current product contract.`

- [ ] **Step 5: Run lane-wide review checks**

```bash
git status --short
git diff --stat review-remediation/integration...HEAD
git diff --check review-remediation/integration...HEAD
rg -n 'optional_postgres|let Some\(pool\).*else|return;.*DATABASE_URL' agent/crates/data/src/migrations.rs
rg -n 'ON CONFLICT \(id\) DO UPDATE|deleted_at = NULL' agent/crates/data/src/migrations.rs
```

Expected: only Plan 09-owned implementation files are changed; the first scan has no silent Postgres skip; fixture seeding has no resurrection update. These scans are hygiene controls, not substitutes for the behavioral tests.

- [ ] **Step 6: Obtain independent branch review and fix every Critical/Important finding**

Review must explicitly inspect:

- migration order and downgrade-free forward compatibility;
- PDF classification-before-decoding and absence of lossy ingestion;
- D-04 half-open deadline, generation binding, and restore/purge race when selected;
- `D-05` exact field retention;
- shared-suite strength and no-semantic-change store decomposition;
- transaction lock order/deadlock risk;
- replay and count truth under two instances;
- JSON typed serialization and raw-payload exclusion;
- Postgres error taxonomy;
- observe deserialization invariants;
- the twice-run disposable evidence.

Re-run focused tests after every fix and the complete two-pass Postgres block after the final fix.

- [ ] **Step 7: Commit final conformance evidence code**

```bash
git add agent/crates/data/src/migrations.rs
git commit -m "test(data): prove migration privacy and backend conformance"
```

## Completion gate

Plan 09 is complete only when:

- every `DATA-001` through `DATA-016` result above is behaviorally proven, with `DATA-016` executed only when D-04 selects `SOFT_DELETE_UNDO` and explicitly marked not applicable under `CONFIRM_DELETE`;
- Plan 04/06 contracts are consumed without a competing type or schema;
- selected `D-01`, `D-02`, `D-04`, and `D-05` branches are recorded and implemented exactly; no worker selects them;
- the one first-merged selected D-01 migration is `0015`, Plan 09 adds only `0016`–`0018` plus, when D-04 selects `SOFT_DELETE_UNDO`, Task 10's one decision-gated undo migration, and directory/include order matches;
- no PostgreSQL test silently returns because `DATABASE_URL` is absent;
- the complete disposable Postgres suite passes twice from fresh Postgres 16 containers;
- generated text/compressed/scanned/encrypted/malformed/magic-prefixed PDF rejection proves no artifacts and no lossy decoding, while valid non-PDF UTF-8 remains supported;
- deletion canary, D-04 restore/expiry when selected, restart, two-instance visibility, seed refusal, replay, counts, usage/delete serialization, multi-instance authorization, nonce retention, migration upgrade, large recap, typed projection/order, and observe hostile-deserialization tests pass;
- one shared memory/Postgres conformance suite is green before and after the four mandatory ingestion, learning/progression, authorization/nonces, and privacy/delete extractions, with every additional deferral carrying the required measurement and owner;
- Plan 08/11/12/15 handoffs are accepted by their owners;
- the branch is independently reviewed and clean against the integration tip.

Local unit green without the two real Postgres executions is not completion evidence.
