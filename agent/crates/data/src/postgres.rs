use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use agent_domain::{
    format_rfc3339_millis,
    learning_outcome::VIVA_TURN_OUTCOME_RECORD_SCHEMA,
    learning_recap::{ConceptLabel, SessionLearningEvidence},
    parse_utc_instant,
    study_projection::{
        StudyProjectionConceptV1, StudyProjectionQuestionProgressV1, StudyProjectionReviewItemV1,
        StudyProjectionSessionV1, StudyProjectionStudySetV1, StudyProjectionVersionV1,
    },
    AnswerAttemptEnvelope, AnswerEvaluation, AuthenticatedStudyProjectionV1, ChallengeResolution,
    ConceptStatus, CreateFileStudySet, CreatePasteStudySet, LibraryNextReviewSummary,
    LibrarySessionRecapSummary, LibrarySessionSummary, LibraryStudyDocumentSummary,
    LibraryStudySetSummary, PersistedFsrsCardV1, PersistedTurnOutcome, PortError,
    ProgressionPolicyId, QuestionProgressionCursor, QuestionProgressionResult,
    ReviewScheduleCapReasonV1, ReviewScheduleDecisionV1, ReviewSchedulingContextV1, SessionConfig,
    SessionTokenNonceClaim, StudyLibrarySnapshot, StudyMemoryStore, StudyQuestion,
    StudySessionDurableCounts, StudySessionRecap, StudySetIngestionRecord, StudySetIngestionStatus,
    StudySourceReference, StudyStoreBackend, StudyStoreCapabilities, StudyStoreWriteCounts,
    StudyStoreWriteOutcome, TurnOutcome, TurnOutcomeRecordReceipt, VoiceUsageRecord,
    VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    memory::{
        current_epoch_seconds, deletion_receipt, generate_file_study_set, generate_paste_study_set,
        last_reviewed_at, payload_sha256, projection_active_question,
        require_selected_progression_policy, review_schedule_summaries, turn_outcome_disposition,
        turn_outcome_transitions, validate_challenge_resolution, validate_turn_outcome,
        ConceptStatusEventPayload, EventAuthorizationKind, QuestionProgressionRecord,
        ReviewScheduleEventPayload, DATA_RETENTION_POLICY, DELETED_ROW_CONSTANT,
        DELETED_STUDY_SET_TITLE, SESSION_TOKEN_NONCE_SKEW_SECONDS,
    },
    recap_label_buckets, InMemoryStudyStore,
};

/// `DATA-015`: ingestion — the durable half of turning one upload into a study
/// set. The port methods below delegate their whole body to it.
mod ingestion;

/// `DATA-015`: learning — canonical outcomes, challenges, progression, the
/// selected D-01 seam, and both canonical reads built from them.
mod learning;

/// `DATA-015`: authorization — the durable browser-event digest and the nonce
/// replay ledger's bounded retention.
mod authorization;

/// `DATA-015`: privacy — the one global lock order, the tombstone-aware ownership
/// guard, usage/delete serialization, and the selected D-05 finalizer.
mod privacy;

#[derive(Clone, Debug)]
pub struct PostgresStudyStore {
    pool: PgPool,
    counts: Arc<PostgresWriteCounters>,
}

/// The published write counts, one lock-free counter per kind.
///
/// `DATA-002`/`DATA-010`: the previous `Arc<RwLock<StudyStoreWriteCounts>>` made the
/// post-commit count update fallible, so a poisoned local lock turned an
/// already-committed row into a returned error. Callers retry returned errors,
/// and a usage event has no stable identity to retry against, so that path could
/// duplicate a committed usage row. A counter that cannot fail cannot do that:
/// one `fetch_add` after a successful commit, and nothing at all on replay,
/// conflict, or rollback.
#[derive(Debug, Default)]
struct PostgresWriteCounters {
    sessions: AtomicUsize,
    answer_attempts: AtomicUsize,
    concept_statuses: AtomicUsize,
    review_items: AtomicUsize,
    recaps: AtomicUsize,
    voice_usage: AtomicUsize,
}

impl PostgresWriteCounters {
    fn increment(&self, kind: WriteCountKind) {
        let counter = match kind {
            WriteCountKind::Session => &self.sessions,
            WriteCountKind::AnswerAttempt => &self.answer_attempts,
            WriteCountKind::ConceptStatus => &self.concept_statuses,
            WriteCountKind::ReviewItem => &self.review_items,
            WriteCountKind::Recap => &self.recaps,
            WriteCountKind::VoiceUsage => &self.voice_usage,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> StudyStoreWriteCounts {
        StudyStoreWriteCounts {
            sessions: self.sessions.load(Ordering::Relaxed),
            answer_attempts: self.answer_attempts.load(Ordering::Relaxed),
            concept_statuses: self.concept_statuses.load(Ordering::Relaxed),
            review_items: self.review_items.load(Ordering::Relaxed),
            recaps: self.recaps.load(Ordering::Relaxed),
            voice_usage: self.voice_usage.load(Ordering::Relaxed),
        }
    }
}

impl PostgresStudyStore {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            counts: Arc::new(PostgresWriteCounters::default()),
        }
    }

    fn uuid_for(logical_id: &str) -> Result<Uuid, PortError> {
        if let Ok(uuid) = logical_id.parse() {
            return Ok(uuid);
        }
        InMemoryStudyStore::fixture_id_translation(logical_id)
            .map(|translation| translation.storage_uuid)
            .map_err(|_| {
                PortError::unavailable(
                    "postgres",
                    logical_id,
                    "logical id is not a UUID and has no fixture mapping",
                )
            })
    }

    fn logical_id_for_uuid(uuid: Uuid) -> String {
        InMemoryStudyStore::fixture_logical_id_for_uuid(uuid)
            .map_or_else(|| uuid.to_string(), ToOwned::to_owned)
    }

    /// One counted write, after the row it counts is committed. Infallible by
    /// construction: see [`PostgresWriteCounters`].
    fn increment_count(&self, kind: WriteCountKind) {
        self.counts.increment(kind);
    }

