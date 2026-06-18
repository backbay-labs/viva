use std::{
    fmt::Write as _,
    sync::{Arc, RwLock},
};

use agent_domain::{
    AnswerEvaluation, ConceptStatus, CreatePasteStudySet, PortError, SessionConfig,
    StudyMemoryStore, StudyQuestion, StudySessionRecap, StudySetIngestionRecord,
    StudySourceReference, StudyStoreBackend, StudyStoreCapabilities, StudyStoreWriteCounts,
    VoiceUsageRecord,
};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{memory::generate_paste_study_set, InMemoryStudyStore};

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
                  AND aa.question_id = $4
                  AND aa.evaluation_label = $5
                  AND aa.concept_status = $6
                  AND ABS(aa.confidence_score - $7) <= 0.000001
                  AND aa.source_span_id = $8
             )",
        )
        .bind(voice_session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
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

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<Value, PortError> {
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let result = sqlx::query(
            "UPDATE voice_sessions
             SET status = 'closed',
                 ended_at = COALESCE(ended_at, NOW()),
                 terminal_reason = $2
             WHERE id = $1",
        )
        .bind(voice_session_uuid)
        .bind(terminal_reason)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            return Err(PortError::unavailable(
                "postgres",
                voice_session_id,
                "voice session does not exist",
            ));
        }
        self.event_authorizations
            .write()
            .map_err(|_| PortError::adapter("postgres", "event authorization lock poisoned"))?
            .retain(|record| record.voice_session_id != voice_session_id);
        Ok(json!({
            "voice_session_id": voice_session_id,
            "status": "closed",
            "terminal_reason": terminal_reason,
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
            .answer_evaluation_was_recorded(user_id, study_set_uuid, voice_session_uuid, evaluation)
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
        sqlx::query(
            "INSERT INTO answer_attempts (id, voice_session_id, question_id, evaluation_label, concept_status, confidence_score, source_span_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(Uuid::new_v4())
        .bind(voice_session_uuid)
        .bind(&evaluation.question_id)
        .bind(&evaluation.label)
        .bind(concept_status_str(&evaluation.concept_status))
        .bind(f64::from(evaluation.confidence_score))
        .bind(source_span_uuid)
        .execute(&self.pool)
        .await
        .map_err(pg_error)?;
        self.increment_count(WriteCountKind::AnswerAttempt)?;
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
        let payload = ConceptStatusEventPayload {
            concept_id,
            status: &status,
        };
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
            "INSERT INTO review_items (id, user_id, study_set_id, concept_id, due_at, reason, status)
             SELECT $1, $2, $3, $4, $5::timestamptz, 'voice_session', 'scheduled'
             WHERE EXISTS (
                 SELECT 1 FROM concepts c
                 JOIN study_sets s ON s.id = c.study_set_id
                 WHERE c.id = $4 AND c.study_set_id = $3 AND s.user_id = $2
             )",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(concept_uuid)
        .bind(due_at)
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

fn pg_error(error: sqlx::Error) -> PortError {
    PortError::adapter("postgres", error.to_string())
}
