# Code Review: Rust data + observe crates and migrations

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | agent/crates/data/, agent/crates/observe/, agent/migrations/ |
| **Verdict** | sound-with-fixes |
| **Confidence** | High for source/schema findings; unknown for a live Postgres execution in this review |

This area holds Viva's persistence layer — the in-memory and Postgres `StudyMemoryStore` backends, the 14-migration schema, and the observe crate's sanitized evidence types. The layer is unusually disciplined: fail-closed authorization on every write, atomic ON CONFLICT replay guards with real concurrent tests, a schema statically asserted to exclude raw learner payloads, and row-level deletion proofs. Adversarial verification confirmed all thirteen first-pass findings against the source; none were refuted, none changed severity. The five important findings are targeted, not structural: the opt-in durable Postgres CI job cannot go green as composed, one write path missed the atomic replay-guard treatment, session replay inflates the BAC-520 session count on Postgres only, deletion tombstones rather than purges verbatim learner excerpts, and replay authorization state is process-local despite the durable backend.

## Strengths

- Atomic replay guards are done properly where implemented: migrations 0012/0013/0014 pair dedupe DELETEs with partial/unique indexes, and the Postgres write paths use ON CONFLICT plus xmax-based insert detection (`agent/crates/data/src/postgres.rs:2119-2154`, `2205-2226`, `2268-2303`), verified by genuine `tokio::join!` concurrent-replay tests (`agent/crates/data/src/migrations.rs:882-1220`).
- Sanitized-by-construction schema: `assert_schema_has_no_raw_payload_columns` (`agent/crates/data/src/migrations.rs:247-275`), the bounded-excerpt CHECK (0005), the digest-only policy CHECK (0011), and `PersistedAnswerEvaluation` deliberately dropping `answer_text` (`agent/crates/data/src/memory.rs:208-227`) all match the claims in `docs/data-governance.md`.
- Fail-closed authorization is consistent across both backends: every write validates study-set ownership, open-session scoping, and canonical source-tuple equality against deterministic retrieval (`agent/crates/data/src/memory.rs:2549-2606`, `agent/crates/data/src/postgres.rs:1565-1618`), with per-field forgery-rejection tests.
- Migration include-list drift is guarded by `migration_include_list_matches_directory_order` (`agent/crates/data/src/migrations.rs:348-372`), keeping the embedded `MIGRATIONS` constant honest against the directory.
- Deletion proofs assert real row-level state — nonce rows, usage rows, and `concept_status_events` purged; the deleted-session tombstone preserved — in both backends (`agent/crates/data/src/migrations.rs:1222-1441`, `agent/crates/data/src/memory.rs:3352-3412`), runnable exactly as documented in `docs/data-governance.md`.
- Evidence-detail sanitization is allowlist-first (ASCII character filter plus length cap) with a marker denylist backstop and per-kind caps, covered by real unit tests (`agent/crates/observe/src/lib.rs:105-192`, `agent/crates/observe/tests/evidence_detail.rs`).

## Findings

### Important

**1. Opt-in durable Postgres test suite is self-conflicting on a shared DATABASE_URL**

`agent/crates/data/src/migrations.rs:1063-1168` (helpers at `1454-1474`), `.github/workflows/validate.yml` durable job

**What**: `optional_postgres_session_recap_backfill_dedupes_existing_session_rows_when_database_url_is_set` applies migrations 0001-0013 via raw SQL (`run_migrations_until` / `apply_migration_sql`), bypassing sqlx's `_sqlx_migrations` ledger, while every other optional_postgres test initializes the same database via `sqlx::migrate!` (`run_migrations`, migrations.rs:67-69). 0001 has no `IF NOT EXISTS` on any `CREATE TABLE`, so whichever path touches the database second fails with "relation study_sets already exists": raw-first leaves the ledger empty so the migrator re-runs 0001; migrator-first makes the raw replay of 0001 collide. CI's durable job runs all of these tests in one invocation against the single `viva_test` database, and cargo's default parallel test execution additionally lets tests mutate shared fixture rows concurrently (whole-table `db_row_counts` deltas, `set_question_active(false)` at migrations.rs:1603 flipping the fixture question under a concurrently running `replay_counted_provider_turn`).

