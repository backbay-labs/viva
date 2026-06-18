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
];

pub async fn run_migrations(pool: &PgPool) -> Result<(), MigrateError> {
    sqlx::migrate!("../../migrations").run(pool).await
}

pub async fn seed_postgres_fixture(pool: &PgPool) -> Result<(), FixtureSeedError> {
    let study_set_id = fixture_uuid("biology-midterm")?;
    let document_id = fixture_uuid("lec-5")?;
    let source_id = fixture_uuid("src-lecture-5-slide-18")?;
    let source = agent_domain::fixture_source_reference();
    let mut tx = pool.begin().await?;

    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('viva_postgres_fixture_seed'))")
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO study_sets (id, user_id, title, course, ingestion_status, ingestion_error)
         VALUES ($1, 'user-1', 'Biology Midterm', 'Biology 201', 'ready', NULL)
         ON CONFLICT (id) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             title = EXCLUDED.title,
             course = EXCLUDED.course,
             ingestion_status = EXCLUDED.ingestion_status,
             ingestion_error = EXCLUDED.ingestion_error,
             updated_at = NOW()",
    )
    .bind(study_set_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO study_documents (id, study_set_id, display_name, source_kind, processing_status, deleted_at)
         VALUES ($1, $2, 'Lecture 5 - Electron Transport.pdf', 'pdf', 'ready', NULL)
         ON CONFLICT (id) DO UPDATE
         SET study_set_id = EXCLUDED.study_set_id,
             display_name = EXCLUDED.display_name,
             source_kind = EXCLUDED.source_kind,
             processing_status = EXCLUDED.processing_status,
             deleted_at = NULL",
    )
    .bind(document_id)
    .bind(study_set_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO source_spans (
             id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (id) DO UPDATE
         SET document_id = EXCLUDED.document_id,
             locator = EXCLUDED.locator,
             excerpt = EXCLUDED.excerpt,
             confidence = EXCLUDED.confidence,
             retrieval_reason = EXCLUDED.retrieval_reason,
             deleted_at = NULL",
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
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE
             SET study_set_id = EXCLUDED.study_set_id,
                 label = EXCLUDED.label,
                 status = EXCLUDED.status,
                 source_span_id = EXCLUDED.source_span_id,
                 public_id = EXCLUDED.public_id,
                 updated_at = NOW()",
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
        "INSERT INTO study_questions (id, study_set_id, question_id, source_span_id, prompt, expected_terms, follow_up, active)
         VALUES (
             '99999999-9999-4999-8999-999999999999',
             $1,
             'q-oxidative-phosphorylation-nadh',
             $2,
             $3,
             $4,
             $5,
             TRUE
         )
         ON CONFLICT (study_set_id, question_id) DO UPDATE
         SET source_span_id = EXCLUDED.source_span_id,
             prompt = EXCLUDED.prompt,
             expected_terms = EXCLUDED.expected_terms,
             follow_up = EXCLUDED.follow_up,
             active = TRUE",
    )
    .bind(study_set_id)
    .bind(source_id)
    .bind(question.prompt)
    .bind(question.expected_terms)
    .bind(question.follow_up)
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
    #[error("fixture id mapping failed: {0}")]
    FixtureId(#[from] PortError),
    #[error("fixture UUID failed to parse: {0}")]
    Uuid(#[from] uuid::Error),
    #[error("fixture seed SQL failed: {0}")]
    Sql(#[from] sqlx::Error),
}

fn fixture_uuid(logical_id: &str) -> Result<Uuid, FixtureSeedError> {
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
    use agent_domain::{
        fixture_question, fixture_source_reference, ConceptStatus, SessionConfig, SessionId,
        StudyMemoryStore, StudyMode, StudySessionRecap, ToolProposal, VivaToolExecutor,
        VoiceUsageRecord,
    };
    use std::sync::Arc;

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
        assert!(!sql.contains("answer_text TEXT"));
        assert!(!sql.contains("evaluation JSONB"));
        assert!(sql.contains("CREATE TABLE voice_usage_events"));
        assert!(sql.contains("cost_estimate_usd"));
        assert!(sql.contains("CREATE TABLE session_recaps"));
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS study_questions"));
        assert!(sql.contains("source_spans_excerpt_bounded"));
        assert!(!sql.contains("summary TEXT"));
        assert!(!sql.contains("headline TEXT"));
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

    #[tokio::test]
    async fn optional_postgres_migrations_apply_when_database_url_is_set() {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool)
            .await
            .expect("migrations should apply when DATABASE_URL is configured");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed should apply after migrations");
    }

    #[tokio::test]
    async fn optional_postgres_fixture_replay_and_negative_matrix_when_database_url_is_set() {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let store = Arc::new(crate::PostgresStudyStore::new(pool.clone()));
        record_fixture_session(store.as_ref()).await;
        let executor = VivaToolExecutor::new(
            store.clone(),
            agent_domain::AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: "biology-midterm".to_owned(),
                voice_session_id: "voice-session-1".to_owned(),
                mode: StudyMode::Quiz,
                active_concepts: vec![
                    "oxidative-phosphorylation".to_owned(),
                    "atp-synthase".to_owned(),
                ],
            },
        );

        let question = executor
            .execute(
                "response-0",
                ToolProposal::select_next_question("biology-midterm", "voice-session-1", "quiz"),
            )
            .await
            .expect("selects seeded question");
        assert_eq!(
            question.result["question"]["source"]["source_id"],
            "src-lecture-5-slide-18"
        );
        executor
            .execute(
                "response-1",
                ToolProposal::evaluate_spoken_answer(
                    "biology-midterm",
                    "voice-session-1",
                    "q-oxidative-phosphorylation-nadh",
                    "NADH donates electrons.",
                ),
            )
            .await
            .expect("records answer");
        executor
            .execute(
                "response-1",
                ToolProposal::retrieve_source_reference(
                    "biology-midterm",
                    "voice-session-1",
                    "src-lecture-5-slide-18",
                ),
            )
            .await
            .expect("retrieves source");
        executor
            .execute(
                "response-1",
                ToolProposal::mark_concept_status(
                    "biology-midterm",
                    "voice-session-1",
                    "oxidative-phosphorylation",
                    "strong",
                ),
            )
            .await
            .expect("records concept status");
        executor
            .execute(
                "response-1",
                ToolProposal::schedule_review_item(
                    "biology-midterm",
                    "voice-session-1",
                    "atp-synthase",
                    "2026-06-16T09:00:00Z",
                ),
            )
            .await
            .expect("schedules review");
        executor
            .execute(
                "response-0",
                ToolProposal::build_session_recap("biology-midterm", "voice-session-1"),
            )
            .await
            .expect("records recap");
        store
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

        let mut forged_recap_source = fixture_source_reference();
        forged_recap_source.document_id = "wrong-doc".to_owned();
        assert!(negative_store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                StudySessionRecap {
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Done".to_owned(),
                    summary: "Recap".to_owned(),
                    strong_concepts: vec!["NADH".to_owned()],
                    shaky_concepts: vec![],
                    missed_concepts: vec![],
                    review_later: vec!["ATP synthase".to_owned()],
                    next_action: "Review tomorrow".to_owned(),
                    source_moments: vec![agent_domain::RecapSourceMoment {
                        text: "Forged recap source".to_owned(),
                        source: forged_recap_source,
                        status: ConceptStatus::Strong,
                    }],
                },
            )
            .await
            .is_err());

        assert_eq!(negative_store.write_counts(), baseline);
        assert_eq!(db_row_counts(&pool).await, row_baseline);
    }

    async fn optional_postgres_pool() -> Option<sqlx::PgPool> {
        let database_url = std::env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        Some(
            crate::connect_pg(&crate::PgConfig::new(database_url))
                .await
                .expect("DATABASE_URL should connect for optional postgres test"),
        )
    }

    async fn record_fixture_session(store: &dyn StudyMemoryStore) {
        store
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

    async fn db_row_counts(pool: &sqlx::PgPool) -> DbRowCounts {
        DbRowCounts {
            voice_sessions: count_rows(pool, "voice_sessions").await,
            answer_attempts: count_rows(pool, "answer_attempts").await,
            review_items: count_rows(pool, "review_items").await,
            session_recaps: count_rows(pool, "session_recaps").await,
            voice_usage_events: count_rows(pool, "voice_usage_events").await,
        }
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
}
