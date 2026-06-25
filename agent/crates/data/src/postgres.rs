use std::{
    fmt::Write as _,
    sync::{Arc, RwLock},
};

use agent_domain::{
    AnswerAttemptEnvelope, AnswerEvaluation, ConceptStatus, CreateFileStudySet,
    CreatePasteStudySet, LibraryNextReviewSummary, LibrarySessionRecapSummary,
    LibrarySessionSummary, LibraryStudyDocumentSummary, LibraryStudySetSummary, PortError,
    SessionConfig, SessionTokenNonceClaim, StudyLibrarySnapshot, StudyMemoryStore, StudyQuestion,
    StudySessionRecap, StudySetIngestionRecord, StudySetIngestionStatus, StudySourceReference,
    StudyStoreBackend, StudyStoreCapabilities, StudyStoreWriteCounts, VoiceUsageRecord,
};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    memory::{generate_file_study_set, generate_paste_study_set},
    InMemoryStudyStore,
};

#[derive(Clone, Debug)]
pub struct PostgresStudyStore {
    pool: PgPool,
    counts: Arc<RwLock<StudyStoreWriteCounts>>,
    event_authorizations: Arc<RwLock<Vec<EventAuthorizationRecord>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EventAuthorizationKind {
    AnswerEvaluation,
    ConceptStatus,
    StudySessionRecap,
}

impl EventAuthorizationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AnswerEvaluation => "answer_evaluation",
            Self::ConceptStatus => "concept_status",
            Self::StudySessionRecap => "study_session_recap",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EventAuthorizationRecord {
    user_id: String,
    study_set_id: String,
    voice_session_id: String,
    response_id: String,
    kind: EventAuthorizationKind,
    payload_sha256: String,
}

#[derive(Serialize)]
struct ConceptStatusEventPayload<'a> {
    concept_id: &'a str,
    status: &'a ConceptStatus,
}

fn event_authorization_record<T: Serialize>(
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    kind: EventAuthorizationKind,
    payload: &T,
) -> Result<EventAuthorizationRecord, PortError> {
    Ok(EventAuthorizationRecord {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        response_id: response_id.to_owned(),
        kind,
        payload_sha256: payload_sha256(kind, response_id, payload)?,
    })
}