**Why it matters**: The workflow-dispatch "Opt-in durable Postgres proof" job — the release-evidence path for durable-store correctness — cannot go green as written, and a developer setting `DATABASE_URL` locally hits the same nondeterministic failures from `cargo test -p data`. Because the default gates skip these tests without `DATABASE_URL`, the breakage is invisible to the green suite.

**Fix**: Give the 0014 backfill test its own database or uniquely-named schema (or derive a second database from `DATABASE_URL` and drop/recreate it), and run the durable job with `--test-threads=1` or make each optional test operate on isolated fixture rows.

**2. record_answer_evaluation compat insert lacks the atomic replay guard**

`agent/crates/data/src/postgres.rs:1958-2031`

**What**: The evaluation-only fallback path does UPDATE, then a separate EXISTS check, then a plain INSERT with no ON CONFLICT clause and no transaction. Concurrent replays of the same `(voice_session_id, response_id)` when no envelope row exists both observe `rows_affected == 0` and `existing_response == false`, and both INSERT; the loser hits the `answer_attempts_voice_session_response_id_idx` unique index (0011:44) and surfaces a raw duplicate-key adapter error. A concurrent `record_answer_attempt_envelope` landing in the check-to-insert window fails the same way.

**Why it matters**: This is exactly the concurrent-replay scenario migrations 0012/0013 and the ON CONFLICT patterns were built to make idempotent for review items, recaps, and concept statuses; the evaluation compat path is the one write left on the check-then-act pattern, and unlike the other three it has no `tokio::join!` concurrency test (migrations.rs:882-1220).

**Fix**: Mirror `record_answer_attempt_envelope`: INSERT ... ON CONFLICT (voice_session_id, response_id) DO NOTHING first, and on zero rows fall back to the UPDATE/verify path; add a concurrent-replay test like the other three writes have.

**3. record_voice_session over-counts sessions on replay, diverging from BAC-520 exact counts**

`agent/crates/data/src/postgres.rs:619-643`

**What**: The INSERT ... ON CONFLICT (id) DO UPDATE returns `rows_affected == 1` for the update path (a re-record of a still-open session, e.g. a reconnect or replayed session start — an input the conditional DO UPDATE deliberately accepts), and `increment_count(WriteCountKind::Session)` runs unconditionally. The DB stays at one row while the counter reaches two. The in-memory backend does not drift: `save()` retains+pushes (`agent/crates/data/src/memory.rs:1876-1888`) and `write_counts()` reports `sessions.len()` (memory.rs:1905-1914).

**Why it matters**: BAC-520's contract is exact write counts with DB-row parity (the count-truth-table tests assert `write_counts` deltas equal `db_row_counts` deltas); a session-start replay silently inflates the sessions count in StoreCounts evidence on the Postgres backend only, and no existing scenario replays `record_voice_session`, so the tests cannot catch it.

**Fix**: Use `RETURNING (xmax = '0'::xid) AS inserted` — the `record_recap` pattern at postgres.rs:2287 — and increment the session count only when `inserted` is true.

**4. Deletion is soft-delete for the most sensitive learner text, with no purge path**

`agent/crates/data/src/postgres.rs:1221-1345`

**What**: `delete_study_set` only sets `deleted_at` on `source_spans` (verbatim learner excerpts, up to 1000 chars each) and `study_documents`; `concepts.label`, `study_questions.prompt/expected_terms/follow_up` (all derived from learner notes), and `study_sets.title/course` are never deleted at all. No job ever hard-deletes tombstoned rows — the only hard DELETEs of these tables live in `retry_file_study_set` (postgres.rs:899-922), a re-ingestion path, not a deletion path. `docs/data-governance.md` states the durable store retains data "until a tester deletion action runs", but the deletion action leaves the excerpt text in the database indefinitely.