    async fn ensure_active_question(
        &self,
        study_set_uuid: Uuid,
        question_id: &str,
    ) -> Result<(), PortError> {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM study_questions
                WHERE study_set_id = $1
                  AND question_id = $2
                  AND active
             )",
        )
        .bind(study_set_uuid)
        .bind(question_id)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        if exists {
            return Ok(());
        }
        Err(PortError::unavailable(
            "postgres",
            question_id,
            "question is not active for this study set",
        ))
    }

    async fn active_question_source(
        &self,
        user_id: &str,
        study_set_id: &str,
        question_id: &str,
    ) -> Result<StudySourceReference, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let row = sqlx::query(
            "SELECT
                sp.id AS source_id,
                sp.document_id,
                sp.locator,
                sp.excerpt,
                sp.confidence,
                sp.retrieval_reason
             FROM study_questions q
             JOIN study_sets s ON s.id = q.study_set_id
             JOIN source_spans sp ON sp.id = q.source_span_id
             JOIN study_documents d ON d.id = sp.document_id
             WHERE q.study_set_id = $1
               AND s.user_id = $2
               AND q.question_id = $3
               AND q.active
               AND d.study_set_id = q.study_set_id
               AND sp.deleted_at IS NULL
               AND d.deleted_at IS NULL",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .bind(question_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(row) = row else {
            return Err(PortError::unavailable(
                "postgres",
                question_id,
                "question is not active for this study set",
            ));
        };
        let locator: Value = row.try_get("locator").map_err(pg_error)?;
        Ok(StudySourceReference {
            source_id: Self::logical_id_for_uuid(
                row.try_get::<Uuid, _>("source_id").map_err(pg_error)?,
            ),
            document_id: Self::logical_id_for_uuid(
                row.try_get::<Uuid, _>("document_id").map_err(pg_error)?,
            ),
            span: locator
                .get("span")
                .and_then(Value::as_str)
                .unwrap_or("source span")
                .to_owned(),
            excerpt: row.try_get("excerpt").map_err(pg_error)?,
            confidence: source_confidence(
                row.try_get::<String, _>("confidence")
                    .map_err(pg_error)?
                    .as_str(),
            )?,
            retrieval_reason: row.try_get("retrieval_reason").map_err(pg_error)?,
        })
    }

    async fn answer_evaluation_was_recorded(
        &self,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        response_id: &str,
        evaluation: &AnswerEvaluation,
    ) -> Result<bool, PortError> {
        let source_span_uuid = Self::uuid_for(&evaluation.source.source_id)?;
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1
                FROM answer_attempts aa
                JOIN voice_sessions vs ON vs.id = aa.voice_session_id
                WHERE aa.voice_session_id = $1
                  AND vs.user_id = $2
                  AND vs.study_set_id = $3
                  AND aa.response_id = $4
                  AND aa.question_id = $5
                  AND aa.evaluation_label = $6
                  AND aa.concept_status = $7
                  AND ABS(aa.confidence_score - $8) <= 0.000001
                  AND aa.source_span_id = $9
             )",
        )
        .bind(voice_session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(response_id)
        .bind(&evaluation.question_id)
        .bind(&evaluation.label)
        .bind(concept_status_str(&evaluation.concept_status))
        .bind(f64::from(evaluation.confidence_score))
        .bind(source_span_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)
    }

    async fn concept_uuid_for(
        &self,
        study_set_uuid: Uuid,
        concept_id: &str,
    ) -> Result<Uuid, PortError> {
        let concept_uuid = if let Ok(uuid) = concept_id.parse::<Uuid>() {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM concepts
                 WHERE study_set_id = $1 AND id = $2",
            )
            .bind(study_set_uuid)
            .bind(uuid)
        } else {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM concepts
                 WHERE study_set_id = $1 AND public_id = $2",
            )
            .bind(study_set_uuid)
            .bind(concept_id)
        }
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        concept_uuid.ok_or_else(|| {
            PortError::unavailable(
                "postgres",
                concept_id,
                "concept is not available for this study set",
            )
        })
    }
}

/// The tenant, session, and concept one D-01 schedule write applies to.
#[derive(Clone, Copy, Debug)]
struct ScheduleScope<'a> {
    user_id: &'a str,
    study_set_uuid: Uuid,
    voice_session_uuid: Uuid,
    concept_uuid: Uuid,
    concept_id: &'a str,
    response_id: &'a str,
}

/// What one D-01 schedule write actually did, so a caller inside a larger
/// transaction can tell an insert from a replay from a lost race without reading
/// an adapter error string.
#[derive(Clone, Debug)]
enum ScheduleWriteOutcome {
    Inserted(ReviewScheduleDecisionV1),
    Replayed(ReviewScheduleDecisionV1),
    /// A concurrent writer won and its unique violation aborted this transaction.
    RaceLost {
        payload_sha256: String,
    },
}

#[derive(Clone, Copy, Debug)]
enum WriteCountKind {
    Session,
    AnswerAttempt,
    ConceptStatus,
    ReviewItem,
    Recap,
    VoiceUsage,
}

