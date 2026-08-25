use std::{
    fmt::Write as _,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, RwLock,
    },
};

use agent_domain::{
    format_rfc3339_millis, AnswerAttemptEnvelope, AnswerEvaluation, ConceptStatus,
    CreateFileStudySet, CreatePasteStudySet, LibraryNextReviewSummary, LibrarySessionRecapSummary,
    LibrarySessionSummary, LibraryStudyDocumentSummary, LibraryStudySetSummary,
    PersistedFsrsCardV1, PortError, ReviewScheduleCapReasonV1, ReviewScheduleDecisionV1,
    ReviewSchedulingContextV1, SessionConfig, SessionTokenNonceClaim, StudyLibrarySnapshot,
    StudyMemoryStore, StudyQuestion, StudySessionDurableCounts, StudySessionRecap,
    StudySetIngestionRecord, StudySetIngestionStatus, StudySourceReference, StudyStoreBackend,
    StudyStoreCapabilities, StudyStoreWriteCounts, StudyStoreWriteOutcome, VoiceUsageRecord,
    VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    memory::{generate_file_study_set, generate_paste_study_set},
    recap_label_buckets, InMemoryStudyStore,
};

#[derive(Clone, Debug)]
pub struct PostgresStudyStore {
    pool: PgPool,
    counts: Arc<PostgresWriteCounters>,
    event_authorizations: Arc<RwLock<Vec<EventAuthorizationRecord>>>,
}

/// The published write counts, one lock-free counter per kind.
///
/// `DATA-002`/`DATA-010`: the previous `RwLock<StudyStoreWriteCounts>` made the
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EventAuthorizationKind {
    AnswerEvaluation,
    ConceptStatus,
    ReviewSchedule,
    StudySessionRecap,
}

impl EventAuthorizationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AnswerEvaluation => "answer_evaluation",
            Self::ConceptStatus => "concept_status",
            Self::ReviewSchedule => "review_schedule",
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

/// The replay-stable half of a scheduling outcome. Mirrors the in-memory store's
/// payload field-for-field so both backends agree on what counts as a replay: the
/// graded inputs, never the clock-derived schedule they produce.
#[derive(Serialize)]
struct ReviewScheduleEventPayload<'a> {
    concept_id: &'a str,
    policy_id: &'a str,
    status: &'a ConceptStatus,
    rating: u8,
    hint_count: Option<u32>,
    miss_count: Option<u32>,
}