**Why it matters**: A tester who runs "Delete This Tester's Session Data" reasonably expects their pasted-notes excerpts to be gone; today they are only hidden from queries. The governance doc's deletion contract does say "tombstones documents and source spans", so the disclosure is partial — but the retention paragraph promises retention only until deletion runs, and nothing ever purges. The schema makes hard delete safe: `answer_attempts.source_span_id` and `concepts.source_span_id` are ON DELETE SET NULL, and the set's session artifacts are already deleted in the same transaction.

**Fix**: Hard-DELETE tombstoned `source_spans` (and optionally the concepts/study_questions rows, or scrub their text columns) in `delete_study_set`, or add a purge sweep; at minimum amend data-governance.md to disclose that deletion tombstones rather than removes excerpt text.

**5. Event authorizations are process-local memory even on the durable backend**

`agent/crates/data/src/postgres.rs:27-32, 106-161, 1565-1679`

**What**: `PostgresStudyStore` keeps `event_authorizations` in an `Arc<RwLock<Vec<...>>>`. `authorize_answer_evaluation` / `authorize_concept_status` / `authorize_recap` require a record pushed by the matching `record_*` call in the same process; `authorize_concept_status` never consults the durable `concept_status_events` table even though it stores the identical `payload_sha256` tuple. The Vec also grows unboundedly within long sessions — the record paths push a duplicate record on every replay (postgres.rs:2145-2152, 2181-2188) — with an O(n) `contains` scan per authorization.

**Why it matters**: After an agent restart, or in any multi-instance deployment, browser event replays that correspond to real durable rows are rejected (fail-closed, so not a security hole, but a functional break for session resume against a backend that advertises `durable: true` in its capabilities at postgres.rs:506-516).

**Fix**: Back `has_event_authorization` with the durable digest — query `concept_status_events` for concept statuses and add equivalent digest tables or columns for evaluation and recap authorizations; dedupe the pushes; or document the single-instance constraint if it is intentional.

### Minor

**1. Redaction marker scan runs before the character filter and can be reassembled around**

`agent/crates/observe/src/lib.rs:113-134`

**What**: `SanitizedEvidenceDetail::from_raw_with_max` checks `contains_forbidden_evidence_detail_marker` on the raw string, then filters to an ASCII allowlist. A forbidden marker split by a non-ASCII character (e.g. a zero-width space inside "answer_text") passes the marker check, and the filter then removes the splitter, reassembling the forbidden marker in the sanitized output. The field-assignment scan already re-scans a filtered string (lib.rs:172-181); the marker scan does not.

**Why it matters**: This is the primary runtime redaction backstop per `docs/data-governance.md`; provider error strings are untrusted input and can legitimately contain unusual Unicode.

**Fix**: Run the marker scan on the post-filter string (or on both the raw and filtered forms) before returning.

**2. VoiceEvidenceEvent's sanitization is bypassable via public fields and Deserialize**

`agent/crates/observe/src/lib.rs:83-103`

**What**: `detail` is a pub field and the struct derives `Deserialize`, so struct-literal construction and JSON round-trips skip the sanitizing `new()` constructor. All current in-repo constructions use `new()`, but nothing enforces it.

**Why it matters**: The "structural allowlist serialization as the primary defense" claim in data-governance.md depends on `new()` being the only entry point; imported or replayed evidence JSON re-enters the type unsanitized.

**Fix**: Make the fields private with read accessors, or apply `sanitize_evidence_detail_for_kind` in a custom `Deserialize` impl.

**3. Expired session-token nonces are never cleaned up; expiry index is dead**

`agent/migrations/0010_voice_session_token_nonces.sql:1-12`