#[async_trait]
impl StudyMemoryStore for PostgresStudyStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        StudyStoreCapabilities {
            backend: StudyStoreBackend::Postgres,
            available: true,
            durable: true,
            nonce_replay_protection: true,
            raw_audio_persistence: false,
            transcript_persistence: false,
            uuid_schema_translation: true,
        }
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.counts.snapshot()
    }

    async fn pending_answer_attempts_for_session(
        &self,
        voice_session_id: &str,
    ) -> Result<usize, PortError> {
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM answer_attempts
             WHERE voice_session_id = $1
               AND evaluation_label IS NULL
               AND concept_status IS NULL",
        )
        .bind(voice_session_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        usize::try_from(count).map_err(|_| {
            PortError::internal(
                "postgres",
                voice_session_id,
                "pending answer attempt count overflowed usize",
            )
        })
    }

    async fn study_session_durable_counts(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<StudySessionDurableCounts, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let row = sqlx::query(
            "SELECT
                (SELECT COUNT(*) FROM answer_attempts attempts
                 JOIN voice_sessions sessions ON sessions.id = attempts.voice_session_id
                 WHERE sessions.user_id = $1
                   AND sessions.study_set_id = $2
                   AND attempts.voice_session_id = $3) AS answer_attempts,
                (SELECT COUNT(*) FROM concept_status_events
                 WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3) AS concept_statuses,
                (SELECT COUNT(*) FROM review_items
                 WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3) AS review_items,
                (SELECT COUNT(*) FROM session_recaps
                 WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3) AS prior_recaps",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        Ok(StudySessionDurableCounts {
            answer_attempts: count_to_usize(row.try_get("answer_attempts").map_err(pg_error)?)?,
            concept_statuses: count_to_usize(row.try_get("concept_statuses").map_err(pg_error)?)?,
            review_items: count_to_usize(row.try_get("review_items").map_err(pg_error)?)?,
            prior_recaps: count_to_usize(row.try_get("prior_recaps").map_err(pg_error)?)?,
        })
    }

    async fn answer_attempt_was_recorded(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
    ) -> Result<bool, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1
                FROM answer_attempts attempts
                JOIN voice_sessions sessions ON sessions.id = attempts.voice_session_id
                WHERE sessions.user_id = $1
                  AND sessions.study_set_id = $2
                  AND attempts.voice_session_id = $3
                  AND attempts.response_id = $4
             )",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(response_id)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)
    }

    /// `DATA-003`: one statement carries both the write and the truth about it.
    ///
    /// `RETURNING (xmax = '0'::xid)` distinguishes the physical insert from the
    /// conflict path, so a replay can be reported as a replay instead of being
    /// counted as a second session. The `DO UPDATE ... SET mode = voice_sessions.mode`
    /// is a deliberate no-op write: it is the only way to make a matching replay
    /// return a row (and therefore be distinguishable from a refused one) without
    /// changing any committed value. A replay of a closed or deleted session, or
    /// one whose owner/set/mode differ, matches no `WHERE` and returns no row,
    /// which is `Conflict` — never a silent reopen.
    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        let session_id = required(config.session_id.as_deref(), "session_id")?;
        let user_id = required(config.user_id.as_deref(), "user_id")?;
        let study_set_id = required(config.study_set_id.as_deref(), "study_set_id")?;
        let session_uuid = Self::uuid_for(session_id)?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        self.ensure_study_set(user_id, study_set_uuid).await?;
        let mode = config.mode.clone().unwrap_or_default();
        let inserted = sqlx::query_scalar::<_, bool>(
            "INSERT INTO voice_sessions (id, user_id, study_set_id, mode, status)
             VALUES ($1, $2, $3, $4, 'open')
             ON CONFLICT (id) DO UPDATE
             SET mode = voice_sessions.mode
             WHERE voice_sessions.user_id = EXCLUDED.user_id
               AND voice_sessions.study_set_id = EXCLUDED.study_set_id
               AND voice_sessions.status = 'open'
               AND voice_sessions.mode = EXCLUDED.mode
             RETURNING (xmax = '0'::xid) AS inserted",
        )
        .bind(session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(mode.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(inserted) = inserted else {
            return Err(PortError::conflict(
                "postgres",
                session_id,
                "voice session cannot be reopened or ownership changed",
            ));
        };
        if !inserted {
            return Ok(StudyStoreWriteOutcome::IdempotentReplay);
        }
        self.increment_count(WriteCountKind::Session);
        Ok(StudyStoreWriteOutcome::Inserted)
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        self.claim_session_token_nonce_at(claim, current_epoch_seconds())
            .await
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<Value, PortError> {
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        // `DATA-005`: closing a session ends its browser authority in the same
        // transaction that closes it. An *open* session may therefore resume
        // across a restart or on a second instance; a closed one cannot replay
        // browser authority anywhere.
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        let updated = sqlx::query(
            "UPDATE voice_sessions
             SET status = 'closed',
                 ended_at = COALESCE(ended_at, NOW()),
                 terminal_reason = $2
             WHERE id = $1 AND status <> 'deleted'
             RETURNING status, terminal_reason",
        )
        .bind(voice_session_uuid)
        .bind(terminal_reason)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        let (status, stored_terminal_reason): (String, Option<String>) = if let Some(row) = updated
        {
            (
                row.try_get("status").map_err(pg_error)?,
                row.try_get("terminal_reason").map_err(pg_error)?,
            )
        } else {
            let row = sqlx::query(
                "SELECT status, terminal_reason
                     FROM voice_sessions
                     WHERE id = $1",
            )
            .bind(voice_session_uuid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(pg_error)?
            .ok_or_else(|| {
                PortError::unavailable("postgres", voice_session_id, "voice session does not exist")
            })?;
            (
                row.try_get("status").map_err(pg_error)?,
                row.try_get("terminal_reason").map_err(pg_error)?,
            )
        };
        authorization::delete_session_digests(&mut tx, voice_session_uuid).await?;
        tx.commit().await.map_err(pg_error)?;
        Ok(json!({
            "voice_session_id": voice_session_id,
            "status": status,
            "terminal_reason": stored_terminal_reason,
        }))
    }

    async fn create_paste_study_set(
        &self,
        input: CreatePasteStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        ingestion::create_paste_study_set(self, input).await
    }

    async fn create_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        ingestion::create_file_study_set(self, input).await
    }

    async fn retry_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        ingestion::retry_file_study_set(self, input).await
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let value = sqlx::query_scalar::<_, Value>(
            "SELECT jsonb_build_object(
                'study_set', jsonb_build_object(
                    'id', s.id,
                    'user_id', s.user_id,
                    'title', s.title,
                    'course', s.course,
                    'ingestion_status', s.ingestion_status,
                    'ingestion_error', s.ingestion_error
                ),
                'documents', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', d.id,
                        'display_name', d.display_name,
                        'source_kind', d.source_kind,
                        'processing_status', d.processing_status
                    ))
                    FROM study_documents d
                    WHERE d.study_set_id = s.id AND d.deleted_at IS NULL
                ), '[]'::jsonb),
                'source_spans', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', sp.id, 'document_id', sp.document_id, 'locator', sp.locator, 'confidence', sp.confidence, 'retrieval_reason', sp.retrieval_reason))
                    FROM source_spans sp
                    JOIN study_documents d ON d.id = sp.document_id
                    WHERE d.study_set_id = s.id AND d.deleted_at IS NULL AND sp.deleted_at IS NULL
                ), '[]'::jsonb),
                'concepts', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', c.id,
                        'public_id', c.public_id,
                        'label', c.label,
                        'status', c.status,
                        'source_span_id', c.source_span_id
                    ) ORDER BY COALESCE(c.public_id, c.id::text), c.id)
                    FROM concepts c
                    WHERE c.study_set_id = s.id
                ), '[]'::jsonb),
                'questions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'question_id', q.question_id,
                        'prompt', q.prompt,
                        'expected_terms', q.expected_terms,
                        'follow_up', q.follow_up,
                        'source_span_id', q.source_span_id
                    ))
                    FROM study_questions q
                    WHERE q.study_set_id = s.id AND q.active
                ), '[]'::jsonb)
             )
             FROM study_sets s
             WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        Ok(value)
    }

    async fn library_snapshot(&self, user_id: &str) -> Result<StudyLibrarySnapshot, PortError> {
        let study_set_rows = sqlx::query(
            "SELECT id, user_id, title, course, ingestion_status, ingestion_error
             FROM study_sets
             WHERE user_id = $1
               AND deleted_at IS NULL
             ORDER BY title ASC, id ASC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_error)?;

        let mut study_sets = Vec::with_capacity(study_set_rows.len());
        for row in study_set_rows {
            let study_set_uuid: Uuid = row.try_get("id").map_err(pg_error)?;
            let study_set_id = Self::logical_id_for_uuid(study_set_uuid);
            let document_rows = sqlx::query(
                "SELECT id, display_name, source_kind, processing_status, deleted_at IS NOT NULL AS deleted
                 FROM study_documents
                 WHERE study_set_id = $1
                 ORDER BY display_name ASC, id ASC",
            )
            .bind(study_set_uuid)
            .fetch_all(&self.pool)
            .await
            .map_err(pg_error)?;
            let mut documents = Vec::with_capacity(document_rows.len());
            for document in document_rows {
                let document_id: Uuid = document.try_get("id").map_err(pg_error)?;
                let processing_status: String =
                    document.try_get("processing_status").map_err(pg_error)?;
                documents.push(LibraryStudyDocumentSummary {
                    id: Self::logical_id_for_uuid(document_id),
                    display_name: document.try_get("display_name").map_err(pg_error)?,
                    source_kind: document.try_get("source_kind").map_err(pg_error)?,
                    processing_status: ingestion_status(&processing_status)?,
                    deleted: document.try_get("deleted").map_err(pg_error)?,
                });
            }

            let concept_count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM concepts WHERE study_set_id = $1",
            )
            .bind(study_set_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(pg_error)?;
            let question_count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*)
                 FROM study_questions q
                 JOIN source_spans sp ON sp.id = q.source_span_id
                 JOIN study_documents d ON d.id = sp.document_id
                 WHERE q.study_set_id = $1
                   AND q.active
                   AND d.study_set_id = q.study_set_id
                   AND sp.deleted_at IS NULL
                   AND d.deleted_at IS NULL",
            )
            .bind(study_set_uuid)
            .fetch_one(&self.pool)
            .await
            .map_err(pg_error)?;
            let open_session_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT id
                 FROM voice_sessions
                 WHERE user_id = $1 AND study_set_id = $2 AND status = 'open'
                 ORDER BY started_at DESC, id DESC
                 LIMIT 1",
            )
            .bind(user_id)
            .bind(study_set_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(pg_error)?
            .map(Self::logical_id_for_uuid);

            let ingestion_status_value: String =
                row.try_get("ingestion_status").map_err(pg_error)?;
            study_sets.push(LibraryStudySetSummary {
                id: study_set_id,
                user_id: row.try_get("user_id").map_err(pg_error)?,
                title: row.try_get("title").map_err(pg_error)?,
                course: row.try_get("course").map_err(pg_error)?,
                ingestion_status: ingestion_status(&ingestion_status_value)?,
                ingestion_error: row.try_get("ingestion_error").map_err(pg_error)?,
                server_owned: true,
                documents,
                concept_count: usize::try_from(concept_count).map_err(|_| {
                    PortError::internal("postgres", user_id, "concept count exceeds usize range")
                })?,
                question_count: usize::try_from(question_count).map_err(|_| {
                    PortError::internal("postgres", user_id, "question count exceeds usize range")
                })?,
                open_session_id,
            });
        }

        let session_rows = sqlx::query(
            "SELECT
                vs.id,
                vs.user_id,
                vs.study_set_id,
                COALESCE(s.title, vs.study_set_id::text) AS study_set_title,
                vs.status,
                vs.terminal_reason
             FROM voice_sessions vs
             LEFT JOIN study_sets s ON s.id = vs.study_set_id
             WHERE vs.user_id = $1
               AND vs.study_set_id IS NOT NULL
               AND vs.status = 'closed'
               AND vs.terminal_reason = 'completed'
             ORDER BY vs.started_at DESC, vs.id DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_error)?;

        let mut sessions = Vec::with_capacity(session_rows.len());
        for row in session_rows {
            let voice_session_uuid: Uuid = row.try_get("id").map_err(pg_error)?;
            let study_set_uuid: Uuid = row.try_get("study_set_id").map_err(pg_error)?;
            let voice_session_id = Self::logical_id_for_uuid(voice_session_uuid);
            let study_set_id = Self::logical_id_for_uuid(study_set_uuid);

            let recap = sqlx::query(
                "SELECT voice_session_id, strong_concepts, shaky_concepts, missed_concepts, review_later
                 FROM session_recaps
                 WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1",
            )
            .bind(user_id)
            .bind(study_set_uuid)
            .bind(voice_session_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(pg_error)?
            .map(|recap_row| {
                let recap_voice_session_uuid: Uuid = recap_row.try_get("voice_session_id")?;
                Ok::<_, sqlx::Error>(LibrarySessionRecapSummary {
                    voice_session_id: Self::logical_id_for_uuid(recap_voice_session_uuid),
                    strong_concepts: recap_row.try_get("strong_concepts")?,
                    shaky_concepts: recap_row.try_get("shaky_concepts")?,
                    missed_concepts: recap_row.try_get("missed_concepts")?,
                    review_later: recap_row.try_get("review_later")?,
                })
            })
            .transpose()
            .map_err(pg_error)?;

            // D-01: only valid v1 decisions reach the authenticated read model. A
            // legacy or superseded `review_items` row is never a fallback, and a
            // `past_exam`-capped decision is excluded from the learner-visible schedule.
            let next_review = sqlx::query(
                "SELECT
                    COALESCE(c.public_id, c.id::text) AS concept_id,
                    c.label,
                    ri.schedule_decision->>'status' AS decision_status,
                    ri.due_at AS persisted_due_at
                 FROM review_items ri
                 JOIN concepts c ON c.id = ri.concept_id
                 WHERE ri.user_id = $1
                   AND ri.study_set_id = $2
                   AND ri.status = 'scheduled'
                   AND ri.voice_session_id = $3
                   AND ri.schedule_schema_version = 1
                   AND ri.schedule_decision IS NOT NULL
                   AND (ri.schedule_cap_reason IS DISTINCT FROM 'past_exam')
                 ORDER BY ri.due_at ASC, c.label ASC
                 LIMIT 1",
            )
            .bind(user_id)
            .bind(study_set_uuid)
            .bind(voice_session_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(pg_error)?
            .map(|review_row| {
                let status_value: String = review_row.try_get("decision_status")?;
                let due_at: DateTime<Utc> = review_row.try_get("persisted_due_at")?;
                Ok::<_, sqlx::Error>((review_row, status_value, due_at))
            })
            .transpose()
            .map_err(pg_error)?
            .map(
                |(review_row, status_value, due_at): (_, String, DateTime<Utc>)| {
                    Ok::<_, PortError>(LibraryNextReviewSummary {
                        concept_id: review_row.try_get("concept_id").map_err(pg_error)?,
                        label: review_row.try_get("label").map_err(pg_error)?,
                        status: concept_status(&status_value)?,
                        persisted_due_at: format_rfc3339_millis(due_at),
                        source: "review_schedule_decision_v1".to_owned(),
                    })
                },
            )
            .transpose()?;

            sessions.push(LibrarySessionSummary {
                voice_session_id,
                user_id: row.try_get("user_id").map_err(pg_error)?,
                study_set_id,
                study_set_title: row.try_get("study_set_title").map_err(pg_error)?,
                status: row.try_get("status").map_err(pg_error)?,
                terminal_reason: row.try_get("terminal_reason").map_err(pg_error)?,
                recap,
                next_review,
            });
        }

        Ok(StudyLibrarySnapshot {
            user_id: user_id.to_owned(),
            study_sets,
            sessions,
        })
    }

    /// `D-05 HARD_PURGE_TEXT` finalization, in one locked transaction.
    ///
    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Value, PortError> {
        privacy::delete_study_set(self, user_id, study_set_id).await
    }

    async fn delete_session_history(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<Value, PortError> {
        privacy::delete_session_history(self, user_id, study_set_id, voice_session_id).await
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        // The concept binding and the grading rubric are read back from the columns
        // that store them (migration `0018`), not recovered by rule from the
        // question id: an authored question whose concept is not `q-{concept}` is a
        // question the derivation could never have described.
        //
        // `DATA-011`: one ownership answer, shared with memory. A set that does not
        // exist, belongs to another user, or has been tombstoned is `Unavailable` —
        // the same fail-closed answer the in-memory guard gives — and never
        // `Ok(None)`, which means the different thing "this readable set has no
        // active question left". Collapsing the two hid deletion behind an ordinary
        // empty read on exactly one backend. Readiness stays `Ok(None)`, because a
        // pending or failed set is readable and simply has no question yet.
        let ingestion_status = sqlx::query_scalar::<_, String>(
            "SELECT ingestion_status
             FROM study_sets
             WHERE id = $1
               AND user_id = $2
               AND deleted_at IS NULL",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(ingestion_status) = ingestion_status else {
            return Err(PortError::unavailable(
                "postgres",
                study_set_id,
                "study set is not available for this user",
            ));
        };
        if ingestion_status != StudySetIngestionStatus::Ready.as_str() {
            return Ok(None);
        }
        Ok(Self::active_questions(&self.pool, study_set_uuid)
            .await?
            .into_iter()
            .next())
    }

    async fn authorize_question_started(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        authorization::authorize_question_started(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            question,
        )
        .await
    }

    async fn authorize_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: &AnswerEvaluation,
    ) -> Result<(), PortError> {
        authorization::authorize_answer_evaluation(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            evaluation,
        )
        .await
    }

    async fn authorize_source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        source: &StudySourceReference,
    ) -> Result<(), PortError> {
        authorization::authorize_source_reference(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            source,
        )
        .await
    }

    async fn authorize_concept_status(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        status: &ConceptStatus,
    ) -> Result<(), PortError> {
        authorization::authorize_concept_status(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            concept_id,
            status,
        )
        .await
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &agent_domain::ManuscriptIntent,
    ) -> Result<(), PortError> {
        authorization::authorize_manuscript_intent(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            intent,
        )
        .await
    }

    async fn authorize_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: &StudySessionRecap,
    ) -> Result<(), PortError> {
        authorization::authorize_recap(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            recap,
        )
        .await
    }

    async fn record_answer_attempt_envelope(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<Value, PortError> {
        envelope.validate_fail_closed().map_err(|reason| {
            PortError::invalid_input("postgres", &envelope.response_id, reason)
        })?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        self.active_question_source(user_id, study_set_id, &envelope.question_id)
            .await?;
        let submission_sequence = i32::try_from(envelope.submission_sequence).map_err(|_| {
            PortError::invalid_input(
                "postgres",
                &envelope.response_id,
                "answer submission sequence exceeds postgres integer",
            )
        })?;
        let byte_count = optional_u64_to_i64(envelope.byte_count, "answer byte count")?;
        let char_count = optional_u64_to_i64(envelope.char_count, "answer char count")?;
        let duration_ms = optional_u64_to_i64(envelope.duration_ms, "answer duration")?;

        // `DATA-002`: one conflict-safe statement. It writes the envelope columns
        // and nothing else, so an evaluation that arrived first keeps its own
        // columns while its placeholder capture metadata is upgraded in place.
        // A replay with different envelope values matches no `WHERE` branch,
        // returns no row, and is a `Conflict` — the duplicate key never escapes.
        let mut remaining_attempts = ANSWER_ATTEMPT_UPSERT_ATTEMPTS;
        let inserted = loop {
            remaining_attempts -= 1;
            let mut tx = self.pool.begin().await.map_err(pg_error)?;
            // `DATA-004`: take the session row's shared lock before writing, so a
            // concurrent deletion is either fully before this transaction or refused
            // by it. Without it a writer that validated first could commit its
            // artifact after the purge had already run.
            Self::lock_open_session_shared(&mut tx, user_id, study_set_uuid, voice_session_uuid)
                .await?;
            let upserted = sqlx::query_scalar::<_, bool>(
                "INSERT INTO answer_attempts (
                    id,
                    voice_session_id,
                    response_id,
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
                    answer_digest_hmac,
                    transcript_status,
                    transcript_confidence_bucket,
                    pre_provider_state
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                 ON CONFLICT (voice_session_id, response_id) DO UPDATE
                 SET submission_sequence = EXCLUDED.submission_sequence,
                     idempotency_key = EXCLUDED.idempotency_key,
                     capture_mode = EXCLUDED.capture_mode,
                     byte_count = EXCLUDED.byte_count,
                     char_count = EXCLUDED.char_count,
                     duration_ms = EXCLUDED.duration_ms,
                     client_generation_id = EXCLUDED.client_generation_id,
                     locale = EXCLUDED.locale,
                     capture_status = EXCLUDED.capture_status,
                     answer_content_policy = EXCLUDED.answer_content_policy,
                     answer_digest_hmac = EXCLUDED.answer_digest_hmac,
                     transcript_status = EXCLUDED.transcript_status,
                     transcript_confidence_bucket = EXCLUDED.transcript_confidence_bucket,
                     pre_provider_state = EXCLUDED.pre_provider_state
                 WHERE answer_attempts.question_id = EXCLUDED.question_id
                   AND (
                       answer_attempts.pre_provider_state = 'evaluation_only_compat'
                       OR (
                           answer_attempts.submission_sequence = EXCLUDED.submission_sequence
                           AND answer_attempts.idempotency_key = EXCLUDED.idempotency_key
                           AND answer_attempts.capture_mode = EXCLUDED.capture_mode
                           AND answer_attempts.byte_count IS NOT DISTINCT FROM EXCLUDED.byte_count
                           AND answer_attempts.char_count IS NOT DISTINCT FROM EXCLUDED.char_count
                           AND answer_attempts.duration_ms IS NOT DISTINCT FROM EXCLUDED.duration_ms
                           AND answer_attempts.client_generation_id
                               IS NOT DISTINCT FROM EXCLUDED.client_generation_id
                           AND answer_attempts.locale IS NOT DISTINCT FROM EXCLUDED.locale
                           AND answer_attempts.capture_status = EXCLUDED.capture_status
                           AND answer_attempts.answer_content_policy
                               = EXCLUDED.answer_content_policy
                           AND answer_attempts.answer_digest_hmac
                               IS NOT DISTINCT FROM EXCLUDED.answer_digest_hmac
                           AND answer_attempts.transcript_status
                               IS NOT DISTINCT FROM EXCLUDED.transcript_status
                           AND answer_attempts.transcript_confidence_bucket
                               IS NOT DISTINCT FROM EXCLUDED.transcript_confidence_bucket
                           AND answer_attempts.pre_provider_state = EXCLUDED.pre_provider_state
                       )
                   )
                 RETURNING (xmax = '0'::xid) AS inserted",
            )
            .bind(Uuid::new_v4())
            .bind(voice_session_uuid)
            .bind(&envelope.response_id)
            .bind(&envelope.question_id)
            .bind(submission_sequence)
            .bind(&envelope.idempotency_key)
            .bind(envelope.capture_mode.as_str())
            .bind(byte_count)
            .bind(char_count)
            .bind(duration_ms)
            .bind(&envelope.client_generation_id)
            .bind(&envelope.locale)
            .bind(envelope.capture_status.as_str())
            .bind(envelope.content_policy.as_str())
            .bind(&envelope.answer_digest_hmac)
            .bind(&envelope.transcript_status)
            .bind(&envelope.transcript_confidence_bucket)
            .bind(&envelope.pre_provider_state)
            .fetch_optional(&mut *tx)
            .await;
            match upserted {
                Ok(Some(inserted)) => {
                    tx.commit().await.map_err(pg_error)?;
                    break inserted;
                }
                Ok(None) => {
                    tx.rollback().await.map_err(pg_error)?;
                    return Err(PortError::conflict(
                        "postgres",
                        &envelope.response_id,
                        "answer attempt envelope cannot be changed",
                    ));
                }
                Err(error) if is_unique_violation(&error) => {
                    // The statement aborted this transaction; nothing it did can
                    // commit, and the retry opens its own.
                    drop(tx);
                    if remaining_attempts == 0 {
                        return Err(duplicate_attempt_key_conflict(&envelope.response_id));
                    }
                }
                Err(error) => {
                    drop(tx);
                    return Err(pg_error(error));
                }
            }
        };
        if inserted {
            self.increment_count(WriteCountKind::AnswerAttempt);
        }

        Ok(json!({
            "voice_session_id": voice_session_id,
            "response_id": envelope.response_id,
            "question_id": envelope.question_id,
            "submission_sequence": envelope.submission_sequence,
            "capture_mode": envelope.capture_mode.as_str(),
            "capture_status": envelope.capture_status.as_str(),
            "answer_content_policy": envelope.content_policy.as_str(),
        }))
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError> {
        evaluation.validate_fail_closed().map_err(|reason| {
            PortError::invalid_input("postgres", &evaluation.question_id, reason)
        })?;
        let canonical = self
            .active_question_source(user_id, study_set_id, &evaluation.question_id)
            .await?;
        if canonical != evaluation.source {
            return Err(PortError::invalid_input(
                "postgres",
                &evaluation.question_id,
                "answer evaluation source tuple does not match active question source",
            ));
        }
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        self.ensure_active_question(study_set_uuid, &evaluation.question_id)
            .await?;
        let source_span_uuid = Self::uuid_for(&evaluation.source.source_id)?;
        // `DATA-002`: one conflict-safe statement replaces the old
        // check-then-insert. Two racing identical writes converge on one physical
        // row instead of one of them surfacing SQLSTATE 23505, and a divergent
        // replay under the same response identity matches no `WHERE` branch and
        // becomes a typed `Conflict` that leaves the committed tuple untouched.
        //
        // The guard's first branch is the envelope-first order (the evaluation
        // columns are still empty); its second is an identical replay. Together
        // with the envelope writer's compat upgrade, both interleavings converge
        // on the same complete tuple.
        //
        // `DATA-005`: the attempt row and the browser authorization digest commit
        // in one transaction, so authority can never exist for an evaluation that
        // was rolled back.
        let mut remaining_attempts = ANSWER_ATTEMPT_UPSERT_ATTEMPTS;
        let inserted = loop {
            remaining_attempts -= 1;
            let mut tx = self.pool.begin().await.map_err(pg_error)?;
            // `DATA-004`: take the session row's shared lock before writing, so a
            // concurrent deletion is either fully before this transaction or refused
            // by it. Without it a writer that validated first could commit its
            // artifact after the purge had already run.
            Self::lock_open_session_shared(&mut tx, user_id, study_set_uuid, voice_session_uuid)
                .await?;
            let upserted = sqlx::query_scalar::<_, bool>(
                "INSERT INTO answer_attempts (
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
                           answer_attempts.evaluation_label
                               IS NOT DISTINCT FROM EXCLUDED.evaluation_label
                           AND answer_attempts.concept_status
                               IS NOT DISTINCT FROM EXCLUDED.concept_status
                           AND answer_attempts.confidence_score
                               IS NOT DISTINCT FROM EXCLUDED.confidence_score
                           AND answer_attempts.source_span_id
                               IS NOT DISTINCT FROM EXCLUDED.source_span_id
                       )
                   )
                 RETURNING (xmax = '0'::xid) AS inserted",
            )
            .bind(Uuid::new_v4())
            .bind(voice_session_uuid)
            .bind(response_id)
            .bind(&evaluation.question_id)
            .bind(format!(
                "{voice_session_id}:{}:1:{response_id}:compat",
                evaluation.question_id
            ))
            .bind(&evaluation.label)
            .bind(concept_status_str(&evaluation.concept_status))
            .bind(f64::from(evaluation.confidence_score))
            .bind(source_span_uuid)
            .fetch_optional(&mut *tx)
            .await;
            match upserted {
                Ok(Some(inserted)) => {
                    Self::insert_event_authorization(
                        &mut tx,
                        user_id,
                        study_set_uuid,
                        voice_session_uuid,
                        response_id,
                        EventAuthorizationKind::AnswerEvaluation,
                        &evaluation,
                    )
                    .await?;
                    tx.commit().await.map_err(pg_error)?;
                    break inserted;
                }
                Ok(None) => {
                    tx.rollback().await.map_err(pg_error)?;
                    return Err(PortError::conflict(
                        "postgres",
                        response_id,
                        "answer evaluation does not match the persisted attempt for this response",
                    ));
                }
                Err(error) if is_unique_violation(&error) => {
                    // The statement aborted this transaction; nothing it did can
                    // commit, and the retry opens its own.
                    drop(tx);
                    if remaining_attempts == 0 {
                        return Err(duplicate_attempt_key_conflict(response_id));
                    }
                }
                Err(error) => {
                    drop(tx);
                    return Err(pg_error(error));
                }
            }
        };
        if inserted {
            self.increment_count(WriteCountKind::AnswerAttempt);
        }
        Ok(json!({
            "voice_session_id": voice_session_id,
            "question_id": evaluation.question_id,
            "evaluation_label": evaluation.label,
            "concept_status": concept_status_str(&evaluation.concept_status),
            "source_id": evaluation.source.source_id,
        }))
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let source_uuid = Self::uuid_for(source_id)?;
        let row = sqlx::query(
            "SELECT sp.id, sp.document_id, sp.locator, sp.excerpt, sp.confidence, sp.retrieval_reason
             FROM source_spans sp
             JOIN study_documents d ON d.id = sp.document_id
             JOIN study_sets s ON s.id = d.study_set_id
             WHERE sp.id = $1
               AND s.id = $2
               AND s.user_id = $3
               AND sp.deleted_at IS NULL
               AND d.deleted_at IS NULL",
        )
        .bind(source_uuid)
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let locator: Value = row.try_get("locator").map_err(pg_error)?;
        Ok(Some(StudySourceReference {
            source_id: Self::logical_id_for_uuid(row.try_get::<Uuid, _>("id").map_err(pg_error)?),
            document_id: Self::logical_id_for_uuid(
                row.try_get::<Uuid, _>("document_id").map_err(pg_error)?,
            ),
            span: locator
                .get("span")
                .and_then(Value::as_str)
                .unwrap_or("source span")
                .to_owned(),
            excerpt: row.try_get("excerpt").map_err(pg_error)?,
            confidence: source_confidence(
                row.try_get::<String, _>("confidence")
                    .map_err(pg_error)?
                    .as_str(),
            )?,
            retrieval_reason: row.try_get("retrieval_reason").map_err(pg_error)?,
        }))
    }

    async fn record_concept_status(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let concept_uuid = self.concept_uuid_for(study_set_uuid, concept_id).await?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let payload = ConceptStatusEventPayload {
            concept_id,
            status: &status,
        };
        let payload_digest = payload_sha256(
            "postgres",
            EventAuthorizationKind::ConceptStatus,
            response_id,
            &payload,
        )?;
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        // `DATA-004`: take the session row's shared lock before writing, so a
        // concurrent deletion is either fully before this transaction or refused by
        // it. Without it a writer that validated first could commit its artifact
        // after the purge had already run.
        Self::lock_open_session_shared(&mut tx, user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let event_insert = sqlx::query(
            "INSERT INTO concept_status_events (
                 user_id,
                 study_set_id,
                 voice_session_id,
                 response_id,
                 concept_id,
                 payload_sha256,
                 status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, study_set_id, voice_session_id, response_id, concept_id, payload_sha256)
             DO NOTHING",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(response_id)
        .bind(concept_uuid)
        .bind(&payload_digest)
        .bind(concept_status_str(&status))
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        if event_insert.rows_affected() == 0 {
            Self::insert_event_authorization(
                &mut tx,
                user_id,
                study_set_uuid,
                voice_session_uuid,
                response_id,
                EventAuthorizationKind::ConceptStatus,
                &payload,
            )
            .await?;
            tx.commit().await.map_err(pg_error)?;
            return Ok(status);
        }
        let result = sqlx::query(
            "UPDATE concepts SET status = $1, updated_at = NOW()
             WHERE id = $2
               AND study_set_id = $3
               AND EXISTS (
                   SELECT 1 FROM study_sets s
                   WHERE s.id = concepts.study_set_id AND s.user_id = $4
               )",
        )
        .bind(concept_status_str(&status))
        .bind(concept_uuid)
        .bind(study_set_uuid)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(pg_error)?;
            return Err(PortError::unavailable(
                "postgres",
                concept_id,
                "concept is not available for this study set",
            ));
        }
        Self::insert_event_authorization(
            &mut tx,
            user_id,
            study_set_uuid,
            voice_session_uuid,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )
        .await?;
        tx.commit().await.map_err(pg_error)?;
        self.increment_count(WriteCountKind::ConceptStatus);
        Ok(status)
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<Value, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let concept_uuid = self.concept_uuid_for(study_set_uuid, concept_id).await?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let result = sqlx::query(
            "INSERT INTO review_items (id, user_id, study_set_id, concept_id, due_at, reason, status, voice_session_id)
             VALUES ($1, $2, $3, $4, $5::timestamptz, 'voice_session', 'scheduled', $6)
             ON CONFLICT (user_id, study_set_id, voice_session_id, concept_id, due_at)
             WHERE status = 'scheduled' AND voice_session_id IS NOT NULL
             DO NOTHING",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(concept_uuid)
        .bind(due_at)
        .bind(voice_session_uuid)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            return Ok(
                json!({ "concept_id": concept_id, "due_at": due_at, "status": "scheduled" }),
            );
        }
        self.increment_count(WriteCountKind::ReviewItem);
        Ok(json!({ "concept_id": concept_id, "due_at": due_at, "status": "scheduled" }))
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        learning::review_scheduling_context(self, user_id, study_set_id, concept_id).await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: ReviewScheduleDecisionV1,
    ) -> Result<Value, PortError> {
        learning::persist_review_schedule_decision(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            concept_id,
            decision,
        )
        .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<Value, PortError> {
        if recap.voice_session_id != voice_session_id {
            return Err(PortError::invalid_input(
                "postgres",
                voice_session_id,
                "recap session does not match authorized session",
            ));
        }
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let mut source_span_ids = Vec::new();
        for moment in &recap.source_moments {
            self.source_reference(user_id, study_set_id, &moment.source_id)
                .await?
                .ok_or_else(|| {
                    PortError::unavailable(
                        "postgres",
                        moment.source_id.clone(),
                        "recap source reference unavailable",
                    )
                })?;
            source_span_ids.push(Self::uuid_for(&moment.source_id)?);
        }
        let buckets = recap_label_buckets(&recap);
        // `DATA-005`: the recap row and its browser authorization digest commit
        // together.
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        // `DATA-004`: take the session row's shared lock before writing, so a
        // concurrent deletion is either fully before this transaction or refused by
        // it. Without it a writer that validated first could commit its artifact
        // after the purge had already run.
        Self::lock_open_session_shared(&mut tx, user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let inserted = sqlx::query_scalar::<_, bool>(
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (user_id, study_set_id, voice_session_id) DO UPDATE
             SET strong_concepts = EXCLUDED.strong_concepts,
                 shaky_concepts = EXCLUDED.shaky_concepts,
                 missed_concepts = EXCLUDED.missed_concepts,
                 review_later = EXCLUDED.review_later,
                 source_span_ids = EXCLUDED.source_span_ids
             RETURNING (xmax = '0'::xid) AS inserted",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&buckets.strong)
        .bind(&buckets.shaky)
        .bind(&buckets.missed)
        .bind(&buckets.review_later)
        .bind(&source_span_ids)
        .fetch_one(&mut *tx)
        .await
        .map_err(pg_error)?;
        Self::insert_event_authorization(
            &mut tx,
            user_id,
            study_set_uuid,
            voice_session_uuid,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            &recap,
        )
        .await?;
        tx.commit().await.map_err(pg_error)?;
        if inserted {
            self.increment_count(WriteCountKind::Recap);
        }
        Ok(json!({
            "voice_session_id": voice_session_id,
            "strong_concepts": buckets.strong,
            "shaky_concepts": buckets.shaky,
            "missed_concepts": buckets.missed,
            "review_later": buckets.review_later,
            "source_span_ids": source_span_ids,
        }))
    }

    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        privacy::record_voice_usage(self, event).await
    }

    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        learning::record_turn_outcome(self, user_id, study_set_id, voice_session_id, outcome).await
    }

    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        learning::session_learning_evidence(self, user_id, study_set_id, voice_session_id).await
    }

    async fn record_challenge_resolution(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        resolution: ChallengeResolution,
    ) -> Result<ChallengeResolution, PortError> {
        learning::record_challenge_resolution(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            resolution,
        )
        .await
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        learning::select_next_question(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            policy,
        )
        .await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<AuthenticatedStudyProjectionV1, PortError> {
        learning::authenticated_study_projection(self, user_id, study_set_id, voice_session_id)
            .await
    }
}

