use agent_domain::PortError;
use sqlx::{migrate::MigrateError, PgPool};
use thiserror::Error;
use uuid::Uuid;

use crate::InMemoryStudyStore;

pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_init.sql",
        include_str!("../../../migrations/0001_init.sql"),
    ),
    (
        "0002_session_indexes.sql",
        include_str!("../../../migrations/0002_session_indexes.sql"),
    ),
    (
        "0003_voice_telemetry.sql",
        include_str!("../../../migrations/0003_voice_telemetry.sql"),
    ),
    (
        "0004_session_recaps.sql",
        include_str!("../../../migrations/0004_session_recaps.sql"),
    ),
    (
        "0005_public_ids_and_bounded_sources.sql",
        include_str!("../../../migrations/0005_public_ids_and_bounded_sources.sql"),
    ),
    (
        "0006_usage_cost_estimate.sql",
        include_str!("../../../migrations/0006_usage_cost_estimate.sql"),
    ),
    (
        "0007_voice_session_terminal_reason.sql",
        include_str!("../../../migrations/0007_voice_session_terminal_reason.sql"),
    ),
    (
        "0008_ingestion_status_and_generated_questions.sql",
        include_str!("../../../migrations/0008_ingestion_status_and_generated_questions.sql"),
    ),
    (
        "0009_review_items_voice_session.sql",
        include_str!("../../../migrations/0009_review_items_voice_session.sql"),
    ),
    (
        "0010_voice_session_token_nonces.sql",
        include_str!("../../../migrations/0010_voice_session_token_nonces.sql"),
    ),
    (
        "0011_answer_attempt_envelopes.sql",
        include_str!("../../../migrations/0011_answer_attempt_envelopes.sql"),
    ),
    (
        "0012_review_items_atomic_replay_guard.sql",
        include_str!("../../../migrations/0012_review_items_atomic_replay_guard.sql"),
    ),
    (
        "0013_recap_and_concept_status_atomic_replay_guard.sql",
        include_str!("../../../migrations/0013_recap_and_concept_status_atomic_replay_guard.sql"),
    ),
    (
        "0014_session_recaps_one_row_per_session.sql",
        include_str!("../../../migrations/0014_session_recaps_one_row_per_session.sql"),
    ),
    (
        "0015_review_schedule_decisions_v1.sql",
        include_str!("../../../migrations/0015_review_schedule_decisions_v1.sql"),
    ),
    (
        "0016_durable_event_authorization_digests.sql",
        include_str!("../../../migrations/0016_durable_event_authorization_digests.sql"),
    ),
    (
        "0017_privacy_tombstone_and_schema_cleanup.sql",
        include_str!("../../../migrations/0017_privacy_tombstone_and_schema_cleanup.sql"),
    ),
    (
        "0018_learning_turn_outcomes.sql",
        include_str!("../../../migrations/0018_learning_turn_outcomes.sql"),
    ),
];

pub async fn run_migrations(pool: &PgPool) -> Result<(), MigrateError> {
    sqlx::migrate!("../../migrations").run(pool).await
}