fn payload_sha256<T: Serialize>(
    kind: EventAuthorizationKind,
    response_id: &str,
    payload: &T,
) -> Result<String, PortError> {
    let payload = serde_json::to_vec(payload)
        .map_err(|error| PortError::adapter("postgres", error.to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(kind.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(response_id.as_bytes());
    hasher.update([0]);
    hasher.update(payload);
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    Ok(encoded)
}

impl PostgresStudyStore {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            counts: Arc::new(RwLock::new(StudyStoreWriteCounts::default())),
            event_authorizations: Arc::new(RwLock::new(Vec::new())),
        }
    }

    fn record_event_authorization<T: Serialize>(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        kind: EventAuthorizationKind,
        payload: &T,
    ) -> Result<(), PortError> {
        let record = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            kind,
            payload,
        )?;
        self.event_authorizations
            .write()
            .map_err(|_| PortError::adapter("postgres", "event authorization lock poisoned"))?
            .push(record);
        Ok(())
    }

    fn has_event_authorization<T: Serialize>(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        kind: EventAuthorizationKind,
        payload: &T,
    ) -> Result<bool, PortError> {
        let record = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            kind,
            payload,
        )?;
        Ok(self
            .event_authorizations
            .read()
            .map_err(|_| PortError::adapter("postgres", "event authorization lock poisoned"))?
            .contains(&record))
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
        match uuid.to_string().as_str() {
            "11111111-1111-4111-8111-111111111111" => "biology-midterm".to_owned(),
            "22222222-2222-4222-8222-222222222222" => "lec-5".to_owned(),
            "33333333-3333-4333-8333-333333333333" => "src-lecture-5-slide-18".to_owned(),
            "44444444-4444-4444-8444-444444444444" => "voice-session-1".to_owned(),
            _ => uuid.to_string(),
        }
    }

    async fn insert_ingestion_artifacts(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        generated: &StudySetIngestionRecord,
        study_set_uuid: Uuid,
    ) -> Result<(), PortError> {
        for document in &generated.documents {
            sqlx::query(
                "INSERT INTO study_documents (id, study_set_id, display_name, source_kind, processing_status, deleted_at)
                 VALUES ($1, $2, $3, $4, $5, NULL)",
            )
            .bind(Self::uuid_for(&document.id)?)
            .bind(study_set_uuid)
            .bind(&document.display_name)
            .bind(&document.source_kind)
            .bind(document.processing_status.as_str())
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        for source in &generated.source_spans {
            sqlx::query(
                "INSERT INTO source_spans (
                    id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, NULL)",
            )
            .bind(Self::uuid_for(&source.id)?)
            .bind(Self::uuid_for(&source.document_id)?)
            .bind(&source.locator)
            .bind(&source.excerpt)
            .bind(source_confidence_str(&source.confidence))
            .bind(&source.retrieval_reason)
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        for concept in &generated.concepts {
            sqlx::query(
                "INSERT INTO concepts (id, study_set_id, label, status, source_span_id, public_id)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&concept.label)
            .bind(concept_status_str(&concept.status))
            .bind(Self::uuid_for(&concept.source_span_id)?)
            .bind(&concept.public_id)
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        for question in &generated.questions {
            sqlx::query(
                "INSERT INTO study_questions (
                    id, study_set_id, question_id, source_span_id, prompt, expected_terms, follow_up, active
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&question.question_id)
            .bind(Self::uuid_for(&question.source.source_id)?)
            .bind(&question.prompt)
            .bind(&question.expected_terms)
            .bind(&question.follow_up)
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        Ok(())
    }

    fn increment_count(&self, kind: WriteCountKind) -> Result<(), PortError> {
        let mut counts = self
            .counts
            .write()
            .map_err(|_| PortError::adapter("postgres", "write count lock poisoned"))?;
        match kind {
            WriteCountKind::Session => counts.sessions += 1,
            WriteCountKind::AnswerAttempt => counts.answer_attempts += 1,
            WriteCountKind::ConceptStatus => counts.concept_statuses += 1,
            WriteCountKind::ReviewItem => counts.review_items += 1,
            WriteCountKind::Recap => counts.recaps += 1,
        }
        Ok(())
    }

    async fn ensure_study_set(&self, user_id: &str, study_set_uuid: Uuid) -> Result<(), PortError> {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM study_sets
                WHERE id = $1 AND user_id = $2
             )",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        if exists {
            return Ok(());
        }
        Err(PortError::unavailable(
            "postgres",
            study_set_uuid.to_string(),
            "study set is not available for this user",
        ))
    }

    async fn ensure_session(
        &self,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
    ) -> Result<(), PortError> {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM voice_sessions
                WHERE id = $1
                  AND user_id = $2
                  AND study_set_id = $3
                  AND status = 'open'
             )",
        )
        .bind(voice_session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        if exists {
            return Ok(());
        }
        Err(PortError::unavailable(
            "postgres",
            voice_session_uuid.to_string(),
            "voice session is not available for this user and study set",
        ))
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

    async fn recap_was_recorded(
        &self,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        recap: &StudySessionRecap,
        source_span_ids: &[Uuid],
    ) -> Result<bool, PortError> {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1
                FROM session_recaps
                WHERE user_id = $1
                  AND study_set_id = $2
                  AND voice_session_id = $3
                  AND strong_concepts = $4
                  AND shaky_concepts = $5
                  AND missed_concepts = $6
                  AND review_later = $7
                  AND source_span_ids = $8
             )",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&recap.strong_concepts)
        .bind(&recap.shaky_concepts)
        .bind(&recap.missed_concepts)
        .bind(&recap.review_later)
        .bind(source_span_ids)
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

#[derive(Clone, Copy, Debug)]
enum WriteCountKind {
    Session,
    AnswerAttempt,
    ConceptStatus,
    ReviewItem,
    Recap,
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
        self.counts
            .read()
            .expect("postgres write count lock poisoned")
            .clone()
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
            PortError::adapter("postgres", "pending answer attempt count overflowed usize")
        })
    }

    async fn record_voice_session(&self, config: &SessionConfig) -> Result<(), PortError> {
        let session_id = required(config.session_id.as_deref(), "session_id")?;
        let user_id = required(config.user_id.as_deref(), "user_id")?;
        let study_set_id = required(config.study_set_id.as_deref(), "study_set_id")?;
        let session_uuid = Self::uuid_for(session_id)?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        self.ensure_study_set(user_id, study_set_uuid).await?;
        let mode = config.mode.clone().unwrap_or_default();
        let result = sqlx::query(
            "INSERT INTO voice_sessions (id, user_id, study_set_id, mode, status)
             VALUES ($1, $2, $3, $4, 'open')
             ON CONFLICT (id) DO UPDATE
             SET mode = EXCLUDED.mode
             WHERE voice_sessions.user_id = EXCLUDED.user_id
               AND voice_sessions.study_set_id = EXCLUDED.study_set_id
               AND voice_sessions.status = 'open'",
        )
        .bind(session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(mode.as_str())
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            return Err(PortError::adapter(
                "postgres",
                "voice session cannot be reopened or ownership changed",
            ));
        }
        self.increment_count(WriteCountKind::Session)?;
        Ok(())
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        let study_set_uuid = Self::uuid_for(&claim.study_set_id)?;
        let voice_session_uuid = Self::uuid_for(&claim.voice_session_id)?;
        self.ensure_study_set(&claim.user_id, study_set_uuid)
            .await?;
        let result = sqlx::query(
            "INSERT INTO voice_session_token_nonces
                (user_id, study_set_id, voice_session_id, nonce, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING",
        )
        .bind(&claim.user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&claim.nonce)
        .bind(i64::try_from(claim.expires_at).map_err(|_| {
            PortError::adapter("postgres", "session token expiry exceeds postgres bigint")
        })?)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            return Err(PortError::unavailable(
                "postgres",
                format!(
                    "{}/{}/{}",
                    claim.user_id, claim.study_set_id, claim.voice_session_id
                ),
                "session token nonce already used",
            ));
        }
        Ok(())
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<Value, PortError> {
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
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
        .fetch_optional(&self.pool)
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
            .fetch_optional(&self.pool)
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
        self.event_authorizations
            .write()
            .map_err(|_| PortError::adapter("postgres", "event authorization lock poisoned"))?
            .retain(|record| record.voice_session_id != voice_session_id);
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
        let generated = generate_paste_study_set(input)?;
        let study_set_uuid = Self::uuid_for(&generated.study_set.id)?;
        let mut tx = self.pool.begin().await.map_err(pg_error)?;

        sqlx::query(
            "INSERT INTO study_sets (id, user_id, title, course, ingestion_status, ingestion_error)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(study_set_uuid)
        .bind(&generated.study_set.user_id)
        .bind(&generated.study_set.title)
        .bind(&generated.study_set.course)
        .bind(generated.study_set.ingestion_status.as_str())
        .bind(&generated.study_set.ingestion_error)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;

        for document in &generated.documents {
            sqlx::query(
                "INSERT INTO study_documents (id, study_set_id, display_name, source_kind, processing_status, deleted_at)
                 VALUES ($1, $2, $3, $4, $5, NULL)",
            )
            .bind(Self::uuid_for(&document.id)?)
            .bind(study_set_uuid)
            .bind(&document.display_name)
            .bind(&document.source_kind)
            .bind(document.processing_status.as_str())
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        }

        for source in &generated.source_spans {
            sqlx::query(
                "INSERT INTO source_spans (
                    id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, NULL)",
            )
            .bind(Self::uuid_for(&source.id)?)
            .bind(Self::uuid_for(&source.document_id)?)
            .bind(&source.locator)
            .bind(&source.excerpt)
            .bind(source_confidence_str(&source.confidence))
            .bind(&source.retrieval_reason)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        }

        for concept in &generated.concepts {
            sqlx::query(
                "INSERT INTO concepts (id, study_set_id, label, status, source_span_id, public_id)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&concept.label)
            .bind(concept_status_str(&concept.status))
            .bind(Self::uuid_for(&concept.source_span_id)?)
            .bind(&concept.public_id)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        }

        for question in &generated.questions {
            sqlx::query(
                "INSERT INTO study_questions (
                    id, study_set_id, question_id, source_span_id, prompt, expected_terms, follow_up, active
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&question.question_id)
            .bind(Self::uuid_for(&question.source.source_id)?)
            .bind(&question.prompt)
            .bind(&question.expected_terms)
            .bind(&question.follow_up)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        }

        tx.commit().await.map_err(pg_error)?;
        Ok(generated)
    }

    async fn create_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        let generated = generate_file_study_set(input)?;
        let study_set_uuid = Self::uuid_for(&generated.study_set.id)?;
        let mut tx = self.pool.begin().await.map_err(pg_error)?;

        sqlx::query(
            "INSERT INTO study_sets (id, user_id, title, course, ingestion_status, ingestion_error)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(study_set_uuid)
        .bind(&generated.study_set.user_id)
        .bind(&generated.study_set.title)
        .bind(&generated.study_set.course)
        .bind(generated.study_set.ingestion_status.as_str())
        .bind(&generated.study_set.ingestion_error)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;

        Self::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

        tx.commit().await.map_err(pg_error)?;
        Ok(generated)
    }

    async fn retry_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        let study_set_id = input
            .study_set_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                PortError::unavailable("postgres", "file_retry", "study_set_id is required")
            })?
            .to_owned();
        let study_set_uuid = Self::uuid_for(&study_set_id)?;
        let row =
            sqlx::query("SELECT title, course FROM study_sets WHERE id = $1 AND user_id = $2")
                .bind(study_set_uuid)
                .bind(&input.user_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(pg_error)?
                .ok_or_else(|| {
                    PortError::unavailable(
                        "postgres",
                        format!("{}/{}", input.user_id, study_set_id),
                        "study set is not available for this user",
                    )
                })?;
        let generated = generate_file_study_set(CreateFileStudySet {
            user_id: input.user_id,
            study_set_id: Some(study_set_id),
            title: row.try_get("title").map_err(pg_error)?,
            course: row.try_get("course").map_err(pg_error)?,
            exam_date: input.exam_date,
            file_name: input.file_name,
            content_type: input.content_type,
            file_bytes: input.file_bytes,
            session_id: input.session_id,
        })?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        sqlx::query("DELETE FROM study_questions WHERE study_set_id = $1")
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        sqlx::query("DELETE FROM concepts WHERE study_set_id = $1")
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM source_spans sp
             USING study_documents d
             WHERE sp.document_id = d.id AND d.study_set_id = $1",
        )
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query("DELETE FROM study_documents WHERE study_set_id = $1")
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        sqlx::query(
            "UPDATE study_sets
             SET title = $2, course = $3, ingestion_status = $4, ingestion_error = $5
             WHERE id = $1",
        )
        .bind(study_set_uuid)
        .bind(&generated.study_set.title)
        .bind(&generated.study_set.course)
        .bind(generated.study_set.ingestion_status.as_str())
        .bind(&generated.study_set.ingestion_error)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;

        Self::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

        tx.commit().await.map_err(pg_error)?;
        self.event_authorizations
            .write()
            .map_err(|_| PortError::adapter("postgres", "event authorization lock poisoned"))?
            .retain(|record| record.study_set_id != generated.study_set.id);
        Ok(generated)
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
             WHERE s.id = $1 AND s.user_id = $2",
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
                    PortError::adapter("postgres", "concept count exceeds usize range")
                })?,
                question_count: usize::try_from(question_count).map_err(|_| {
                    PortError::adapter("postgres", "question count exceeds usize range")
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

            let next_review = sqlx::query(
                "SELECT
                    COALESCE(c.public_id, c.id::text) AS concept_id,
                    c.label,
                    c.status,
                    ri.due_at::text AS persisted_due_at
                 FROM review_items ri
                 JOIN concepts c ON c.id = ri.concept_id
                 WHERE ri.user_id = $1
                   AND ri.study_set_id = $2
                   AND ri.status = 'scheduled'
                   AND ri.voice_session_id = $3
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
                let status_value: String = review_row.try_get("status")?;
                Ok::<_, sqlx::Error>((review_row, status_value))
            })
            .transpose()
            .map_err(pg_error)?
            .map(|(review_row, status_value)| {
                Ok::<_, PortError>(LibraryNextReviewSummary {
                    concept_id: review_row.try_get("concept_id").map_err(pg_error)?,
                    label: review_row.try_get("label").map_err(pg_error)?,
                    status: concept_status(&status_value)?,
                    persisted_due_at: review_row.try_get("persisted_due_at").map_err(pg_error)?,
                    source: "persisted_review_item".to_owned(),
                })
            })
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

    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Value, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        self.ensure_study_set(user_id, study_set_uuid).await?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        let deleted_source_spans = sqlx::query(
            "UPDATE source_spans sp
             SET deleted_at = COALESCE(sp.deleted_at, NOW())
             FROM study_documents d
             WHERE sp.document_id = d.id
               AND d.study_set_id = $1
               AND sp.deleted_at IS NULL",
        )
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?
        .rows_affected();
        let deleted_documents = sqlx::query(
            "UPDATE study_documents
             SET deleted_at = COALESCE(deleted_at, NOW())
             WHERE study_set_id = $1 AND deleted_at IS NULL",
        )
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?
        .rows_affected();
        let disabled_questions = sqlx::query(
            "UPDATE study_questions
             SET active = FALSE
             WHERE study_set_id = $1 AND active",
        )
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?
        .rows_affected();
        let hidden_sessions = sqlx::query(
            "UPDATE voice_sessions
             SET status = 'deleted',
                 terminal_reason = 'deleted',
                 ended_at = COALESCE(ended_at, NOW())
             WHERE user_id = $1
               AND study_set_id = $2
               AND status <> 'deleted'",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?
        .rows_affected();

        sqlx::query(
            "DELETE FROM session_recaps
             WHERE user_id = $1 AND study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM review_items
             WHERE user_id = $1 AND study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM answer_attempts aa
             USING voice_sessions vs
             WHERE aa.voice_session_id = vs.id
               AND vs.user_id = $1
               AND vs.study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM voice_usage_events vue
             USING voice_sessions vs
             WHERE vue.voice_session_id = vs.id
               AND vs.user_id = $1
               AND vs.study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM voice_session_token_nonces
             WHERE user_id = $1 AND study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;

        tx.commit().await.map_err(pg_error)?;
        self.event_authorizations
            .write()
            .map_err(|_| PortError::adapter("postgres", "authorization lock poisoned"))?
            .retain(|record| record.user_id != user_id || record.study_set_id != study_set_id);

        Ok(json!({
            "study_set_id": study_set_id,
            "status": "deleted",
            "deleted_documents": deleted_documents,
            "deleted_source_spans": deleted_source_spans,
            "disabled_questions": disabled_questions,
            "hidden_sessions": hidden_sessions,
        }))
    }

    async fn delete_session_history(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<Value, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let owner = sqlx::query(
            "SELECT user_id, study_set_id
             FROM voice_sessions
             WHERE id = $1",
        )
        .bind(voice_session_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?
        .ok_or_else(|| {
            PortError::unavailable("postgres", voice_session_id, "voice session does not exist")
        })?;
        let owner_user_id: String = owner.try_get("user_id").map_err(pg_error)?;
        let owner_study_set_id: Uuid = owner.try_get("study_set_id").map_err(pg_error)?;
        if owner_user_id != user_id || owner_study_set_id != study_set_uuid {
            return Err(PortError::unavailable(
                "postgres",
                voice_session_id,
                "voice session is not available for this user and study set",
            ));
        }

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        sqlx::query(
            "UPDATE voice_sessions
             SET status = 'deleted',
                 terminal_reason = 'deleted',
                 ended_at = COALESCE(ended_at, NOW())
             WHERE id = $1",
        )
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM session_recaps
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM review_items
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query("DELETE FROM answer_attempts WHERE voice_session_id = $1")
            .bind(voice_session_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        sqlx::query("DELETE FROM voice_usage_events WHERE voice_session_id = $1")
            .bind(voice_session_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM voice_session_token_nonces
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        tx.commit().await.map_err(pg_error)?;

        self.event_authorizations
            .write()
            .map_err(|_| PortError::adapter("postgres", "authorization lock poisoned"))?
            .retain(|record| {
                record.user_id != user_id
                    || record.study_set_id != study_set_id
                    || record.voice_session_id != voice_session_id
            });

        Ok(json!({
            "voice_session_id": voice_session_id,
            "study_set_id": study_set_id,
            "status": "deleted",
        }))
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let row = sqlx::query(
            "SELECT
                q.question_id,
                q.prompt,
                q.expected_terms,
                q.follow_up,
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
               AND s.ingestion_status = 'ready'
               AND q.active
               AND d.study_set_id = q.study_set_id
               AND sp.deleted_at IS NULL
               AND d.deleted_at IS NULL
             ORDER BY q.created_at ASC
             LIMIT 1",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let locator: Value = row.try_get("locator").map_err(pg_error)?;
        Ok(Some(StudyQuestion {
            question_id: row.try_get("question_id").map_err(pg_error)?,
            prompt: row.try_get("prompt").map_err(pg_error)?,
            expected_terms: row.try_get("expected_terms").map_err(pg_error)?,
            follow_up: row.try_get("follow_up").map_err(pg_error)?,
            source: StudySourceReference {
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
            },
        }))
    }

    async fn authorize_question_started(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let canonical = self
            .active_question(user_id, study_set_id)
            .await?
            .ok_or_else(|| {
                PortError::unavailable(
                    "postgres",
                    &question.question_id,
                    "question is not active for this study set",
                )
            })?;
        if canonical != *question {
            return Err(PortError::adapter(
                "postgres",
                "question tuple does not match deterministic retrieval",
            ));
        }
        Ok(())
    }

    async fn authorize_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: &AnswerEvaluation,
    ) -> Result<(), PortError> {
        evaluation
            .validate_fail_closed()
            .map_err(|reason| PortError::adapter("postgres", reason))?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let canonical = self
            .active_question_source(user_id, study_set_id, &evaluation.question_id)
            .await?;
        if canonical != evaluation.source {
            return Err(PortError::adapter(
                "postgres",
                "answer evaluation source tuple does not match active question source",
            ));
        }
        if !self
            .answer_evaluation_was_recorded(
                user_id,
                study_set_uuid,
                voice_session_uuid,
                response_id,
                evaluation,
            )
            .await?
        {
            return Err(PortError::adapter(
                "postgres",
                "answer evaluation event does not match persisted answer attempt",
            ));
        }
        if !self.has_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::AnswerEvaluation,
            evaluation,
        )? {
            return Err(PortError::adapter(
                "postgres",
                "answer evaluation event does not match authorized browser payload",
            ));
        }
        Ok(())
    }

    async fn authorize_source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        source: &StudySourceReference,
    ) -> Result<(), PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let canonical = self
            .source_reference(user_id, study_set_id, &source.source_id)
            .await?
            .ok_or_else(|| {
                PortError::unavailable(
                    "postgres",
                    source.source_id.clone(),
                    "source reference unavailable",
                )
            })?;
        if canonical != *source {
            return Err(PortError::adapter(
                "postgres",
                "source tuple does not match deterministic retrieval",
            ));
        }
        Ok(())
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
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        self.concept_uuid_for(study_set_uuid, concept_id).await?;
        let payload = ConceptStatusEventPayload { concept_id, status };
        if !self.has_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )? {
            return Err(PortError::adapter(
                "postgres",
                "concept status event does not match authorized browser payload",
            ));
        }
        Ok(())
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &agent_domain::ManuscriptIntent,
    ) -> Result<(), PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        match intent {
            agent_domain::ManuscriptIntent::Scene { .. } => Ok(()),
            agent_domain::ManuscriptIntent::Entity {
                entity_id,
                entity_kind,
                ..
            } => match entity_kind {
                agent_domain::ManuscriptEntityKind::Concept => {
                    self.concept_uuid_for(study_set_uuid, entity_id).await?;
                    Ok(())
                }
                agent_domain::ManuscriptEntityKind::Source => self
                    .source_reference(user_id, study_set_id, entity_id)
                    .await?
                    .map(|_| ())
                    .ok_or_else(|| {
                        PortError::unavailable(
                            "postgres",
                            entity_id,
                            "source entity is not available for this study set",
                        )
                    }),
                agent_domain::ManuscriptEntityKind::MarginalNote => Err(PortError::unavailable(
                    "postgres",
                    entity_id,
                    "marginal note entity is not server-owned",
                )),
            },
            agent_domain::ManuscriptIntent::Marginalia {
                anchor_entity_id, ..
            } => {
                if self
                    .concept_uuid_for(study_set_uuid, anchor_entity_id)
                    .await
                    .is_ok()
                    || self
                        .source_reference(user_id, study_set_id, anchor_entity_id)
                        .await?
                        .is_some()
                {
                    return Ok(());
                }
                Err(PortError::unavailable(
                    "postgres",
                    anchor_entity_id,
                    "marginalia anchor is not available for this study set",
                ))
            }
        }
    }

    async fn authorize_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: &StudySessionRecap,
    ) -> Result<(), PortError> {
        if recap.voice_session_id != voice_session_id {
            return Err(PortError::adapter(
                "postgres",
                "recap session does not match authorized session",
            ));
        }
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let mut source_span_ids = Vec::new();
        for moment in &recap.source_moments {
            let canonical = self
                .source_reference(user_id, study_set_id, &moment.source.source_id)
                .await?
                .ok_or_else(|| {
                    PortError::unavailable(
                        "postgres",
                        moment.source.source_id.clone(),
                        "recap source reference unavailable",
                    )
                })?;
            if canonical != moment.source {
                return Err(PortError::adapter(
                    "postgres",
                    "recap source tuple does not match deterministic retrieval",
                ));
            }
            source_span_ids.push(Self::uuid_for(&moment.source.source_id)?);
        }
        if !self
            .recap_was_recorded(
                user_id,
                study_set_uuid,
                voice_session_uuid,
                recap,
                &source_span_ids,
            )
            .await?
        {
            return Err(PortError::adapter(
                "postgres",
                "recap event does not match persisted session recap",
            ));
        }
        if !self.has_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            recap,
        )? {
            return Err(PortError::adapter(
                "postgres",
                "recap event does not match authorized browser payload",
            ));
        }
        Ok(())
    }

    async fn record_answer_attempt_envelope(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<Value, PortError> {
        envelope
            .validate_fail_closed()
            .map_err(|reason| PortError::adapter("postgres", reason))?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        self.active_question_source(user_id, study_set_id, &envelope.question_id)
            .await?;
        let submission_sequence = i32::try_from(envelope.submission_sequence).map_err(|_| {
            PortError::adapter(
                "postgres",
                "answer submission sequence exceeds postgres integer",
            )
        })?;
        let byte_count = optional_u64_to_i64(envelope.byte_count, "answer byte count")?;
        let char_count = optional_u64_to_i64(envelope.char_count, "answer char count")?;
        let duration_ms = optional_u64_to_i64(envelope.duration_ms, "answer duration")?;

        let inserted = sqlx::query(
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
             ON CONFLICT (voice_session_id, response_id) DO NOTHING",
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
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if inserted.rows_affected() == 0 {
            let matches = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1
                    FROM answer_attempts
                    WHERE voice_session_id = $1
                      AND response_id = $2
                      AND question_id = $3
                      AND submission_sequence = $4
                      AND idempotency_key = $5
                      AND capture_mode = $6
                      AND byte_count IS NOT DISTINCT FROM $7
                      AND char_count IS NOT DISTINCT FROM $8
                      AND duration_ms IS NOT DISTINCT FROM $9
                      AND client_generation_id IS NOT DISTINCT FROM $10
                      AND locale IS NOT DISTINCT FROM $11
                      AND capture_status = $12
                      AND answer_content_policy = $13
                      AND answer_digest_hmac IS NOT DISTINCT FROM $14
                      AND transcript_status IS NOT DISTINCT FROM $15
                      AND transcript_confidence_bucket IS NOT DISTINCT FROM $16
                      AND pre_provider_state = $17
                )",
            )
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
            .fetch_one(&self.pool)
            .await
            .map_err(pg_error)?;
            if !matches {
                return Err(PortError::adapter(
                    "postgres",
                    "answer attempt envelope cannot be changed",
                ));
            }
        } else {
            self.increment_count(WriteCountKind::AnswerAttempt)?;
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
        evaluation
            .validate_fail_closed()
            .map_err(|reason| PortError::adapter("postgres", reason))?;
        let canonical = self
            .active_question_source(user_id, study_set_id, &evaluation.question_id)
            .await?;
        if canonical != evaluation.source {
            return Err(PortError::adapter(
                "postgres",
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
        let updated = sqlx::query(
            "UPDATE answer_attempts
             SET evaluation_label = $1,
                 concept_status = $2,
                 confidence_score = $3,
                 source_span_id = $4
             WHERE voice_session_id = $5
               AND response_id = $6
               AND question_id = $7",
        )
        .bind(&evaluation.label)
        .bind(concept_status_str(&evaluation.concept_status))
        .bind(f64::from(evaluation.confidence_score))
        .bind(source_span_uuid)
        .bind(voice_session_uuid)
        .bind(response_id)
        .bind(&evaluation.question_id)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if updated.rows_affected() == 0 {
            let existing_response = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1 FROM answer_attempts
                    WHERE voice_session_id = $1 AND response_id = $2
                )",
            )
            .bind(voice_session_uuid)
            .bind(response_id)
            .fetch_one(&self.pool)
            .await
            .map_err(pg_error)?;
            if existing_response {
                return Err(PortError::adapter(
                    "postgres",
                    "answer evaluation question does not match persisted attempt envelope",
                ));
            }
            sqlx::query(
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
                 VALUES ($1, $2, $3, $4, 1, $5, 'typed', 'accepted', 'none', 'evaluation_only_compat', $6, $7, $8, $9)",
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
            .execute(&self.pool)
            .await
            .map_err(pg_error)?;
            self.increment_count(WriteCountKind::AnswerAttempt)?;
        }
        self.record_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::AnswerEvaluation,
            &evaluation,
        )?;
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
        if self.has_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )? {
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
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            return Err(PortError::unavailable(
                "postgres",
                concept_id,
                "concept is not available for this study set",
            ));
        }
        self.increment_count(WriteCountKind::ConceptStatus)?;
        self.record_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )?;
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
        self.increment_count(WriteCountKind::ReviewItem)?;
        Ok(json!({ "concept_id": concept_id, "due_at": due_at, "status": "scheduled" }))
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
            return Err(PortError::adapter(
                "postgres",
                "recap session does not match authorized session",
            ));
        }
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
        let mut source_span_ids = Vec::new();
        for moment in &recap.source_moments {
            let canonical = self
                .source_reference(user_id, study_set_id, &moment.source.source_id)
                .await?
                .ok_or_else(|| {
                    PortError::unavailable(
                        "postgres",
                        moment.source.source_id.clone(),
                        "recap source reference unavailable",
                    )
                })?;
            if canonical != moment.source {
                return Err(PortError::adapter(
                    "postgres",
                    "recap source tuple does not match deterministic retrieval",
                ));
            }
            source_span_ids.push(Self::uuid_for(&moment.source.source_id)?);
        }
        if self
            .recap_was_recorded(
                user_id,
                study_set_uuid,
                voice_session_uuid,
                &recap,
                &source_span_ids,
            )
            .await?
        {
            self.record_event_authorization(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                EventAuthorizationKind::StudySessionRecap,
                &recap,
            )?;
            return Ok(json!({
                "voice_session_id": voice_session_id,
                "strong_concepts": recap.strong_concepts,
                "shaky_concepts": recap.shaky_concepts,
                "missed_concepts": recap.missed_concepts,
                "review_later": recap.review_later,
                "source_span_ids": source_span_ids,
            }));
        }
        sqlx::query(
            "INSERT INTO session_recaps (id, user_id, study_set_id, voice_session_id, strong_concepts, shaky_concepts, missed_concepts, review_later, source_span_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&recap.strong_concepts)
        .bind(&recap.shaky_concepts)
        .bind(&recap.missed_concepts)
        .bind(&recap.review_later)
        .bind(&source_span_ids)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        self.increment_count(WriteCountKind::Recap)?;
        self.record_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            &recap,
        )?;
        Ok(json!({
            "voice_session_id": voice_session_id,
            "strong_concepts": recap.strong_concepts,
            "shaky_concepts": recap.shaky_concepts,
            "missed_concepts": recap.missed_concepts,
            "review_later": recap.review_later,
            "source_span_ids": source_span_ids,
        }))
    }

    async fn record_voice_usage(&self, event: VoiceUsageRecord) -> Result<(), PortError> {
        let voice_session_uuid = event
            .voice_session_id
            .as_deref()
            .map(Self::uuid_for)
            .transpose()?;
        if let Some(voice_session_uuid) = voice_session_uuid {
            let deleted = sqlx::query_scalar::<_, bool>(
                "SELECT status = 'deleted' FROM voice_sessions WHERE id = $1",
            )
            .bind(voice_session_uuid)
            .fetch_optional(&self.pool)
            .await
            .map_err(pg_error)?
            .unwrap_or(false);
            if deleted {
                return Ok(());
            }
        }
        sqlx::query(
            "INSERT INTO voice_usage_events (
                id,
                voice_session_id,
                provider,
                model,
                duration_seconds,
                text_input_tokens,
                text_output_tokens,
                audio_input_tokens,
                audio_output_tokens,
                cost_estimate_usd,
                first_audio_latency_ms,
                answer_eval_latency_ms,
                source_retrieval_latency_ms,
                source_grounded_correction_count
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(Uuid::new_v4())
        .bind(voice_session_uuid)
        .bind(event.provider)
        .bind(event.model)
        .bind(to_i64(event.duration_seconds, "duration_seconds")?)
        .bind(to_i64(event.text_input_tokens, "text_input_tokens")?)
        .bind(to_i64(event.text_output_tokens, "text_output_tokens")?)
        .bind(to_i64(event.audio_input_tokens, "audio_input_tokens")?)
        .bind(to_i64(event.audio_output_tokens, "audio_output_tokens")?)
        .bind(event.cost_estimate_usd)
        .bind(
            event
                .first_audio_latency_ms
                .map(|value| to_i64(value, "first_audio_latency_ms"))
                .transpose()?,
        )
        .bind(
            event
                .answer_eval_latency_ms
                .map(|value| to_i64(value, "answer_eval_latency_ms"))
                .transpose()?,
        )
        .bind(
            event
                .source_retrieval_latency_ms
                .map(|value| to_i64(value, "source_retrieval_latency_ms"))
                .transpose()?,
        )
        .bind(to_i64(
            event.source_grounded_correction_count,
            "source_grounded_correction_count",
        )?)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        Ok(())
    }
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
        other => Err(PortError::adapter(
            "postgres",
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
        other => Err(PortError::adapter(
            "postgres",
            format!("unknown ingestion status `{other}`"),
        )),
    }
}

fn source_confidence(value: &str) -> Result<agent_domain::SourceConfidence, PortError> {
    match value {
        "high" => Ok(agent_domain::SourceConfidence::High),
        "medium" => Ok(agent_domain::SourceConfidence::Medium),
        "low" => Ok(agent_domain::SourceConfidence::Low),
        other => Err(PortError::adapter(
            "postgres",
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
    i64::try_from(value)
        .map_err(|_| PortError::adapter("postgres", format!("{label} exceeds BIGINT range")))
}

fn optional_u64_to_i64(value: Option<u64>, label: &str) -> Result<Option<i64>, PortError> {
    value.map(|value| to_i64(value, label)).transpose()
}

fn pg_error(error: sqlx::Error) -> PortError {
    PortError::adapter("postgres", error.to_string())
}