**What**: `voice_session_token_nonces` rows persist until an explicit session/set deletion; no code in data or agent-service deletes rows by `expires_at`, so `voice_session_token_nonces_expiry_idx` supports a sweep that does not exist. The in-memory equivalent (`agent/crates/data/src/memory.rs:2035-2061`) likewise grows unboundedly with an O(n) replay scan.

**Why it matters**: Unbounded table growth in production for rows that carry no value after token expiry, and slight drift from the data-minimization posture of the governance doc.

**Fix**: Add a periodic `DELETE FROM voice_session_token_nonces WHERE expires_at < extract(epoch from now())` — opportunistically on claim, or a startup/interval sweep.

**4. 0013 payload unique index is superseded by 0014 but never dropped**

`agent/migrations/0014_session_recaps_one_row_per_session.sql:11-12`

**What**: `session_recaps_voice_session_payload_idx` (0013, a unique btree over five array columns) is strictly implied by 0014's `session_recaps_voice_session_unique_idx`, yet no migration drops it.

**Why it matters**: The dead index costs every recap write and, being a btree over TEXT[]/UUID[] payloads, imposes an index-row size ceiling (~2.7KB) that could make a recap INSERT fail for long concept-label arrays even though the real one-row-per-session constraint would accept it.

**Fix**: Add a migration: `DROP INDEX IF EXISTS session_recaps_voice_session_payload_idx;`.

**5. record_voice_usage deleted-session check races with deletion**

`agent/crates/data/src/postgres.rs:2322-2395`

**What**: The `SELECT status = 'deleted'` guard and the subsequent INSERT are separate statements with no transaction; a `delete_session_history` committing between them leaves a `voice_usage_events` row for a deleted session — the exact state the optional_postgres privacy test asserts cannot exist (migrations.rs:1298-1325 verifies only the sequential case).

**Why it matters**: Small window, but it silently violates the deletion contract in data-governance.md (usage rows removed on session deletion), and nothing sweeps orphans afterwards.

**Fix**: Collapse to one statement — `INSERT ... SELECT $bindings WHERE EXISTS (SELECT 1 FROM voice_sessions WHERE id = $2 AND status <> 'deleted')` — or add an FK plus a re-sweep at the end of the deletion transaction.

**6. study_context and library ordering diverge between backends**

`agent/crates/data/src/memory.rs:2228-2235, 2382-2386`

**What**: In-memory `study_context` serializes `StudySetRecord`/`StudyDocumentRecord`/`SourceSpanRecord` shapes (study_set_id, title, full source with excerpt, full StudyQuestion objects) while Postgres builds a different JSON shape (id, display_name, no excerpt — postgres.rs:947-1011). The only consumer, `server_active_concepts` (agent-service/src/ws.rs:2795-2812), tolerates both by probing `public_id`/`id`. Separately, in-memory `library_snapshot` orders sessions by `voice_session_id` string descending as a recency proxy while Postgres orders by `started_at DESC` (postgres.rs:1124) — effectively random ordering for UUID session ids.

**Why it matters**: The untyped `Value` contract invites silent drift between backends, and the ordering divergence produces visibly different library session order depending on the configured store.

**Fix**: Define a typed StudyContext struct both backends serialize, and record a created-at ordinal in `VoiceSessionRecord` so the in-memory snapshot can sort by actual recency.

**7. In-memory record_voice_session check-then-act race can reopen a closed session**

`agent/crates/data/src/memory.rs:2002-2033`

**What**: Validation (closed-session and ownership checks) runs under a read lock that is released before `save()` reacquires a write lock and unconditionally retains+pushes a fresh `status='open'` record (memory.rs:1876-1888). A `close_voice_session` interleaved between the two replaces the closed record with an open one — the exact transition the Postgres backend prevents atomically via its conditional DO UPDATE (postgres.rs:622-626).

**Why it matters**: In-memory is the default non-durable backend used in dev/synthetic mode; the guard that "closed voice session cannot be reopened" is advisory rather than enforced there.