/// Seed the development fixture into a clean schema.
///
/// `COR-03`/`SEC-03`: this is insert-only. It refuses outright when any fixture
/// root already exists — including a `HARD_PURGE_TEXT` tombstone — so seeding can
/// never clear `deleted_at`, reactivate a question, overwrite a concept status, or
/// otherwise put deleted learner material back. Normal durable startup must call
/// [`run_migrations`] alone; this belongs to an explicit development or test
/// entrypoint.
pub async fn seed_postgres_fixture(pool: &PgPool) -> Result<(), FixtureSeedError> {
    let study_set_id = fixture_uuid("biology-midterm")?;
    let document_id = fixture_uuid("lec-5")?;
    let source_id = fixture_uuid("src-lecture-5-slide-18")?;
    let source = agent_domain::fixture_source_reference();
    let mut tx = pool.begin().await?;

    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('viva_postgres_fixture_seed'))")
        .execute(&mut *tx)
        .await?;

    // Every fixture root is checked behind the same advisory lock that serializes
    // the insert, so two concurrent seeds cannot both see "absent".
    for (entity, exists_sql) in [
        (
            "study_sets",
            "SELECT EXISTS(SELECT 1 FROM study_sets WHERE id = $1)",
        ),
        (
            "study_documents",
            "SELECT EXISTS(SELECT 1 FROM study_documents WHERE id = $1)",
        ),
        (
            "source_spans",
            "SELECT EXISTS(SELECT 1 FROM source_spans WHERE id = $1)",
        ),
    ] {
        let id = match entity {
            "study_sets" => study_set_id,
            "study_documents" => document_id,
            _ => source_id,
        };
        let exists = sqlx::query_scalar::<_, bool>(exists_sql)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if exists {
            tx.rollback().await?;
            return Err(FixtureSeedError::ExistingFixture {
                entity,
                id: id.to_string(),
            });
        }
    }

    sqlx::query(
        "INSERT INTO study_sets (id, user_id, title, course, ingestion_status, ingestion_error)
         VALUES ($1, 'user-1', 'Biology Midterm', 'Biology 201', 'ready', NULL)",
    )
    .bind(study_set_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO study_documents (id, study_set_id, display_name, source_kind, processing_status, deleted_at)
         VALUES ($1, $2, 'Lecture 5 - Electron Transport.pdf', 'pdf', 'ready', NULL)",
    )
    .bind(document_id)
    .bind(study_set_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO source_spans (
             id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL)",
    )
    .bind(source_id)
    .bind(document_id)
    .bind(serde_json::json!({ "span": source.span }))
    .bind(source.excerpt)
    .bind(source_confidence_str(&source.confidence))
    .bind(source.retrieval_reason)
    .execute(&mut *tx)
    .await?;

    for (public_id, label, status, concept_uuid) in [
        (
            "oxidative-phosphorylation",
            "Oxidative phosphorylation",
            "shaky",
            "55555555-5555-4555-8555-555555555555",
        ),
        (
            "nadh",
            "NADH",
            "review",
            "66666666-6666-4666-8666-666666666666",
        ),
        (
            "atp-synthase",
            "ATP synthase",
            "review",
            "77777777-7777-4777-8777-777777777777",
        ),
        (
            "cellular-respiration",
            "Cellular respiration",
            "shaky",
            "88888888-8888-4888-8888-888888888888",
        ),
    ] {
        sqlx::query(
            "INSERT INTO concepts (id, study_set_id, label, status, source_span_id, public_id)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(parse_uuid(concept_uuid)?)
        .bind(study_set_id)
        .bind(label)
        .bind(status)
        .bind(source_id)
        .bind(public_id)
        .execute(&mut *tx)
        .await?;
    }

    let question = agent_domain::fixture_question();
    sqlx::query(
        "INSERT INTO study_questions (
             id, study_set_id, question_id, source_span_id, prompt, expected_terms, follow_up,
             active, ingestion_ordinal, concept_id, rubric_json
         )
         VALUES (
             '99999999-9999-4999-8999-999999999999',
             $1,
             'q-oxidative-phosphorylation-nadh',
             $2,
             $3,
             $4,
             $5,
             TRUE,
             1,
             $6,
             $7
         )",
    )
    .bind(study_set_id)
    .bind(source_id)
    .bind(question.prompt)
    .bind(question.expected_terms)
    .bind(question.follow_up)
    .bind(question.concept_id)
    .bind(serde_json::to_value(question.rubric).map_err(FixtureSeedError::Json)?)
    .execute(&mut *tx)
    .await?;

    // The fixture's single question owns ordinal 1, so the next generated question
    // for this set is numbered 2.
    sqlx::query(
        "INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
         VALUES ($1, 2)",
    )
    .bind(study_set_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub fn migration_sql() -> String {
    MIGRATIONS
        .iter()
        .map(|(name, sql)| format!("-- {name}\n{sql}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Error)]
pub enum FixtureSeedError {
    /// A fixture root — including a deletion tombstone — is already present.
    ///
    /// `COR-03`/`SEC-03`: seeding refuses rather than writing over it, so deleted
    /// learner material can never be resurrected by a seed.
    #[error("fixture {entity} row {id} already exists; seeding refuses to overwrite it")]
    ExistingFixture { entity: &'static str, id: String },
    #[error("fixture id mapping failed: {0}")]
    FixtureId(#[from] PortError),
    #[error("fixture UUID failed to parse: {0}")]
    Uuid(#[from] uuid::Error),
    #[error("fixture seed SQL failed: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("fixture seed JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

/// Accepts either a fixture logical id or an already-real UUID, exactly as the
/// production store's own id resolution does. A test that creates a second session
/// with a real UUID must be able to query for it.
fn fixture_uuid(logical_id: &str) -> Result<Uuid, FixtureSeedError> {
    if let Ok(uuid) = logical_id.parse() {
        return Ok(uuid);
    }
    Ok(InMemoryStudyStore::fixture_id_translation(logical_id)?.storage_uuid)
}

fn parse_uuid(value: &str) -> Result<Uuid, FixtureSeedError> {
    Ok(value.parse()?)
}

fn source_confidence_str(confidence: &agent_domain::SourceConfidence) -> &'static str {
    match confidence {
        agent_domain::SourceConfidence::High => "high",
        agent_domain::SourceConfidence::Medium => "medium",
        agent_domain::SourceConfidence::Low => "low",
    }
}

pub fn assert_schema_has_no_raw_payload_columns() -> Result<(), String> {
    let sql = migration_sql().to_ascii_lowercase();
    for forbidden in [
        "raw_audio",
        "audio_blob",
        "audio_bytes",
        "document_blob",
        "document_bytes",
        "source_file_bytes",
        "answer_text",
        "prompt_text",
        "raw_prompt",
        "raw_transcript",
        "transcript_text",
        "answer_transcript",
        "source_excerpt",
        "recap_text",
    ] {
        if sql.contains(forbidden) {
            return Err(format!(
                "migration schema contains forbidden payload column: {forbidden}"
            ));
        }
    }
    if sql.contains("excerpt text") && !sql.contains("char_length(excerpt) <= 1000") {
        return Err("migration schema contains an unrestricted excerpt column".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{validate_challenge_resolution, validate_turn_outcome};
    use crate::PostgresStudyStore;
    use agent_domain::{
        fixture_question, fixture_source_reference,
        learning_recap::{
            RecapConceptOutcome, RecapSourceMoment, ReviewScheduleAuthority, ReviewScheduleSummary,
            VIVA_STUDY_SESSION_RECAP_SCHEMA,
        },
        AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
        AnswerEvaluation, ChallengeResolution, ConceptStatus, PersistedTurnOutcome, PortErrorKind,
        ProgressionPolicyId, QuestionProgressionCursor, QuestionProgressionResult,
        ReviewScheduleDecisionV1, SessionConfig, SessionId, SessionLearningEvidence,
        SessionTokenNonceClaim, StudyMemoryStore, StudyMode, StudyQuestion, StudySessionRecap,
        StudySourceReference, StudyStoreWriteCounts, StudyStoreWriteOutcome, TurnOutcome,
        TurnResolution, VoiceUsageRecord,
    };
    use serde::Deserialize;
    use std::sync::Arc;

    /// The environment contract for the required PostgreSQL suite, as a pure
    /// function of its two inputs.
    ///
    /// There is deliberately no `Option` anywhere in the result: the only two
    /// answers are a usable URL or a reason the run cannot proceed. `Ok(None)` is
    /// what the old helper returned, and it is what let a suite that proved nothing
    /// report success.
    fn postgres_environment_contract(
        required: bool,
        database_url: Option<&str>,
    ) -> Result<String, String> {
        let url = database_url
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match (required, url) {
            (_, Some(url)) => Ok(url.to_owned()),
            (true, None) => {
                Err("DATA_POSTGRES_REQUIRED=1 requires a non-empty DATABASE_URL".to_owned())
            }
            (false, None) => Err(
                "a PostgreSQL test requires DATA_POSTGRES_REQUIRED=1 and a non-empty DATABASE_URL"
                    .to_owned(),
            ),
        }
    }

    /// The process-environment wrapper around that contract.
    ///
    /// It never returns an `Option` and never returns early: a PostgreSQL test that
    /// reaches this line either gets a URL or fails loudly.
    fn required_postgres_url() -> String {
        let required =
            std::env::var("DATA_POSTGRES_REQUIRED").is_ok_and(|value| value.trim() == "1");
        let database_url = std::env::var("DATABASE_URL").ok();
        match postgres_environment_contract(required, database_url.as_deref()) {
            Ok(url) => url,
            Err(reason) => panic!("{reason}"),
        }
    }

    /// One disposable PostgreSQL schema per test case.
    ///
    /// `DATA-001`: the sqlx ledger, the seeded fixture ids, whole-table counters, and
    /// question activity are all per-schema, so two cases running against the same
    /// database cannot see each other's rows or convince each other that a migration
    /// has already run.
    struct PostgresSchemaFixture {
        admin_pool: sqlx::PgPool,
        pool: sqlx::PgPool,
        /// Always self-generated as `viva_data_test_{uuid simple}`; never derived
        /// from test input, and never rebuilt or truncated after creation.
        schema_name: String,
    }

    impl PostgresSchemaFixture {
        /// A fresh schema with the full sqlx-ledger migration chain applied.
        async fn migrated() -> Self {
            let fixture = Self::empty().await;
            run_migrations(&fixture.pool)
                .await
                .expect("migrations apply inside the isolated schema");
            fixture
        }

        /// A fresh, empty schema for the raw historical-backfill path.
        async fn empty() -> Self {
            let database_url = required_postgres_url();
            let admin_pool = crate::connect_pg(&crate::PgConfig::new(database_url.clone()))
                .await
                .expect("DATABASE_URL connects for the required postgres suite");
            let schema_name = format!("viva_data_test_{}", Uuid::new_v4().simple());
            sqlx::raw_sql(&format!("CREATE SCHEMA \"{schema_name}\""))
                .execute(&admin_pool)
                .await
                .expect("isolated test schema is created");

            // The callback closes over the one quoted identifier this fixture owns.
            // It never reconstructs or truncates the name.
            let search_path = format!("SET search_path TO \"{schema_name}\"");
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(5)
                .after_connect(move |connection, _meta| {
                    let search_path = search_path.clone();
                    Box::pin(async move {
                        use sqlx::Executor as _;
                        connection.execute(search_path.as_str()).await?;
                        Ok(())
                    })
                })
                .connect(&database_url)
                .await
                .expect("isolated schema pool connects");

            Self {
                admin_pool,
                pool,
                schema_name,
            }
        }

        fn pool(&self) -> &sqlx::PgPool {
            &self.pool
        }

        /// Cleanup is an assertion, not a best-effort side effect: a schema that
        /// cannot be dropped leaks state into the next run, and the test that leaked
        /// it is the one that must say so.
        async fn cleanup(self) -> Result<(), sqlx::Error> {
            self.pool.close().await;
            assert!(
                is_generated_test_schema_name(&self.schema_name),
                "refusing to drop `{}`: only self-generated viva_data_test_<32 hex> schemas are droppable",
                self.schema_name
            );
            let dropped = sqlx::raw_sql(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema_name))
                .execute(&self.admin_pool)
                .await
                .map(|_| ());
            self.admin_pool.close().await;
            dropped
        }
    }

    impl Drop for PostgresSchemaFixture {
        fn drop(&mut self) {
            // Best-effort only. `cleanup` is the cleanup path; this exists so a
            // panicking test still surfaces the leak in its output.
            if !self.pool.is_closed() {
                eprintln!(
                    "postgres test schema `{}` was not cleaned up; call `cleanup()`",
                    self.schema_name
                );
            }
        }
    }

    /// `^viva_data_test_[0-9a-f]{32}$`, without widening Cargo ownership for a
    /// regex dependency. Together with double-quoting, this is the identifier-safety
    /// mechanism sqlx 0.8 does not provide (`QueryBuilder` has no `push_identifier`).
    fn is_generated_test_schema_name(name: &str) -> bool {
        const PREFIX: &str = "viva_data_test_";
        let Some(suffix) = name.strip_prefix(PREFIX) else {
            return false;
        };
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }

    /// One authoritative v1 decision, computed the way the live path computes it.
    fn library_decision() -> agent_domain::ReviewScheduleDecisionV1 {
        agent_domain::decide_review_schedule(
            agent_domain::parse_utc_instant("2031-04-05T12:00:00.000Z").expect("instant parses"),
            &agent_domain::ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: None,
                miss_count: None,
            },
            &agent_domain::ReviewSchedulingContextV1 {
                schema_version: agent_domain::VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: None,
                card: None,
            },
        )
        .expect("authoritative decision")
    }

    async fn study_set_row_count(pool: &sqlx::PgPool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM study_sets")
            .fetch_one(pool)
            .await
            .expect("study set count query succeeds")
    }

    async fn sqlx_ledger_row_count(pool: &sqlx::PgPool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await
            .expect("sqlx ledger count query succeeds")
    }

    async fn column_exists(pool: &sqlx::PgPool, table: &str, column: &str) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (
                 SELECT 1
                 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = $1
                   AND column_name = $2
             )",
        )
        .bind(table)
        .bind(column)
        .fetch_one(pool)
        .await
        .expect("column existence query succeeds")
    }

    async fn index_exists(pool: &sqlx::PgPool, index: &str) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (
                 SELECT 1
                 FROM pg_indexes
                 WHERE schemaname = current_schema()
                   AND indexname = $1
             )",
        )
        .bind(index)
        .fetch_one(pool)
        .await
        .expect("index existence query succeeds")
    }

    async fn table_exists(pool: &sqlx::PgPool, table: &str) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (
                 SELECT 1
                 FROM information_schema.tables
                 WHERE table_schema = current_schema()
                   AND table_name = $1
             )",
        )
        .bind(table)
        .fetch_one(pool)
        .await
        .expect("table existence query succeeds")
    }

    /// `DATA-001`/`QLT-03`: the environment contract, as a pure function.
    ///
    /// The old helper answered a missing `DATABASE_URL` with `None`, and every
    /// PostgreSQL test then returned early and reported success — a suite that
    /// proves nothing while looking green. Absence of a database is a failure of the
    /// required command, never a skip. Keeping the rule pure is what lets it be
    /// proven without a process environment and without a database.
    #[test]
    fn postgres_required_environment_never_silently_skips() {
        assert_eq!(
            postgres_environment_contract(true, None),
            Err("DATA_POSTGRES_REQUIRED=1 requires a non-empty DATABASE_URL".to_owned()),
        );
        assert_eq!(
            postgres_environment_contract(true, Some("   ")),
            Err("DATA_POSTGRES_REQUIRED=1 requires a non-empty DATABASE_URL".to_owned()),
        );
        assert_eq!(
            postgres_environment_contract(true, Some(" postgresql://viva@localhost/db ")),
            Ok("postgresql://viva@localhost/db".to_owned()),
        );
        // Without the flag the answer is still an error, never `None`: nothing in
        // this module can express "skipped but passing".
        assert_eq!(
            postgres_environment_contract(false, None),
            Err(
                "a PostgreSQL test requires DATA_POSTGRES_REQUIRED=1 and a non-empty DATABASE_URL"
                    .to_owned()
            ),
        );
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_each_case_uses_an_isolated_schema() {
        let first = PostgresSchemaFixture::migrated().await;
        let second = PostgresSchemaFixture::migrated().await;
        assert_ne!(first.schema_name, second.schema_name);

        // A seeded row in one fixture is invisible to the other, so no test can
        // observe another test's ids, counts, or question activity.
        seed_postgres_fixture(first.pool())
            .await
            .expect("fixture seed applies inside the first schema");
        assert_eq!(study_set_row_count(first.pool()).await, 1);
        assert_eq!(study_set_row_count(second.pool()).await, 0);

        // Each schema carries its own sqlx ledger, so neither can convince the other
        // that a migration has already run.
        assert_eq!(
            sqlx_ledger_row_count(first.pool()).await,
            MIGRATIONS.len() as i64
        );
        assert_eq!(
            sqlx_ledger_row_count(second.pool()).await,
            MIGRATIONS.len() as i64
        );

        first.cleanup().await.expect("first schema drops cleanly");
        second.cleanup().await.expect("second schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_sqlx_ledger_and_raw_backfill_do_not_share_schema_state() {
        let ledger = PostgresSchemaFixture::migrated().await;
        let backfill = PostgresSchemaFixture::empty().await;

        // The raw historical path applies the same SQL without the sqlx ledger, so
        // its schema must end with the same tables and no `_sqlx_migrations` row.
        for (name, _) in MIGRATIONS {
            apply_migration_sql(backfill.pool(), name)
                .await
                .expect("raw historical migration applies");
        }

        assert_eq!(
            sqlx_ledger_row_count(ledger.pool()).await,
            MIGRATIONS.len() as i64
        );
        assert!(!table_exists(backfill.pool(), "_sqlx_migrations").await);
        for table in [
            "study_sets",
            "voice_sessions",
            "answer_attempts",
            "concepts",
        ] {
            assert!(table_exists(ledger.pool(), table).await, "{table}");
            assert!(table_exists(backfill.pool(), table).await, "{table}");
        }

        ledger.cleanup().await.expect("ledger schema drops cleanly");
        backfill
            .cleanup()
            .await
            .expect("backfill schema drops cleanly");
    }

    /// `DATA-005`/`DATA-013`: the final applied schema, read from the catalog.
    ///
    /// This asserts the state a real database ends in, not the text of a migration
    /// file: a migration that is written but never reached, or reached but rolled
    /// back by a later one, has to fail here.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_final_schema_has_durable_authorization_and_deletion_tombstone() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool();

        assert!(table_exists(pool, "event_authorization_digests").await);
        for column in [
            "user_id",
            "study_set_id",
            "voice_session_id",
            "response_id",
            "event_kind",
            "payload_sha256",
            "created_at",
        ] {
            assert!(
                column_exists(pool, "event_authorization_digests", column).await,
                "event_authorization_digests.{column}"
            );
        }
        // The digest is learner-derived but carries no event JSON: a raw payload
        // column here would put browser event bodies back in the database.
        for forbidden in ["payload", "payload_json", "event_json", "answer_text"] {
            assert!(
                !column_exists(pool, "event_authorization_digests", forbidden).await,
                "event_authorization_digests must not store {forbidden}"
            );
        }
        assert!(
            index_exists(pool, "event_authorization_digests_session_lookup_idx").await,
            "session lookup index"
        );

        // The deletion tombstone is its own column, never an overloaded ingestion
        // status: active reads require `deleted_at IS NULL`.
        assert!(column_exists(pool, "study_sets", "deleted_at").await);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// `DATA-009`: `0014` superseded the payload index with a one-row-per-session
    /// unique index, but the superseded index stayed behind and kept a btree row-size
    /// limit on recap content. The chain must end with it gone.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_final_schema_drops_obsolete_recap_index() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool();

        assert!(
            !index_exists(pool, "session_recaps_voice_session_payload_idx").await,
            "the superseded payload index must not survive the chain"
        );
        assert!(
            index_exists(pool, "session_recaps_voice_session_unique_idx").await,
            "the one-row-per-session index that replaced it must remain"
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// `DATA-013`: the exact six-column inventory the `DATA-SCHEMA-UNWRITTEN` rule
    /// names. Every one was added by a migration and bound by no production writer;
    /// the deterministic default is to drop it, and a column that reappears without a
    /// merged typed writer fails here.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_final_schema_enforces_data_schema_unwritten_rule() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool();

        for column in [
            "provider_attempt_id",
            "terminal_reason",
            "failure_class",
            "stage",
            "retry_eligible",
            "concept_id",
        ] {
            assert!(
                !column_exists(pool, "answer_attempts", column).await,
                "answer_attempts.{column} is written by nothing and must be dropped"
            );
        }
        // The columns production actually binds are untouched.
        for column in [
            "response_id",
            "question_id",
            "submission_sequence",
            "idempotency_key",
            "capture_mode",
            "capture_status",
            "answer_content_policy",
            "pre_provider_state",
            "evaluation_label",
            "concept_status",
            "confidence_score",
            "source_span_id",
        ] {
            assert!(
                column_exists(pool, "answer_attempts", column).await,
                "answer_attempts.{column} is bound by a production writer"
            );
        }

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// `DATA-009`, behaviourally: a large but entirely valid recap is accepted.
    ///
    /// The superseded payload index indexed the recap arrays themselves, so a recap
    /// whose concept labels exceed the btree row limit was rejected by the database
    /// with an index error the learner could do nothing about. This inserts through
    /// `PostgresStudyStore::record_recap`, not raw SQL, so the whole write path is
    /// what is proven.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_large_recap_does_not_hit_obsolete_payload_index_limit() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&store).await;

        // The labels are high-entropy on purpose. A btree index value may be
        // compressed but never stored out of line, so repetitive prose slips under
        // the 2704-byte limit and would prove nothing; incompressible content makes
        // the superseded index reject the write deterministically.
        let mut recap = fixture_recap();
        recap.concepts = (0..64)
            .map(|index| RecapConceptOutcome {
                concept_id: format!("concept-{index:03}"),
                label: format!(
                    "{}{}{}",
                    Uuid::new_v4().simple(),
                    Uuid::new_v4().simple(),
                    Uuid::new_v4().simple()
                ),
                status: ConceptStatus::Strong,
            })
            .collect();
        recap.review_schedule = Vec::new();
        let payload_bytes: usize = recap.concepts.iter().map(|c| c.label.len()).sum();
        assert!(
            payload_bytes > 2704,
            "the recap must exceed the btree row limit the obsolete index imposed, got {payload_bytes}"
        );

        store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-large-recap",
                recap,
            )
            .await
            .expect("a large valid recap is accepted");

        let stored = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM session_recaps WHERE voice_session_id = $1",
        )
        .bind(fixture_uuid("voice-session-1").expect("voice session fixture UUID"))
        .fetch_one(&pool)
        .await
        .expect("recap row count query succeeds");
        assert_eq!(stored, 1);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[test]
    fn migrations_keep_raw_payload_columns_out_of_postgres() {
        assert_schema_has_no_raw_payload_columns().expect("schema must avoid raw payload columns");
    }

    #[test]
    fn migrations_define_sanitized_voice_session_and_source_span_tables() {
        let sql = migration_sql();

        assert!(sql.contains("CREATE TABLE voice_sessions"));
        assert!(sql.contains("CREATE TABLE source_spans"));
        assert!(sql.contains("question_id TEXT NOT NULL"));
        assert!(sql.contains("evaluation_label TEXT NOT NULL"));
        assert!(sql.contains("response_id TEXT"));
        assert!(sql.contains("answer_content_policy TEXT NOT NULL DEFAULT 'none'"));
        assert!(sql.contains("ALTER COLUMN evaluation_label DROP NOT NULL"));
        assert!(sql.contains("answer_attempts_voice_session_response_id_idx"));
        assert!(!sql.contains("answer_text TEXT"));
        assert!(!sql.contains("evaluation JSONB"));
        assert!(sql.contains("CREATE TABLE voice_usage_events"));
        assert!(sql.contains("cost_estimate_usd"));
        assert!(sql.contains("CREATE TABLE session_recaps"));
        assert!(sql.contains("voice_session_id UUID REFERENCES voice_sessions"));
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS study_questions"));
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS voice_session_token_nonces"));
        assert!(sql.contains("PRIMARY KEY (user_id, study_set_id, voice_session_id, nonce)"));
        assert!(sql.contains("source_spans_excerpt_bounded"));
        assert!(!sql.contains("summary TEXT"));
        assert!(!sql.contains("headline TEXT"));
    }

    #[test]
    fn migrations_define_atomic_review_item_replay_guard() {
        let sql = migration_sql();
        assert!(sql.contains("DELETE FROM review_items duplicate"));
        assert!(sql.contains("AND duplicate.id > kept.id"));
        assert!(sql.contains("review_items_voice_session_concept_due_scheduled_idx"));
        assert!(sql.contains(
            "ON review_items (user_id, study_set_id, voice_session_id, concept_id, due_at)"
        ));
        assert!(sql.contains("WHERE status = 'scheduled' AND voice_session_id IS NOT NULL"));
    }

    #[test]
    fn migrations_define_atomic_recap_and_concept_status_replay_guards() {
        let sql = migration_sql();
        assert!(sql.contains("session_recaps_voice_session_payload_idx"));
        assert!(sql.contains(
            "ON session_recaps (user_id, study_set_id, voice_session_id, strong_concepts, shaky_concepts, missed_concepts, review_later, source_span_ids)"
        ));
        assert!(sql.contains("session_recaps_voice_session_unique_idx"));
        assert!(sql.contains("ON session_recaps (user_id, study_set_id, voice_session_id)"));
        assert!(sql.contains("concept_status_events"));
        assert!(sql.contains(
            "PRIMARY KEY (user_id, study_set_id, voice_session_id, response_id, concept_id, payload_sha256)"
        ));
    }

    #[test]
    fn migrations_define_the_v1_review_schedule_decision_columns() {
        let sql = migration_sql();
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS schedule_schema_version SMALLINT"));
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS schedule_decision JSONB"));
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS schedule_card JSONB"));
        assert!(sql.contains("review_items_schedule_v1_complete"));
        assert!(sql.contains("schedule_schema_version = 1"));
        assert!(sql.contains("review_items_schedule_cap_reason_valid"));
        assert!(sql.contains("IN ('exam_margin', 'past_exam')"));
        assert!(sql.contains("review_items_schedule_decision_v1_idx"));
    }

    /// The 0012 guard keys on `due_at`, which a replay recomputes from a later clock.
    /// The v1 replay guard must key on the graded outcome instead, or a replayed tool
    /// call writes a second scheduled review and advances the persisted FSRS card.
    #[test]
    fn migrations_guard_review_schedule_replays_on_the_graded_outcome_not_the_due_date() {
        let sql = migration_sql();
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS schedule_response_id TEXT"));
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS schedule_payload_sha256 TEXT"));
        assert!(sql.contains(
            "CREATE UNIQUE INDEX IF NOT EXISTS review_items_schedule_response_replay_idx"
        ));
        assert!(sql.contains("schedule_response_id, schedule_payload_sha256"));
        assert!(sql.contains("AND schedule_response_id IS NOT NULL"));
        // The replay key must never be the computed schedule.
        let replay_index = sql
            .split("review_items_schedule_response_replay_idx")
            .nth(1)
            .expect("replay index is defined");
        let replay_definition = replay_index
            .split(';')
            .next()
            .expect("replay index definition terminates");
        assert!(!replay_definition.contains("due_at"), "{replay_definition}");
    }

    #[test]
    fn migrations_supersede_the_four_known_fixed_review_dates_without_inventing_new_ones() {
        let sql = migration_sql();
        assert!(sql.contains("SET status = 'superseded'"));
        for buggy in [
            "2026-06-18T09:00:00Z",
            "2026-06-19T09:00:00Z",
            "2026-06-20T09:00:00Z",
            "2026-06-24T09:00:00Z",
        ] {
            assert!(sql.contains(buggy), "migration must supersede {buggy}");
        }
        // Supersession only: the migration never writes a replacement due date.
        assert!(!sql.contains("SET due_at ="));
        assert!(!sql.contains("UPDATE review_items\nSET due_at"));
    }

    #[test]
    fn migration_include_list_matches_directory_order() {
        let migrations_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../migrations")
            .canonicalize()
            .expect("migrations directory exists");
        let mut directory_names = std::fs::read_dir(migrations_dir)
            .expect("migrations directory is readable")
            .map(|entry| {
                entry
                    .expect("migration entry is readable")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.ends_with(".sql"))
            .collect::<Vec<_>>();
        directory_names.sort();

        let include_names = MIGRATIONS
            .iter()
            .map(|(name, _)| (*name).to_owned())
            .collect::<Vec<_>>();

        assert_eq!(include_names, directory_names);
    }

    #[test]
    fn count_truth_table_fixture_covers_retry_cancel_watchdog_and_double_submit() {
        let table = count_truth_table();
        assert_eq!(table.schema, "viva.store_count_truth_table.v1");
        let scenarios = table
            .scenarios
            .iter()
            .map(|scenario| scenario.scenario.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            scenarios,
            vec![
                "happy",
                "retry_after_429",
                "cancel_mid_work",
                "watchdog_expiry",
                "double_submit"
            ]
        );
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_migrations_apply() {
        let fixture = PostgresSchemaFixture::empty().await;
        let pool = fixture.pool().clone();
        run_migrations(&pool)
            .await
            .expect("migrations should apply when DATABASE_URL is configured");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed should apply after migrations");

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_fixture_replay_and_negative_matrix() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let store = Arc::new(crate::PostgresStudyStore::new(pool.clone()));
        record_fixture_session(store.as_ref()).await;
        record_one_counted_turn(store.as_ref(), "voice-session-1").await;
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_usage(VoiceUsageRecord {
                voice_session_id: Some("voice-session-1".to_owned()),
                provider: "synthetic".to_owned(),
                model: "synthetic-viva".to_owned(),
                duration_seconds: 1,
                text_input_tokens: 20,
                text_output_tokens: 10,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
                cost_estimate_usd: 0.00002,
                first_audio_latency_ms: None,
                answer_eval_latency_ms: Some(1),
                source_retrieval_latency_ms: None,
                source_grounded_correction_count: 1,
            })
            .await
            .expect("records usage");

        let counts = store.write_counts();
        assert_eq!(counts.sessions, 1);
        assert_eq!(counts.answer_attempts, 1);
        assert_eq!(counts.concept_statuses, 1);
        assert_eq!(counts.review_items, 1);
        assert_eq!(counts.recaps, 1);

        let usage_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM voice_usage_events WHERE voice_session_id = $1",
        )
        .bind(fixture_uuid("voice-session-1").expect("voice fixture UUID"))
        .fetch_one(&pool)
        .await
        .expect("usage row count query succeeds");
        assert!(usage_count >= 1);

        let negative_store = crate::PostgresStudyStore::new(pool.clone());
        record_fixture_session(&negative_store).await;
        let baseline = negative_store.write_counts();
        let row_baseline = db_row_counts(&pool).await;

        assert!(negative_store
            .study_context("user-2", "biology-midterm")
            .await
            .expect("wrong-user context query succeeds")
            .is_none());
        assert!(negative_store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("wrong-session-owner")),
                user_id: Some("user-2".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .is_err());
        insert_secondary_study_set(&pool).await;
        assert!(negative_store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-2".to_owned()),
                study_set_id: Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .is_err());
        assert!(negative_store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "missing-session",
                "response-1",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .is_err());
        assert!(negative_store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "unknown-concept",
                ConceptStatus::Strong,
            )
            .await
            .is_err());
        assert!(negative_store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "unknown-concept",
                "2026-06-16T09:00:00Z",
            )
            .await
            .is_err());

        let question = fixture_question();
        let mut forged_source = fixture_source_reference();
        forged_source.span = "slide:99".to_owned();
        assert!(negative_store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                agent_domain::AnswerEvaluation {
                    question_id: question.question_id.clone(),
                    answer_text: "NADH donates electrons.".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Forged source.".to_owned(),
                    retry_prompt: question.follow_up.clone(),
                    source: forged_source,
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.84,
                },
            )
            .await
            .is_err());

        set_question_active(&pool, false).await;
        assert!(negative_store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                agent_domain::AnswerEvaluation {
                    question_id: question.question_id,
                    answer_text: "NADH donates electrons.".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Inactive question.".to_owned(),
                    retry_prompt: question.follow_up,
                    source: fixture_source_reference(),
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.84,
                },
            )
            .await
            .is_err());
        set_question_active(&pool, true).await;

        set_document_deleted(&pool, true).await;
        assert!(negative_store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .expect("tombstoned doc source query succeeds")
            .is_none());
        set_document_deleted(&pool, false).await;
        set_source_deleted(&pool, true).await;
        assert!(negative_store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .expect("tombstoned source query succeeds")
            .is_none());
        set_source_deleted(&pool, false).await;

        // The v2 recap moment carries only a source id, so a forged moment is a
        // source id this user and study set do not own.
        let mut forged_recap = fixture_recap();
        forged_recap.source_moments = vec![RecapSourceMoment {
            response_id: "response-0".to_owned(),
            source_id: "src-not-owned-by-this-study-set".to_owned(),
        }];
        assert!(negative_store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                forged_recap,
            )
            .await
            .is_err());

        assert_eq!(negative_store.write_counts(), baseline);
        assert_eq!(db_row_counts(&pool).await, row_baseline);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_count_truth_table_stays_exact_under_replayed_provider_writes() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let expected = expected_count_delta("happy");
        let store = Arc::new(crate::PostgresStudyStore::new(pool.clone()));
        let session_id = Uuid::new_v4().to_string();
        let baseline_writes = store.write_counts();
        let baseline_rows = db_row_counts(&pool).await;

        record_count_table_session(store.as_ref(), &session_id).await;
        record_one_counted_turn(store.as_ref(), &session_id).await;
        record_one_counted_turn(store.as_ref(), &session_id).await;
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_usage(VoiceUsageRecord {
                voice_session_id: Some(session_id),
                provider: "synthetic".to_owned(),
                model: "synthetic-viva".to_owned(),
                duration_seconds: 1,
                text_input_tokens: 20,
                text_output_tokens: 10,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
                cost_estimate_usd: 0.00002,
                first_audio_latency_ms: None,
                answer_eval_latency_ms: Some(1),
                source_retrieval_latency_ms: None,
                source_grounded_correction_count: 1,
            })
            .await
            .expect("records usage");

        assert_eq!(
            count_delta_from_writes(store.write_counts(), baseline_writes),
            expected
        );
        assert_eq!(
            count_delta_from_rows(db_row_counts(&pool).await, baseline_rows, expected),
            expected
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_study_session_durable_counts_match_real_schema() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let store = Arc::new(crate::PostgresStudyStore::new(pool.clone()));
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(store.as_ref(), &session_id).await;
        record_one_counted_turn(store.as_ref(), &session_id).await;

        let counts = store
            .study_session_durable_counts("user-1", "biology-midterm", &session_id)
            .await
            .expect("durable count query uses the migrated postgres schema");
        assert_eq!(counts.answer_attempts, 1);
        assert_eq!(counts.concept_statuses, 1);
        assert_eq!(counts.review_items, 1);
        assert_eq!(counts.prior_recaps, 1);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_session_token_nonce_claims_reject_replay() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let store = PostgresStudyStore::new(pool.clone());
        let claim = SessionTokenNonceClaim {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            nonce: "nonce-postgres-replay".to_owned(),
            expires_at: 1_800_000_000,
        };

        store
            .claim_session_token_nonce(claim.clone())
            .await
            .expect("first nonce claim succeeds");
        let replay = store
            .claim_session_token_nonce(claim.clone())
            .await
            .expect_err("replayed nonce claim is rejected");
        // `DATA-008`: a reused nonce lost a uniqueness race. Plan 06's taxonomy
        // reserves `Conflict` for exactly that and names a reused nonce as its
        // example; `Unavailable` would say the port could not answer at all.
        assert_eq!(replay.kind(), PortErrorKind::Conflict);
        assert_eq!(replay.port(), "postgres");
        assert_eq!(replay.reason(), "session token nonce already used");
        assert_eq!(session_token_nonce_rows(&pool, &claim).await, 1);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// `DATA-008`: the one clock the nonce boundary table is written against.
    const NONCE_PRUNE_NOW: u64 = 10_000;
    /// Claimed early enough that none of the three boundary rows is pruned on the
    /// way in; the prune under test is the one a later claim performs.
    const NONCE_PRUNE_EARLIER_NOW: u64 = 9_000;
    /// `9_939 + 60 < 10_000`: past validity *and* past the published skew.
    const NONCE_PRUNE_EXPIRED_BEYOND_SKEW: u64 = 9_939;
    /// `9_940 + 60 == 10_000`: the exact last instant service verification still
    /// accepts the token, so the nonce must still be there to refuse a replay.
    const NONCE_PRUNE_SKEW_BOUNDARY: u64 = 9_940;
    /// Not expired at all.
    const NONCE_PRUNE_LIVE: u64 = 10_001;

    fn nonce_prune_claim(
        voice_session_id: &str,
        nonce: &str,
        expires_at: u64,
    ) -> SessionTokenNonceClaim {
        SessionTokenNonceClaim {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            nonce: nonce.to_owned(),
            expires_at,
        }
    }

    /// The three boundary claims plus the later claim that triggers the prune.
    fn nonce_prune_boundary_claims(voice_session_id: &str) -> [SessionTokenNonceClaim; 3] {
        [
            nonce_prune_claim(
                voice_session_id,
                "nonce-expired-beyond-skew",
                NONCE_PRUNE_EXPIRED_BEYOND_SKEW,
            ),
            nonce_prune_claim(
                voice_session_id,
                "nonce-skew-boundary",
                NONCE_PRUNE_SKEW_BOUNDARY,
            ),
            nonce_prune_claim(voice_session_id, "nonce-live", NONCE_PRUNE_LIVE),
        ]
    }

    fn assert_nonce_replay_refused(error: &agent_domain::PortError, port: &str) {
        assert_eq!(
            error.kind(),
            PortErrorKind::Conflict,
            "a replayed nonce lost a uniqueness race; it is not an unavailable port"
        );
        assert_eq!(error.port(), port);
        assert_eq!(error.reason(), "session token nonce already used");
    }

    /// `DATA-008`, in-memory half.
    ///
    /// Retention is bounded by the *published* acceptance rule, not by `expires_at`
    /// alone: `agent_service::config` verifies a session token while
    /// `expires_at + EXPIRY_CLOCK_SKEW_SECONDS >= now`, so a nonce dropped at
    /// `expires_at` would leave a 60-second window in which a still-valid token
    /// could be replayed against an empty ledger.
    #[tokio::test]
    async fn memory_nonce_prune_keeps_token_skew_boundary_and_rejects_live_replay() {
        let store = crate::InMemoryStudyStore::seeded_fixture();
        record_fixture_session(&store).await;
        let session_id = "voice-session-1";
        let claims = nonce_prune_boundary_claims(session_id);

        // All three exist first, or the prune assertions below prove nothing.
        for claim in &claims {
            store
                .claim_session_token_nonce_at(claim.clone(), NONCE_PRUNE_EARLIER_NOW)
                .expect("boundary nonce is claimed before any of them can be pruned");
        }
        assert_eq!(store.snapshot().session_token_nonces.len(), 3);

        // A later claim prunes opportunistically before it claims.
        let trigger = nonce_prune_claim(session_id, "nonce-prune-trigger", NONCE_PRUNE_LIVE);
        store
            .claim_session_token_nonce_at(trigger.clone(), NONCE_PRUNE_NOW)
            .expect("a fresh claim at the prune clock succeeds");

        let retained = store.snapshot().session_token_nonces;
        let retained_nonces = retained
            .iter()
            .map(|record| record.nonce.as_str())
            .collect::<Vec<_>>();
        assert!(
            !retained_nonces.contains(&"nonce-expired-beyond-skew"),
            "9_939 + 60 < 10_000, so the row is past validity and past the skew: {retained_nonces:?}"
        );
        assert!(
            retained_nonces.contains(&"nonce-skew-boundary"),
            "9_940 + 60 == 10_000 is still accepted by token verification: {retained_nonces:?}"
        );
        assert!(
            retained_nonces.contains(&"nonce-live"),
            "10_001 has not expired at all: {retained_nonces:?}"
        );
        assert_eq!(retained.len(), 3, "{retained_nonces:?}");

        // Replay defense is unweakened for everything still inside the window.
        for claim in [&claims[1], &claims[2]] {
            let replay = store
                .claim_session_token_nonce_at(claim.clone(), NONCE_PRUNE_NOW)
                .expect_err("a retained nonce cannot be replayed");
            assert_nonce_replay_refused(&replay, "memory");
        }
        assert_eq!(store.snapshot().session_token_nonces.len(), 3);

        // Deletion is immediate and does not wait for expiry: an already-expired row
        // inserted after this claim's own prune is removed with the retained ones.
        let late_expired = nonce_prune_claim(session_id, "nonce-late-expired", 9_000);
        store
            .claim_session_token_nonce_at(late_expired, NONCE_PRUNE_NOW)
            .expect("an expired nonce still claims; the prune ran before this insert");
        assert_eq!(store.snapshot().session_token_nonces.len(), 4);

        store
            .delete_session_history("user-1", "biology-midterm", session_id)
            .await
            .expect("session history deletion succeeds");
        assert!(
            store.snapshot().session_token_nonces.is_empty(),
            "session deletion removes retained and expired nonce rows immediately"
        );

        // Same for study-set deletion, over a second session's rows.
        let second_session = "vs-0001";
        for (nonce, expires_at) in [
            ("nonce-study-live", NONCE_PRUNE_LIVE),
            ("nonce-study-expired", 9_000),
        ] {
            store
                .claim_session_token_nonce_at(
                    nonce_prune_claim(second_session, nonce, expires_at),
                    NONCE_PRUNE_NOW,
                )
                .expect("second-session nonce is claimed");
        }
        assert_eq!(store.snapshot().session_token_nonces.len(), 2);
        store
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("study set deletion succeeds");
        assert!(
            store.snapshot().session_token_nonces.is_empty(),
            "study-set deletion removes retained and expired nonce rows immediately"
        );
    }

    /// `DATA-008`, durable half. Same boundary table, same clock, same refusals.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_nonce_prune_keeps_token_skew_boundary_and_rejects_live_replay() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&store).await;
        let session_id = "voice-session-1";
        let claims = nonce_prune_boundary_claims(session_id);

        for claim in &claims {
            store
                .claim_session_token_nonce_at(claim.clone(), NONCE_PRUNE_EARLIER_NOW)
                .await
                .expect("boundary nonce is claimed before any of them can be pruned");
        }
        for claim in &claims {
            assert_eq!(session_token_nonce_rows(&pool, claim).await, 1);
        }

        let trigger = nonce_prune_claim(session_id, "nonce-prune-trigger", NONCE_PRUNE_LIVE);
        store
            .claim_session_token_nonce_at(trigger.clone(), NONCE_PRUNE_NOW)
            .await
            .expect("a fresh claim at the prune clock succeeds");

        assert_eq!(
            session_token_nonce_rows(&pool, &claims[0]).await,
            0,
            "9_939 + 60 < 10_000, so the row is past validity and past the skew"
        );
        assert_eq!(
            session_token_nonce_rows(&pool, &claims[1]).await,
            1,
            "9_940 + 60 == 10_000 is still accepted by token verification"
        );
        assert_eq!(
            session_token_nonce_rows(&pool, &claims[2]).await,
            1,
            "10_001 has not expired at all"
        );
        assert_eq!(session_token_nonce_rows(&pool, &trigger).await, 1);

        for claim in [&claims[1], &claims[2]] {
            let replay = store
                .claim_session_token_nonce_at(claim.clone(), NONCE_PRUNE_NOW)
                .await
                .expect_err("a retained nonce cannot be replayed");
            assert_nonce_replay_refused(&replay, "postgres");
            assert_eq!(session_token_nonce_rows(&pool, claim).await, 1);
        }

        let late_expired = nonce_prune_claim(session_id, "nonce-late-expired", 9_000);
        store
            .claim_session_token_nonce_at(late_expired.clone(), NONCE_PRUNE_NOW)
            .await
            .expect("an expired nonce still claims; the prune ran before this insert");
        assert_eq!(session_token_nonce_rows(&pool, &late_expired).await, 1);

        store
            .delete_session_history("user-1", "biology-midterm", session_id)
            .await
            .expect("session history deletion succeeds");
        for claim in [&claims[1], &claims[2], &trigger, &late_expired] {
            assert_eq!(
                session_token_nonce_rows(&pool, claim).await,
                0,
                "session deletion removes retained and expired nonce rows immediately"
            );
        }

        let second_session = "vs-0001";
        let study_live = nonce_prune_claim(second_session, "nonce-study-live", NONCE_PRUNE_LIVE);
        let study_expired = nonce_prune_claim(second_session, "nonce-study-expired", 9_000);
        for claim in [&study_live, &study_expired] {
            store
                .claim_session_token_nonce_at(claim.clone(), NONCE_PRUNE_NOW)
                .await
                .expect("second-session nonce is claimed");
            assert_eq!(session_token_nonce_rows(&pool, claim).await, 1);
        }
        store
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("study set deletion succeeds");
        for claim in [&study_live, &study_expired] {
            assert_eq!(
                session_token_nonce_rows(&pool, claim).await,
                0,
                "study-set deletion removes retained and expired nonce rows immediately"
            );
        }

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// `DATA-008`: the prune predicate is served by the index migration `0010`
    /// already created, so bounding retention costs one indexed range delete rather
    /// than a sequential scan of every nonce ever claimed.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_nonce_prune_uses_existing_expiry_index() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let study_set_uuid = fixture_uuid("biology-midterm").expect("study set fixture UUID");
        let session_uuid = fixture_uuid("voice-session-1").expect("voice session fixture UUID");

        // Enough rows, and a selective enough predicate, that index selection is a
        // real choice rather than a rounding error on a three-row table.
        sqlx::query(
            "INSERT INTO voice_session_token_nonces
                 (user_id, study_set_id, voice_session_id, nonce, expires_at)
             SELECT 'user-1',
                    $1,
                    $2,
                    'plan-nonce-' || generated,
                    CASE WHEN generated <= 200 THEN 1000 ELSE 2000000000 END
             FROM generate_series(1, 5000) AS generated",
        )
        .bind(study_set_uuid)
        .bind(session_uuid)
        .execute(&pool)
        .await
        .expect("query-plan fixture rows insert");
        sqlx::raw_sql("ANALYZE voice_session_token_nonces")
            .execute(&pool)
            .await
            .expect("statistics are collected before the plan is read");

        let mut tx = pool.begin().await.expect("explain transaction begins");
        // Disabled only for this assertion: it removes the planner's freedom to pick
        // a scan for cost reasons so the question left is the one under test —
        // whether an index can serve `expires_at < $1` at all.
        sqlx::raw_sql("SET LOCAL enable_seqscan = off")
            .execute(&mut *tx)
            .await
            .expect("sequential scan is disabled for the explain");
        let plan = sqlx::query_scalar::<_, String>(
            "EXPLAIN DELETE FROM voice_session_token_nonces WHERE expires_at < $1",
        )
        .bind(1_500_i64)
        .fetch_all(&mut *tx)
        .await
        .expect("the prune statement plans")
        .join("\n");
        tx.rollback().await.expect("explain transaction rolls back");

        assert!(
            plan.contains("voice_session_token_nonces_expiry_idx"),
            "the prune predicate must be served by migration 0010's expiry index:\n{plan}"
        );
        let remaining = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM voice_session_token_nonces WHERE nonce LIKE 'plan-nonce-%'",
        )
        .fetch_one(&pool)
        .await
        .expect("query-plan fixture rows are counted");
        assert_eq!(
            remaining, 5_000,
            "EXPLAIN without ANALYZE plans the delete; it never executes it"
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_library_snapshot_scopes_review_items_to_voice_session() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool);
        record_fixture_session(&store).await;
        let second_session_id = "55555555-5555-4555-8555-555555555555";
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(second_session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records second fixture session");
        // D-01A: only an authoritative v1 decision reaches the authenticated read
        // model, so per-session scoping is proven with the decisions the library
        // query actually selects. A legacy `schedule_review_item` row is deliberately
        // never a fallback, which is why this test cannot be written with one.
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-library-1",
                "nadh",
                library_decision(),
            )
            .await
            .expect("schedules first session review");
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                second_session_id,
                "response-library-2",
                "atp-synthase",
                library_decision(),
            )
            .await
            .expect("schedules second session review");
        // The library snapshot only reports completed sessions, so both sessions have
        // to close for the per-session scoping to be observable at all. Until this
        // lane made the PostgreSQL suite required, this test never ran and this
        // missing close was never visible.
        store
            .close_voice_session("voice-session-1", "completed")
            .await
            .expect("closes first fixture session");
        store
            .close_voice_session(second_session_id, "completed")
            .await
            .expect("closes second fixture session");

        let snapshot = store
            .library_snapshot("user-1")
            .await
            .expect("library snapshot succeeds");
        let first = snapshot
            .sessions
            .iter()
            .find(|session| session.voice_session_id == "voice-session-1")
            .expect("first session row");
        let second = snapshot
            .sessions
            .iter()
            .find(|session| session.voice_session_id == second_session_id)
            .expect("second session row");

        assert_eq!(
            first
                .next_review
                .as_ref()
                .map(|review| review.concept_id.as_str()),
            Some("nadh")
        );
        assert_eq!(
            second
                .next_review
                .as_ref()
                .map(|review| review.concept_id.as_str()),
            Some("atp-synthase")
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_schedule_review_item_concurrent_replay_is_atomic() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&store).await;

        let before = store.write_counts();
        let first = store.schedule_review_item(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "atp-synthase",
            "2026-06-22T09:00:00Z",
        );
        let second = store.schedule_review_item(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "atp-synthase",
            "2026-06-22T09:00:00Z",
        );
        let (first, second) = tokio::join!(first, second);
        first.expect("first replay schedules review item");
        second.expect("second replay observes atomic duplicate guard");

        let after = store.write_counts();
        assert_eq!(after.review_items - before.review_items, 1);
        let row_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM review_items
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND concept_id = $4
               AND due_at = $5::timestamptz
               AND status = 'scheduled'",
        )
        .bind("user-1")
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind(fixture_uuid("voice-session-1").expect("voice session fixture UUID"))
        .bind(parse_uuid("77777777-7777-4777-8777-777777777777").expect("concept fixture UUID"))
        .bind("2026-06-22T09:00:00Z")
        .fetch_one(&pool)
        .await
        .expect("review item row count query succeeds");
        assert_eq!(row_count, 1);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The Postgres half of the D-01 replay guard. Two calls that differ only because
    /// the wall clock moved are the same graded outcome: they must leave exactly one
    /// scheduled row, and the persisted FSRS card must not advance.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_review_schedule_decision_replay_writes_one_row() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&store).await;

        let graded_at =
            agent_domain::parse_utc_instant("2031-04-05T12:00:00.000Z").expect("instant parses");
        let outcome = agent_domain::ReviewOutcomeV1 {
            status: ConceptStatus::Shaky,
            hint_count: Some(2),
            miss_count: Some(1),
        };
        let context = agent_domain::ReviewSchedulingContextV1::empty();
        let first_decision = agent_domain::decide_review_schedule(graded_at, &outcome, &context)
            .expect("first decision");
        // The replay reads a later clock, exactly as the live executor does.
        let replay_decision = agent_domain::decide_review_schedule(
            graded_at + chrono::Duration::seconds(1),
            &outcome,
            &context,
        )
        .expect("replayed decision");
        assert_ne!(first_decision.due_at, replay_decision.due_at);

        let before = store.write_counts();
        let first = store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-7",
                "atp-synthase",
                first_decision.clone(),
            )
            .await
            .expect("first decision persists");
        let replay = store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-7",
                "atp-synthase",
                replay_decision,
            )
            .await
            .expect("replay observes the guard");
        assert_eq!(replay, first, "a replay reports the persisted decision");

        let after = store.write_counts();
        assert_eq!(after.review_items - before.review_items, 1);
        let row_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM review_items
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND concept_id = $4
               AND status = 'scheduled'
               AND schedule_schema_version = 1",
        )
        .bind("user-1")
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind(fixture_uuid("voice-session-1").expect("voice session fixture UUID"))
        .bind(parse_uuid("77777777-7777-4777-8777-777777777777").expect("concept fixture UUID"))
        .fetch_one(&pool)
        .await
        .expect("review item row count query succeeds");
        assert_eq!(row_count, 1);

        let context = store
            .review_scheduling_context("user-1", "biology-midterm", "atp-synthase")
            .await
            .expect("authoritative context");
        assert_eq!(
            context.card.as_ref().map(|card| card.reps),
            Some(1),
            "a replay must not advance the persisted FSRS card"
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// Long enough for the paste/file ingestion heuristics to derive real source
    /// spans and concepts.
    fn ingestible_text() -> String {
        let sentences = [
            "Mitochondria electron transport builds a proton gradient across the inner membrane for ATP synthase.",
            "NADH transfers electrons through Complex I while oxygen accepts them at the end of the chain.",
            "Chemiosmosis couples proton flow to ATP production during oxidative phosphorylation.",
        ]
        .join(" ");
        format!("{sentences} {}", sentences.repeat(8))
    }

    const EXAM_AT: &str = "2031-04-05T18:30:00.000Z";
    const EXAM_CAPPED_DUE_AT: &str = "2031-04-04T18:30:00.000Z";
    const SCHEDULE_GRADED_AT: &str = "2031-04-05T12:00:00.000Z";

    /// D-01's exam margin and past-exam fail-closed rule are unreachable unless the
    /// exam instant the learner supplies at ingestion actually lands in the durable
    /// backend. This drives the whole authoritative path on real PostgreSQL:
    /// ingestion -> `review_scheduling_context` -> `decide_review_schedule`.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_ingestion_persists_the_exam_instant_for_the_d01_cap() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        let store = PostgresStudyStore::new(pool.clone());

        let ingested = store
            .create_paste_study_set(agent_domain::CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Bio paste".to_owned(),
                course: None,
                exam_date: Some(EXAM_AT.to_owned()),
                pasted_text: ingestible_text(),
                session_id: Some(Uuid::new_v4().to_string()),
            })
            .await
            .expect("paste ingestion succeeds");
        let concept_id = ingested
            .concepts
            .first()
            .expect("ingestion produced a concept")
            .public_id
            .clone();

        let context = store
            .review_scheduling_context("user-1", &ingested.study_set.id, &concept_id)
            .await
            .expect("authoritative context");
        assert_eq!(
            context.exam_at,
            Some(agent_domain::parse_utc_instant(EXAM_AT).expect("exam instant")),
            "the exam cap has no authoritative input if ingestion drops the exam instant"
        );

        let decision = agent_domain::decide_review_schedule(
            agent_domain::parse_utc_instant(SCHEDULE_GRADED_AT).expect("instant parses"),
            &agent_domain::ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: None,
                miss_count: None,
            },
            &context,
        )
        .expect("authoritative decision");
        assert_eq!(
            agent_domain::format_rfc3339_millis(decision.due_at),
            EXAM_CAPPED_DUE_AT
        );
        assert_eq!(
            decision.cap_reason,
            Some(agent_domain::ReviewScheduleCapReasonV1::ExamMargin)
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The production retry route always sends `exam_date: None`, so a retry that
    /// writes the input verbatim erases the learner's exam instant on the durable
    /// backend exactly as it did in memory.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_file_retry_keeps_the_exam_instant_the_learner_recorded() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        let store = PostgresStudyStore::new(pool.clone());

        let ingested = store
            .create_file_study_set(agent_domain::CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Bio PDF".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: Some(EXAM_AT.to_owned()),
                file_name: "Lecture 9.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: ingestible_text().into_bytes(),
                session_id: Some(Uuid::new_v4().to_string()),
            })
            .await
            .expect("file ingestion succeeds");
        let study_set_id = ingested.study_set.id.clone();

        let retried = store
            .retry_file_study_set(agent_domain::CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: Some(study_set_id.clone()),
                title: String::new(),
                course: None,
                exam_date: None,
                file_name: "Lecture 9 rescan.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: ingestible_text().into_bytes(),
                session_id: Some(Uuid::new_v4().to_string()),
            })
            .await
            .expect("retry succeeds");
        let concept_id = retried
            .concepts
            .first()
            .expect("retry produced a concept")
            .public_id
            .clone();

        assert_eq!(
            store
                .review_scheduling_context("user-1", &study_set_id, &concept_id)
                .await
                .expect("authoritative context")
                .exam_at,
            Some(agent_domain::parse_utc_instant(EXAM_AT).expect("exam instant")),
            "a file retry must not erase the exam instant the learner already recorded"
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// Fail closed where the learner supplies the value, on the durable backend too.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_ingestion_rejects_an_unparseable_exam_date() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        let store = PostgresStudyStore::new(pool.clone());
        store
            .create_paste_study_set(agent_domain::CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Bio paste".to_owned(),
                course: None,
                exam_date: Some("sometime next week".to_owned()),
                pasted_text: ingestible_text(),
                session_id: Some(Uuid::new_v4().to_string()),
            })
            .await
            .expect_err("an unparseable exam date is rejected where the learner supplies it");

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// Under the D-01 exam cap every decision for one concept clamps to the SAME
    /// `due_at`, so a guard that leans on the `due_at` conflict arbiter
    /// (`review_items_voice_session_concept_due_scheduled_idx`, migration 0012) sees
    /// a plain conflict and takes `DO UPDATE`: the replay counts as a second review
    /// write and overwrites the authoritative first decision.
    ///
    /// The window that has to be closed is narrow and real: racer B reads, finds
    /// nothing, racer A commits, and only then does B insert. Reproducing it needs
    /// genuine parallelism — a multi-threaded runtime, one warmed connection per
    /// racer so `BEGIN` cannot serialize them, a barrier so they start together, and
    /// enough rounds that the interleaving actually occurs. Four racers against a
    /// pool of five: no racer can starve while another holds the guard.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_review_schedule_decision_concurrent_replay_under_the_exam_cap_writes_one_row()
    {
        const RACERS: usize = 4;
        const ROUNDS: usize = 12;

        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = Arc::new(PostgresStudyStore::new(pool.clone()));
        record_fixture_session(store.as_ref()).await;

        // Open one connection per racer up front. A lazily grown pool hands the same
        // connection to each racer in turn, which serializes the transactions and
        // hides the very interleaving under test.
        {
            let mut warm = Vec::new();
            for _ in 0..RACERS {
                warm.push(pool.acquire().await.expect("pool connection"));
            }
            drop(warm);
        }

        let graded_at =
            agent_domain::parse_utc_instant(SCHEDULE_GRADED_AT).expect("instant parses");
        let outcome = agent_domain::ReviewOutcomeV1 {
            status: ConceptStatus::Shaky,
            hint_count: Some(2),
            miss_count: Some(1),
        };
        let context = agent_domain::ReviewSchedulingContextV1 {
            schema_version: agent_domain::VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at: Some(agent_domain::parse_utc_instant(EXAM_AT).expect("exam instant")),
            card: None,
        };
        // Each racer reads the clock a second later, exactly as a replayed tool call
        // does; under the cap every one of them still clamps to the same due date.
        let decisions: Vec<_> = (0..RACERS)
            .map(|offset| {
                agent_domain::decide_review_schedule(
                    graded_at + chrono::Duration::seconds(offset as i64),
                    &outcome,
                    &context,
                )
                .expect("capped decision")
            })
            .collect();
        assert!(
            decisions
                .iter()
                .all(|decision| decision.due_at == decisions[0].due_at),
            "the cap is what makes the due_at arbiter collide"
        );
        assert!(
            decisions
                .iter()
                .any(|decision| decision.generated_at != decisions[0].generated_at),
            "the racers must be distinguishable by the clock-derived field"
        );

        for round in 0..ROUNDS {
            // A fresh graded outcome per round: each round is a first call plus three
            // replays of that same call, never a replay of an earlier round.
            let response_id = format!("response-cap-{round}");
            let barrier = Arc::new(tokio::sync::Barrier::new(RACERS));
            let before = store.write_counts();

            let mut handles = Vec::new();
            for decision in decisions.iter().take(RACERS).cloned() {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                let response_id = response_id.clone();
                handles.push(tokio::spawn(async move {
                    barrier.wait().await;
                    store
                        .persist_review_schedule_decision(
                            "user-1",
                            "biology-midterm",
                            "voice-session-1",
                            &response_id,
                            "atp-synthase",
                            decision,
                        )
                        .await
                }));
            }
            let mut results = Vec::new();
            for handle in handles {
                results.push(handle.await.expect("racer joins").expect("racer succeeds"));
            }
            for result in &results {
                assert_eq!(
                    result, &results[0],
                    "round {round}: every racer reports the one persisted decision"
                );
            }

            let after = store.write_counts();
            assert_eq!(
                after.review_items - before.review_items,
                1,
                "round {round}: a replay writes nothing, even when the cap makes the due dates equal"
            );
            let rows = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM review_items
                 WHERE schedule_response_id = $1 AND status = 'scheduled'",
            )
            .bind(&response_id)
            .fetch_one(&pool)
            .await
            .expect("row count query succeeds");
            assert_eq!(rows, 1, "round {round}");

            let persisted_generated_at = sqlx::query_scalar::<_, String>(
                "SELECT schedule_decision->>'generated_at' FROM review_items
                 WHERE schedule_response_id = $1 AND status = 'scheduled'",
            )
            .bind(&response_id)
            .fetch_one(&pool)
            .await
            .expect("persisted decision query succeeds");
            assert!(
                decisions.iter().any(|decision| {
                    agent_domain::format_rfc3339_millis(decision.generated_at)
                        == persisted_generated_at
                }),
                "round {round}: the persisted decision must be one a caller produced"
            );
            assert_eq!(
                results[0]["due_at"].as_str(),
                Some(agent_domain::format_rfc3339_millis(decisions[0].due_at).as_str()),
                "round {round}"
            );
        }

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The two backends must leave the same authorization ledger behind: a replay
    /// performs no write, so it appends no second authorization on either.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_review_schedule_decision_replay_records_exactly_one_authorization() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&store).await;

        let decision = agent_domain::decide_review_schedule(
            agent_domain::parse_utc_instant(SCHEDULE_GRADED_AT).expect("instant parses"),
            &agent_domain::ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: Some(2),
                miss_count: Some(1),
            },
            &agent_domain::ReviewSchedulingContextV1::empty(),
        )
        .expect("authoritative decision");
        for _ in 0..3 {
            store
                .persist_review_schedule_decision(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-ledger",
                    "atp-synthase",
                    decision.clone(),
                )
                .await
                .expect("decision persists");
        }
        // The durable proof that a replay wrote nothing: one scheduled review row
        // for this graded outcome, keyed on the response and the replay-stable
        // payload digest, and one counted review write.
        //
        // This assertion used to read a process-local ledger. Task 5 removed that
        // ledger, and a review schedule has no browser authorization digest to read
        // instead (no `authorize_*` path consults one, and migration 0016's
        // `event_kind` check admits only the three browser events that do) — so the
        // claim is made against the durable rows that actually carry it.
        let scheduled_rows = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM review_items
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND status = 'scheduled'
               AND schedule_schema_version = 1
               AND schedule_response_id = $4",
        )
        .bind("user-1")
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind(fixture_uuid("voice-session-1").expect("voice session fixture UUID"))
        .bind("response-ledger")
        .fetch_one(&pool)
        .await
        .expect("scheduled review row count query succeeds");
        assert_eq!(
            scheduled_rows, 1,
            "a replay writes nothing, so it creates no second scheduled review"
        );
        let distinct_digests = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(DISTINCT schedule_payload_sha256)
             FROM review_items
             WHERE schedule_response_id = $1",
        )
        .bind("response-ledger")
        .fetch_one(&pool)
        .await
        .expect("schedule digest query succeeds");
        assert_eq!(distinct_digests, 1);
        assert_eq!(store.write_counts().review_items, 1);
        // A schedule write is not a browser event, so it writes no browser digest.
        assert_eq!(digest_rows_for_session(&pool, "voice-session-1").await, 0);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_recap_concurrent_replay_is_atomic() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let first_store = PostgresStudyStore::new(pool.clone());
        let second_store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&first_store).await;
        let recap = fixture_recap();

        let first = first_store.record_recap(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-recap",
            recap.clone(),
        );
        let second = second_store.record_recap(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-recap",
            recap,
        );
        let (first, second) = tokio::join!(first, second);
        first.expect("first replay records recap");
        second.expect("second replay observes atomic duplicate guard");

        assert_eq!(
            first_store.write_counts().recaps + second_store.write_counts().recaps,
            1
        );
        let row_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM session_recaps
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3",
        )
        .bind("user-1")
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind(fixture_uuid("voice-session-1").expect("voice session fixture UUID"))
        .fetch_one(&pool)
        .await
        .expect("recap row count query succeeds");
        assert_eq!(row_count, 1);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_recap_replaces_session_payload_without_incrementing_count() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &session_id).await;
        let mut first = fixture_recap();
        first.voice_session_id.clone_from(&session_id);
        let mut replacement = first.clone();
        for concept in &mut replacement.concepts {
            concept.status = ConceptStatus::Strong;
        }

        store
            .record_recap(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-recap-a",
                first,
            )
            .await
            .expect("first recap records");
        store
            .record_recap(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-recap-b",
                replacement,
            )
            .await
            .expect("second recap replaces session row");

        assert_eq!(store.write_counts().recaps, 1);
        let row_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM session_recaps
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3",
        )
        .bind("user-1")
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind(parse_uuid(&session_id).expect("voice session UUID"))
        .fetch_one(&pool)
        .await
        .expect("recap row count query succeeds");
        assert_eq!(row_count, 1);
        let strong_concepts = sqlx::query_scalar::<_, Vec<String>>(
            "SELECT strong_concepts
             FROM session_recaps
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3",
        )
        .bind("user-1")
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind(parse_uuid(&session_id).expect("voice session UUID"))
        .fetch_one(&pool)
        .await
        .expect("recap strong concepts query succeeds");
        assert_eq!(
            strong_concepts,
            vec!["NADH".to_owned(), "ATP synthase".to_owned()]
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The minimum the 0014 recap backfill needs, written with pre-0014 columns
    /// only: a study set, its document, and the source span its recaps cite.
    async fn seed_pre_0014_recap_fixture(pool: &sqlx::PgPool) {
        let study_set_id = fixture_uuid("biology-midterm").expect("study set fixture UUID");
        let document_id = fixture_uuid("lec-5").expect("document fixture UUID");
        let source_id = fixture_uuid("src-lecture-5-slide-18").expect("source fixture UUID");
        let source = agent_domain::fixture_source_reference();
        sqlx::query(
            "INSERT INTO study_sets (id, user_id, title, course, ingestion_status, ingestion_error)
             VALUES ($1, 'user-1', 'Biology Midterm', 'Biology 201', 'ready', NULL)",
        )
        .bind(study_set_id)
        .execute(pool)
        .await
        .expect("pre-0014 study set seeds");
        sqlx::query(
            "INSERT INTO study_documents (
                 id, study_set_id, display_name, source_kind, processing_status, deleted_at
             )
             VALUES ($1, $2, 'Lecture 5 - Electron Transport.pdf', 'pdf', 'ready', NULL)",
        )
        .bind(document_id)
        .bind(study_set_id)
        .execute(pool)
        .await
        .expect("pre-0014 document seeds");
        sqlx::query(
            "INSERT INTO source_spans (
                 id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, NULL)",
        )
        .bind(source_id)
        .bind(document_id)
        .bind(serde_json::json!({ "span": source.span }))
        .bind(source.excerpt)
        .bind(source_confidence_str(&source.confidence))
        .bind(source.retrieval_reason)
        .execute(pool)
        .await
        .expect("pre-0014 source span seeds");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_session_recap_backfill_dedupes_existing_session_rows() {
        let fixture = PostgresSchemaFixture::empty().await;
        let pool = fixture.pool().clone();
        run_migrations_until(&pool, "0014_session_recaps_one_row_per_session.sql")
            .await
            .expect("pre-0014 migrations apply");
        // Seeded against the *pre-0014* schema, so this historical-path test cannot
        // be broken by a column a later migration adds to the production seed.
        seed_pre_0014_recap_fixture(&pool).await;
        let session_id = Uuid::new_v4().to_string();
        let study_set_uuid = fixture_uuid("biology-midterm").expect("study set fixture UUID");
        // The session row is inserted against the pre-0014 schema for the same
        // reason the fixture above is: production store code targets the *final*
        // schema — `DATA-004` made `record_voice_session`'s ownership guard read
        // `study_sets.deleted_at`, which migration 0017 adds — and this test is
        // about migration 0014's backfill, not about any writer.
        sqlx::query(
            "INSERT INTO voice_sessions (id, user_id, study_set_id, mode, status)
             VALUES ($1, 'user-1', $2, 'quiz', 'open')",
        )
        .bind(parse_uuid(&session_id).expect("voice session UUID"))
        .bind(study_set_uuid)
        .execute(&pool)
        .await
        .expect("pre-0014 voice session row inserts");
        let voice_session_uuid = parse_uuid(&session_id).expect("voice session UUID");
        let source_uuid = fixture_uuid("src-lecture-5-slide-18").expect("source span fixture UUID");

        for (strong, shaky, offset_seconds) in [
            (
                vec!["NADH".to_owned()],
                vec!["ATP synthase".to_owned()],
                0_i64,
            ),
            (
                vec!["NADH".to_owned(), "ATP synthase".to_owned()],
                Vec::new(),
                1_i64,
            ),
        ] {
            sqlx::query(
                "INSERT INTO session_recaps (
                    id,
                    user_id,
                    study_set_id,
                    voice_session_id,
                    strong_concepts,
                    shaky_concepts,
                    missed_concepts,
                    review_later,
                    source_span_ids,
                    created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8, NOW() + ($9 || ' seconds')::interval)",
            )
            .bind(Uuid::new_v4())
            .bind("user-1")
            .bind(study_set_uuid)
            .bind(voice_session_uuid)
            .bind(strong)
            .bind(shaky)
            .bind(vec!["ATP synthase".to_owned()])
            .bind(vec![source_uuid])
            .bind(offset_seconds.to_string())
            .execute(&pool)
            .await
            .expect("pre-0014 duplicate session recap row inserts");
        }
        assert_eq!(session_recap_rows_for_session(&pool, &session_id).await, 2);

        apply_migration_sql(&pool, "0014_session_recaps_one_row_per_session.sql")
            .await
            .expect("0014 migration applies");

        assert_eq!(session_recap_rows_for_session(&pool, &session_id).await, 1);
        let unique_index_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (
                SELECT 1
                FROM pg_indexes
                WHERE schemaname = current_schema()
                  AND tablename = 'session_recaps'
                  AND indexname = 'session_recaps_voice_session_unique_idx'
            )",
        )
        .fetch_one(&pool)
        .await
        .expect("unique recap index existence query succeeds");
        assert!(unique_index_exists);
        let duplicate_insert = sqlx::query(
            "INSERT INTO session_recaps (
                id,
                user_id,
                study_set_id,
                voice_session_id,
                strong_concepts,
                shaky_concepts,
                missed_concepts,
                review_later,
                source_span_ids
            )
            VALUES ($1, $2, $3, $4, $5, '{}', '{}', '{}', $6)",
        )
        .bind(Uuid::new_v4())
        .bind("user-1")
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(vec!["replacement".to_owned()])
        .bind(vec![source_uuid])
        .execute(&pool)
        .await;
        assert!(
            duplicate_insert.is_err(),
            "0014 unique index must block a second recap row for the same session"
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_concept_status_concurrent_replay_is_atomic() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let first_store = PostgresStudyStore::new(pool.clone());
        let second_store = PostgresStudyStore::new(pool.clone());
        record_fixture_session(&first_store).await;

        let first = first_store.record_concept_status(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-concept-status",
            "oxidative-phosphorylation",
            ConceptStatus::Strong,
        );
        let second = second_store.record_concept_status(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-concept-status",
            "oxidative-phosphorylation",
            ConceptStatus::Strong,
        );
        let (first, second) = tokio::join!(first, second);
        first.expect("first replay records concept status");
        second.expect("second replay observes atomic duplicate guard");

        assert_eq!(
            first_store.write_counts().concept_statuses
                + second_store.write_counts().concept_statuses,
            1
        );
        let status = sqlx::query_scalar::<_, String>(
            "SELECT status
             FROM concepts
             WHERE study_set_id = $1 AND public_id = $2",
        )
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .bind("oxidative-phosphorylation")
        .fetch_one(&pool)
        .await
        .expect("concept status query succeeds");
        assert_eq!(status, "strong");

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_privacy_deletes_purge_usage_and_preserve_deleted_sessions() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = "55555555-5555-4555-8555-555555555555";
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records privacy session");
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_usage(VoiceUsageRecord {
                voice_session_id: Some(session_id.to_owned()),
                provider: "synthetic".to_owned(),
                model: "synthetic-viva".to_owned(),
                duration_seconds: 2,
                text_input_tokens: 20,
                text_output_tokens: 10,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
                cost_estimate_usd: 0.00002,
                first_audio_latency_ms: None,
                answer_eval_latency_ms: Some(1),
                source_retrieval_latency_ms: None,
                source_grounded_correction_count: 1,
            })
            .await
            .expect("records privacy usage");
        let session_delete_nonce = SessionTokenNonceClaim {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: session_id.to_owned(),
            nonce: "nonce-session-delete".to_owned(),
            expires_at: 1_800_000_000,
        };
        store
            .claim_session_token_nonce(session_delete_nonce.clone())
            .await
            .expect("records nonce for session deletion proof");
        assert_eq!(usage_rows_for_session(&pool, session_id).await, 1);
        assert_eq!(
            session_token_nonce_rows(&pool, &session_delete_nonce).await,
            1
        );
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                session_id,
                "response-session-delete",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .expect("records concept status event for session deletion proof");
        assert_eq!(
            concept_status_event_rows_for_session(&pool, session_id).await,
            1
        );

        store
            .delete_session_history("user-1", "biology-midterm", session_id)
            .await
            .expect("deletes session history");
        assert_eq!(usage_rows_for_session(&pool, session_id).await, 0);
        assert_eq!(
            session_token_nonce_rows(&pool, &session_delete_nonce).await,
            0
        );
        assert_eq!(
            concept_status_event_rows_for_session(&pool, session_id).await,
            0
        );
        // Usage aimed at a deleted session writes no row, and now says so: the typed
        // outcome has no value meaning "nothing happened", so the refusal is a
        // `Conflict` rather than a silent success the caller would read as `Inserted`.
        let late_usage = store
            .record_voice_usage(VoiceUsageRecord {
                voice_session_id: Some(session_id.to_owned()),
                provider: "synthetic".to_owned(),
                model: "synthetic-viva".to_owned(),
                duration_seconds: 2,
                text_input_tokens: 20,
                text_output_tokens: 10,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
                cost_estimate_usd: 0.00002,
                first_audio_latency_ms: None,
                answer_eval_latency_ms: Some(1),
                source_retrieval_latency_ms: None,
                source_grounded_correction_count: 1,
            })
            .await
            .expect_err("usage for a deleted session is refused");
        assert_eq!(late_usage.kind(), PortErrorKind::Conflict);
        assert_eq!(usage_rows_for_session(&pool, session_id).await, 0);

        let close_after_delete = store
            .close_voice_session(session_id, "completed")
            .await
            .expect("close preserves deleted session");
        assert_eq!(close_after_delete["status"], "deleted");
        assert_eq!(close_after_delete["terminal_reason"], "deleted");
        assert_eq!(session_status(&pool, session_id).await, "deleted");

        let study_delete_session_id = "66666666-6666-4666-8666-666666666666";
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(study_delete_session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records study delete session");
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_usage(VoiceUsageRecord {
                voice_session_id: Some(study_delete_session_id.to_owned()),
                provider: "synthetic".to_owned(),
                model: "synthetic-viva".to_owned(),
                duration_seconds: 2,
                text_input_tokens: 20,
                text_output_tokens: 10,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
                cost_estimate_usd: 0.00002,
                first_audio_latency_ms: None,
                answer_eval_latency_ms: Some(1),
                source_retrieval_latency_ms: None,
                source_grounded_correction_count: 1,
            })
            .await
            .expect("records study delete usage");
        let study_delete_nonce = SessionTokenNonceClaim {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: study_delete_session_id.to_owned(),
            nonce: "nonce-study-delete".to_owned(),
            expires_at: 1_800_000_000,
        };
        store
            .claim_session_token_nonce(study_delete_nonce.clone())
            .await
            .expect("records nonce for study set deletion proof");
        assert_eq!(
            usage_rows_for_session(&pool, study_delete_session_id).await,
            1
        );
        assert_eq!(
            session_token_nonce_rows(&pool, &study_delete_nonce).await,
            1
        );
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                study_delete_session_id,
                "response-study-delete",
                "atp-synthase",
                ConceptStatus::Shaky,
            )
            .await
            .expect("records concept status event for study set deletion proof");
        assert_eq!(
            concept_status_event_rows_for_session(&pool, study_delete_session_id).await,
            1
        );

        store
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("deletes study set privacy artifacts");
        assert_eq!(
            usage_rows_for_session(&pool, study_delete_session_id).await,
            0
        );
        assert_eq!(
            session_token_nonce_rows(&pool, &study_delete_nonce).await,
            0
        );
        assert_eq!(
            concept_status_event_rows_for_session(&pool, study_delete_session_id).await,
            0
        );
        // Same refusal after study-set deletion: no row, and a typed conflict rather
        // than a success the caller would record as an accepted usage event.
        let late_usage = store
            .record_voice_usage(VoiceUsageRecord {
                voice_session_id: Some(study_delete_session_id.to_owned()),
                provider: "synthetic".to_owned(),
                model: "synthetic-viva".to_owned(),
                duration_seconds: 2,
                text_input_tokens: 20,
                text_output_tokens: 10,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
                cost_estimate_usd: 0.00002,
                first_audio_latency_ms: None,
                answer_eval_latency_ms: Some(1),
                source_retrieval_latency_ms: None,
                source_grounded_correction_count: 1,
            })
            .await
            .expect_err("usage after study set deletion is refused");
        assert_eq!(late_usage.kind(), PortErrorKind::Conflict);
        assert_eq!(
            usage_rows_for_session(&pool, study_delete_session_id).await,
            0
        );
        assert_eq!(
            session_status(&pool, study_delete_session_id).await,
            "deleted"
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    // ------------------------------------------------------------------
    // Task 4 (`DATA-002`, `DATA-003`, `DATA-010`)
    //
    // Session, evaluation, usage, and count writes have to be atomic against
    // a concurrent racer and against deletion. Every assertion below is on
    // return variants, final rows, final values, per-instance count deltas,
    // and typed error kinds — "it did not panic" proves nothing here.
    // ------------------------------------------------------------------

    fn session_config(session_id: &str) -> SessionConfig {
        SessionConfig {
            session_id: Some(SessionId::new(session_id)),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        }
    }

    fn fixture_envelope(response_id: &str) -> AnswerAttemptEnvelope {
        let question = fixture_question();
        AnswerAttemptEnvelope {
            response_id: response_id.to_owned(),
            question_id: question.question_id.clone(),
            submission_sequence: 1,
            idempotency_key: format!("{}:1:{response_id}", question.question_id),
            capture_mode: AnswerCaptureMode::Typed,
            byte_count: Some(24),
            char_count: Some(24),
            duration_ms: Some(1_200),
            client_generation_id: Some("generation-1".to_owned()),
            locale: Some("en-US".to_owned()),
            capture_status: AnswerCaptureStatus::Accepted,
            content_policy: AnswerContentPolicy::None,
            answer_digest_hmac: None,
            transcript_status: Some("final".to_owned()),
            transcript_confidence_bucket: Some("high".to_owned()),
            pre_provider_state: "captured".to_owned(),
        }
    }

    fn fixture_evaluation(label: &str, status: ConceptStatus, confidence: f32) -> AnswerEvaluation {
        let question = fixture_question();
        AnswerEvaluation {
            question_id: question.question_id,
            answer_text: "NADH donates electrons.".to_owned(),
            label: label.to_owned(),
            concise_feedback: "Grounded in the seeded source.".to_owned(),
            retry_prompt: question.follow_up,
            source: question.source,
            concept_status: status,
            confidence_score: confidence,
        }
    }

    fn usage_record(session_id: &str) -> VoiceUsageRecord {
        VoiceUsageRecord {
            voice_session_id: Some(session_id.to_owned()),
            provider: "synthetic".to_owned(),
            model: "synthetic-viva".to_owned(),
            duration_seconds: 2,
            text_input_tokens: 20,
            text_output_tokens: 10,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
            cost_estimate_usd: 0.00002,
            first_audio_latency_ms: None,
            answer_eval_latency_ms: Some(1),
            source_retrieval_latency_ms: None,
            source_grounded_correction_count: 1,
        }
    }

    /// The complete persisted answer-attempt tuple: every envelope column and
    /// every evaluation column, so a converged race can be compared as one value
    /// instead of field by field at each call site.
    #[derive(Debug, PartialEq)]
    struct AttemptRow {
        question_id: String,
        submission_sequence: i32,
        idempotency_key: String,
        capture_mode: String,
        byte_count: Option<i64>,
        char_count: Option<i64>,
        duration_ms: Option<i64>,
        client_generation_id: Option<String>,
        locale: Option<String>,
        capture_status: String,
        answer_content_policy: String,
        transcript_status: Option<String>,
        transcript_confidence_bucket: Option<String>,
        pre_provider_state: String,
        evaluation_label: Option<String>,
        concept_status: Option<String>,
        confidence_score: Option<f64>,
        source_span_id: Option<Uuid>,
    }

    async fn attempt_rows(
        pool: &sqlx::PgPool,
        voice_session_id: &str,
        response_id: &str,
    ) -> Vec<AttemptRow> {
        sqlx::query(
            "SELECT
                 question_id,
                 submission_sequence,
                 idempotency_key,
                 capture_mode,
                 byte_count,
                 char_count,
                 duration_ms,
                 client_generation_id,
                 locale,
                 capture_status,
                 answer_content_policy,
                 transcript_status,
                 transcript_confidence_bucket,
                 pre_provider_state,
                 evaluation_label,
                 concept_status,
                 confidence_score,
                 source_span_id
             FROM answer_attempts
             WHERE voice_session_id = $1 AND response_id = $2
             ORDER BY id",
        )
        .bind(fixture_uuid(voice_session_id).expect("voice session fixture UUID"))
        .bind(response_id)
        .fetch_all(pool)
        .await
        .expect("answer attempt row query succeeds")
        .into_iter()
        .map(|row| {
            use sqlx::Row as _;
            AttemptRow {
                question_id: row.get("question_id"),
                submission_sequence: row.get("submission_sequence"),
                idempotency_key: row.get("idempotency_key"),
                capture_mode: row.get("capture_mode"),
                byte_count: row.get("byte_count"),
                char_count: row.get("char_count"),
                duration_ms: row.get("duration_ms"),
                client_generation_id: row.get("client_generation_id"),
                locale: row.get("locale"),
                capture_status: row.get("capture_status"),
                answer_content_policy: row.get("answer_content_policy"),
                transcript_status: row.get("transcript_status"),
                transcript_confidence_bucket: row.get("transcript_confidence_bucket"),
                pre_provider_state: row.get("pre_provider_state"),
                evaluation_label: row.get("evaluation_label"),
                concept_status: row.get("concept_status"),
                confidence_score: row.get("confidence_score"),
                source_span_id: row.get("source_span_id"),
            }
        })
        .collect()
    }

    /// The tuple both convergence orders have to reach: the full envelope plus
    /// the full evaluation, with neither writer clearing the other's columns.
    fn converged_attempt_row(response_id: &str, evaluation: &AnswerEvaluation) -> AttemptRow {
        let envelope = fixture_envelope(response_id);
        AttemptRow {
            question_id: envelope.question_id,
            submission_sequence: 1,
            idempotency_key: envelope.idempotency_key,
            capture_mode: "typed".to_owned(),
            byte_count: Some(24),
            char_count: Some(24),
            duration_ms: Some(1_200),
            client_generation_id: Some("generation-1".to_owned()),
            locale: Some("en-US".to_owned()),
            capture_status: "accepted".to_owned(),
            answer_content_policy: "none".to_owned(),
            transcript_status: Some("final".to_owned()),
            transcript_confidence_bucket: Some("high".to_owned()),
            pre_provider_state: "captured".to_owned(),
            evaluation_label: Some(evaluation.label.clone()),
            concept_status: Some(
                match evaluation.concept_status {
                    ConceptStatus::Strong => "strong",
                    ConceptStatus::Shaky => "shaky",
                    ConceptStatus::Missed => "missed",
                    ConceptStatus::Review => "review",
                }
                .to_owned(),
            ),
            confidence_score: Some(f64::from(evaluation.confidence_score)),
            source_span_id: Some(
                fixture_uuid(&evaluation.source.source_id).expect("source fixture UUID"),
            ),
        }
    }

    /// Stops a deletion transaction *after* it has already removed this
    /// session's usage rows and *before* it commits, by holding the table its
    /// final statement needs.
    ///
    /// This is the forced interleaving the unserialized check-then-insert loses:
    /// a usage writer that only reads `status` sees the pre-delete value, writes
    /// its row, and the row outlives the commit. A writer that takes the session
    /// row lock instead cannot even read until the deletion commits.
    /// Parks every answer-attempt INSERT on the seeded source span's key-share
    /// lock.
    ///
    /// The evaluation writer's `UPDATE` matches no row, so it fires no
    /// foreign-key trigger and runs straight through; the existence probe is a
    /// plain read. Only the INSERT's foreign-key check needs the locked row. A
    /// check-then-insert therefore parks *after* its probe has already answered
    /// "no row exists", which is precisely the window a single conflict-safe
    /// upsert closes.
    async fn wait_for_parked_attempt_inserts(pool: &sqlx::PgPool, expected: i64) {
        for _ in 0..400 {
            let parked = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*)
                 FROM pg_stat_activity
                 WHERE datname = current_database()
                   AND state = 'active'
                   AND wait_event_type = 'Lock'
                   AND query LIKE '%INSERT INTO answer_attempts%'",
            )
            .fetch_one(pool)
            .await
            .expect("parked-backend query succeeds");
            if parked >= expected {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("fewer than {expected} answer-attempt inserts parked on the source-span wedge");
    }

    async fn wait_until_delete_is_wedged(pool: &sqlx::PgPool) {
        for _ in 0..400 {
            let blocked = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*)
                 FROM pg_stat_activity
                 WHERE datname = current_database()
                   AND state = 'active'
                   AND wait_event_type = 'Lock'
                   AND query LIKE '%DELETE FROM voice_session_token_nonces%'",
            )
            .fetch_one(pool)
            .await
            .expect("blocked-backend query succeeds");
            if blocked > 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("the deletion transaction never reached the wedge lock");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_voice_session_replay_is_idempotent_and_count_exact() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let first_store = PostgresStudyStore::new(pool.clone());
        let second_store = PostgresStudyStore::new(pool.clone());

        // Sequential replay on one instance: one physical row, one counted write.
        let sequential_id = Uuid::new_v4().to_string();
        assert_eq!(
            first_store
                .record_voice_session(&session_config(&sequential_id))
                .await
                .expect("first session write succeeds"),
            StudyStoreWriteOutcome::Inserted
        );
        assert_eq!(
            first_store
                .record_voice_session(&session_config(&sequential_id))
                .await
                .expect("session replay succeeds"),
            StudyStoreWriteOutcome::IdempotentReplay
        );
        assert_eq!(first_store.write_counts().sessions, 1);
        assert_eq!(voice_session_rows(&pool, &sequential_id).await, 1);
        assert_eq!(session_status(&pool, &sequential_id).await, "open");

        // Concurrent replay across two instances over the same pool.
        let concurrent_id = Uuid::new_v4().to_string();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let first = {
            let store = first_store.clone();
            let config = session_config(&concurrent_id);
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store.record_voice_session(&config).await
            })
        };
        let second = {
            let store = second_store.clone();
            let config = session_config(&concurrent_id);
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store.record_voice_session(&config).await
            })
        };
        let first = first.await.expect("first racer joins");
        let second = second.await.expect("second racer joins");
        let mut outcomes = vec![
            first.expect("first concurrent session write succeeds"),
            second.expect("second concurrent session write succeeds"),
        ];
        outcomes.sort_by_key(|outcome| match outcome {
            StudyStoreWriteOutcome::Inserted => 0,
            StudyStoreWriteOutcome::IdempotentReplay => 1,
        });
        assert_eq!(
            outcomes,
            vec![
                StudyStoreWriteOutcome::Inserted,
                StudyStoreWriteOutcome::IdempotentReplay
            ]
        );
        assert_eq!(voice_session_rows(&pool, &concurrent_id).await, 1);
        // Instance deltas: the sequential pair already counted one session on the
        // first instance, so the summed delta for the raced id must be exactly one.
        assert_eq!(
            (first_store.write_counts().sessions - 1) + second_store.write_counts().sessions,
            1
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_answer_evaluation_concurrent_compat_replay_is_atomic() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let first_store = PostgresStudyStore::new(pool.clone());
        let second_store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&first_store, &session_id).await;

        let evaluation = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);
        let response_id = "response-compat-race";

        // Force the interleaving instead of hoping for it: both racers reach the
        // physical insert together, each having already observed "no row".
        let mut wedge = pool.begin().await.expect("wedge transaction begins");
        sqlx::query("SELECT id FROM source_spans WHERE id = $1 FOR UPDATE")
            .bind(fixture_uuid("src-lecture-5-slide-18").expect("source fixture UUID"))
            .fetch_one(&mut *wedge)
            .await
            .expect("source span wedge lock is taken");

        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let first = {
            let store = first_store.clone();
            let session_id = session_id.clone();
            let evaluation = evaluation.clone();
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store
                    .record_answer_evaluation(
                        "user-1",
                        "biology-midterm",
                        &session_id,
                        response_id,
                        evaluation,
                    )
                    .await
            })
        };
        let second = {
            let store = second_store.clone();
            let session_id = session_id.clone();
            let evaluation = evaluation.clone();
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store
                    .record_answer_evaluation(
                        "user-1",
                        "biology-midterm",
                        &session_id,
                        response_id,
                        evaluation,
                    )
                    .await
            })
        };
        wait_for_parked_attempt_inserts(&pool, 2).await;
        wedge.commit().await.expect("source span wedge releases");

        let first = first.await.expect("first racer joins");
        let second = second.await.expect("second racer joins");
        for result in [&first, &second] {
            let error = match result {
                Ok(_) => continue,
                Err(error) => error,
            };
            panic!("concurrent identical evaluation replay failed: {error:?}");
        }

        let rows = attempt_rows(&pool, &session_id, response_id).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].evaluation_label.as_deref(), Some("mostly correct"));
        assert_eq!(rows[0].concept_status.as_deref(), Some("strong"));
        assert_eq!(rows[0].pre_provider_state, "evaluation_only_compat");
        assert_eq!(
            first_store.write_counts().answer_attempts
                + second_store.write_counts().answer_attempts,
            1
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_answer_envelope_and_evaluation_converge_in_either_order() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let envelope_store = PostgresStudyStore::new(pool.clone());
        let evaluation_store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&envelope_store, &session_id).await;
        let evaluation = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);

        // Order 1: envelope first, evaluation second.
        let envelope_first = "response-envelope-first";
        envelope_store
            .record_answer_attempt_envelope(
                "user-1",
                "biology-midterm",
                &session_id,
                fixture_envelope(envelope_first),
            )
            .await
            .expect("envelope records first");
        evaluation_store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                envelope_first,
                evaluation.clone(),
            )
            .await
            .expect("evaluation fills the envelope row");
        assert_eq!(
            attempt_rows(&pool, &session_id, envelope_first).await,
            vec![converged_attempt_row(envelope_first, &evaluation)]
        );

        // Order 2: evaluation first, envelope second.
        let evaluation_first = "response-evaluation-first";
        evaluation_store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                evaluation_first,
                evaluation.clone(),
            )
            .await
            .expect("evaluation records first");
        envelope_store
            .record_answer_attempt_envelope(
                "user-1",
                "biology-midterm",
                &session_id,
                fixture_envelope(evaluation_first),
            )
            .await
            .expect("envelope upgrades the compat row");
        assert_eq!(
            attempt_rows(&pool, &session_id, evaluation_first).await,
            vec![converged_attempt_row(evaluation_first, &evaluation)]
        );

        // Order 3: released together, so whichever wins the insert, the committed
        // tuple is the same.
        let raced = "response-envelope-evaluation-race";
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let envelope_task = {
            let store = envelope_store.clone();
            let session_id = session_id.clone();
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store
                    .record_answer_attempt_envelope(
                        "user-1",
                        "biology-midterm",
                        &session_id,
                        fixture_envelope(raced),
                    )
                    .await
            })
        };
        let evaluation_task = {
            let store = evaluation_store.clone();
            let session_id = session_id.clone();
            let evaluation = evaluation.clone();
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store
                    .record_answer_evaluation(
                        "user-1",
                        "biology-midterm",
                        &session_id,
                        raced,
                        evaluation,
                    )
                    .await
            })
        };
        envelope_task
            .await
            .expect("envelope racer joins")
            .expect("raced envelope write succeeds");
        evaluation_task
            .await
            .expect("evaluation racer joins")
            .expect("raced evaluation write succeeds");
        assert_eq!(
            attempt_rows(&pool, &session_id, raced).await,
            vec![converged_attempt_row(raced, &evaluation)]
        );

        // Three physical rows, three counted attempts across both instances.
        assert_eq!(
            envelope_store.write_counts().answer_attempts
                + evaluation_store.write_counts().answer_attempts,
            3
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_conflicting_evaluation_replay_returns_conflict_without_mutation() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &session_id).await;

        let response_id = "response-divergent-replay";
        let original = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                response_id,
                original.clone(),
            )
            .await
            .expect("first evaluation records");
        let committed = attempt_rows(&pool, &session_id, response_id).await;
        let attempts_after_first = store.write_counts().answer_attempts;

        let divergent = fixture_evaluation("wrong", ConceptStatus::Missed, 0.11);
        let error = store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                response_id,
                divergent,
            )
            .await
            .expect_err("a divergent replay under the same response identity is refused");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert!(
            !error.reason().contains("23505") && !error.reason().contains("duplicate key"),
            "conflict must not leak SQLSTATE detail: {}",
            error.reason()
        );
        assert_eq!(
            attempt_rows(&pool, &session_id, response_id).await,
            committed
        );
        assert_eq!(store.write_counts().answer_attempts, attempts_after_first);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_voice_usage_and_session_delete_serialize_to_no_usage_row() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let usage_store = PostgresStudyStore::new(pool.clone());
        let delete_store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&usage_store, &session_id).await;

        let mut wedge = pool.begin().await.expect("wedge transaction begins");
        sqlx::query("LOCK TABLE voice_session_token_nonces IN EXCLUSIVE MODE")
            .execute(&mut *wedge)
            .await
            .expect("wedge lock is taken");

        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let delete = {
            let store = delete_store.clone();
            let session_id = session_id.clone();
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store
                    .delete_session_history("user-1", "biology-midterm", &session_id)
                    .await
            })
        };
        barrier.wait().await;
        wait_until_delete_is_wedged(&pool).await;

        let usage = {
            let store = usage_store.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move { store.record_voice_usage(usage_record(&session_id)).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        wedge.commit().await.expect("wedge lock releases");

        delete
            .await
            .expect("delete joins")
            .expect("session history deletion succeeds");
        let usage = usage.await.expect("usage joins");

        // The invariant this test owns: whichever of the two legal serial orders
        // ran, the final deleted state contains no usage row.
        assert_eq!(usage_rows_for_session(&pool, &session_id).await, 0);
        assert_eq!(session_status(&pool, &session_id).await, "deleted");
        // And the usage writer reported that order truthfully.
        match usage {
            Ok(StudyStoreWriteOutcome::Inserted) => {
                assert_eq!(usage_store.write_counts().voice_usage, 1);
            }
            Ok(StudyStoreWriteOutcome::IdempotentReplay) => {
                panic!("usage has no stable identity and must never report a replay")
            }
            Err(error) => {
                assert_eq!(error.kind(), PortErrorKind::Conflict);
                assert_eq!(usage_store.write_counts().voice_usage, 0);
            }
        }

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_voice_usage_and_study_delete_serialize_to_no_usage_row() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let usage_store = PostgresStudyStore::new(pool.clone());
        let delete_store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&usage_store, &session_id).await;

        let mut wedge = pool.begin().await.expect("wedge transaction begins");
        sqlx::query("LOCK TABLE voice_session_token_nonces IN EXCLUSIVE MODE")
            .execute(&mut *wedge)
            .await
            .expect("wedge lock is taken");

        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let delete = {
            let store = delete_store.clone();
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                store.delete_study_set("user-1", "biology-midterm").await
            })
        };
        barrier.wait().await;
        wait_until_delete_is_wedged(&pool).await;

        let usage = {
            let store = usage_store.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move { store.record_voice_usage(usage_record(&session_id)).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        wedge.commit().await.expect("wedge lock releases");

        delete
            .await
            .expect("delete joins")
            .expect("study set deletion succeeds");
        let usage = usage.await.expect("usage joins");

        // The invariant this test owns: whichever of the two legal serial orders
        // ran, the final deleted state contains no usage row.
        assert_eq!(usage_rows_for_session(&pool, &session_id).await, 0);
        assert_eq!(session_status(&pool, &session_id).await, "deleted");
        // And the usage writer reported that order truthfully.
        match usage {
            Ok(StudyStoreWriteOutcome::Inserted) => {
                assert_eq!(usage_store.write_counts().voice_usage, 1);
            }
            Ok(StudyStoreWriteOutcome::IdempotentReplay) => {
                panic!("usage has no stable identity and must never report a replay")
            }
            Err(error) => {
                assert_eq!(error.kind(), PortErrorKind::Conflict);
                assert_eq!(usage_store.write_counts().voice_usage, 0);
            }
        }

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    // ------------------------------------------------------------------
    // Task 5 (`DATA-005`)
    //
    // Browser-event authorization is durable, tenant-scoped, and dies with the
    // session it authorized. A process-local ledger cannot make any of those
    // claims: it disappears on restart, is invisible to a second instance, and
    // grows without bound under replay.
    // ------------------------------------------------------------------

    const OTHER_PAYLOAD_SHA256: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    async fn digest_rows_for_session(pool: &sqlx::PgPool, voice_session_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM event_authorization_digests
             WHERE voice_session_id = $1",
        )
        .bind(fixture_uuid(voice_session_id).expect("voice session fixture UUID"))
        .fetch_one(pool)
        .await
        .expect("authorization digest row count query succeeds")
    }

    async fn digest_rows_for_study_set(pool: &sqlx::PgPool, study_set_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM event_authorization_digests
             WHERE study_set_id = $1",
        )
        .bind(fixture_uuid(study_set_id).expect("study set fixture UUID"))
        .fetch_one(pool)
        .await
        .expect("authorization digest row count query succeeds")
    }

    /// Rewrites exactly one column of the single stored digest row.
    ///
    /// Rewriting the durable key is the same thing as a caller presenting a
    /// different value for that field: either way, five of six key fields match
    /// and one does not. Each helper is a literal statement — there is no
    /// dynamic column name anywhere in this file.
    async fn swap_digest_user(pool: &sqlx::PgPool, from: &str, to: &str) -> u64 {
        sqlx::query("UPDATE event_authorization_digests SET user_id = $2 WHERE user_id = $1")
            .bind(from)
            .bind(to)
            .execute(pool)
            .await
            .expect("digest user swap succeeds")
            .rows_affected()
    }

    async fn swap_digest_study_set(pool: &sqlx::PgPool, from: Uuid, to: Uuid) -> u64 {
        sqlx::query(
            "UPDATE event_authorization_digests SET study_set_id = $2 WHERE study_set_id = $1",
        )
        .bind(from)
        .bind(to)
        .execute(pool)
        .await
        .expect("digest study set swap succeeds")
        .rows_affected()
    }

    async fn swap_digest_voice_session(pool: &sqlx::PgPool, from: Uuid, to: Uuid) -> u64 {
        sqlx::query(
            "UPDATE event_authorization_digests
             SET voice_session_id = $2
             WHERE voice_session_id = $1",
        )
        .bind(from)
        .bind(to)
        .execute(pool)
        .await
        .expect("digest voice session swap succeeds")
        .rows_affected()
    }

    async fn swap_digest_response(pool: &sqlx::PgPool, from: &str, to: &str) -> u64 {
        sqlx::query(
            "UPDATE event_authorization_digests SET response_id = $2 WHERE response_id = $1",
        )
        .bind(from)
        .bind(to)
        .execute(pool)
        .await
        .expect("digest response swap succeeds")
        .rows_affected()
    }

    async fn swap_digest_event_kind(pool: &sqlx::PgPool, from: &str, to: &str) -> u64 {
        sqlx::query("UPDATE event_authorization_digests SET event_kind = $2 WHERE event_kind = $1")
            .bind(from)
            .bind(to)
            .execute(pool)
            .await
            .expect("digest event kind swap succeeds")
            .rows_affected()
    }

    /// Replaces the stored digest and returns what it was, so the caller can put
    /// it back and prove the rejection changed nothing.
    async fn swap_digest_payload(pool: &sqlx::PgPool, to: &str) -> String {
        let previous = sqlx::query_scalar::<_, String>(
            "SELECT payload_sha256 FROM event_authorization_digests",
        )
        .fetch_one(pool)
        .await
        .expect("digest payload read succeeds");
        sqlx::query("UPDATE event_authorization_digests SET payload_sha256 = $1")
            .bind(to)
            .execute(pool)
            .await
            .expect("digest payload swap succeeds");
        previous
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_answer_evaluation_authorization_survives_store_reconstruction() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let session_id = Uuid::new_v4().to_string();
        let evaluation = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);

        // Store A writes, then is dropped: a restart, expressed as an object graph.
        {
            let first_store = PostgresStudyStore::new(pool.clone());
            record_count_table_session(&first_store, &session_id).await;
            first_store
                .record_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    &session_id,
                    "response-restart",
                    evaluation.clone(),
                )
                .await
                .expect("evaluation records under the first store");
        }

        let second_store = PostgresStudyStore::new(pool.clone());
        second_store
            .authorize_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-restart",
                &evaluation,
            )
            .await
            .expect("a reconstructed store authorizes the durable digest");
        assert_eq!(digest_rows_for_session(&pool, &session_id).await, 1);

        // Closing the session ends browser authority for it, durably.
        second_store
            .close_voice_session(&session_id, "completed")
            .await
            .expect("session closes");
        assert_eq!(digest_rows_for_session(&pool, &session_id).await, 0);
        let error = second_store
            .authorize_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-restart",
                &evaluation,
            )
            .await
            .expect_err("a closed session cannot replay browser authority");
        assert!(matches!(
            error.kind(),
            PortErrorKind::Conflict | PortErrorKind::Unavailable
        ));

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_concept_status_authorization_is_visible_to_second_instance() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        // Both instances exist before the write, so nothing can be explained by
        // one of them having observed the other's construction.
        let writer = PostgresStudyStore::new(pool.clone());
        let reader = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&writer, &session_id).await;

        writer
            .record_concept_status(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-two-instance",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .expect("concept status records under the writing instance");

        reader
            .authorize_concept_status(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-two-instance",
                "nadh",
                &ConceptStatus::Strong,
            )
            .await
            .expect("the second instance authorizes the durable digest");
        assert_eq!(digest_rows_for_session(&pool, &session_id).await, 1);

        let error = reader
            .authorize_concept_status(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-two-instance",
                "nadh",
                &ConceptStatus::Missed,
            )
            .await
            .expect_err("a different status is a different payload");
        assert_eq!(error.kind(), PortErrorKind::Conflict);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_recap_authorization_is_visible_to_second_instance() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let writer = PostgresStudyStore::new(pool.clone());
        let reader = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&writer, &session_id).await;
        let mut recap = fixture_recap();
        recap.voice_session_id.clone_from(&session_id);

        writer
            .record_recap(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-recap-two-instance",
                recap.clone(),
            )
            .await
            .expect("recap records under the writing instance");

        reader
            .authorize_recap(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-recap-two-instance",
                &recap,
            )
            .await
            .expect("the second instance authorizes the durable digest");
        assert_eq!(digest_rows_for_session(&pool, &session_id).await, 1);

        let mut forged = recap.clone();
        forged.headline = "Strong concepts: 2 of 2.".to_owned();
        let error = reader
            .authorize_recap(
                "user-1",
                "biology-midterm",
                &session_id,
                "response-recap-two-instance",
                &forged,
            )
            .await
            .expect_err("a changed recap is a different payload");
        assert_eq!(error.kind(), PortErrorKind::Conflict);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_authorization_digest_rejects_wrong_response_kind_payload_and_tenant() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        insert_secondary_study_set(&pool).await;
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        let other_session_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &session_id).await;
        record_count_table_session(&store, &other_session_id).await;
        let evaluation = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);
        let response_id = "response-negative-matrix";

        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_id,
                response_id,
                evaluation.clone(),
            )
            .await
            .expect("evaluation records");
        assert_eq!(digest_rows_for_session(&pool, &session_id).await, 1);

        let session_uuid = parse_uuid(&session_id).expect("session id is a UUID");
        let other_session_uuid = parse_uuid(&other_session_id).expect("session id is a UUID");
        let study_set_uuid = fixture_uuid("biology-midterm").expect("study set fixture UUID");
        let other_study_set_uuid =
            parse_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("secondary set UUID");

        let authorize = |store: PostgresStudyStore,
                         session_id: String,
                         evaluation: AnswerEvaluation| async move {
            store
                .authorize_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    &session_id,
                    response_id,
                    &evaluation,
                )
                .await
        };

        // Baseline: the untouched six-field key authorizes.
        authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect("the stored digest authorizes its own event");

        // 1 — user.
        assert_eq!(swap_digest_user(&pool, "user-1", "user-2").await, 1);
        let error = authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect_err("a digest recorded for another tenant is not authority here");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert_eq!(swap_digest_user(&pool, "user-2", "user-1").await, 1);

        // 2 — study set.
        assert_eq!(
            swap_digest_study_set(&pool, study_set_uuid, other_study_set_uuid).await,
            1
        );
        let error = authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect_err("a digest recorded for another study set is not authority here");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert_eq!(
            swap_digest_study_set(&pool, other_study_set_uuid, study_set_uuid).await,
            1
        );

        // 3 — voice session.
        assert_eq!(
            swap_digest_voice_session(&pool, session_uuid, other_session_uuid).await,
            1
        );
        let error = authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect_err("a digest recorded for another session is not authority here");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert_eq!(
            swap_digest_voice_session(&pool, other_session_uuid, session_uuid).await,
            1
        );

        // 4 — response.
        assert_eq!(
            swap_digest_response(&pool, response_id, "response-other").await,
            1
        );
        let error = authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect_err("a digest recorded for another response is not authority here");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert_eq!(
            swap_digest_response(&pool, "response-other", response_id).await,
            1
        );

        // 5 — event kind.
        assert_eq!(
            swap_digest_event_kind(&pool, "answer_evaluation", "concept_status").await,
            1
        );
        let error = authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect_err("a concept-status digest does not authorize an evaluation");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert_eq!(
            swap_digest_event_kind(&pool, "concept_status", "answer_evaluation").await,
            1
        );

        // 6 — payload.
        let original_payload = swap_digest_payload(&pool, OTHER_PAYLOAD_SHA256).await;
        let error = authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect_err("a digest of another payload is not authority for this one");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        let restored = swap_digest_payload(&pool, &original_payload).await;
        assert_eq!(restored, OTHER_PAYLOAD_SHA256);

        // Every rejection left the row untouched, so the original still authorizes.
        authorize(store.clone(), session_id.clone(), evaluation.clone())
            .await
            .expect("the restored digest authorizes its own event again");
        assert_eq!(digest_rows_for_session(&pool, &session_id).await, 1);

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[derive(Deserialize)]
    struct LearningRecapFixtures {
        recaps: std::collections::BTreeMap<String, StudySessionRecap>,
    }

    /// The Plan 04 recap fixtures, re-pointed at the seeded tenant.
    ///
    /// Only the identity fields both backends validate against their own rows are
    /// replaced; every byte of canonical recap content — headline, summary,
    /// concepts, review schedule, next action, deferred turns — is the fixture's.
    fn learning_core_recap_fixtures(voice_session_id: &str) -> Vec<(String, StudySessionRecap)> {
        let fixtures: LearningRecapFixtures = serde_json::from_str(include_str!(
            "../../../fixtures/learning-core/recaps-v1.json"
        ))
        .expect("learning-core recap fixture is valid JSON");
        fixtures
            .recaps
            .into_iter()
            .map(|(name, mut recap)| {
                recap.voice_session_id = voice_session_id.to_owned();
                recap.source_moments = vec![RecapSourceMoment {
                    response_id: format!("response-{name}"),
                    source_id: fixture_source_reference().source_id,
                }];
                (name, recap)
            })
            .collect()
    }

    /// `DATA-005` Step 6: the two backends' stored digests are the same bytes.
    ///
    /// Both now hash through one crate-private canonical encoder, so this is a
    /// differential over the whole write path rather than over one function: the
    /// memory store's ledger and the Postgres digest table must agree for every
    /// browser event and for every canonical Plan 04 recap fixture.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_authorization_digest_bytes_are_identical() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let durable = PostgresStudyStore::new(pool.clone());
        let volatile = crate::InMemoryStudyStore::seeded_fixture();
        let session_id = "voice-session-1";
        record_fixture_session(&durable).await;
        record_fixture_session(&volatile).await;

        let evaluation = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);
        for store in [&durable as &dyn StudyMemoryStore, &volatile] {
            store
                .record_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    session_id,
                    "response-differential",
                    evaluation.clone(),
                )
                .await
                .expect("evaluation records on both backends");
            store
                .record_concept_status(
                    "user-1",
                    "biology-midterm",
                    session_id,
                    "response-differential",
                    "nadh",
                    ConceptStatus::Strong,
                )
                .await
                .expect("concept status records on both backends");
        }

        for (name, recap) in learning_core_recap_fixtures(session_id) {
            for store in [&durable as &dyn StudyMemoryStore, &volatile] {
                store
                    .record_recap(
                        "user-1",
                        "biology-midterm",
                        session_id,
                        &format!("response-{name}"),
                        recap.clone(),
                    )
                    .await
                    .unwrap_or_else(|error| {
                        panic!("recap fixture {name} records on both backends: {error:?}")
                    });
            }
        }

        let mut durable_digests = sqlx::query_scalar::<_, String>(
            "SELECT payload_sha256 FROM event_authorization_digests ORDER BY payload_sha256",
        )
        .fetch_all(&pool)
        .await
        .expect("digest read succeeds");
        durable_digests.sort();
        let mut volatile_digests = volatile
            .snapshot()
            .event_authorizations
            .into_iter()
            .map(|record| record.payload_sha256)
            .collect::<Vec<_>>();
        volatile_digests.sort();

        // Two browser events plus one digest per canonical recap fixture.
        assert_eq!(
            durable_digests.len(),
            2 + learning_core_recap_fixtures(session_id).len()
        );
        assert_eq!(durable_digests, volatile_digests);
        assert!(durable_digests.iter().all(|digest| digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))));

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_authorization_digest_is_deleted_with_session_and_study_set() {
        let fixture = PostgresSchemaFixture::migrated().await;
        let pool = fixture.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let evaluation = fixture_evaluation("mostly correct", ConceptStatus::Strong, 0.84);

        let session_delete_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &session_delete_id).await;
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &session_delete_id,
                "response-session-delete",
                evaluation.clone(),
            )
            .await
            .expect("evaluation records");
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                &session_delete_id,
                "response-session-delete",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .expect("concept status records");
        assert_eq!(digest_rows_for_session(&pool, &session_delete_id).await, 2);

        store
            .delete_session_history("user-1", "biology-midterm", &session_delete_id)
            .await
            .expect("session history deletion succeeds");
        assert_eq!(digest_rows_for_session(&pool, &session_delete_id).await, 0);

        let study_delete_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &study_delete_id).await;
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                &study_delete_id,
                "response-study-delete",
                evaluation,
            )
            .await
            .expect("evaluation records");
        assert_eq!(digest_rows_for_study_set(&pool, "biology-midterm").await, 1);

        store
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("study set deletion succeeds");
        assert_eq!(digest_rows_for_study_set(&pool, "biology-midterm").await, 0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM event_authorization_digests")
                .fetch_one(&pool)
                .await
                .expect("digest total query succeeds"),
            0
        );

        fixture
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    // ------------------------------------------------------------------
    // Task 6 — Plan 04's canonical learning persistence.
    //
    // Every fixture below is deserialized from `agent/fixtures/learning-core/`
    // and seeded identically into both backends, so a difference between the two
    // is a difference in the store and never in the test data.
    // ------------------------------------------------------------------

    const LEARNING_USER_ID: &str = "user-101";
    const LEARNING_SET_ID: &str = "set-cellular-respiration";

    #[derive(Deserialize)]
    struct LearningProgressionFixture {
        policy: ProgressionPolicyId,
        voice_session_id: String,
        active_question_ids: Vec<String>,
        inactive_question_ids: Vec<String>,
        questions: std::collections::BTreeMap<String, StudyQuestion>,
        cursors: std::collections::BTreeMap<String, QuestionProgressionCursor>,
        results: std::collections::BTreeMap<String, QuestionProgressionResult>,
    }

    #[derive(Deserialize)]
    struct LearningTurnOutcomeFixture {
        outcomes: std::collections::BTreeMap<String, TurnOutcome>,
        persisted: std::collections::BTreeMap<String, PersistedTurnOutcome>,
        challenges: std::collections::BTreeMap<String, ChallengeResolution>,
    }

    #[derive(Deserialize)]
    struct LearningEvidenceFixture {
        evidence: std::collections::BTreeMap<String, SessionLearningEvidence>,
        recaps: std::collections::BTreeMap<String, StudySessionRecap>,
    }

    fn progression_fixture() -> LearningProgressionFixture {
        serde_json::from_str(include_str!(
            "../../../fixtures/learning-core/question-progression-v1.json"
        ))
        .expect("learning-core progression fixture is valid")
    }

    fn turn_outcome_fixture() -> LearningTurnOutcomeFixture {
        serde_json::from_str(include_str!(
            "../../../fixtures/learning-core/turn-outcomes-v1.json"
        ))
        .expect("learning-core turn outcome fixture is valid")
    }

    fn evidence_fixture() -> LearningEvidenceFixture {
        serde_json::from_str(include_str!(
            "../../../fixtures/learning-core/recaps-v1.json"
        ))
        .expect("learning-core evidence fixture is valid")
    }

    /// The one study set both backends are seeded with.
    ///
    /// Questions and their bound sources come straight from Plan 04's progression
    /// fixture. Two extra inactive questions and two extra source spans exist only
    /// because the evidence fixtures cite them; they carry no fixture-pinned
    /// content and are never part of a compared value.
    struct LearningCoreSeed {
        documents: Vec<(String, String)>,
        sources: Vec<StudySourceReference>,
        concepts: Vec<(String, String, ConceptStatus)>,
        /// `(question, active, ingestion ordinal)`.
        questions: Vec<(StudyQuestion, bool, i64)>,
    }

    fn extra_source(source_id: &str, document_id: &str, span: &str) -> StudySourceReference {
        StudySourceReference {
            source_id: source_id.to_owned(),
            document_id: document_id.to_owned(),
            span: span.to_owned(),
            excerpt: "Cited by a canonical turn outcome fixture.".to_owned(),
            confidence: agent_domain::SourceConfidence::Medium,
            retrieval_reason: "ordered progression source bound by the server".to_owned(),
        }
    }

    fn extra_question(
        question_id: &str,
        concept_id: &str,
        source: &StudySourceReference,
    ) -> StudyQuestion {
        StudyQuestion {
            question_id: question_id.to_owned(),
            concept_id: concept_id.to_owned(),
            prompt: format!("Recall the ATP yield bound to {concept_id}."),
            expected_terms: vec!["ATP".to_owned()],
            follow_up: "Say the number and the stage in one sentence.".to_owned(),
            rubric: agent_domain::EvaluationRubricV1 {
                policy_version: agent_domain::learning_outcome::VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
                    .to_owned(),
                criteria: vec![agent_domain::RubricCriterionV1 {
                    criterion_id: format!("crit-{concept_id}"),
                    concept_id: concept_id.to_owned(),
                    claim: format!("The learner states the ATP yield for {concept_id}."),
                    source_id: source.source_id.clone(),
                    required: true,
                }],
            },
            source: source.clone(),
        }
    }

    fn learning_core_seed() -> LearningCoreSeed {
        let fixture = progression_fixture();
        let mut questions = Vec::new();
        let mut sources = Vec::new();
        let mut ordinal = 0_i64;
        for question_id in fixture
            .active_question_ids
            .iter()
            .chain(fixture.inactive_question_ids.iter())
        {
            let question = fixture
                .questions
                .get(question_id)
                .unwrap_or_else(|| panic!("progression fixture is missing question {question_id}"))
                .clone();
            let active = fixture.active_question_ids.contains(question_id);
            ordinal += 1;
            sources.push(question.source.clone());
            questions.push((question, active, ordinal));
        }

        let glycolysis_source = extra_source("src-lec3-slide-04", "lec3", "slide:04");
        let krebs_source = extra_source("src-lec4-slide-11", "lec4", "slide:11");
        let coupling_source = extra_source("src-lec5-slide-22", "lec5", "slide:22");
        sources.push(krebs_source.clone());
        sources.push(coupling_source);
        sources.sort_by(|left, right| left.source_id.cmp(&right.source_id));
        sources.dedup_by(|left, right| left.source_id == right.source_id);

        ordinal += 1;
        questions.push((
            extra_question(
                "q-glycolysis-net-atp",
                "concept-glycolysis-atp",
                &glycolysis_source,
            ),
            false,
            ordinal,
        ));
        ordinal += 1;
        questions.push((
            extra_question("q-krebs-net-atp", "concept-krebs-atp", &krebs_source),
            false,
            ordinal,
        ));

        LearningCoreSeed {
            documents: vec![
                ("lec5".to_owned(), "Lecture 5".to_owned()),
                ("lec4".to_owned(), "Lecture 4".to_owned()),
                ("lec3".to_owned(), "Lecture 3".to_owned()),
            ],
            sources,
            concepts: vec![
                (
                    "concept-electron-transport-chain".to_owned(),
                    "Electron transport chain".to_owned(),
                    ConceptStatus::Review,
                ),
                (
                    "concept-proton-gradient".to_owned(),
                    "Proton gradient".to_owned(),
                    ConceptStatus::Review,
                ),
                (
                    "concept-atp-synthesis".to_owned(),
                    "ATP synthesis".to_owned(),
                    ConceptStatus::Review,
                ),
                (
                    "concept-glycolysis-atp".to_owned(),
                    "ATP yield".to_owned(),
                    ConceptStatus::Review,
                ),
                (
                    "concept-krebs-atp".to_owned(),
                    "ATP yield".to_owned(),
                    ConceptStatus::Review,
                ),
            ],
            questions,
        }
    }

    fn seed_learning_core_memory(seed: &LearningCoreSeed) -> crate::InMemoryStudyStore {
        let store = crate::InMemoryStudyStore::new();
        store.upsert_study_set(crate::StudySetRecord {
            study_set_id: LEARNING_SET_ID.to_owned(),
            user_id: LEARNING_USER_ID.to_owned(),
            title: "Cellular respiration".to_owned(),
            course: Some("BIO 201".to_owned()),
            ingestion_status: agent_domain::StudySetIngestionStatus::Ready,
            ingestion_error: None,
            concept_ids: seed
                .concepts
                .iter()
                .map(|(concept_id, _, _)| concept_id.clone())
                .collect(),
            question_ids: seed
                .questions
                .iter()
                .map(|(question, _, _)| question.question_id.clone())
                .collect(),
        });
        for (document_id, title) in &seed.documents {
            store.upsert_document(crate::StudyDocumentRecord {
                study_set_id: LEARNING_SET_ID.to_owned(),
                document_id: document_id.clone(),
                title: title.clone(),
                source_kind: "pdf".to_owned(),
                processing_status: agent_domain::StudySetIngestionStatus::Ready,
                tombstoned: false,
            });
        }
        for source in &seed.sources {
            store.upsert_source_span(crate::SourceSpanRecord {
                study_set_id: LEARNING_SET_ID.to_owned(),
                source: source.clone(),
                tombstoned: false,
            });
        }
        for (concept_id, label, status) in &seed.concepts {
            store.upsert_concept(crate::ConceptRecord {
                study_set_id: LEARNING_SET_ID.to_owned(),
                concept_id: concept_id.clone(),
                label: label.clone(),
                status: status.clone(),
                source_span_id: seed.sources[0].source_id.clone(),
            });
        }
        for (question, active, _) in &seed.questions {
            store.upsert_question(crate::StudyQuestionRecord {
                study_set_id: LEARNING_SET_ID.to_owned(),
                question: question.clone(),
                active: *active,
            });
        }
        store
    }

    async fn open_learning_session(store: &dyn StudyMemoryStore, voice_session_id: &str) {
        let outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(voice_session_id)),
                user_id: Some(LEARNING_USER_ID.to_owned()),
                study_set_id: Some(LEARNING_SET_ID.to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("learning-core session opens");
        assert_eq!(outcome, StudyStoreWriteOutcome::Inserted);
    }

    async fn seed_learning_core_postgres(pool: &sqlx::PgPool, seed: &LearningCoreSeed) {
        sqlx::query(
            "INSERT INTO study_sets (id, user_id, title, course, ingestion_status, ingestion_error)
             VALUES ($1, $2, 'Cellular respiration', 'BIO 201', 'ready', NULL)",
        )
        .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
        .bind(LEARNING_USER_ID)
        .execute(pool)
        .await
        .expect("learning-core study set seeds");

        for (document_id, title) in &seed.documents {
            sqlx::query(
                "INSERT INTO study_documents (
                     id, study_set_id, display_name, source_kind, processing_status, deleted_at
                 )
                 VALUES ($1, $2, $3, 'pdf', 'ready', NULL)",
            )
            .bind(fixture_uuid(document_id).expect("document UUID"))
            .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
            .bind(title)
            .execute(pool)
            .await
            .expect("learning-core document seeds");
        }

        for source in &seed.sources {
            sqlx::query(
                "INSERT INTO source_spans (
                     id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, NULL)",
            )
            .bind(fixture_uuid(&source.source_id).expect("source UUID"))
            .bind(fixture_uuid(&source.document_id).expect("document UUID"))
            .bind(serde_json::json!({ "span": source.span }))
            .bind(&source.excerpt)
            .bind(source_confidence_str(&source.confidence))
            .bind(&source.retrieval_reason)
            .execute(pool)
            .await
            .expect("learning-core source span seeds");
        }

        for (concept_id, label, status) in &seed.concepts {
            sqlx::query(
                "INSERT INTO concepts (id, study_set_id, label, status, source_span_id, public_id)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(Uuid::new_v4())
            .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
            .bind(label)
            .bind(match status {
                ConceptStatus::Strong => "strong",
                ConceptStatus::Shaky => "shaky",
                ConceptStatus::Missed => "missed",
                ConceptStatus::Review => "review",
            })
            .bind(fixture_uuid(&seed.sources[0].source_id).expect("source UUID"))
            .bind(concept_id)
            .execute(pool)
            .await
            .expect("learning-core concept seeds");
        }

        for (question, active, ordinal) in &seed.questions {
            sqlx::query(
                "INSERT INTO study_questions (
                     id, study_set_id, question_id, source_span_id, prompt, expected_terms,
                     follow_up, active, ingestion_ordinal, concept_id, rubric_json
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            )
            .bind(Uuid::new_v4())
            .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
            .bind(&question.question_id)
            .bind(fixture_uuid(&question.source.source_id).expect("source UUID"))
            .bind(&question.prompt)
            .bind(&question.expected_terms)
            .bind(&question.follow_up)
            .bind(active)
            .bind(ordinal)
            .bind(&question.concept_id)
            .bind(serde_json::to_value(&question.rubric).expect("rubric serializes"))
            .execute(pool)
            .await
            .expect("learning-core question seeds");
        }

        sqlx::query(
            "INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
             VALUES ($1, $2)
             ON CONFLICT (study_set_id) DO UPDATE SET next_ordinal = EXCLUDED.next_ordinal",
        )
        .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
        .bind(seed.questions.len() as i64 + 1)
        .execute(pool)
        .await
        .expect("learning-core ingestion cursor seeds");
    }

    /// An independent oracle for the review schedule a session's outcomes produce.
    ///
    /// `LEARN-009` removed the separate scheduling tool, so under D-01
    /// `SERVER_PERSISTED_FSRS` the only thing that schedules a review is an
    /// evaluated turn's concept transition. This recomputes that from Plan 04's
    /// published `decide_review_schedule`, chaining each concept's card exactly as
    /// a store must, so the assertion is against the decision function and not
    /// against whatever the store happened to write.
    fn expected_review_decisions(outcomes: &[TurnOutcome]) -> Vec<ReviewScheduleSummary> {
        let mut cards: std::collections::BTreeMap<String, agent_domain::PersistedFsrsCardV1> =
            std::collections::BTreeMap::new();
        let mut latest: std::collections::BTreeMap<String, ReviewScheduleDecisionV1> =
            std::collections::BTreeMap::new();
        for outcome in outcomes {
            let recorded_at =
                agent_domain::parse_utc_instant(&outcome.recorded_at).expect("instant parses");
            let TurnResolution::Evaluated {
                concept_transitions,
                ..
            } = &outcome.resolution
            else {
                continue;
            };
            for transition in concept_transitions {
                let decision = agent_domain::decide_review_schedule(
                    recorded_at,
                    &agent_domain::ReviewOutcomeV1 {
                        status: transition.to_status.clone(),
                        hint_count: None,
                        miss_count: None,
                    },
                    &agent_domain::ReviewSchedulingContextV1 {
                        schema_version: agent_domain::VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                        exam_at: None,
                        card: cards.get(&transition.concept_id).cloned(),
                    },
                )
                .expect("authoritative decision");
                cards.insert(transition.concept_id.clone(), decision.card.clone());
                latest
                    .entry(transition.concept_id.clone())
                    .and_modify(|existing| {
                        if decision.generated_at >= existing.generated_at {
                            *existing = decision.clone();
                        }
                    })
                    .or_insert(decision);
            }
        }
        let mut summaries = latest
            .into_iter()
            .filter(|(_, decision)| {
                decision.cap_reason != Some(agent_domain::ReviewScheduleCapReasonV1::PastExam)
            })
            .map(|(concept_id, decision)| ReviewScheduleSummary {
                concept_id,
                due_at: agent_domain::format_rfc3339_millis(decision.due_at),
                authority:
                    agent_domain::learning_recap::ReviewScheduleAuthority::ServerPersistedFsrs,
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| {
            left.due_at
                .cmp(&right.due_at)
                .then_with(|| left.concept_id.cmp(&right.concept_id))
        });
        summaries
    }

    fn outcome_named(name: &str) -> TurnOutcome {
        turn_outcome_fixture()
            .outcomes
            .remove(name)
            .unwrap_or_else(|| panic!("turn outcome fixture is missing {name}"))
    }

    fn challenge_named(name: &str) -> ChallengeResolution {
        turn_outcome_fixture()
            .challenges
            .remove(name)
            .unwrap_or_else(|| panic!("challenge fixture is missing {name}"))
    }

    async fn concept_status_of(pool: &sqlx::PgPool, concept_id: &str) -> String {
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM concepts WHERE study_set_id = $1 AND public_id = $2",
        )
        .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
        .bind(concept_id)
        .fetch_one(pool)
        .await
        .expect("concept status query succeeds")
    }

    async fn learning_row_counts(pool: &sqlx::PgPool) -> (i64, i64, i64, i64, i64) {
        let row = sqlx::query(
            "SELECT
                 (SELECT COUNT(*) FROM learning_turn_outcomes) AS outcomes,
                 (SELECT COUNT(*) FROM learning_challenge_resolutions) AS challenges,
                 (SELECT COUNT(*) FROM question_progression_cursors) AS cursors,
                 (SELECT COUNT(*) FROM review_items) AS reviews,
                 (SELECT COUNT(*) FROM event_authorization_digests) AS digests",
        )
        .fetch_one(pool)
        .await
        .expect("learning row count query succeeds");
        use sqlx::Row as _;
        (
            row.get("outcomes"),
            row.get("challenges"),
            row.get("cursors"),
            row.get("reviews"),
            row.get("digests"),
        )
    }

    /// `assert_schema_has_no_raw_payload_columns` guards migration SQL, but a JSONB
    /// column's shape is the stored type's shape. This is the run-time half: every
    /// canonical learning document is checked against the same forbidden-field list
    /// before either backend accepts it.
    #[test]
    fn learning_payload_serialization_has_no_raw_payload_columns() {
        assert!(assert_schema_has_no_raw_payload_columns().is_ok());

        let outcomes = turn_outcome_fixture();
        for (name, outcome) in &outcomes.outcomes {
            let value = serde_json::to_value(outcome).expect("outcome serializes");
            assert_eq!(
                crate::memory::raw_learner_payload_field(&value),
                None,
                "{name}"
            );
            validate_turn_outcome("memory", outcome)
                .unwrap_or_else(|error| panic!("{name} is accepted: {error:?}"));
        }
        for (name, challenge) in &outcomes.challenges {
            let value = serde_json::to_value(challenge).expect("challenge serializes");
            assert_eq!(
                crate::memory::raw_learner_payload_field(&value),
                None,
                "{name}"
            );
            validate_challenge_resolution("memory", challenge)
                .unwrap_or_else(|error| panic!("{name} is accepted: {error:?}"));
        }
        for (name, evidence) in &evidence_fixture().evidence {
            let value = serde_json::to_value(evidence).expect("evidence serializes");
            assert_eq!(
                crate::memory::raw_learner_payload_field(&value),
                None,
                "{name}"
            );
        }

        // Negative control: the check has to see a forbidden name at any depth, and
        // it must see every name the schema check guards.
        for forbidden in crate::memory::FORBIDDEN_RAW_LEARNER_PAYLOAD_FIELDS {
            let nested = serde_json::json!({
                "schema": "viva.turn_outcome.v1",
                "resolution": { "kind": "evaluated", (*forbidden): "the learner said this" }
            });
            assert_eq!(
                crate::memory::raw_learner_payload_field(&nested),
                Some(*forbidden)
            );
        }
        // Case is not an escape hatch.
        assert_eq!(
            crate::memory::raw_learner_payload_field(&serde_json::json!({
                "resolution": { "Answer_Text": "the learner said this" }
            })),
            Some("answer_text")
        );
    }

    #[tokio::test]
    async fn memory_record_turn_outcome_is_atomic_and_replay_safe() {
        let seed = learning_core_seed();
        let store = seed_learning_core_memory(&seed);
        open_learning_session(&store, "vs-0004").await;
        let fixture = turn_outcome_fixture();
        let outcome = outcome_named("evaluated_strong");

        let first = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0004",
                outcome.clone(),
            )
            .await
            .expect("first outcome persists");
        assert_eq!(first, fixture.persisted["first_record"]);

        let replay = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0004",
                outcome.clone(),
            )
            .await
            .expect("identical replay is accepted");
        assert_eq!(replay, fixture.persisted["replay_record"]);

        // One row, one set of transitions, one authorization — a replay adds none.
        let evidence = store
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0004")
            .await
            .expect("evidence reads back");
        assert_eq!(evidence.outcomes, vec![outcome.clone()]);
        // One browser authorization digest per recorded concept transition, plus
        // the replay key of the D-01 decision each transition scheduled, and
        // nothing for anything the outcome did not claim.
        let ledger = store.snapshot().event_authorizations;
        assert_eq!(
            ledger
                .iter()
                .filter(|record| record.kind == crate::memory::EventAuthorizationKind::ConceptStatus)
                .count(),
            2
        );
        assert_eq!(
            ledger
                .iter()
                .filter(
                    |record| record.kind == crate::memory::EventAuthorizationKind::ReviewSchedule
                )
                .count(),
            2
        );
        assert_eq!(ledger.len(), 4);
        let state = store.snapshot();
        assert_eq!(
            state.concepts[&format!("{LEARNING_SET_ID}::concept-electron-transport-chain")].status,
            ConceptStatus::Strong
        );

        // A one-field change under the same response identity is a conflict, and
        // it changes nothing.
        let mut divergent = outcome.clone();
        divergent.rubric_policy_version = "viva.semantic-rubric.v0".to_owned();
        let error = store
            .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0004", divergent)
            .await
            .expect_err("a divergent replay is refused");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        let after = store
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0004")
            .await
            .expect("evidence still reads back");
        assert_eq!(after, evidence);
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_turn_outcome_is_atomic_and_replay_safe() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        open_learning_session(&store, "vs-0004").await;
        let fixture = turn_outcome_fixture();
        let outcome = outcome_named("evaluated_strong");

        let first = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0004",
                outcome.clone(),
            )
            .await
            .expect("first outcome persists");
        assert_eq!(first, fixture.persisted["first_record"]);
        assert_eq!(
            concept_status_of(&pool, "concept-electron-transport-chain").await,
            "strong"
        );
        let (outcomes, _, cursors, reviews, digests) = learning_row_counts(&pool).await;
        assert_eq!(outcomes, 1);
        assert_eq!(cursors, 1);
        // One browser authorization digest and one scheduled review per recorded
        // concept transition: `LEARN-009` made the evaluated turn the only thing
        // that schedules a review.
        assert_eq!(digests, 2);
        assert_eq!(reviews, 2);

        let replay = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0004",
                outcome.clone(),
            )
            .await
            .expect("identical replay is accepted");
        assert_eq!(replay, fixture.persisted["replay_record"]);
        assert_eq!(learning_row_counts(&pool).await, (1, 0, 1, 2, 2));

        let mut divergent = outcome.clone();
        divergent.rubric_policy_version = "viva.semantic-rubric.v0".to_owned();
        let error = store
            .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0004", divergent)
            .await
            .expect_err("a divergent replay is refused");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
        assert_eq!(learning_row_counts(&pool).await, (1, 0, 1, 2, 2));
        let stored = store
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0004")
            .await
            .expect("evidence reads back");
        assert_eq!(stored.outcomes, vec![outcome]);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_turn_outcome_rolls_back_every_transition_on_failure() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        open_learning_session(&store, "vs-0004").await;

        let before_status = concept_status_of(&pool, "concept-electron-transport-chain").await;
        let before_counts = learning_row_counts(&pool).await;

        // One injected invalid transition: a concept this tenant does not own.
        let mut outcome = outcome_named("evaluated_strong");
        if let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &mut outcome.resolution
        {
            concept_transitions.push(agent_domain::ConceptStatusTransition {
                concept_id: "concept-not-in-this-study-set".to_owned(),
                from_status: ConceptStatus::Review,
                to_status: ConceptStatus::Strong,
                criterion_ids: vec!["crit-etc-donor".to_owned()],
            });
        } else {
            panic!("evaluated_strong is an evaluated outcome");
        }

        let error = store
            .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0004", outcome)
            .await
            .expect_err("an invalid transition refuses the whole outcome");
        assert!(matches!(
            error.kind(),
            PortErrorKind::InvalidInput | PortErrorKind::Unavailable
        ));

        // Outcome, transitions, progression, schedule, and authorization digest are
        // all exactly as they were.
        assert_eq!(
            concept_status_of(&pool, "concept-electron-transport-chain").await,
            before_status
        );
        assert_eq!(
            concept_status_of(&pool, "concept-proton-gradient").await,
            "review"
        );
        assert_eq!(learning_row_counts(&pool).await, before_counts);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_record_challenge_resolution_binds_existing_outcome_and_source() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        open_learning_session(&store, "vs-0006").await;

        // A challenge against an outcome that does not exist is refused.
        let orphan = challenge_named("source_confirmed");
        let error = store
            .record_challenge_resolution(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0006",
                orphan.clone(),
            )
            .await
            .expect_err("a challenge cannot bind a missing outcome");
        assert!(matches!(
            error.kind(),
            PortErrorKind::Unavailable | PortErrorKind::Conflict
        ));

        store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0006",
                outcome_named("evaluated_required_contradiction_is_wrong"),
            )
            .await
            .expect("challenged outcome persists");

        let stored = store
            .record_challenge_resolution(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0006",
                orphan.clone(),
            )
            .await
            .expect("challenge binds its outcome and source");
        assert_eq!(stored, orphan);
        let replay = store
            .record_challenge_resolution(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0006",
                orphan.clone(),
            )
            .await
            .expect("identical challenge replay returns the stored value");
        assert_eq!(replay, orphan);

        let mut divergent = orphan.clone();
        divergent.disposition = agent_domain::ChallengeDisposition::Deferred;
        let error = store
            .record_challenge_resolution(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0006", divergent)
            .await
            .expect_err("a changed challenge field is refused");
        assert_eq!(error.kind(), PortErrorKind::Conflict);

        // An unknown source is refused.
        let mut forged = challenge_named("deferred");
        forged.correction_id = "corr-forged".to_owned();
        forged.challenged_response_id = "resp-0008".to_owned();
        forged.source_id = "src-not-owned".to_owned();
        let error = store
            .record_challenge_resolution(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0006", forged)
            .await
            .expect_err("a challenge cannot cite a source this tenant does not own");
        assert!(matches!(
            error.kind(),
            PortErrorKind::Unavailable | PortErrorKind::InvalidInput
        ));

        // Supersession is only legal behind a resolution that permits reevaluation.
        let replacement = outcome_named("evaluated_replacement_supersedes_challenged");
        let error = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0006",
                replacement.clone(),
            )
            .await
            .expect_err("supersession without a reevaluation resolution is refused");
        assert!(matches!(
            error.kind(),
            PortErrorKind::Conflict | PortErrorKind::InvalidInput
        ));

        store
            .record_challenge_resolution(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                "vs-0006",
                challenge_named("reevaluation_required"),
            )
            .await
            .expect("reevaluation resolution persists");
        store
            .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0006", replacement)
            .await
            .expect("supersession is legal behind a reevaluation resolution");

        let (_, challenges, _, _, _) = learning_row_counts(&pool).await;
        assert_eq!(challenges, 2);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// Drives the canonical D-02B sequence against one store and returns every
    /// observed `(result, cursor)` pair, keyed by the fixture case it should equal.
    async fn drive_ordered_progression(
        store: &dyn StudyMemoryStore,
        session_id: &str,
    ) -> Vec<(&'static str, QuestionProgressionResult)> {
        let steps: [(&str, &str, Option<&str>); 6] = [
            ("selected_first", "resp-p1", None),
            (
                "retry_current_increments_attempt",
                "resp-p2",
                Some("evaluated_required_contradiction_is_wrong"),
            ),
            (
                "deferred_keeps_current_question",
                "resp-p3",
                Some("deferred_evaluator_unavailable"),
            ),
            (
                "selected_second_after_advance",
                "resp-p4",
                Some("evaluated_strong"),
            ),
            (
                "selected_third_after_advance",
                "resp-p5",
                Some("evaluated_synonym_accepted"),
            ),
            (
                "exhausted_emits_no_question",
                "resp-p6",
                Some("evaluated_mostly_correct"),
            ),
        ];
        // The question each selection returns, in order. Step `n` records the
        // outcome of selection `n - 1`, so it names `selected_question[n - 1]`.
        let selected_question = [
            "q-etc-electron-flow",
            "q-etc-electron-flow",
            "q-etc-electron-flow",
            "q-gradient-direction",
            "q-atp-synthase-coupling",
        ];

        let mut observed = Vec::new();
        for (index, (case, response_id, outcome_name)) in steps.iter().enumerate() {
            if let Some(outcome_name) = outcome_name {
                // The disposition of the *previous* selection's response is what
                // moves the cursor; the selection itself then reports the move.
                let mut outcome = outcome_named(outcome_name);
                outcome.response_id = format!("{response_id}-prior");
                outcome.question_id = selected_question[index - 1].to_owned();
                if let TurnResolution::Evaluated {
                    concept_transitions,
                    ..
                } = &mut outcome.resolution
                {
                    concept_transitions.clear();
                }
                store
                    .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, session_id, outcome)
                    .await
                    .expect("progression outcome persists");
                let result = store
                    .select_next_question(
                        LEARNING_USER_ID,
                        LEARNING_SET_ID,
                        session_id,
                        &format!("{response_id}-prior"),
                        ProgressionPolicyId::OrderedV1,
                    )
                    .await
                    .expect("selection succeeds");
                observed.push((
                    match *case {
                        "retry_current_increments_attempt" => "retry_current_increments_attempt",
                        "deferred_keeps_current_question" => "deferred_keeps_current_question",
                        "selected_second_after_advance" => "selected_second_after_advance",
                        "selected_third_after_advance" => "selected_third_after_advance",
                        "exhausted_emits_no_question" => "exhausted_emits_no_question",
                        other => panic!("unexpected progression case {other}"),
                    },
                    result,
                ));
            } else {
                let result = store
                    .select_next_question(
                        LEARNING_USER_ID,
                        LEARNING_SET_ID,
                        session_id,
                        response_id,
                        ProgressionPolicyId::OrderedV1,
                    )
                    .await
                    .expect("first selection succeeds");
                observed.push(("selected_first", result));
            }
        }
        observed
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_select_next_question_reconnect_and_replay_share_one_cursor() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let fixture = progression_fixture();
        let store = PostgresStudyStore::new(pool.clone());
        open_learning_session(&store, &fixture.voice_session_id).await;

        let first = store
            .select_next_question(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                &fixture.voice_session_id,
                "resp-cursor-1",
                fixture.policy,
            )
            .await
            .expect("first selection succeeds");
        assert_eq!(first, fixture.results["selected_first"]);

        // Replay of the same authorized response returns the stored selection and
        // the unchanged revision.
        let replay = store
            .select_next_question(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                &fixture.voice_session_id,
                "resp-cursor-1",
                fixture.policy,
            )
            .await
            .expect("replay succeeds");
        assert_eq!(replay, first);

        // Reconnect: a second store instance over the same pool resumes the cursor
        // rather than restarting it.
        let reconnected = PostgresStudyStore::new(pool.clone());
        let after_reconnect = reconnected
            .select_next_question(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                &fixture.voice_session_id,
                "resp-cursor-1",
                fixture.policy,
            )
            .await
            .expect("reconnect resumes the cursor");
        assert_eq!(after_reconnect, first);

        // Exactly one cursor row, at the revision the fixture pins.
        let (_, _, cursors, _, _) = learning_row_counts(&pool).await;
        assert_eq!(cursors, 1);
        let revision = sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM question_progression_cursors WHERE voice_session_id = $1",
        )
        .bind(fixture_uuid(&fixture.voice_session_id).expect("session UUID"))
        .fetch_one(&pool)
        .await
        .expect("cursor revision query succeeds");
        assert_eq!(revision, 1);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The five Plan 06 learning methods, exercised on a production store against a
    /// canonical seeded session. None may answer `Unavailable`.
    async fn assert_learning_ports_are_implemented(store: &dyn StudyMemoryStore) {
        let session_id = "vs-0002";
        open_learning_session(store, session_id).await;
        let fixture = evidence_fixture();
        let seeded = fixture.evidence["mixed_strong_shaky_missed"].clone();

        for outcome in &seeded.outcomes {
            let persisted = store
                .record_turn_outcome(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    session_id,
                    outcome.clone(),
                )
                .await
                .expect("record_turn_outcome is implemented");
            assert_eq!(persisted.turn_outcome, *outcome);
            assert!(!persisted.record.replayed);
            assert_eq!(persisted.record.response_id, outcome.response_id);
            assert_eq!(
                persisted.record.schema,
                agent_domain::learning_outcome::VIVA_TURN_OUTCOME_RECORD_SCHEMA
            );
        }
        // Replay reports the replay, and reports the same outcome.
        let replayed = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                session_id,
                seeded.outcomes[0].clone(),
            )
            .await
            .expect("replay is implemented");
        assert!(replayed.record.replayed);
        assert_eq!(replayed.turn_outcome, seeded.outcomes[0]);

        let evidence = store
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("session_learning_evidence is implemented");
        assert_eq!(evidence.user_id, LEARNING_USER_ID);
        assert_eq!(evidence.study_set_id, LEARNING_SET_ID);
        assert_eq!(evidence.voice_session_id, session_id);
        assert_eq!(evidence.outcomes, seeded.outcomes);
        let mut expected_labels = seeded.concept_labels.clone();
        expected_labels.sort_by(|left, right| left.concept_id.cmp(&right.concept_id));
        assert_eq!(evidence.concept_labels, expected_labels);
        // The schedule is the one D-01 computes from these outcomes — every entry
        // under the selected `server_persisted_fsrs` authority, one per transitioned
        // concept, and never the rejected read-time authority.
        assert_eq!(
            evidence.review_decisions,
            expected_review_decisions(&seeded.outcomes)
        );
        assert_eq!(evidence.review_decisions.len(), 3);

        let challenge = ChallengeResolution {
            schema: agent_domain::learning_outcome::VIVA_CHALLENGE_RESOLUTION_SCHEMA.to_owned(),
            correction_id: "corr-override-1".to_owned(),
            challenged_response_id: seeded.outcomes[0].response_id.clone(),
            source_id: "src-lec5-slide-19".to_owned(),
            disposition: agent_domain::ChallengeDisposition::SourceConfirmed,
            replacement_response_id: None,
        };
        let stored_challenge = store
            .record_challenge_resolution(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                session_id,
                challenge.clone(),
            )
            .await
            .expect("record_challenge_resolution is implemented");
        assert_eq!(stored_challenge, challenge);

        let selection = store
            .select_next_question(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                session_id,
                &seeded.outcomes[0].response_id,
                ProgressionPolicyId::OrderedV1,
            )
            .await
            .expect("select_next_question is implemented");
        match selection {
            QuestionProgressionResult::Selected { total, .. }
            | QuestionProgressionResult::Retry { total, .. }
            | QuestionProgressionResult::Exhausted { total, .. } => assert_eq!(total, 3),
        }

        let projection = store
            .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("authenticated_study_projection is implemented");
        assert_eq!(projection.study_set.id, LEARNING_SET_ID);
        assert_eq!(projection.study_set.title, "Cellular respiration");
        assert_eq!(projection.study_set.course.as_deref(), Some("BIO 201"));
        assert_eq!(
            projection.study_set.ingestion_status,
            agent_domain::StudySetIngestionStatus::Ready
        );
        assert_eq!(projection.session.id, session_id);
        assert_eq!(projection.session.mode, StudyMode::Quiz);
        assert_eq!(projection.concepts.len(), 5);
        assert_eq!(projection.question_progress.total, 3);
        assert_eq!(projection.review_schedule.len(), 3);
        for item in &projection.review_schedule {
            assert_eq!(
                item.authority,
                agent_domain::learning_recap::ReviewScheduleAuthority::ServerPersistedFsrs
            );
            assert!(projection
                .concepts
                .iter()
                .any(|concept| concept.id == item.concept_id));
        }
        for concept in &projection.concepts {
            let scheduled = projection
                .review_schedule
                .iter()
                .find(|item| item.concept_id == concept.id)
                .map(|item| item.due_at.clone());
            assert_eq!(concept.due_at, scheduled);
        }
    }

    #[tokio::test]
    async fn memory_learning_ports_override_fail_closed_defaults() {
        let seed = learning_core_seed();
        let store = seed_learning_core_memory(&seed);
        assert_learning_ports_are_implemented(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_learning_ports_override_fail_closed_defaults() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        assert_learning_ports_are_implemented(&store).await;
        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_backend_session_learning_evidence_matches_fixture_bytes() {
        let fixture = evidence_fixture();
        let seed = learning_core_seed();

        // Each fixture case runs on its own schema and its own in-memory store: a
        // persisted FSRS card is per concept and outlives a session, so sharing one
        // study set between cases would let one case's grading move another's due
        // dates. `reconnect_rebuild` is `mixed_strong_shaky_missed` read a second
        // time on the same session and is covered by re-reading it below.
        for case in [
            "all_missed",
            "mixed_strong_shaky_missed",
            "deferred_only",
            "evaluated_then_idempotent_replay",
            "superseded_challenged_outcome",
            "no_outcomes",
            "same_label_distinct_concepts",
            "source_moment_outside_outcome",
        ] {
            let fixture_schema = PostgresSchemaFixture::migrated().await;
            let pool = fixture_schema.pool().clone();
            seed_learning_core_postgres(&pool, &seed).await;
            let durable = PostgresStudyStore::new(pool.clone());
            let volatile = seed_learning_core_memory(&seed);
            let seeded = fixture.evidence[case].clone();
            let session_id = seeded.voice_session_id.clone();
            for store in [&durable as &dyn StudyMemoryStore, &volatile] {
                open_learning_session(store, &session_id).await;
                for outcome in &seeded.outcomes {
                    if outcome.supersedes_response_id.is_some() {
                        let challenged = outcome
                            .supersedes_response_id
                            .clone()
                            .expect("supersession names a challenged response");
                        store
                            .record_challenge_resolution(
                                LEARNING_USER_ID,
                                LEARNING_SET_ID,
                                &session_id,
                                ChallengeResolution {
                                    schema: agent_domain::learning_outcome::VIVA_CHALLENGE_RESOLUTION_SCHEMA
                                        .to_owned(),
                                    correction_id: format!("corr-{case}"),
                                    challenged_response_id: challenged,
                                    source_id: "src-lec5-slide-19".to_owned(),
                                    disposition: agent_domain::ChallengeDisposition::ReevaluationRequired,
                                    replacement_response_id: Some(outcome.response_id.clone()),
                                },
                            )
                            .await
                            .expect("reevaluation resolution persists");
                    }
                    store
                        .record_turn_outcome(
                            LEARNING_USER_ID,
                            LEARNING_SET_ID,
                            &session_id,
                            outcome.clone(),
                        )
                        .await
                        .unwrap_or_else(|error| panic!("{case} outcome persists: {error:?}"));
                }
            }

            let durable_evidence = durable
                .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, &session_id)
                .await
                .unwrap_or_else(|error| panic!("{case} durable evidence: {error:?}"));
            let volatile_evidence = volatile
                .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, &session_id)
                .await
                .unwrap_or_else(|error| panic!("{case} volatile evidence: {error:?}"));

            // Byte equality across backends, not just typed equality.
            assert_eq!(
                serde_json::to_string(&durable_evidence).expect("evidence serializes"),
                serde_json::to_string(&volatile_evidence).expect("evidence serializes"),
                "{case}"
            );

            // The stored outcomes come back as the fixture's canonical bytes.
            let mut expected_outcomes = seeded.outcomes.clone();
            expected_outcomes.dedup_by(|left, right| left.response_id == right.response_id);
            assert_eq!(
                serde_json::to_string(&durable_evidence.outcomes).expect("outcomes serialize"),
                serde_json::to_string(&expected_outcomes).expect("outcomes serialize"),
                "{case}"
            );

            // The schedule is server-computed, so the fixture's authored due dates
            // are the one thing a store cannot reproduce. Every other byte of the
            // fixture recap must match, including which concepts are scheduled at
            // all and in what order.
            assert_eq!(
                durable_evidence.review_decisions,
                expected_review_decisions(&expected_outcomes),
                "{case}"
            );
            let mut expected_recap = fixture.recaps[case].clone();
            expected_recap.voice_session_id.clone_from(&session_id);
            let mut fixture_scheduled = expected_recap
                .review_schedule
                .iter()
                .map(|item| item.concept_id.clone())
                .collect::<Vec<_>>();
            fixture_scheduled.sort();
            let mut stored_scheduled = durable_evidence
                .review_decisions
                .iter()
                .map(|item| item.concept_id.clone())
                .collect::<Vec<_>>();
            stored_scheduled.sort();
            assert_eq!(stored_scheduled, fixture_scheduled, "{case}");
            for item in &mut expected_recap.review_schedule {
                item.due_at = durable_evidence
                    .review_decisions
                    .iter()
                    .find(|decision| decision.concept_id == item.concept_id)
                    .unwrap_or_else(|| panic!("{case} schedules {}", item.concept_id))
                    .due_at
                    .clone();
            }
            let rebuilt = agent_domain::build_session_recap(&durable_evidence)
                .unwrap_or_else(|error| panic!("{case} recap folds: {error:?}"));
            assert_eq!(rebuilt, expected_recap, "{case}");

            // A reconnect rebuilds the identical evidence from the same rows.
            let reread = PostgresStudyStore::new(pool.clone())
                .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, &session_id)
                .await
                .unwrap_or_else(|error| panic!("{case} reconnect evidence: {error:?}"));
            assert_eq!(reread, durable_evidence, "{case}");

            fixture_schema
                .cleanup()
                .await
                .expect("isolated test schema drops cleanly");
        }
    }

    /// The stored cursor, as Plan 04's canonical type.
    ///
    /// `progression_json` carries the cursor's own fields at the top level — so
    /// that the row's `revision` column and `progression_json.revision` are the
    /// same field — plus the store-owned `applied_response_ids` replay set, which
    /// is not part of Plan 04's published cursor and is dropped here.
    async fn stored_progression_cursor(
        pool: &sqlx::PgPool,
        voice_session_id: &str,
    ) -> QuestionProgressionCursor {
        let mut json = sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT progression_json
             FROM question_progression_cursors
             WHERE voice_session_id = $1",
        )
        .bind(fixture_uuid(voice_session_id).expect("session UUID"))
        .fetch_one(pool)
        .await
        .expect("cursor query succeeds");
        json.as_object_mut()
            .expect("progression_json is an object")
            .remove("applied_response_ids");
        serde_json::from_value(json).expect("stored cursor is Plan 04's canonical cursor")
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_backend_progression_cursor_matches_selected_d02_contract() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let durable = PostgresStudyStore::new(pool.clone());
        let volatile = seed_learning_core_memory(&seed);
        let fixture = progression_fixture();
        assert_eq!(fixture.policy, ProgressionPolicyId::OrderedV1);

        let mut per_backend = Vec::new();
        for store in [&durable as &dyn StudyMemoryStore, &volatile] {
            open_learning_session(store, &fixture.voice_session_id).await;
            per_backend.push(drive_ordered_progression(store, &fixture.voice_session_id).await);
        }
        assert_eq!(per_backend[0], per_backend[1]);
        for (case, observed) in &per_backend[0] {
            assert_eq!(observed, &fixture.results[*case], "{case}");
        }

        // The durable cursor itself, not just the results it produced.
        assert_eq!(
            stored_progression_cursor(&pool, &fixture.voice_session_id).await,
            fixture.cursors["after_exhaustion"]
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_backend_review_authority_matches_selected_d01_contract() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = learning_core_seed();
        seed_learning_core_postgres(&pool, &seed).await;
        let durable = PostgresStudyStore::new(pool.clone());
        let volatile = seed_learning_core_memory(&seed);
        let fixture = evidence_fixture();
        let seeded = fixture.evidence["mixed_strong_shaky_missed"].clone();
        let session_id = seeded.voice_session_id.clone();

        for store in [&durable as &dyn StudyMemoryStore, &volatile] {
            open_learning_session(store, &session_id).await;
            for outcome in &seeded.outcomes {
                store
                    .record_turn_outcome(
                        LEARNING_USER_ID,
                        LEARNING_SET_ID,
                        &session_id,
                        outcome.clone(),
                    )
                    .await
                    .expect("outcome persists");
            }
        }

        let durable_evidence = durable
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, &session_id)
            .await
            .expect("durable evidence");
        let volatile_evidence = volatile
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, &session_id)
            .await
            .expect("volatile evidence");
        assert_eq!(
            durable_evidence.review_decisions,
            volatile_evidence.review_decisions
        );
        // D-01 selected `SERVER_PERSISTED_FSRS`; no store may report the rejected
        // read-time authority.
        for decision in &durable_evidence.review_decisions {
            assert_eq!(
                decision.authority,
                agent_domain::learning_recap::ReviewScheduleAuthority::ServerPersistedFsrs
            );
        }
        // Against the published decision function, not against the store's own
        // output: a store that scheduled from its own clock would not match.
        assert_eq!(
            durable_evidence.review_decisions,
            expected_review_decisions(&seeded.outcomes)
        );
        // Exactly the concepts the fixture's evidence schedules, in the store's
        // published order.
        let mut fixture_concepts = seeded
            .review_decisions
            .iter()
            .map(|decision| decision.concept_id.clone())
            .collect::<Vec<_>>();
        fixture_concepts.sort();
        let mut stored_concepts = durable_evidence
            .review_decisions
            .iter()
            .map(|decision| decision.concept_id.clone())
            .collect::<Vec<_>>();
        stored_concepts.sort();
        assert_eq!(stored_concepts, fixture_concepts);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    // ------------------------------------------------------------------
    // Task 8 (`DATA-011`)
    //
    // The two backends have to return Plan 04's typed projection with the same
    // fields and the same ordering, and the library's completed-session list has
    // to be in true recency order on both. Every assertion below compares the two
    // backends against each other over the same driven writes, so a value only one
    // of them can produce fails.
    // ------------------------------------------------------------------

    /// The authoritative exam instant both backends project as `exam_label`.
    const PROJECTION_EXAM_AT: &str = "2031-04-09T18:30:00.000Z";

    /// The two non-lexical session ids the ordering tests use. Sorting them as
    /// text and ordering them by recency give opposite answers, which is what
    /// makes the difference observable.
    const RECENCY_FIRST_SESSION: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const RECENCY_SECOND_SESSION: &str = "11111111-1111-4111-8111-111111111110";

    async fn set_started_at(pool: &sqlx::PgPool, voice_session_id: &str, started_at: &str) {
        sqlx::query("UPDATE voice_sessions SET started_at = $2 WHERE id = $1")
            .bind(fixture_uuid(voice_session_id).expect("session UUID"))
            .bind(agent_domain::parse_utc_instant(started_at).expect("instant parses"))
            .execute(pool)
            .await
            .expect("started_at is pinned for a deterministic ordering proof");
    }

    async fn open_biology_session(store: &dyn StudyMemoryStore, voice_session_id: &str) {
        assert_eq!(
            store
                .record_voice_session(&SessionConfig {
                    session_id: Some(SessionId::new(voice_session_id)),
                    user_id: Some("user-1".to_owned()),
                    study_set_id: Some("biology-midterm".to_owned()),
                    mode: Some(StudyMode::Quiz),
                    ..SessionConfig::default()
                })
                .await
                .expect("session opens"),
            StudyStoreWriteOutcome::Inserted
        );
    }

    fn completed_session_ids(snapshot: &agent_domain::StudyLibrarySnapshot) -> Vec<String> {
        snapshot
            .sessions
            .iter()
            .map(|session| session.voice_session_id.clone())
            .collect()
    }

    /// Plan 04's `AuthenticatedStudyProjectionV1`, built by each backend from its
    /// own rows, must be the same typed value and the same bytes.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_backend_authenticated_study_projection_is_identical() {
        let seed = learning_core_seed();
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        seed_learning_core_postgres(&pool, &seed).await;
        let durable = PostgresStudyStore::new(pool.clone());
        let volatile = seed_learning_core_memory(&seed);

        // The exam instant is authoritative store context on both backends.
        sqlx::query("UPDATE study_sets SET exam_at = $2 WHERE id = $1")
            .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
            .bind(agent_domain::parse_utc_instant(PROJECTION_EXAM_AT).expect("instant parses"))
            .execute(&pool)
            .await
            .expect("exam instant seeds");
        volatile.set_study_set_exam_date(LEARNING_SET_ID, Some(PROJECTION_EXAM_AT.to_owned()));

        let session_id = "vs-0001";
        for store in [&durable as &dyn StudyMemoryStore, &volatile] {
            open_learning_session(store, session_id).await;
            let selected = store
                .select_next_question(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    session_id,
                    "resp-projection-1",
                    ProgressionPolicyId::OrderedV1,
                )
                .await
                .expect("first selection succeeds");
            let QuestionProgressionResult::Selected { question, .. } = &selected else {
                panic!("the first ordered selection returns a question: {selected:?}");
            };
            assert_eq!(question.question_id, "q-etc-electron-flow");
            let mut outcome = outcome_named("evaluated_strong");
            outcome.response_id = "resp-projection-1".to_owned();
            outcome.question_id = question.question_id.clone();
            store
                .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, session_id, outcome)
                .await
                .expect("graded outcome persists");
            // The graded turn advanced, so select again: the projection's active
            // question is the cursor's current question, and a projection with
            // none would compare equal for the wrong reason.
            let advanced = store
                .select_next_question(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    session_id,
                    "resp-projection-2",
                    ProgressionPolicyId::OrderedV1,
                )
                .await
                .expect("second selection succeeds");
            let QuestionProgressionResult::Selected { question, .. } = &advanced else {
                panic!("the second ordered selection returns a question: {advanced:?}");
            };
            assert_eq!(question.question_id, "q-gradient-direction");
        }

        let durable_projection = durable
            .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("durable projection");
        let volatile_projection = volatile
            .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("volatile projection");

        // Not vacuously equal: every part of the projection carries a value.
        assert_eq!(durable_projection.study_set.id, LEARNING_SET_ID);
        assert_eq!(
            durable_projection.study_set.exam_label.as_deref(),
            Some(PROJECTION_EXAM_AT)
        );
        assert_eq!(durable_projection.concepts.len(), seed.concepts.len());
        assert_eq!(durable_projection.question_progress.total, 3);
        assert!(durable_projection.active_question.is_some());
        assert!(!durable_projection.review_schedule.is_empty());

        assert_eq!(durable_projection, volatile_projection);
        assert_eq!(
            serde_json::to_string(&durable_projection).expect("projection serializes"),
            serde_json::to_string(&volatile_projection).expect("projection serializes"),
        );

        // A reconnect rebuilds the identical projection from the same rows.
        let reread = PostgresStudyStore::new(pool.clone())
            .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("reconnect projection");
        assert_eq!(reread, durable_projection);

        // A tombstoned source is omitted by both backends, so the question bound
        // to it stops being active on both.
        sqlx::query("UPDATE study_documents SET deleted_at = NOW() WHERE id = $1")
            .bind(fixture_uuid("lec5").expect("document UUID"))
            .execute(&pool)
            .await
            .expect("document tombstones");
        volatile.upsert_document(crate::StudyDocumentRecord {
            study_set_id: LEARNING_SET_ID.to_owned(),
            document_id: "lec5".to_owned(),
            title: "Lecture 5".to_owned(),
            source_kind: "pdf".to_owned(),
            processing_status: agent_domain::StudySetIngestionStatus::Ready,
            tombstoned: true,
        });

        let durable_after = durable
            .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("durable projection after tombstone");
        let volatile_after = volatile
            .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
            .await
            .expect("volatile projection after tombstone");
        assert_eq!(
            durable_after.question_progress.total, 0,
            "a tombstoned source removes every question bound to it"
        );
        assert!(durable_after.active_question.is_none());
        assert_eq!(durable_after, volatile_after);
        assert_eq!(
            serde_json::to_string(&durable_after).expect("projection serializes"),
            serde_json::to_string(&volatile_after).expect("projection serializes"),
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The library's completed sessions are ordered by true recency on both
    /// backends: the *second* session inserted comes first, and an idempotent
    /// replay of the first one does not move it.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_backend_library_sessions_use_true_recency_order() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let durable = PostgresStudyStore::new(pool.clone());
        let volatile = crate::InMemoryStudyStore::seeded_fixture();

        for store in [&durable as &dyn StudyMemoryStore, &volatile] {
            open_biology_session(store, RECENCY_FIRST_SESSION).await;
            open_biology_session(store, RECENCY_SECOND_SESSION).await;
            // Between the inserts and the closes, replay the *first* session. A
            // remove-and-push replay would move it to the end of the in-memory
            // vector and make it the most recent one.
            assert_eq!(
                store
                    .record_voice_session(&SessionConfig {
                        session_id: Some(SessionId::new(RECENCY_FIRST_SESSION)),
                        user_id: Some("user-1".to_owned()),
                        study_set_id: Some("biology-midterm".to_owned()),
                        mode: Some(StudyMode::Quiz),
                        ..SessionConfig::default()
                    })
                    .await
                    .expect("replaying an open session succeeds"),
                StudyStoreWriteOutcome::IdempotentReplay
            );
            for session_id in [RECENCY_FIRST_SESSION, RECENCY_SECOND_SESSION] {
                store
                    .close_voice_session(session_id, "completed")
                    .await
                    .expect("session closes as completed");
            }
        }
        // The durable ordering key is `started_at`; pin it so the proof is exact.
        set_started_at(&pool, RECENCY_FIRST_SESSION, "2031-04-05T12:00:00.000Z").await;
        set_started_at(&pool, RECENCY_SECOND_SESSION, "2031-04-05T12:00:05.000Z").await;

        let durable_library = durable
            .library_snapshot("user-1")
            .await
            .expect("durable library snapshot");
        let volatile_library = volatile
            .library_snapshot("user-1")
            .await
            .expect("volatile library snapshot");

        assert_eq!(
            completed_session_ids(&durable_library),
            vec![
                RECENCY_SECOND_SESSION.to_owned(),
                RECENCY_FIRST_SESSION.to_owned()
            ],
            "the later session is first"
        );
        assert_eq!(
            completed_session_ids(&volatile_library),
            completed_session_ids(&durable_library),
            "both backends order completed sessions by true recency"
        );
        assert_eq!(durable_library.sessions, volatile_library.sessions);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// When recency ties, the documented tie-break is the session id, descending.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_memory_backend_tie_breaks_library_order_by_session_id() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let durable = PostgresStudyStore::new(pool.clone());
        let volatile = crate::InMemoryStudyStore::seeded_fixture();

        for store in [&durable as &dyn StudyMemoryStore, &volatile] {
            // In memory the equivalent of a durable `started_at` tie is the stable
            // insertion order the projection contract documents: insert the lower
            // id first so reverse-insertion and descending id agree.
            open_biology_session(store, RECENCY_SECOND_SESSION).await;
            open_biology_session(store, RECENCY_FIRST_SESSION).await;
            for session_id in [RECENCY_FIRST_SESSION, RECENCY_SECOND_SESSION] {
                store
                    .close_voice_session(session_id, "completed")
                    .await
                    .expect("session closes as completed");
            }
        }
        // Exactly equal durable start instants, so only the tie-break can order them.
        for session_id in [RECENCY_FIRST_SESSION, RECENCY_SECOND_SESSION] {
            set_started_at(&pool, session_id, "2031-04-05T12:00:00.000Z").await;
        }

        let durable_library = durable
            .library_snapshot("user-1")
            .await
            .expect("durable library snapshot");
        let volatile_library = volatile
            .library_snapshot("user-1")
            .await
            .expect("volatile library snapshot");

        assert_eq!(
            completed_session_ids(&durable_library),
            vec![
                RECENCY_FIRST_SESSION.to_owned(),
                RECENCY_SECOND_SESSION.to_owned()
            ],
            "an exact tie orders by session id, descending"
        );
        assert_eq!(
            completed_session_ids(&volatile_library),
            completed_session_ids(&durable_library),
        );
        assert_eq!(durable_library.sessions, volatile_library.sessions);

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    async fn run_migrations_until(
        pool: &sqlx::PgPool,
        stop_before_name: &str,
    ) -> Result<(), sqlx::Error> {
        for (name, _) in MIGRATIONS {
            if *name == stop_before_name {
                break;
            }
            apply_migration_sql(pool, name).await?;
        }
        Ok(())
    }

    async fn apply_migration_sql(pool: &sqlx::PgPool, name: &str) -> Result<(), sqlx::Error> {
        let sql = MIGRATIONS
            .iter()
            .find_map(|(migration_name, sql)| (*migration_name == name).then_some(*sql))
            .unwrap_or_else(|| panic!("missing migration {name}"));
        sqlx::raw_sql(sql).execute(pool).await?;
        Ok(())
    }

    async fn record_fixture_session(store: &dyn StudyMemoryStore) {
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records fixture session");
    }

    async fn record_count_table_session(store: &dyn StudyMemoryStore, session_id: &str) {
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records count-table fixture session");
    }

    fn fixture_recap() -> StudySessionRecap {
        StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Strong concepts: 1 of 2.".to_owned(),
            summary: "Graded concepts: 2. Evaluated turns: 1. Deferred turns: 0.".to_owned(),
            concepts: vec![
                RecapConceptOutcome {
                    concept_id: "oxidative-phosphorylation".to_owned(),
                    label: "NADH".to_owned(),
                    status: ConceptStatus::Strong,
                },
                RecapConceptOutcome {
                    concept_id: "atp-synthase".to_owned(),
                    label: "ATP synthase".to_owned(),
                    status: ConceptStatus::Shaky,
                },
            ],
            review_schedule: vec![ReviewScheduleSummary {
                concept_id: "atp-synthase".to_owned(),
                due_at: "2031-04-07T12:00:00.000Z".to_owned(),
                authority: ReviewScheduleAuthority::ServerPersistedFsrs,
            }],
            next_action: "Review the scheduled concepts on their due dates.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-count-table-answer".to_owned(),
                source_id: fixture_source_reference().source_id,
            }],
            deferred_turns: 0,
        }
    }

    /// One counted provider turn, written through the store ports `data` owns.
    ///
    /// Plan 04's `LEARN-009` removed the `mark_concept_status` and
    /// `schedule_review_item` tools and rebuilt the remaining live tools on the
    /// progression/outcome/evidence ports Plan 09 Task 6 implements, so the count
    /// truth table is driven directly against the store. The scenario's write set is
    /// unchanged: one answer attempt, one concept status, one review item, one recap.
    async fn record_one_counted_turn(store: &crate::PostgresStudyStore, session_id: &str) {
        let question = store
            .active_question("user-1", "biology-midterm")
            .await
            .expect("active question read")
            .expect("seeded active question");
        assert_eq!(question.source.source_id, "src-lecture-5-slide-18");
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                session_id,
                "response-count-table-answer",
                agent_domain::AnswerEvaluation {
                    question_id: question.question_id.clone(),
                    answer_text: "NADH donates electrons.".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Grounded in the seeded source.".to_owned(),
                    retry_prompt: question.follow_up.clone(),
                    source: question.source.clone(),
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.84,
                },
            )
            .await
            .expect("records answer");
        store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .expect("source read")
            .expect("retrieves source");
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                session_id,
                "response-count-table-answer",
                "oxidative-phosphorylation",
                ConceptStatus::Strong,
            )
            .await
            .expect("records concept status");
        store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                session_id,
                "atp-synthase",
                "2031-04-07T12:00:00.000Z",
            )
            .await
            .expect("schedules review");
        let mut recap = fixture_recap();
        recap.voice_session_id = session_id.to_owned();
        store
            .record_recap(
                "user-1",
                "biology-midterm",
                session_id,
                "response-count-table-recap",
                recap,
            )
            .await
            .expect("records recap");
    }

    async fn set_question_active(pool: &sqlx::PgPool, active: bool) {
        sqlx::query(
            "UPDATE study_questions
             SET active = $1
             WHERE study_set_id = $2 AND question_id = 'q-oxidative-phosphorylation-nadh'",
        )
        .bind(active)
        .bind(fixture_uuid("biology-midterm").expect("study set fixture UUID"))
        .execute(pool)
        .await
        .expect("updates seeded question active flag");
    }

    async fn set_document_deleted(pool: &sqlx::PgPool, deleted: bool) {
        sqlx::query(
            "UPDATE study_documents
             SET deleted_at = CASE WHEN $1 THEN NOW() ELSE NULL END
             WHERE id = $2",
        )
        .bind(deleted)
        .bind(fixture_uuid("lec-5").expect("document fixture UUID"))
        .execute(pool)
        .await
        .expect("updates seeded document tombstone");
    }

    async fn set_source_deleted(pool: &sqlx::PgPool, deleted: bool) {
        sqlx::query(
            "UPDATE source_spans
             SET deleted_at = CASE WHEN $1 THEN NOW() ELSE NULL END
             WHERE id = $2",
        )
        .bind(deleted)
        .bind(fixture_uuid("src-lecture-5-slide-18").expect("source fixture UUID"))
        .execute(pool)
        .await
        .expect("updates seeded source tombstone");
    }

    async fn insert_secondary_study_set(pool: &sqlx::PgPool) {
        sqlx::query(
            "INSERT INTO study_sets (id, user_id, title, course)
             VALUES (
                 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                 'user-2',
                 'Secondary Study Set',
                 'Biology 201'
             )
             ON CONFLICT (id) DO UPDATE
             SET user_id = EXCLUDED.user_id,
                 title = EXCLUDED.title,
                 course = EXCLUDED.course",
        )
        .execute(pool)
        .await
        .expect("inserts secondary study set");
    }

    #[derive(Debug, Eq, PartialEq)]
    struct DbRowCounts {
        voice_sessions: i64,
        answer_attempts: i64,
        review_items: i64,
        session_recaps: i64,
        voice_usage_events: i64,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
    struct ExactCountDelta {
        sessions: usize,
        answer_attempts: usize,
        concept_statuses: usize,
        review_items: usize,
        recaps: usize,
        usage_events: usize,
    }

    #[derive(Debug, Deserialize)]
    struct CountTruthTable {
        schema: String,
        scenarios: Vec<CountTruthScenario>,
    }

    #[derive(Debug, Deserialize)]
    struct CountTruthScenario {
        scenario: String,
        expected_delta: ExactCountDelta,
    }

    /// PENDING PLAN 05 FIXTURE AMENDMENT — the unversioned root path is still the
    /// only place this table exists.
    ///
    /// Plan 09 Task 1 Step 5 requires this import to move to a v5 path, but
    /// `agent/fixtures/voice-protocol/v5/manifest.json` carries no row for the store
    /// count truth table and `agent/fixtures/voice-protocol/**` is Plan 05's, not
    /// this lane's. The assertions are still needed — `DATA-002`/`DATA-003` prove
    /// exact write-count deltas against this table — so the reference is kept and the
    /// amendment request (add `VOICE-STORE-COUNT-TRUTH-TABLE` at
    /// `agent/fixtures/voice-protocol/v5/count-truth-table.json`) is escalated to the
    /// coordinator rather than satisfied by deleting coverage or by this lane writing
    /// another plan's fixture. Plan 05 must not delete the eleven legacy root fixtures
    /// until that row exists and this import points at it.
    fn count_truth_table() -> CountTruthTable {
        serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/count-truth-table.json"
        ))
        .expect("count truth table fixture is valid JSON")
    }

    fn expected_count_delta(scenario: &str) -> ExactCountDelta {
        count_truth_table()
            .scenarios
            .into_iter()
            .find(|row| row.scenario == scenario)
            .unwrap_or_else(|| panic!("missing count truth table scenario {scenario}"))
            .expected_delta
    }

    /// Every field, including usage, now comes from the store's own published
    /// counters: Plan 06's `StudyStoreWriteCounts.voice_usage` made the usage
    /// delta sayable, so the truth table no longer takes it from the test.
    fn count_delta_from_writes(
        after: StudyStoreWriteCounts,
        before: StudyStoreWriteCounts,
    ) -> ExactCountDelta {
        ExactCountDelta {
            sessions: after.sessions - before.sessions,
            answer_attempts: after.answer_attempts - before.answer_attempts,
            concept_statuses: after.concept_statuses - before.concept_statuses,
            review_items: after.review_items - before.review_items,
            recaps: after.recaps - before.recaps,
            usage_events: after.voice_usage - before.voice_usage,
        }
    }

    fn count_delta_from_rows(
        after: DbRowCounts,
        before: DbRowCounts,
        expected: ExactCountDelta,
    ) -> ExactCountDelta {
        ExactCountDelta {
            sessions: row_delta(after.voice_sessions, before.voice_sessions),
            answer_attempts: row_delta(after.answer_attempts, before.answer_attempts),
            concept_statuses: expected.concept_statuses,
            review_items: row_delta(after.review_items, before.review_items),
            recaps: row_delta(after.session_recaps, before.session_recaps),
            usage_events: row_delta(after.voice_usage_events, before.voice_usage_events),
        }
    }

    fn row_delta(after: i64, before: i64) -> usize {
        usize::try_from(after - before).expect("row count delta is non-negative")
    }

    async fn db_row_counts(pool: &sqlx::PgPool) -> DbRowCounts {
        DbRowCounts {
            voice_sessions: count_rows(pool, "voice_sessions").await,
            answer_attempts: count_rows(pool, "answer_attempts").await,
            review_items: count_rows(pool, "review_items").await,
            session_recaps: count_rows(pool, "session_recaps").await,
            voice_usage_events: count_rows(pool, "voice_usage_events").await,
        }
    }

    async fn session_token_nonce_rows(pool: &sqlx::PgPool, claim: &SessionTokenNonceClaim) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM voice_session_token_nonces
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND nonce = $4",
        )
        .bind(&claim.user_id)
        .bind(fixture_uuid(&claim.study_set_id).expect("study set fixture UUID"))
        .bind(fixture_uuid(&claim.voice_session_id).expect("voice session fixture UUID"))
        .bind(&claim.nonce)
        .fetch_one(pool)
        .await
        .expect("session token nonce row count query succeeds")
    }

    async fn concept_status_event_rows_for_session(
        pool: &sqlx::PgPool,
        voice_session_id: &str,
    ) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM concept_status_events
             WHERE voice_session_id = $1",
        )
        .bind(fixture_uuid(voice_session_id).expect("voice session fixture UUID"))
        .fetch_one(pool)
        .await
        .expect("concept status event row count query succeeds")
    }

    async fn session_recap_rows_for_session(pool: &sqlx::PgPool, voice_session_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM session_recaps
             WHERE voice_session_id = $1",
        )
        .bind(parse_uuid(voice_session_id).expect("session id is a UUID"))
        .fetch_one(pool)
        .await
        .expect("session recap row count query succeeds")
    }

    async fn count_rows(pool: &sqlx::PgPool, table: &str) -> i64 {
        let sql = match table {
            "voice_sessions" => "SELECT COUNT(*) FROM voice_sessions",
            "answer_attempts" => "SELECT COUNT(*) FROM answer_attempts",
            "review_items" => "SELECT COUNT(*) FROM review_items",
            "session_recaps" => "SELECT COUNT(*) FROM session_recaps",
            "voice_usage_events" => "SELECT COUNT(*) FROM voice_usage_events",
            _ => panic!("unexpected table {table}"),
        };
        sqlx::query_scalar::<_, i64>(sql)
            .fetch_one(pool)
            .await
            .expect("row count query succeeds")
    }

    async fn voice_session_rows(pool: &sqlx::PgPool, voice_session_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM voice_sessions
             WHERE id = $1",
        )
        .bind(parse_uuid(voice_session_id).expect("session id is a UUID"))
        .fetch_one(pool)
        .await
        .expect("voice session row count query succeeds")
    }

    async fn usage_rows_for_session(pool: &sqlx::PgPool, voice_session_id: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM voice_usage_events
             WHERE voice_session_id = $1",
        )
        .bind(parse_uuid(voice_session_id).expect("session id is a UUID"))
        .fetch_one(pool)
        .await
        .expect("usage row count query succeeds")
    }

    async fn session_status(pool: &sqlx::PgPool, voice_session_id: &str) -> String {
        sqlx::query_scalar::<_, String>(
            "SELECT status
             FROM voice_sessions
             WHERE id = $1",
        )
        .bind(parse_uuid(voice_session_id).expect("session id is a UUID"))
        .fetch_one(pool)
        .await
        .expect("session status query succeeds")
    }

    // ------------------------------------------------------------------
    // Task 9 (`DATA-004`, `COR-03`, `SEC-03`)
    //
    // The coordinator recorded `D-05 = HARD_PURGE_TEXT` and `D-04 = CONFIRM_DELETE`
    // (registry rows 76-77). Deleting a study set therefore has to *remove* every
    // learner-authored and learner-derived text row and leave only content-free
    // idempotency tombstones — on both backends, across a store reconstruction, and
    // without a fixture seed being able to put any of it back.
    //
    // The proof is a canary: one string that exists nowhere in the product, written
    // into every learner-text field the schema has. After deletion no row anywhere
    // may still contain it.
    // ------------------------------------------------------------------

    /// A string that appears in no product code path, so any occurrence after a
    /// deletion is learner material that survived it.
    const DELETE_CANARY: &str = "VIVA_LEARNER_DELETE_CANARY_8F6A";

    /// The constant title a `HARD_PURGE_TEXT` tombstone is scrubbed to.
    const DELETED_TITLE: &str = "[deleted]";

    /// The policy name the deletion response reports under the recorded D-05
    /// selection.
    const HARD_PURGE_TEXT_POLICY: &str = "hard_purge_text";

    /// Every base table that can hold a scoped learner row.
    ///
    /// `review_items` is also the selected upstream D-01 v1 seam: migration `0015`
    /// (`SERVER_PERSISTED_FSRS`) stores the schedule decision in `review_items`
    /// columns rather than a separate table, which
    /// `postgres_delete_canary_scan_covers_every_learner_text_table` asserts
    /// directly so this list cannot silently miss a schedule table.
    const CANARY_SCOPED_TABLES: &[&str] = &[
        "answer_attempts",
        "concept_status_events",
        "concepts",
        "event_authorization_digests",
        "learning_challenge_resolutions",
        "learning_turn_outcomes",
        "question_progression_cursors",
        "review_items",
        "session_recaps",
        "source_spans",
        "study_documents",
        "study_question_ingestion_cursors",
        "study_questions",
        "study_sets",
        "voice_session_token_nonces",
        "voice_sessions",
        "voice_usage_events",
    ];

    fn canary_text(existing: &str) -> String {
        format!("{DELETE_CANARY} {existing}")
    }

    /// The canonical learning-core seed with the canary written into every
    /// learner-authored and learner-derived text field it owns.
    ///
    /// Identifiers are deliberately untouched: ids are the content-free metadata
    /// the tombstone is allowed to keep, and moving them would make the fixture
    /// unusable by the very store methods the canary has to travel through.
    fn canary_learning_core_seed() -> LearningCoreSeed {
        let mut seed = learning_core_seed();
        for (_, title) in seed.documents.iter_mut() {
            *title = canary_text(title);
        }
        for source in seed.sources.iter_mut() {
            source.excerpt = canary_text(&source.excerpt);
            source.retrieval_reason = canary_text(&source.retrieval_reason);
        }
        for (_, label, _) in seed.concepts.iter_mut() {
            *label = canary_text(label);
        }
        for (question, _, _) in seed.questions.iter_mut() {
            question.prompt = canary_text(&question.prompt);
            question.follow_up = canary_text(&question.follow_up);
            question.expected_terms = question
                .expected_terms
                .iter()
                .map(|term| canary_text(term))
                .collect();
            for criterion in question.rubric.criteria.iter_mut() {
                criterion.claim = canary_text(&criterion.claim);
            }
            // The question's embedded source is the same tuple the span row holds,
            // and both backends compare them for equality, so the canary has to be
            // applied identically to both copies.
            question.source.excerpt = canary_text(&question.source.excerpt);
            question.source.retrieval_reason = canary_text(&question.source.retrieval_reason);
        }
        seed
    }

    /// The study-set row's own learner text, which neither seeder parameterizes.
    fn canary_study_set_record(seed: &LearningCoreSeed) -> crate::StudySetRecord {
        crate::StudySetRecord {
            study_set_id: LEARNING_SET_ID.to_owned(),
            user_id: LEARNING_USER_ID.to_owned(),
            title: canary_text("Cellular respiration"),
            course: Some(canary_text("BIO 201")),
            ingestion_status: agent_domain::StudySetIngestionStatus::Ready,
            ingestion_error: Some(canary_text("last ingestion note")),
            concept_ids: seed
                .concepts
                .iter()
                .map(|(concept_id, _, _)| concept_id.clone())
                .collect(),
            question_ids: seed
                .questions
                .iter()
                .map(|(question, _, _)| question.question_id.clone())
                .collect(),
        }
    }

    fn canary_memory_store(seed: &LearningCoreSeed) -> crate::InMemoryStudyStore {
        let store = seed_learning_core_memory(seed);
        store.upsert_study_set(canary_study_set_record(seed));
        store
    }

    async fn seed_canary_postgres(pool: &sqlx::PgPool, seed: &LearningCoreSeed) {
        seed_learning_core_postgres(pool, seed).await;
        let record = canary_study_set_record(seed);
        sqlx::query(
            "UPDATE study_sets
             SET title = $2, course = $3, ingestion_error = $4
             WHERE id = $1",
        )
        .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
        .bind(&record.title)
        .bind(record.course.as_deref())
        .bind(record.ingestion_error.as_deref())
        .execute(pool)
        .await
        .expect("canary study set text seeds");
    }

    /// A recap whose concept labels reach all four stored label arrays.
    ///
    /// The durable row stores labels bucketed by status (`recap_label_buckets`),
    /// and `review_later` is driven by `review_schedule`, so a recap of nothing but
    /// `Review` concepts would store no label at all and the canary would never
    /// enter `session_recaps`.
    fn canary_recap(voice_session_id: &str, seed: &LearningCoreSeed) -> StudySessionRecap {
        let bucketed = [
            ConceptStatus::Strong,
            ConceptStatus::Shaky,
            ConceptStatus::Missed,
            ConceptStatus::Review,
        ];
        let concepts = seed
            .concepts
            .iter()
            .enumerate()
            .map(|(index, (concept_id, label, _))| RecapConceptOutcome {
                concept_id: concept_id.clone(),
                label: label.clone(),
                status: bucketed[index % bucketed.len()].clone(),
            })
            .collect::<Vec<_>>();
        let review_schedule = concepts
            .iter()
            .filter(|concept| concept.status == ConceptStatus::Review)
            .map(|concept| ReviewScheduleSummary {
                concept_id: concept.concept_id.clone(),
                due_at: "2031-04-06T09:00:00.000Z".to_owned(),
                authority: ReviewScheduleAuthority::ServerPersistedFsrs,
            })
            .collect();
        StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            headline: canary_text("You are close on the electron transport chain"),
            summary: canary_text("Two concepts strong, one to revisit"),
            concepts,
            review_schedule,
            next_action: canary_text("Revisit the proton gradient"),
            source_moments: Vec::new(),
            deferred_turns: 0,
        }
    }

    fn canary_usage(voice_session_id: &str) -> VoiceUsageRecord {
        VoiceUsageRecord {
            voice_session_id: Some(voice_session_id.to_owned()),
            provider: "synthetic".to_owned(),
            model: "synthetic-viva".to_owned(),
            duration_seconds: 3,
            text_input_tokens: 30,
            text_output_tokens: 12,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
            cost_estimate_usd: 0.00003,
            first_audio_latency_ms: None,
            answer_eval_latency_ms: Some(2),
            source_retrieval_latency_ms: None,
            source_grounded_correction_count: 0,
        }
    }

    fn canary_nonce(voice_session_id: &str) -> SessionTokenNonceClaim {
        SessionTokenNonceClaim {
            user_id: LEARNING_USER_ID.to_owned(),
            study_set_id: LEARNING_SET_ID.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            nonce: format!("nonce-{DELETE_CANARY}"),
            expires_at: 1_800_000_000,
        }
    }

    /// Write one of every learner artifact the schema can hold, with the canary in
    /// every field the port lets a caller choose.
    ///
    /// The evaluation *label* is deliberately not canaried: it is a closed rubric
    /// vocabulary and a canary value is refused by `validate_fail_closed`, which is
    /// the behaviour we want. The canary reaches that table through the stored
    /// outcome's feedback instead.
    async fn drive_canary_session(
        store: &dyn StudyMemoryStore,
        voice_session_id: &str,
        seed: &LearningCoreSeed,
    ) {
        open_learning_session(store, voice_session_id).await;

        let selected = store
            .select_next_question(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                voice_session_id,
                "resp-canary-1",
                ProgressionPolicyId::OrderedV1,
            )
            .await
            .expect("canary selection succeeds");
        let QuestionProgressionResult::Selected { question, .. } = &selected else {
            panic!("the ordered policy selects a question: {selected:?}");
        };
        let question = question.clone();

        store
            .record_answer_evaluation(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                voice_session_id,
                "resp-canary-1",
                AnswerEvaluation {
                    question_id: question.question_id.clone(),
                    answer_text: canary_text("the learner's own words"),
                    label: "mostly correct".to_owned(),
                    concise_feedback: canary_text("close, name the complex"),
                    retry_prompt: canary_text("which complex pumps first?"),
                    source: question.source.clone(),
                    concept_status: ConceptStatus::Shaky,
                    confidence_score: 0.7,
                },
            )
            .await
            .expect("canary evaluation persists");

        let mut outcome = outcome_named("evaluated_strong");
        outcome.response_id = "resp-canary-1".to_owned();
        outcome.question_id = question.question_id.clone();
        if let TurnResolution::Evaluated {
            concise_feedback,
            retry_prompt,
            ..
        } = &mut outcome.resolution
        {
            *concise_feedback = canary_text("you named the gradient correctly");
            *retry_prompt = Some(canary_text("say it once more with the complex"));
        }
        store
            .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, voice_session_id, outcome)
            .await
            .expect("canary turn outcome persists");

        store
            .record_challenge_resolution(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                voice_session_id,
                ChallengeResolution {
                    schema: agent_domain::learning_outcome::VIVA_CHALLENGE_RESOLUTION_SCHEMA
                        .to_owned(),
                    correction_id: format!("corr-{DELETE_CANARY}"),
                    challenged_response_id: "resp-canary-1".to_owned(),
                    source_id: question.source.source_id.clone(),
                    disposition: agent_domain::ChallengeDisposition::SourceConfirmed,
                    replacement_response_id: None,
                },
            )
            .await
            .expect("canary challenge resolution persists");

        store
            .record_concept_status(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                voice_session_id,
                "resp-canary-status",
                &seed.concepts[0].0,
                ConceptStatus::Shaky,
            )
            .await
            .expect("canary concept status persists");

        store
            .record_recap(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                voice_session_id,
                "resp-canary-recap",
                canary_recap(voice_session_id, seed),
            )
            .await
            .expect("canary recap persists");

        assert_eq!(
            store
                .record_voice_usage(canary_usage(voice_session_id))
                .await
                .expect("canary usage persists"),
            StudyStoreWriteOutcome::Inserted
        );

        store
            .claim_session_token_nonce(canary_nonce(voice_session_id))
            .await
            .expect("canary nonce claims");
    }

    /// The number of rows in one table whose full serialized row still contains the
    /// canary. `to_jsonb(row)::text` covers every column, including arrays and
    /// JSONB, so a new learner column cannot escape the scan by being added later.
    async fn canary_rows_in_table(pool: &sqlx::PgPool, table: &str) -> i64 {
        assert!(
            CANARY_SCOPED_TABLES.contains(&table),
            "{table} is not one of this test's enumerated tables"
        );
        let sql = format!(
            "SELECT COUNT(*) FROM {table} AS scanned WHERE to_jsonb(scanned)::text LIKE $1"
        );
        sqlx::query_scalar::<_, i64>(&sql)
            .bind(format!("%{DELETE_CANARY}%"))
            .fetch_one(pool)
            .await
            .unwrap_or_else(|error| panic!("canary scan of {table} succeeds: {error:?}"))
    }

    /// Every enumerated table, with the tables that still hold the canary named.
    async fn tables_still_holding_the_canary(pool: &sqlx::PgPool) -> Vec<String> {
        let mut held = Vec::new();
        for table in CANARY_SCOPED_TABLES {
            if canary_rows_in_table(pool, table).await > 0 {
                held.push((*table).to_owned());
            }
        }
        held
    }

    async fn study_set_tombstone_row(pool: &sqlx::PgPool) -> sqlx::postgres::PgRow {
        sqlx::query(
            "SELECT title, course, exam_at, exam_date, ingestion_status, ingestion_error,
                    deleted_at IS NOT NULL AS tombstoned
             FROM study_sets
             WHERE id = $1",
        )
        .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
        .fetch_one(pool)
        .await
        .expect("the deleted study set keeps exactly one tombstone row")
    }

    async fn assert_hard_purge_tombstone(pool: &sqlx::PgPool) {
        use sqlx::Row as _;
        let row = study_set_tombstone_row(pool).await;
        assert!(
            row.try_get::<bool, _>("tombstoned")
                .expect("tombstone flag"),
            "the tombstone is `deleted_at`, not an ingestion status"
        );
        assert_eq!(
            row.try_get::<String, _>("title").expect("title"),
            DELETED_TITLE
        );
        assert_eq!(
            row.try_get::<Option<String>, _>("course").expect("course"),
            None
        );
        assert_eq!(
            row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("exam_at")
                .expect("exam_at"),
            None
        );
        assert_eq!(
            row.try_get::<Option<chrono::NaiveDate>, _>("exam_date")
                .expect("exam_date"),
            None
        );
        assert_eq!(
            row.try_get::<String, _>("ingestion_status")
                .expect("ingestion status"),
            "deleted"
        );
        assert_eq!(
            row.try_get::<Option<String>, _>("ingestion_error")
                .expect("ingestion error"),
            None
        );

        for (table, sql) in [
            (
                "study_questions",
                "SELECT COUNT(*) FROM study_questions WHERE study_set_id = $1",
            ),
            (
                "concepts",
                "SELECT COUNT(*) FROM concepts WHERE study_set_id = $1",
            ),
            (
                "study_documents",
                "SELECT COUNT(*) FROM study_documents WHERE study_set_id = $1",
            ),
            (
                "study_question_ingestion_cursors",
                "SELECT COUNT(*) FROM study_question_ingestion_cursors WHERE study_set_id = $1",
            ),
        ] {
            let remaining = sqlx::query_scalar::<_, i64>(sql)
                .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
                .fetch_one(pool)
                .await
                .unwrap_or_else(|error| panic!("{table} count succeeds: {error:?}"));
            assert_eq!(
                remaining, 0,
                "HARD_PURGE_TEXT deletes {table} outright rather than deactivating it"
            );
        }
    }

    /// The in-memory backend applies exactly the selected `HARD_PURGE_TEXT` policy.
    #[tokio::test]
    async fn memory_selected_d05_policy_removes_exact_canary_fields() {
        let seed = canary_learning_core_seed();
        let store = canary_memory_store(&seed);
        let session_id = "vs-0001";
        drive_canary_session(&store, session_id, &seed).await;

        // Not a vacuous proof: the canary really is in this backend's state first.
        let before = serde_json::to_string(&store.snapshot()).expect("state serializes");
        assert!(
            before.contains(DELETE_CANARY),
            "the canary must be present before deletion or the test proves nothing"
        );

        let receipt = store
            .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
            .await
            .expect("study set deletion succeeds");
        assert_eq!(receipt["status"], "deleted");
        assert_eq!(receipt["policy"], HARD_PURGE_TEXT_POLICY);
        assert_eq!(receipt["study_set_id"], LEARNING_SET_ID);

        let state = store.snapshot();
        let after = serde_json::to_string(&state).expect("state serializes");
        assert!(
            !after.contains(DELETE_CANARY),
            "learner text survived an in-memory HARD_PURGE_TEXT deletion"
        );

        // What remains is exactly the content-free tombstone.
        let tombstone = state
            .study_sets
            .get(LEARNING_SET_ID)
            .expect("the tombstone keeps repeated deletes idempotent");
        assert_eq!(tombstone.title, DELETED_TITLE);
        assert_eq!(tombstone.course, None);
        assert_eq!(tombstone.ingestion_error, None);
        assert!(tombstone.concept_ids.is_empty());
        assert!(tombstone.question_ids.is_empty());
        assert!(
            state.deleted_study_sets.contains_key(LEARNING_SET_ID),
            "`deleted_at` is the deletion authority in this backend too"
        );
        assert!(!state.study_set_exam_dates.contains_key(LEARNING_SET_ID));
        assert!(state
            .documents
            .values()
            .all(|record| record.study_set_id != LEARNING_SET_ID));
        assert!(state
            .source_spans
            .values()
            .all(|record| record.study_set_id != LEARNING_SET_ID));
        assert!(state
            .concepts
            .values()
            .all(|record| record.study_set_id != LEARNING_SET_ID));
        assert!(state
            .questions
            .values()
            .all(|record| record.study_set_id != LEARNING_SET_ID));
        assert!(state.answer_attempts.is_empty());
        assert!(state.concept_statuses.is_empty());
        assert!(state.review_items.is_empty());
        assert!(state.review_schedule_decisions.is_empty());
        assert!(state.recaps.is_empty());
        assert!(state.voice_usage_events.is_empty());
        assert!(state.turn_outcomes.is_empty());
        assert!(state.challenge_resolutions.is_empty());
        assert!(state.question_progressions.is_empty());
        assert!(state.event_authorizations.is_empty());
        assert!(state.session_token_nonces.is_empty());

        // The session tombstone keeps its identity and nothing else.
        let session = state
            .sessions
            .iter()
            .find(|session| session.voice_session_id == session_id)
            .expect("the deleted session keeps a content-free tombstone");
        assert_eq!(session.status, "deleted");
        assert_eq!(session.terminal_reason.as_deref(), Some("deleted"));

        // The tombstone is not an active study set on any read path.
        assert!(store
            .library_snapshot(LEARNING_USER_ID)
            .await
            .expect("library snapshot")
            .study_sets
            .iter()
            .all(|summary| summary.id != LEARNING_SET_ID));
        // This backend reports an unavailable set as a typed error rather than
        // `Ok(None)`; the durable backend reports `Ok(None)`. That `Option`-versus-
        // error split predates this task and belongs to Plan 06's port contract —
        // what matters here is that neither backend returns a question.
        assert_eq!(
            store
                .active_question(LEARNING_USER_ID, LEARNING_SET_ID)
                .await
                .expect_err("a tombstone has no active question")
                .kind(),
            PortErrorKind::Unavailable
        );
        assert_eq!(
            store
                .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
                .await
                .expect_err("a tombstone has no authenticated projection")
                .kind(),
            PortErrorKind::Unavailable
        );

        // Repeated deletion is idempotent and returns the same content-free receipt.
        let repeat = store
            .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
            .await
            .expect("repeated deletion is idempotent");
        assert_eq!(repeat, receipt);
        assert_eq!(
            serde_json::to_string(&store.snapshot()).expect("state serializes"),
            after,
            "a repeated delete mutates nothing"
        );
    }

    /// The durable backend applies exactly the same selected policy, row by row.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_selected_d05_policy_removes_exact_canary_fields() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = canary_learning_core_seed();
        seed_canary_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = "vs-0001";
        drive_canary_session(&store, session_id, &seed).await;

        // Not a vacuous proof, and exact: these are the tables a learner's own text
        // reaches, and the deletion has to empty every one of them. The tables
        // deliberately absent hold no free text at all — `answer_attempts` keeps a
        // closed-vocabulary evaluation label, digests keep hashes, and the cursor,
        // schedule, status-event, usage, and session rows keep identifiers.
        assert_eq!(
            tables_still_holding_the_canary(&pool).await,
            vec![
                "concepts".to_owned(),
                "learning_challenge_resolutions".to_owned(),
                "learning_turn_outcomes".to_owned(),
                "session_recaps".to_owned(),
                "source_spans".to_owned(),
                "study_documents".to_owned(),
                "study_questions".to_owned(),
                "study_sets".to_owned(),
                "voice_session_token_nonces".to_owned(),
            ],
            "the canary must reach every learner-text table before deletion"
        );

        let receipt = store
            .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
            .await
            .expect("study set deletion succeeds");
        assert_eq!(receipt["status"], "deleted");
        assert_eq!(receipt["policy"], HARD_PURGE_TEXT_POLICY);
        assert_eq!(receipt["study_set_id"], LEARNING_SET_ID);

        assert_eq!(
            tables_still_holding_the_canary(&pool).await,
            Vec::<String>::new(),
            "HARD_PURGE_TEXT leaves no row containing learner text"
        );
        assert_hard_purge_tombstone(&pool).await;
        assert_eq!(
            learning_session_tombstone(&pool, session_id).await,
            (
                "deleted".to_owned(),
                "deleted".to_owned(),
                Some("deleted".to_owned())
            )
        );

        // The tombstone is excluded from every active read path.
        assert!(store
            .library_snapshot(LEARNING_USER_ID)
            .await
            .expect("library snapshot")
            .study_sets
            .iter()
            .all(|summary| summary.id != LEARNING_SET_ID));
        assert_eq!(
            store
                .active_question(LEARNING_USER_ID, LEARNING_SET_ID)
                .await
                .expect("active question lookup"),
            None
        );
        assert_eq!(
            store
                .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, session_id)
                .await
                .expect_err("a tombstone has no authenticated projection")
                .kind(),
            PortErrorKind::Unavailable
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// Neither a store reconstruction nor a fixture seed may bring deleted material
    /// back (`COR-03`, `SEC-03`).
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        seed_postgres_fixture(&pool)
            .await
            .expect("a clean schema accepts exactly one seed");
        let store = PostgresStudyStore::new(pool.clone());
        store
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("the seeded fixture set is deleted");

        let deleted_set = fixture_uuid("biology-midterm").expect("fixture set UUID");
        let tombstone_title = |pool: sqlx::PgPool| async move {
            sqlx::query_scalar::<_, String>("SELECT title FROM study_sets WHERE id = $1")
                .bind(deleted_set)
                .fetch_one(&pool)
                .await
                .expect("the tombstone row survives")
        };
        assert_eq!(tombstone_title(pool.clone()).await, DELETED_TITLE);

        // Reconstructing the store rebuilds nothing: the tombstone is durable.
        let reconstructed = PostgresStudyStore::new(pool.clone());
        assert!(reconstructed
            .library_snapshot("user-1")
            .await
            .expect("library snapshot after reconstruction")
            .study_sets
            .iter()
            .all(|summary| summary.id != "biology-midterm"));
        assert_eq!(tombstone_title(pool.clone()).await, DELETED_TITLE);

        // Seeding refuses rather than reviving.
        let refusal = seed_postgres_fixture(&pool)
            .await
            .expect_err("seeding must refuse to write over an existing fixture or tombstone");
        assert!(
            matches!(&refusal, FixtureSeedError::ExistingFixture { entity, .. } if *entity == "study_sets"),
            "seed refusal is the typed existing-fixture refusal: {refusal:?}"
        );
        assert!(
            refusal.to_string().contains("already exists"),
            "seed refusal must name the existing fixture: {refusal}"
        );
        assert_eq!(tombstone_title(pool.clone()).await, DELETED_TITLE);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM study_questions WHERE study_set_id = $1"
            )
            .bind(deleted_set)
            .fetch_one(&pool)
            .await
            .expect("question count"),
            0,
            "seeding must not reactivate or recreate deleted questions"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM study_sets WHERE id = $1 AND deleted_at IS NULL"
            )
            .bind(deleted_set)
            .fetch_one(&pool)
            .await
            .expect("tombstone count"),
            0,
            "seeding must never clear `deleted_at`"
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// A repeated delete is a no-op that returns the same content-free receipt.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_repeated_delete_is_idempotent_and_content_free() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = canary_learning_core_seed();
        seed_canary_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        drive_canary_session(&store, "vs-0001", &seed).await;

        let first = store
            .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
            .await
            .expect("first deletion succeeds");
        let after_first = study_set_snapshot_json(&pool).await;

        let second = store
            .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
            .await
            .expect("repeated deletion is idempotent, not an error");
        assert_eq!(
            first, second,
            "a repeated delete returns the stored tombstone's own receipt"
        );
        assert_eq!(
            after_first,
            study_set_snapshot_json(&pool).await,
            "a repeated delete performs no ensure, seed, session update, or child mutation"
        );

        // The receipt itself is content-free: identifiers, a timestamp, and constants.
        let receipt = first.as_object().expect("the receipt is a JSON object");
        let mut keys = receipt.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "deleted_at".to_owned(),
                "policy".to_owned(),
                "status".to_owned(),
                "study_set_id".to_owned(),
            ]
        );
        assert_eq!(receipt["policy"], HARD_PURGE_TEXT_POLICY);
        assert!(!serde_json::to_string(&first)
            .expect("receipt serializes")
            .contains(DELETE_CANARY));

        // A tombstone the finalizer cannot recognize is a durability failure, never
        // a licence to rehydrate or re-scrub it.
        sqlx::query("UPDATE study_sets SET title = $2 WHERE id = $1")
            .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
            .bind(canary_text("resurrected title"))
            .execute(&pool)
            .await
            .expect("malformed tombstone is forced for the negative control");
        assert_eq!(
            store
                .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
                .await
                .expect_err("a malformed tombstone is not silently rescrubbed")
                .kind(),
            PortErrorKind::Durability
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// The deleted session's tombstone constants, by fixture logical id.
    async fn learning_session_tombstone(
        pool: &sqlx::PgPool,
        voice_session_id: &str,
    ) -> (String, String, Option<String>) {
        use sqlx::Row as _;
        let row =
            sqlx::query("SELECT mode, status, terminal_reason FROM voice_sessions WHERE id = $1")
                .bind(fixture_uuid(voice_session_id).expect("session UUID"))
                .fetch_one(pool)
                .await
                .expect("the deleted session keeps a content-free tombstone row");
        (
            row.try_get("mode").expect("mode"),
            row.try_get("status").expect("status"),
            row.try_get("terminal_reason").expect("terminal reason"),
        )
    }

    async fn study_set_snapshot_json(pool: &sqlx::PgPool) -> String {
        sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(scanned)::text FROM study_sets AS scanned WHERE id = $1",
        )
        .bind(fixture_uuid(LEARNING_SET_ID).expect("learning set UUID"))
        .fetch_one(pool)
        .await
        .expect("the tombstone row serializes")
    }

    /// The canary scan itself is complete: it names every base table in the final
    /// schema, so a future learner table cannot be added outside the proof.
    #[tokio::test]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_delete_canary_scan_covers_every_learner_text_table() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();

        let mut base_tables = sqlx::query_scalar::<_, String>(
            "SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = current_schema()
               AND table_type = 'BASE TABLE'
               AND table_name <> '_sqlx_migrations'
             ORDER BY table_name",
        )
        .fetch_all(&pool)
        .await
        .expect("the final schema lists its base tables");
        base_tables.sort();
        let mut enumerated = CANARY_SCOPED_TABLES
            .iter()
            .map(|table| (*table).to_owned())
            .collect::<Vec<_>>();
        enumerated.sort();
        assert_eq!(
            base_tables, enumerated,
            "every base table in the final schema must be in the canary scan"
        );

        // The selected D-01 v1 seam is `review_items` columns, not a table of its
        // own, so the scan's `review_items` entry is the schedule/history coverage
        // the plan requires.
        for branch_table in ["review_schedule_decisions", "review_history_events"] {
            assert!(
                !base_tables.contains(&branch_table.to_owned()),
                "{branch_table} must not exist: 0015 stores the selected v1 decision in review_items"
            );
        }
        assert!(sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'review_items'
                   AND column_name = 'schedule_decision'
             )"
        )
        .fetch_one(&pool)
        .await
        .expect("column lookup succeeds"));

        // And the scan finds nothing after a real deletion.
        let seed = canary_learning_core_seed();
        seed_canary_postgres(&pool, &seed).await;
        let store = PostgresStudyStore::new(pool.clone());
        drive_canary_session(&store, "vs-0001", &seed).await;
        store
            .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
            .await
            .expect("study set deletion succeeds");
        assert_eq!(
            tables_still_holding_the_canary(&pool).await,
            Vec::<String>::new()
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }

    /// Deletion serializes against every artifact writer: whichever order wins, the
    /// committed end state is the content-free tombstone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    #[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_delete_serializes_against_every_artifact_writer() {
        let fixture_schema = PostgresSchemaFixture::migrated().await;
        let pool = fixture_schema.pool().clone();
        let seed = canary_learning_core_seed();
        seed_canary_postgres(&pool, &seed).await;
        let writer = Arc::new(PostgresStudyStore::new(pool.clone()));
        let deleter = Arc::new(PostgresStudyStore::new(pool.clone()));
        let session_id = "vs-0001";
        drive_canary_session(writer.as_ref(), session_id, &seed).await;

        // Six independent writers and the deletion are released together.
        let barrier = Arc::new(tokio::sync::Barrier::new(7));
        let mut racers: Vec<tokio::task::JoinHandle<()>> = Vec::new();

        let usage_store = Arc::clone(&writer);
        let usage_barrier = Arc::clone(&barrier);
        racers.push(tokio::spawn(async move {
            usage_barrier.wait().await;
            let _ = usage_store
                .record_voice_usage(canary_usage("vs-0001"))
                .await;
        }));

        let recap_store = Arc::clone(&writer);
        let recap_barrier = Arc::clone(&barrier);
        let recap_seed = canary_learning_core_seed();
        racers.push(tokio::spawn(async move {
            recap_barrier.wait().await;
            let _ = recap_store
                .record_recap(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    "vs-0001",
                    "resp-canary-race-recap",
                    canary_recap("vs-0001", &recap_seed),
                )
                .await;
        }));

        let status_store = Arc::clone(&writer);
        let status_barrier = Arc::clone(&barrier);
        let raced_concept = seed.concepts[1].0.clone();
        racers.push(tokio::spawn(async move {
            status_barrier.wait().await;
            let _ = status_store
                .record_concept_status(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    "vs-0001",
                    "resp-canary-race-status",
                    &raced_concept,
                    ConceptStatus::Strong,
                )
                .await;
        }));

        let nonce_store = Arc::clone(&writer);
        let nonce_barrier = Arc::clone(&barrier);
        racers.push(tokio::spawn(async move {
            nonce_barrier.wait().await;
            let mut claim = canary_nonce("vs-0001");
            claim.nonce = format!("{}-race", claim.nonce);
            let _ = nonce_store.claim_session_token_nonce(claim).await;
        }));

        let outcome_store = Arc::clone(&writer);
        let outcome_barrier = Arc::clone(&barrier);
        let raced_question = seed.questions[0].0.question_id.clone();
        racers.push(tokio::spawn(async move {
            outcome_barrier.wait().await;
            let mut outcome = outcome_named("evaluated_strong");
            outcome.response_id = "resp-canary-race-outcome".to_owned();
            outcome.question_id = raced_question;
            if let TurnResolution::Evaluated {
                concise_feedback, ..
            } = &mut outcome.resolution
            {
                *concise_feedback = canary_text("late feedback");
            }
            let _ = outcome_store
                .record_turn_outcome(LEARNING_USER_ID, LEARNING_SET_ID, "vs-0001", outcome)
                .await;
        }));

        let selection_store = Arc::clone(&writer);
        let selection_barrier = Arc::clone(&barrier);
        racers.push(tokio::spawn(async move {
            selection_barrier.wait().await;
            let _ = selection_store
                .select_next_question(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    "vs-0001",
                    "resp-canary-race-select",
                    ProgressionPolicyId::OrderedV1,
                )
                .await;
        }));

        let delete_store = Arc::clone(&deleter);
        let delete_barrier = Arc::clone(&barrier);
        let delete = tokio::spawn(async move {
            delete_barrier.wait().await;
            delete_store
                .delete_study_set(LEARNING_USER_ID, LEARNING_SET_ID)
                .await
        });

        for racer in racers {
            racer.await.expect("racer joins");
        }
        delete
            .await
            .expect("delete joins")
            .expect("study set deletion succeeds under the race");

        // Whichever order won, the committed state is the tombstone.
        assert_eq!(
            tables_still_holding_the_canary(&pool).await,
            Vec::<String>::new(),
            "a writer that raced deletion must not leave learner text behind"
        );
        assert_hard_purge_tombstone(&pool).await;
        assert_eq!(
            learning_session_tombstone(&pool, session_id).await,
            (
                "deleted".to_owned(),
                "deleted".to_owned(),
                Some("deleted".to_owned())
            )
        );

        // Every artifact writer refuses a tombstoned set afterwards.
        assert_eq!(
            writer
                .record_voice_usage(canary_usage(session_id))
                .await
                .expect_err("usage after deletion is refused")
                .kind(),
            PortErrorKind::Conflict
        );
        assert_eq!(
            writer
                .record_voice_session(&SessionConfig {
                    session_id: Some(SessionId::new("11111111-1111-4111-8111-11111111abcd")),
                    user_id: Some(LEARNING_USER_ID.to_owned()),
                    study_set_id: Some(LEARNING_SET_ID.to_owned()),
                    mode: Some(StudyMode::Quiz),
                    ..SessionConfig::default()
                })
                .await
                .expect_err("a tombstoned set opens no new session")
                .kind(),
            PortErrorKind::Unavailable
        );
        assert_eq!(
            writer
                .claim_session_token_nonce(canary_nonce(session_id))
                .await
                .expect_err("a tombstoned set claims no nonce")
                .kind(),
            PortErrorKind::Unavailable
        );

        fixture_schema
            .cleanup()
            .await
            .expect("isolated test schema drops cleanly");
    }
}