impl<'a> ReviewScheduleEventPayload<'a> {
    fn new(concept_id: &'a str, decision: &'a ReviewScheduleDecisionV1) -> Self {
        Self {
            concept_id,
            policy_id: &decision.policy_id,
            status: &decision.status,
            rating: decision.rating,
            hint_count: decision.hint_count,
            miss_count: decision.miss_count,
        }
    }
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
        .map_err(|error| json_invariant("event_authorization_payload", &error))?;
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
            counts: Arc::new(PostgresWriteCounters::default()),
            event_authorizations: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Test seam: the ledger is private and is only ever consulted by membership, so
    /// nothing else can observe how many entries a replay leaves behind.
    #[cfg(test)]
    pub(crate) fn event_authorization_ledger_len(&self) -> usize {
        self.event_authorizations
            .read()
            .expect("event authorization lock poisoned")
            .len()
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
        let mut ledger = self
            .event_authorizations
            .write()
            .map_err(|_| lock_poisoned("event_authorizations"))?;
        // The ledger records that one authorized outcome was written, and it is only
        // ever consulted by membership. A replay writes nothing, so it must not
        // append a second entry either — which is what the in-memory backend already
        // does, and the two backends have to agree.
        if !ledger.contains(&record) {
            ledger.push(record);
        }
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
            .map_err(|_| lock_poisoned("event_authorizations"))?
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

    /// One counted write, after the row it counts is committed. Infallible by
    /// construction: see [`PostgresWriteCounters`].
    fn increment_count(&self, kind: WriteCountKind) {
        self.counts.increment(kind);
    }

    /// Locks every session row a deletion is about to mutate, in a stable order.
    ///
    /// `ORDER BY id` is the deadlock-avoidance rule: two deletions that touch
    /// overlapping session sets take the same row locks in the same sequence.
    async fn lock_sessions_for_deletion(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
    ) -> Result<(), PortError> {
        sqlx::query(
            "SELECT id
             FROM voice_sessions
             WHERE user_id = $1
               AND study_set_id = $2
             ORDER BY id
             FOR UPDATE",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .fetch_all(&mut **tx)
        .await
        .map_err(pg_error)?;
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

    /// The v1 decision already on record for one graded outcome, if any. The lookup key
    /// is the scope plus `(response_id, payload_sha256)` — deliberately not the
    /// computed `due_at`, which moves with the clock on every replay.
    ///
    /// Takes the executor so the replay read can run inside the same transaction, and
    /// behind the same advisory lock, as the write it guards.
    async fn persisted_review_schedule_decision<'e, E>(
        executor: E,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        concept_uuid: Uuid,
        response_id: &str,
        payload_sha256: &str,
    ) -> Result<Option<ReviewScheduleDecisionV1>, PortError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        sqlx::query_scalar::<_, Value>(
            "SELECT schedule_decision FROM review_items
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND concept_id = $4
               AND status = 'scheduled'
               AND schedule_schema_version = 1
               AND schedule_response_id = $5
               AND schedule_payload_sha256 = $6
             ORDER BY schedule_generated_at ASC
             LIMIT 1",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(concept_uuid)
        .bind(response_id)
        .bind(payload_sha256)
        .fetch_optional(executor)
        .await
        .map_err(pg_error)?
        .map(|value| {
            serde_json::from_value::<ReviewScheduleDecisionV1>(value)
                .map_err(|error| json_invariant("review_schedule_decision_json", &error))
        })
        .transpose()
    }
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
            PortError::invalid_input(
                "postgres",
                &claim.nonce,
                "session token expiry exceeds postgres bigint",
            )
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
            .map_err(|_| lock_poisoned("event_authorizations"))?
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
        let exam_at = crate::ingestion_exam_instant("postgres", input.exam_date.as_deref())?;
        let generated = generate_paste_study_set(input)?;
        let study_set_uuid = Self::uuid_for(&generated.study_set.id)?;
        let mut tx = self.pool.begin().await.map_err(pg_error)?;

        sqlx::query(
            "INSERT INTO study_sets (
                 id, user_id, title, course, ingestion_status, ingestion_error, exam_at, exam_date
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, ($7 AT TIME ZONE 'UTC')::date)",
        )
        .bind(study_set_uuid)
        .bind(&generated.study_set.user_id)
        .bind(&generated.study_set.title)
        .bind(&generated.study_set.course)
        .bind(generated.study_set.ingestion_status.as_str())
        .bind(&generated.study_set.ingestion_error)
        .bind(exam_at)
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
        let exam_at = crate::ingestion_exam_instant("postgres", input.exam_date.as_deref())?;
        let generated = generate_file_study_set(input)?;
        let study_set_uuid = Self::uuid_for(&generated.study_set.id)?;
        let mut tx = self.pool.begin().await.map_err(pg_error)?;

        sqlx::query(
            "INSERT INTO study_sets (
                 id, user_id, title, course, ingestion_status, ingestion_error, exam_at, exam_date
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, ($7 AT TIME ZONE 'UTC')::date)",
        )
        .bind(study_set_uuid)
        .bind(&generated.study_set.user_id)
        .bind(&generated.study_set.title)
        .bind(&generated.study_set.course)
        .bind(generated.study_set.ingestion_status.as_str())
        .bind(&generated.study_set.ingestion_error)
        .bind(exam_at)
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
        let exam_at = crate::ingestion_exam_instant("postgres", input.exam_date.as_deref())?;
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
        // A retry re-ingests the file; it never re-asks the learner for the exam
        // date, and the production retry route always sends none. Writing that
        // absence verbatim would erase the only authoritative input D-01's exam cap
        // has, so an absent exam date leaves the recorded instant untouched — the
        // same rule title and course already follow.
        sqlx::query(
            "UPDATE study_sets
             SET title = $2,
                 course = $3,
                 ingestion_status = $4,
                 ingestion_error = $5,
                 exam_at = COALESCE($6, exam_at),
                 exam_date = COALESCE(($6 AT TIME ZONE 'UTC')::date, exam_date)
             WHERE id = $1",
        )
        .bind(study_set_uuid)
        .bind(&generated.study_set.title)
        .bind(&generated.study_set.course)
        .bind(generated.study_set.ingestion_status.as_str())
        .bind(&generated.study_set.ingestion_error)
        .bind(exam_at)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;

        Self::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