fn row_string(row: &sqlx::postgres::PgRow, column: &'static str) -> Result<String, PortError> {
    row.try_get(column).map_err(pg_error)
}

/// `D-03B` selected quiz-only, so the enum has one variant and every stored row
/// reads back as it. There is no second mode to disagree about.
fn study_mode(_stored: &str) -> agent_domain::StudyMode {
    agent_domain::StudyMode::Quiz
}

/// `progression_json` holds the canonical cursor's own fields at the top level —
/// so the row's `revision` column and `progression_json.revision` are the same
/// field — plus the store-owned `applied_response_ids` replay set, which is not
/// part of Plan 04's published cursor.
fn progression_record_to_json(record: &QuestionProgressionRecord) -> Result<Value, PortError> {
    let mut value = serde_json::to_value(&record.cursor)
        .map_err(|error| json_invariant("question_progression_cursor_json", &error))?;
    let object = value.as_object_mut().ok_or_else(|| {
        PortError::internal(
            "postgres",
            "question_progression_cursor_json",
            "a serialized progression cursor is always a JSON object",
        )
    })?;
    object.insert(
        "applied_response_ids".to_owned(),
        serde_json::to_value(&record.applied_response_ids)
            .map_err(|error| json_invariant("question_progression_applied_ids", &error))?,
    );
    Ok(value)
}