**Fix**: Hold a single write lock across the existence/status check and the insert (inline save's logic under one lock).

**8. Never-written answer_attempts columns: provider_attempt_id, terminal_reason, failure_class, stage, retry_eligible, concept_id**

`agent/migrations/0011_answer_attempt_envelopes.sql:18-24`

**What**: 0011 adds `provider_attempt_id`/`terminal_reason`/`failure_class`/`stage`/`retry_eligible` to `answer_attempts`, and 0001 gave it `concept_id`, but neither answer_attempts INSERT in postgres.rs (envelope at 1822, compat at 1997) nor any other code in the agent workspace ever binds these columns — failure-class data flows only through evidence events per `docs/provider-failure-observability.md`.

**Why it matters**: Dead schema misleads readers into thinking per-attempt failure classification is persisted; drift between the schema's implied contract and the actual observability path.

**Fix**: Either wire the BAC-510 failure fields into the attempt-failure write path, or drop the columns in a follow-up migration and rely on the documented evidence-event channel.

## Verification notes

No findings were refuted or downgraded; all five important findings and, on spot-check, all eight minor findings reproduced directly from the cited source.

- Important-1: confirmed 0001 has no IF NOT EXISTS, the backfill test bypasses the `_sqlx_migrations` ledger while its peers use `sqlx::migrate!`, and the durable CI job runs everything in one invocation against one database — either interleaving order fails.
- Important-4: the candidate refutation — hard DELETEs of source_spans/concepts/study_questions at postgres.rs:899-922 — turned out to be `retry_file_study_set` (re-ingestion), not a deletion path; the finding stands, with the softening note that data-governance.md's deletion contract does say "tombstones".
- Important-3: verified the in-memory side does not drift (`write_counts` reports `sessions.len()`), so the over-count is Postgres-only, breaking cross-backend parity as claimed.
- Minor-1: traced the exact bypass — the marker scan runs on the raw string only, while the field-assignment scan already demonstrates the post-filter re-scan pattern the marker scan lacks.

## Recommendations

1. Isolate the durable Postgres proof: per-test schema/database for the 0014 backfill test, `--test-threads=1` for the durable CI job — and actually exercise the job, since it is workflow_dispatch-only today and its breakage is invisible.
2. Extend the ON CONFLICT atomic replay-guard pattern to the `record_answer_evaluation` compat insert and add a concurrent-replay test for it, completing the BAC-520 set.
3. Make `record_voice_session` count only true inserts (the xmax pattern already in this file) so StoreCounts evidence stays exact under session-start replay.
4. Decide hard-purge semantics for tombstoned learner excerpts and derived text (concept labels, question prompts, set titles); implement a purge in `delete_study_set` or amend data-governance.md to disclose tombstone retention explicitly.
5. Persist event-authorization digests durably (`concept_status_events` already models the shape) so restart/multi-instance deployments don't fail closed on event replay; dedupe the in-memory Vec meanwhile.
6. Add an expired-nonce sweep using the existing `voice_session_token_nonces_expiry_idx`.
7. Ship a cleanup migration: drop the superseded `session_recaps_voice_session_payload_idx` and the never-written `answer_attempts` columns.
8. Harden `SanitizedEvidenceDetail`: run the marker scan after (or additionally after) the character filter, and close the pub-field/Deserialize bypass around `VoiceEvidenceEvent::new`.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first-pass reviewer; verification confirmed every finding without refutation or severity change).

This persistence layer substantiates most of what `docs/data-governance.md` claims: fail-closed authorization on every write, atomic replay guards with genuine concurrent tests, a schema statically asserted to exclude raw learner payloads, and deletion proofs that check actual rows. The confirmed findings are targeted rather than structural — a self-conflicting opt-in test suite, one write path missing the established replay-guard pattern, a Postgres-only count inflation, tombstone-not-purge deletion for the most sensitive text, and process-local replay authorization — and all are fixable incrementally without redesign. Nothing found risks losing committed data or leaking learner content through the primary sanitized paths.
