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
    use crate::PostgresStudyStore;
    use agent_domain::{
        fixture_question, fixture_source_reference, ConceptStatus, SessionConfig, SessionId,
        SessionTokenNonceClaim, StudyMemoryStore, StudyMode, StudySessionRecap,
        StudyStoreWriteCounts, ToolProposal, VivaToolExecutor, VoiceUsageRecord,
    };
    use serde::Deserialize;
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
                    "shaky",
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

    #[tokio::test]
    async fn optional_postgres_count_truth_table_stays_exact_under_replayed_provider_writes_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let expected = expected_count_delta("happy");
        let store = Arc::new(crate::PostgresStudyStore::new(pool.clone()));
        let session_id = Uuid::new_v4().to_string();
        let baseline_writes = store.write_counts();
        let baseline_rows = db_row_counts(&pool).await;

        record_count_table_session(store.as_ref(), &session_id).await;
        let executor = count_table_executor(store.clone(), &session_id);
        replay_counted_provider_turn(&executor, &session_id).await;
        replay_counted_provider_turn(&executor, &session_id).await;
        store
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
            count_delta_from_writes(store.write_counts(), baseline_writes, 1),
            expected
        );
        assert_eq!(
            count_delta_from_rows(db_row_counts(&pool).await, baseline_rows, expected),
            expected
        );
    }

    #[tokio::test]
    async fn optional_postgres_study_session_durable_counts_match_real_schema_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");

        let store = Arc::new(crate::PostgresStudyStore::new(pool.clone()));
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(store.as_ref(), &session_id).await;
        let executor = count_table_executor(store.clone(), &session_id);
        replay_counted_provider_turn(&executor, &session_id).await;

        let counts = store
            .study_session_durable_counts("user-1", "biology-midterm", &session_id)
            .await
            .expect("durable count query uses the migrated postgres schema");
        assert_eq!(counts.answer_attempts, 1);
        assert_eq!(counts.concept_statuses, 1);
        assert_eq!(counts.review_items, 1);
        assert_eq!(counts.prior_recaps, 1);
    }

    #[tokio::test]
    async fn optional_postgres_session_token_nonce_claims_reject_replay_when_database_url_is_set() {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
        match replay {
            PortError::Unavailable { port, reason, .. } => {
                assert_eq!(port, "postgres");
                assert_eq!(reason, "session token nonce already used");
            }
            other => panic!("unexpected replay error: {other}"),
        }
        assert_eq!(session_token_nonce_rows(&pool, &claim).await, 1);
    }

    #[tokio::test]
    async fn optional_postgres_library_snapshot_scopes_review_items_to_voice_session_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool);
        record_fixture_session(&store).await;
        let second_session_id = "55555555-5555-4555-8555-555555555555";
        store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(second_session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records second fixture session");
        store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "nadh",
                "2026-06-20T09:00:00Z",
            )
            .await
            .expect("schedules first session review");
        store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                second_session_id,
                "atp-synthase",
                "2026-06-18T09:00:00Z",
            )
            .await
            .expect("schedules second session review");
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
    }

    #[tokio::test]
    async fn optional_postgres_schedule_review_item_concurrent_replay_is_atomic_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    }

    /// The Postgres half of the D-01 replay guard. Two calls that differ only because
    /// the wall clock moved are the same graded outcome: they must leave exactly one
    /// scheduled row, and the persisted FSRS card must not advance.
    #[tokio::test]
    async fn optional_postgres_review_schedule_decision_replay_writes_one_row_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    async fn optional_postgres_ingestion_persists_the_exam_instant_for_the_d01_cap_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    }

    /// The production retry route always sends `exam_date: None`, so a retry that
    /// writes the input verbatim erases the learner's exam instant on the durable
    /// backend exactly as it did in memory.
    #[tokio::test]
    async fn optional_postgres_file_retry_keeps_the_exam_instant_the_learner_recorded_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        let store = PostgresStudyStore::new(pool.clone());

        let ingested = store
            .create_file_study_set(agent_domain::CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Bio PDF".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: Some(EXAM_AT.to_owned()),
                file_name: "Lecture 9.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
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
                file_name: "Lecture 9 rescan.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
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
    }

    /// Fail closed where the learner supplies the value, on the durable backend too.
    #[tokio::test]
    async fn optional_postgres_ingestion_rejects_an_unparseable_exam_date_when_database_url_is_set()
    {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    async fn optional_postgres_review_schedule_decision_concurrent_replay_under_the_exam_cap_writes_one_row_when_database_url_is_set(
    ) {
        const RACERS: usize = 4;
        const ROUNDS: usize = 12;

        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    }

    /// The two backends must leave the same authorization ledger behind: a replay
    /// performs no write, so it appends no second authorization on either.
    #[tokio::test]
    async fn optional_postgres_review_schedule_decision_replay_records_exactly_one_authorization_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
        assert_eq!(
            store.event_authorization_ledger_len(),
            1,
            "a replay writes nothing, so it appends no second authorization"
        );
    }

    #[tokio::test]
    async fn optional_postgres_record_recap_concurrent_replay_is_atomic_when_database_url_is_set() {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    }

    #[tokio::test]
    async fn optional_postgres_record_recap_replaces_session_payload_without_incrementing_count_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &session_id).await;
        let mut first = fixture_recap();
        first.voice_session_id.clone_from(&session_id);
        let mut replacement = first.clone();
        replacement.strong_concepts.push("ATP synthase".to_owned());
        replacement.shaky_concepts.clear();

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
    }

    #[tokio::test]
    async fn optional_postgres_session_recap_backfill_dedupes_existing_session_rows_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations_until(&pool, "0014_session_recaps_one_row_per_session.sql")
            .await
            .expect("pre-0014 migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = Uuid::new_v4().to_string();
        record_count_table_session(&store, &session_id).await;
        let study_set_uuid = fixture_uuid("biology-midterm").expect("study set fixture UUID");
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
                WHERE schemaname = 'public'
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
    }

    #[tokio::test]
    async fn optional_postgres_record_concept_status_concurrent_replay_is_atomic_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
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
    }

    #[tokio::test]
    async fn optional_postgres_privacy_deletes_purge_usage_and_preserve_deleted_sessions_when_database_url_is_set(
    ) {
        let Some(pool) = optional_postgres_pool().await else {
            return;
        };
        run_migrations(&pool).await.expect("migrations apply");
        seed_postgres_fixture(&pool)
            .await
            .expect("fixture seed applies");
        let store = PostgresStudyStore::new(pool.clone());
        let session_id = "55555555-5555-4555-8555-555555555555";
        store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records privacy session");
        store
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
        store
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
            .expect("ignores usage for deleted session");
        assert_eq!(usage_rows_for_session(&pool, session_id).await, 0);

        let close_after_delete = store
            .close_voice_session(session_id, "completed")
            .await
            .expect("close preserves deleted session");
        assert_eq!(close_after_delete["status"], "deleted");
        assert_eq!(close_after_delete["terminal_reason"], "deleted");
        assert_eq!(session_status(&pool, session_id).await, "deleted");

        let study_delete_session_id = "66666666-6666-4666-8666-666666666666";
        store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(study_delete_session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records study delete session");
        store
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
        store
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
            .expect("ignores usage after study set deletion");
        assert_eq!(
            usage_rows_for_session(&pool, study_delete_session_id).await,
            0
        );
        assert_eq!(
            session_status(&pool, study_delete_session_id).await,
            "deleted"
        );
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

    async fn record_count_table_session(store: &dyn StudyMemoryStore, session_id: &str) {
        store
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
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            strong_concepts: vec!["NADH".to_owned()],
            shaky_concepts: vec!["ATP synthase".to_owned()],
            missed_concepts: vec![],
            review_later: vec!["ATP synthase".to_owned()],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![agent_domain::RecapSourceMoment {
                text: "NADH donates electrons.".to_owned(),
                source: fixture_source_reference(),
                status: ConceptStatus::Strong,
            }],
        }
    }

    fn count_table_executor(
        store: Arc<crate::PostgresStudyStore>,
        session_id: &str,
    ) -> VivaToolExecutor {
        VivaToolExecutor::new(
            store,
            agent_domain::AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: "biology-midterm".to_owned(),
                voice_session_id: session_id.to_owned(),
                mode: StudyMode::Quiz,
                active_concepts: vec![
                    "oxidative-phosphorylation".to_owned(),
                    "atp-synthase".to_owned(),
                ],
            },
        )
    }

    async fn replay_counted_provider_turn(executor: &VivaToolExecutor, session_id: &str) {
        executor
            .execute(
                "response-count-table-question",
                ToolProposal::select_next_question("biology-midterm", session_id, "quiz"),
            )
            .await
            .expect("selects seeded question");
        executor
            .execute(
                "response-count-table-answer",
                ToolProposal::evaluate_spoken_answer(
                    "biology-midterm",
                    session_id,
                    "q-oxidative-phosphorylation-nadh",
                    "NADH donates electrons.",
                ),
            )
            .await
            .expect("records answer");
        executor
            .execute(
                "response-count-table-answer",
                ToolProposal::retrieve_source_reference(
                    "biology-midterm",
                    session_id,
                    "src-lecture-5-slide-18",
                ),
            )
            .await
            .expect("retrieves source");
        executor
            .execute(
                "response-count-table-answer",
                ToolProposal::mark_concept_status(
                    "biology-midterm",
                    session_id,
                    "oxidative-phosphorylation",
                    "strong",
                ),
            )
            .await
            .expect("records concept status");
        executor
            .execute(
                "response-count-table-answer",
                ToolProposal::schedule_review_item(
                    "biology-midterm",
                    session_id,
                    "atp-synthase",
                    "shaky",
                ),
            )
            .await
            .expect("schedules review");
        executor
            .execute(
                "response-count-table-recap",
                ToolProposal::build_session_recap("biology-midterm", session_id),
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

    fn count_delta_from_writes(
        after: StudyStoreWriteCounts,
        before: StudyStoreWriteCounts,
        usage_events: usize,
    ) -> ExactCountDelta {
        ExactCountDelta {
            sessions: after.sessions - before.sessions,
            answer_attempts: after.answer_attempts - before.answer_attempts,
            concept_statuses: after.concept_statuses - before.concept_statuses,
            review_items: after.review_items - before.review_items,
            recaps: after.recaps - before.recaps,
            usage_events,
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
}