fn progression_record_from_json(
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    mut value: Value,
) -> Result<QuestionProgressionRecord, PortError> {
    let object = value.as_object_mut().ok_or_else(|| {
        PortError::internal(
            "postgres",
            "question_progression_cursor_json",
            "a stored progression cursor is always a JSON object",
        )
    })?;
    let applied = object
        .remove("applied_response_ids")
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let applied_response_ids: Vec<String> = serde_json::from_value(applied)
        .map_err(|error| json_invariant("question_progression_applied_ids", &error))?;
    let cursor: QuestionProgressionCursor = serde_json::from_value(value)
        .map_err(|error| json_invariant("question_progression_cursor_json", &error))?;
    Ok(QuestionProgressionRecord {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        cursor,
        applied_response_ids,
    })
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, PortError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            PortError::unavailable("postgres", "<missing>", format!("{label} is required"))
        })
}

fn concept_status_str(status: &ConceptStatus) -> &'static str {
    match status {
        ConceptStatus::Strong => "strong",
        ConceptStatus::Shaky => "shaky",
        ConceptStatus::Missed => "missed",
        ConceptStatus::Review => "review",
    }
}

fn concept_status(value: &str) -> Result<ConceptStatus, PortError> {
    match value {
        "strong" => Ok(ConceptStatus::Strong),
        "shaky" => Ok(ConceptStatus::Shaky),
        "missed" => Ok(ConceptStatus::Missed),
        "review" => Ok(ConceptStatus::Review),
        other => Err(PortError::internal(
            "postgres",
            "concept_status",
            format!("unknown concept status `{other}`"),
        )),
    }
}