        tx.commit().await.map_err(pg_error)?;
        self.event_authorizations
            .write()
            .map_err(|_| lock_poisoned("event_authorizations"))?
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

    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Value, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        self.ensure_study_set(user_id, study_set_uuid).await?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        // `DATA-010`: take every affected session row lock, in `id` order, before
        // any status mutation or artifact removal. A concurrent usage write is
        // then either fully before this transaction or fully refused by it.
        Self::lock_sessions_for_deletion(&mut tx, user_id, study_set_uuid).await?;
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
            "DELETE FROM concept_status_events
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
            .map_err(|_| lock_poisoned("event_authorizations"))?
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
        // `DATA-010`: same session-row lock the usage writer takes, before any
        // status mutation or artifact removal.
        sqlx::query("SELECT id FROM voice_sessions WHERE id = $1 FOR UPDATE")
            .bind(voice_session_uuid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(pg_error)?;
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
            "DELETE FROM concept_status_events
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
            .map_err(|_| lock_poisoned("event_authorizations"))?
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
        let question_id: String = row.try_get("question_id").map_err(pg_error)?;
        let prompt: String = row.try_get("prompt").map_err(pg_error)?;
        let source_id =
            Self::logical_id_for_uuid(row.try_get::<Uuid, _>("source_id").map_err(pg_error)?);
        Ok(Some(StudyQuestion {
            concept_id: crate::generated_question_concept_id(&question_id),
            rubric: crate::generated_question_rubric(&question_id, &prompt, &source_id),
            question_id,
            prompt,
            expected_terms: row.try_get("expected_terms").map_err(pg_error)?,
            follow_up: row.try_get("follow_up").map_err(pg_error)?,
            source: StudySourceReference {
                source_id,
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
            return Err(PortError::invalid_input(
                "postgres",
                &question.question_id,
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
        evaluation.validate_fail_closed().map_err(|reason| {
            PortError::invalid_input("postgres", &evaluation.question_id, reason)
        })?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;
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
            return Err(PortError::conflict(
                "postgres",
                response_id,
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
            return Err(PortError::conflict(
                "postgres",
                response_id,
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
            return Err(PortError::invalid_input(
                "postgres",
                &source.source_id,
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
            return Err(PortError::conflict(
                "postgres",
                response_id,
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
        for moment in &recap.source_moments {
            // The v2 recap moment carries only the response and source identity, so
            // deterministic retrieval is proven by resolving that source id against
            // this tenant's own spans; there is no client-supplied tuple left to
            // disagree with.
            self.source_reference(user_id, study_set_id, &moment.source_id)
                .await?
                .ok_or_else(|| {
                    PortError::unavailable(
                        "postgres",
                        moment.source_id.clone(),
                        "recap source reference unavailable",
                    )
                })?;
        }
        if !self.has_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            recap,
        )? {
            return Err(PortError::conflict(
                "postgres",
                response_id,
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
        let inserted = sqlx::query_scalar::<_, bool>(
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
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(inserted) = inserted else {
            return Err(PortError::conflict(
                "postgres",
                &envelope.response_id,
                "answer attempt envelope cannot be changed",
            ));
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
        let inserted = sqlx::query_scalar::<_, bool>(
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
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?;
        let Some(inserted) = inserted else {
            return Err(PortError::conflict(
                "postgres",
                response_id,
                "answer evaluation does not match the persisted attempt for this response",
            ));
        };
        if inserted {
            self.increment_count(WriteCountKind::AnswerAttempt);
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
        let payload_digest =
            payload_sha256(EventAuthorizationKind::ConceptStatus, response_id, &payload)?;
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
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
            tx.commit().await.map_err(pg_error)?;
            self.record_event_authorization(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                EventAuthorizationKind::ConceptStatus,
                &payload,
            )?;
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
        tx.commit().await.map_err(pg_error)?;
        self.increment_count(WriteCountKind::ConceptStatus);
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
        self.increment_count(WriteCountKind::ReviewItem);
        Ok(json!({ "concept_id": concept_id, "due_at": due_at, "status": "scheduled" }))
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let concept_uuid = self.concept_uuid_for(study_set_uuid, concept_id).await?;

        // D-01: the exam instant is authoritative store context, never a tool
        // argument, and it is compared as the exact stored UTC instant. The legacy
        // `study_sets.exam_date` DATE (migration 0001) is never read here: reading a
        // calendar day as midnight UTC is exactly the rounding D-01's UTC rule
        // forbids, and it would silently move every capped due date.
        let exam_at = sqlx::query_scalar::<sqlx::Postgres, Option<DateTime<Utc>>>(
            "SELECT exam_at
             FROM study_sets
             WHERE id = $1 AND user_id = $2",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?
        .flatten();

        let card = sqlx::query_scalar::<sqlx::Postgres, Value>(
            "SELECT schedule_card
             FROM review_items
             WHERE user_id = $1
               AND study_set_id = $2
               AND concept_id = $3
               AND status = 'scheduled'
               AND schedule_schema_version = 1
               AND schedule_card IS NOT NULL
             ORDER BY schedule_generated_at DESC, id DESC
             LIMIT 1",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(concept_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?
        .map(|value| {
            serde_json::from_value::<PersistedFsrsCardV1>(value)
                .map_err(|error| json_invariant("persisted_fsrs_card_json", &error))
        })
        .transpose()?;

        Ok(ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at,
            card,
        })
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
        decision
            .validate()
            .map_err(|error| PortError::invalid_input("postgres", concept_id, error.to_string()))?;

        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let concept_uuid = self.concept_uuid_for(study_set_uuid, concept_id).await?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;

        let payload = ReviewScheduleEventPayload::new(concept_id, &decision);
        let payload_digest = payload_sha256(
            EventAuthorizationKind::ReviewSchedule,
            response_id,
            &payload,
        )?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;

        // Serialize every schedule write for this concept in this session. Without
        // it the replay read below and the insert are two statements with a gap: two
        // racers both read nothing and both insert. `ON CONFLICT` cannot close that
        // gap, because a single statement has exactly one arbiter and the two guards
        // need different ones — under the D-01 exam cap every decision for a concept
        // clamps to the *same* `due_at`, so the racer lands on migration 0012's
        // due-date index, takes `DO UPDATE`, counts a second review write and
        // overwrites the authoritative first decision. A hash collision between two
        // different keys can only make an unrelated pair serialize; it can never make
        // this guard wrong.
        let replay_lock_key = format!(
            "viva.review_schedule:{user_id}:{study_set_uuid}:{voice_session_uuid}:{concept_uuid}"
        );
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&replay_lock_key)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;

        // A replay reads a later clock and so recomputes a different `due_at`; keying
        // the guard on the schedule would let it write a second scheduled review and
        // advance the persisted FSRS card. The first decision for this graded outcome
        // stays authoritative and is what the caller reports back.
        if let Some(persisted) = Self::persisted_review_schedule_decision(
            &mut *tx,
            user_id,
            study_set_uuid,
            voice_session_uuid,
            concept_uuid,
            response_id,
            &payload_digest,
        )
        .await?
        {
            tx.commit().await.map_err(pg_error)?;
            self.record_event_authorization(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                EventAuthorizationKind::ReviewSchedule,
                &payload,
            )?;
            return Ok(persisted.public_summary(concept_id));
        }

        let decision_json = serde_json::to_value(&decision)
            .map_err(|error| json_invariant("review_schedule_decision_json", &error))?;
        let card_json = serde_json::to_value(&decision.card)
            .map_err(|error| json_invariant("persisted_fsrs_card_json", &error))?;
        let cap_reason = decision.cap_reason.map(|reason| match reason {
            ReviewScheduleCapReasonV1::ExamMargin => "exam_margin",
            ReviewScheduleCapReasonV1::PastExam => "past_exam",
        });

        // One statement: the due date and the versioned decision/card land together
        // or neither does. `review_items_schedule_response_replay_idx` (migration 0015)
        // is the belt-and-braces backstop behind the advisory lock, and its unique
        // violation routes back through the same read.
        let inserted = sqlx::query(
            "INSERT INTO review_items (
                 id, user_id, study_set_id, concept_id, due_at, reason, status, voice_session_id,
                 schedule_schema_version, schedule_policy_id, schedule_decision, schedule_card,
                 schedule_generated_at, schedule_cap_reason, schedule_response_id,
                 schedule_payload_sha256
             )
             VALUES (
                 $1, $2, $3, $4, $5, 'voice_session', 'scheduled', $6, 1, $7, $8, $9, $10, $11,
                 $12, $13
             )
             ON CONFLICT (user_id, study_set_id, voice_session_id, concept_id, due_at)
             WHERE status = 'scheduled' AND voice_session_id IS NOT NULL
             DO UPDATE SET
                 schedule_schema_version = EXCLUDED.schedule_schema_version,
                 schedule_policy_id = EXCLUDED.schedule_policy_id,
                 schedule_decision = EXCLUDED.schedule_decision,
                 schedule_card = EXCLUDED.schedule_card,
                 schedule_generated_at = EXCLUDED.schedule_generated_at,
                 schedule_cap_reason = EXCLUDED.schedule_cap_reason,
                 schedule_response_id = EXCLUDED.schedule_response_id,
                 schedule_payload_sha256 = EXCLUDED.schedule_payload_sha256
             WHERE review_items.schedule_decision IS DISTINCT FROM EXCLUDED.schedule_decision",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(concept_uuid)
        .bind(decision.due_at)
        .bind(voice_session_uuid)
        .bind(&decision.policy_id)
        .bind(&decision_json)
        .bind(&card_json)
        .bind(decision.generated_at)
        .bind(cap_reason)
        .bind(response_id)
        .bind(&payload_digest)
        .execute(&mut *tx)
        .await;

        let result = match inserted {
            Ok(result) => {
                tx.commit().await.map_err(pg_error)?;
                result
            }
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                // A concurrent replay won the race. Report what it persisted; never
                // let this call become a second scheduled review. The unique
                // violation has already aborted this transaction, so the re-read runs
                // on a fresh connection.
                tx.rollback().await.map_err(pg_error)?;
                let persisted = Self::persisted_review_schedule_decision(
                    &self.pool,
                    user_id,
                    study_set_uuid,
                    voice_session_uuid,
                    concept_uuid,
                    response_id,
                    &payload_digest,
                )
                .await?
                .ok_or_else(|| {
                    PortError::conflict(
                        "postgres",
                        response_id,
                        "review schedule write conflicted with an unrelated scheduled row",
                    )
                })?;
                self.record_event_authorization(
                    user_id,
                    study_set_id,
                    voice_session_id,
                    response_id,
                    EventAuthorizationKind::ReviewSchedule,
                    &payload,
                )?;
                return Ok(persisted.public_summary(concept_id));
            }
            Err(error) => return Err(pg_error(error)),
        };

        if result.rows_affected() > 0 {
            self.increment_count(WriteCountKind::ReviewItem);
        }
        self.record_event_authorization(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ReviewSchedule,
            &payload,
        )?;
        Ok(decision.public_summary(concept_id))
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
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        if inserted {
            self.increment_count(WriteCountKind::Recap);
        }
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
        let voice_session_uuid = event
            .voice_session_id
            .as_deref()
            .map(Self::uuid_for)
            .transpose()?;
        // `DATA-010`: the status read and the insert are one transaction, and the
        // read takes the session row's `FOR UPDATE` lock that both deletion paths
        // also take. That leaves exactly two serial orders — usage commits and
        // deletion then removes it, or deletion commits and usage observes
        // `deleted` and writes nothing — and no interleaving in which a usage row
        // outlives the deletion.
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        if let Some(voice_session_uuid) = voice_session_uuid {
            let status = sqlx::query_scalar::<_, String>(
                "SELECT status
                 FROM voice_sessions
                 WHERE id = $1
                 FOR UPDATE",
            )
            .bind(voice_session_uuid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(pg_error)?;
            if status.as_deref() == Some("deleted") {
                // No row was written, so neither write outcome is true here. The
                // typed contract makes that sayable: a usage event aimed at a
                // deleted session lost to deletion.
                tx.commit().await.map_err(pg_error)?;
                return Err(PortError::conflict(
                    "postgres",
                    event.voice_session_id.as_deref().unwrap_or("unknown"),
                    "voice session was deleted before usage could be recorded",
                ));
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
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        tx.commit().await.map_err(pg_error)?;
        // Usage records carry no stable event identity, so an accepted write is
        // always a real insert; Plan 09 never reports a usage replay it cannot
        // identify. The count moves only after the commit succeeded.
        self.increment_count(WriteCountKind::VoiceUsage);
        Ok(StudyStoreWriteOutcome::Inserted)
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

/// Every SQL/pool/transaction failure is a durability failure: the store could
/// not commit or could not answer, and nothing about the caller's request was
/// wrong. Plans 07/08 select retry policy from `PortErrorKind::Durability`, never
/// from this diagnostic text.
fn pg_error(error: sqlx::Error) -> PortError {
    PortError::durability("postgres", "sqlx", error.to_string())
}

/// A poisoned process-local lock is a broken adapter invariant, not a caller
/// error and not a storage failure.
fn lock_poisoned(lock: &'static str) -> PortError {
    PortError::internal("postgres", lock, "postgres store lock poisoned")
}

/// Encoding an already-typed domain value, or decoding one this store itself
/// wrote, cannot fail for a caller reason; a failure here means the adapter's own
/// invariant broke.
fn json_invariant(id: &'static str, error: &serde_json::Error) -> PortError {
    PortError::internal("postgres", id, error.to_string())
}