fn ingestion_status(value: &str) -> Result<StudySetIngestionStatus, PortError> {
    match value {
        "pending" => Ok(StudySetIngestionStatus::Pending),
        "processing" => Ok(StudySetIngestionStatus::Processing),
        "retry" => Ok(StudySetIngestionStatus::Retry),
        "ready" => Ok(StudySetIngestionStatus::Ready),
        "failed" => Ok(StudySetIngestionStatus::Failed),
        other => Err(PortError::internal(
            "postgres",
            "ingestion_status",
            format!("unknown ingestion status `{other}`"),
        )),
    }
}

fn source_confidence(value: &str) -> Result<agent_domain::SourceConfidence, PortError> {
    match value {
        "high" => Ok(agent_domain::SourceConfidence::High),
        "medium" => Ok(agent_domain::SourceConfidence::Medium),
        "low" => Ok(agent_domain::SourceConfidence::Low),
        other => Err(PortError::internal(
            "postgres",
            "source_confidence",
            format!("unknown source confidence `{other}`"),
        )),
    }
}

fn source_confidence_str(confidence: &agent_domain::SourceConfidence) -> &'static str {
    match confidence {
        agent_domain::SourceConfidence::High => "high",
        agent_domain::SourceConfidence::Medium => "medium",
        agent_domain::SourceConfidence::Low => "low",
    }
}

fn to_i64(value: u64, label: &str) -> Result<i64, PortError> {
    i64::try_from(value).map_err(|_| {
        PortError::invalid_input("postgres", label, format!("{label} exceeds BIGINT range"))
    })
}

fn count_to_usize(count: i64) -> Result<usize, PortError> {
    usize::try_from(count).map_err(|_| {
        PortError::internal(
            "postgres",
            "durable_counts",
            "durable count exceeds platform usize",
        )
    })
}

fn optional_u64_to_i64(value: Option<u64>, label: &str) -> Result<Option<i64>, PortError> {
    value.map(|value| to_i64(value, label)).transpose()
}

/// How many times one `answer_attempts` upsert may run before its duplicate key
/// is treated as a real conflict.
///
/// `DATA-002` requires concurrent envelope/evaluation writes to converge
/// "without a duplicate-key adapter error", and Task 4 states the same rule from
/// the other side: the statement "never leaks SQLSTATE 23505". Migration `0011`
/// puts *two* unique indexes on `answer_attempts`
/// (`answer_attempts_voice_session_response_id_idx` and
/// `answer_attempts_voice_session_idempotency_idx`) and one `ON CONFLICT` clause
/// arbitrates exactly one of them, so PostgreSQL raises a hard 23505 for a
/// collision on the other index — `ON CONFLICT` cannot absorb it.
///
/// Two different situations reach that error and they need different answers:
///
/// 1. Two identical concurrent writers. The loser's arbiter pre-check ran before
///    the winner's arbiter index tuple existed, so it inserted speculatively and
///    met the winner's idempotency tuple instead. The winner is committed by the
///    time the error is raised, so running the same statement again sees it
///    through the arbiter and takes the `DO UPDATE` branch. That is an idempotent
///    replay, not a fault.
/// 2. A different response claiming an already-committed idempotency key. Running
///    again cannot help; the caller conflicts with committed state.
///
/// One bounded retry separates them without a second arbiter, an advisory lock,
/// or a schema change: the first attempt absorbs the race, and a second identical
/// failure proves the collision is real and becomes a typed `Conflict`.
const ANSWER_ATTEMPT_UPSERT_ATTEMPTS: u32 = 2;

/// SQLSTATE 23505 — `unique_violation`. Read from the code, never from the
/// message text, so a translated or reworded server string cannot change the
/// adapter's decision.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "23505")
}

/// The stable answer for a real idempotency-key collision. The SQLSTATE and the
/// constraint name stay inside the adapter; callers see the same typed `Conflict`
/// they see for every other rejected replay.
fn duplicate_attempt_key_conflict(response_id: &str) -> PortError {
    PortError::conflict(
        "postgres",
        response_id,
        "answer attempt idempotency key is already claimed by another response",
    )
}

/// Every SQL/pool/transaction failure is a durability failure: the store could
/// not commit or could not answer, and nothing about the caller's request was
/// wrong. Plans 07/08 select retry policy from `PortErrorKind::Durability`, never
/// from this diagnostic text.
fn pg_error(error: sqlx::Error) -> PortError {
    PortError::durability("postgres", "sqlx", error.to_string())
}

/// Encoding an already-typed domain value, or decoding one this store itself
/// wrote, cannot fail for a caller reason; a failure here means the adapter's own
/// invariant broke.
fn json_invariant(id: &'static str, error: &serde_json::Error) -> PortError {
    PortError::internal("postgres", id, error.to_string())
}
