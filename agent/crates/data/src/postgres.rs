use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use agent_domain::{
    format_rfc3339_millis,
    learning_outcome::VIVA_TURN_OUTCOME_RECORD_SCHEMA,
    learning_recap::{ConceptLabel, SessionLearningEvidence},
    parse_utc_instant,
    study_projection::{StudyProjectionConceptV1, StudyProjectionQuestionProgressV1,
        StudyProjectionReviewItemV1, StudyProjectionSessionV1, StudyProjectionStudySetV1,
        StudyProjectionVersionV1},
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
        generate_file_study_set, generate_paste_study_set, last_reviewed_at, payload_sha256,
        projection_active_question, require_selected_progression_policy, review_schedule_summaries,
        turn_outcome_disposition, turn_outcome_transitions, validate_challenge_resolution,
        validate_turn_outcome, ConceptStatusEventPayload, EventAuthorizationKind,
        QuestionProgressionRecord, ReviewScheduleEventPayload,
    },
    recap_label_buckets, InMemoryStudyStore,
};

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

    /// Records that one browser payload was authorized, in the same transaction
    /// as the domain row it authorizes.
    ///
    /// `DATA-005`: the digest and its authoritative write commit together or roll
    /// back together, so authority can never outlive — or precede — the record it
    /// belongs to. There is no process-local shadow cache: a durable store that
    /// keeps one loses every authorization on restart and shows none of them to a
    /// second instance, which is the same thing as having no authorization at all
    /// on a two-instance deployment.
    ///
    /// The table stores no raw event JSON; the digest is still learner-derived,
    /// so session close and both privacy deletions remove it.
    async fn insert_event_authorization<T: Serialize>(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        response_id: &str,
        kind: EventAuthorizationKind,
        payload: &T,
    ) -> Result<(), PortError> {
        let digest = payload_sha256("postgres", kind, response_id, payload)?;
        sqlx::query(
            "INSERT INTO event_authorization_digests (
                 user_id,
                 study_set_id,
                 voice_session_id,
                 response_id,
                 event_kind,
                 payload_sha256
             )
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(response_id)
        .bind(kind.as_str())
        .bind(&digest)
        .execute(&mut **tx)
        .await
        .map_err(pg_error)?;
        Ok(())
    }

    /// An exact match on all six key fields. Five of six is not authorization.
    async fn has_event_authorization<T: Serialize>(
        &self,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        response_id: &str,
        kind: EventAuthorizationKind,
        payload: &T,
    ) -> Result<bool, PortError> {
        let digest = payload_sha256("postgres", kind, response_id, payload)?;
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                 SELECT 1
                 FROM event_authorization_digests
                 WHERE user_id = $1
                   AND study_set_id = $2
                   AND voice_session_id = $3
                   AND response_id = $4
                   AND event_kind = $5
                   AND payload_sha256 = $6
             )",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(response_id)
        .bind(kind.as_str())
        .bind(&digest)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)
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
            // One ordinal per question, allocated in the same transaction as the
            // question it numbers. `created_at` cannot do this job: two questions
            // written by one statement share it, and the order Plan 04's ordered
            // progression walks has to be the order they were committed in.
            let ordinal = sqlx::query_scalar::<_, i64>(
                "INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
                 VALUES ($1, 2)
                 ON CONFLICT (study_set_id) DO UPDATE
                 SET next_ordinal = study_question_ingestion_cursors.next_ordinal + 1
                 RETURNING next_ordinal - 1 AS allocated_ordinal",
            )
            .bind(study_set_uuid)
            .fetch_one(&mut **tx)
            .await
            .map_err(pg_error)?;
            sqlx::query(
                "INSERT INTO study_questions (
                    id, study_set_id, question_id, source_span_id, prompt, expected_terms,
                    follow_up, active, ingestion_ordinal, concept_id, rubric_json
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $10)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&question.question_id)
            .bind(Self::uuid_for(&question.source.source_id)?)
            .bind(&question.prompt)
            .bind(&question.expected_terms)
            .bind(&question.follow_up)
            .bind(ordinal)
            .bind(&question.concept_id)
            .bind(
                serde_json::to_value(&question.rubric)
                    .map_err(|error| json_invariant("study_question_rubric_json", &error))?,
            )
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        Ok(())
    }


    /// Locks exactly the tenant-owned open session row for the rest of `tx`.
    ///
    /// `DATA-010`: every learner-data mutation that must not outlive a deletion
    /// takes this lock inside its own transaction, and both deletion paths take
    /// the same lock before they mutate status or remove artifacts. That leaves
    /// only two serial orders — write-then-delete, or delete-then-refuse — and no
    /// interleaving in which a late learning artifact survives the deletion.
    async fn lock_open_session(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
    ) -> Result<(), PortError> {
        let locked = sqlx::query_scalar::<_, Uuid>(
            "SELECT id
             FROM voice_sessions
             WHERE id = $1
               AND user_id = $2
               AND study_set_id = $3
               AND status = 'open'
             FOR UPDATE",
        )
        .bind(voice_session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .fetch_optional(&mut **tx)
        .await
        .map_err(pg_error)?;
        if locked.is_some() {
            return Ok(());
        }
        Err(PortError::unavailable(
            "postgres",
            voice_session_uuid.to_string(),
            "voice session is not available for this user and study set",
        ))
    }

    /// A session evidence and projections may still be read from: owned by this
    /// tenant and not deleted.
    async fn ensure_readable_session(
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
                  AND status <> 'deleted'
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

    fn study_question_from_row(row: &sqlx::postgres::PgRow) -> Result<StudyQuestion, PortError> {
        let locator: Value = row.try_get("locator").map_err(pg_error)?;
        let rubric: Value = row.try_get("rubric_json").map_err(pg_error)?;
        Ok(StudyQuestion {
            question_id: row.try_get("question_id").map_err(pg_error)?,
            concept_id: row.try_get("concept_id").map_err(pg_error)?,
            prompt: row.try_get("prompt").map_err(pg_error)?,
            expected_terms: row.try_get("expected_terms").map_err(pg_error)?,
            follow_up: row.try_get("follow_up").map_err(pg_error)?,
            rubric: serde_json::from_value(rubric)
                .map_err(|error| json_invariant("study_question_rubric_json", &error))?,
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
        })
    }

    const ACTIVE_QUESTION_SELECT: &'static str = "SELECT
             q.question_id,
             q.concept_id,
             q.prompt,
             q.expected_terms,
             q.follow_up,
             q.rubric_json,
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
           AND q.active
           AND d.study_set_id = q.study_set_id
           AND sp.deleted_at IS NULL
           AND d.deleted_at IS NULL
         ORDER BY q.ingestion_ordinal ASC, q.question_id ASC";

    /// The set's active questions in committed ingestion order.
    ///
    /// `ingestion_ordinal` is allocated once per question when it is written, so
    /// the order is the order the questions were committed in — not `created_at`,
    /// which two questions written in the same statement can share.
    async fn active_questions<'e, E>(
        executor: E,
        study_set_uuid: Uuid,
    ) -> Result<Vec<StudyQuestion>, PortError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        let rows = sqlx::query(Self::ACTIVE_QUESTION_SELECT)
            .bind(study_set_uuid)
            .fetch_all(executor)
            .await
            .map_err(pg_error)?;
        rows.iter().map(Self::study_question_from_row).collect()
    }

    /// Every canonical outcome this session recorded, in the published order.
    async fn session_turn_outcomes<'e, E>(
        executor: E,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
    ) -> Result<Vec<TurnOutcome>, PortError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        sqlx::query_scalar::<_, Value>(
            "SELECT outcome_json
             FROM learning_turn_outcomes
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
             ORDER BY recorded_at ASC, response_id ASC",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .fetch_all(executor)
        .await
        .map_err(pg_error)?
        .into_iter()
        .map(|value| {
            serde_json::from_value::<TurnOutcome>(value)
                .map_err(|error| json_invariant("learning_turn_outcome_json", &error))
        })
        .collect()
    }

    /// Every v1 decision this session persisted, paired with its concept's public
    /// id.
    async fn session_review_decisions<'e, E>(
        executor: E,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
    ) -> Result<Vec<(String, ReviewScheduleDecisionV1)>, PortError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        let rows = sqlx::query(
            "SELECT COALESCE(c.public_id, c.id::text) AS concept_public_id,
                    r.schedule_decision
             FROM review_items r
             JOIN concepts c ON c.id = r.concept_id
             WHERE r.user_id = $1
               AND r.study_set_id = $2
               AND r.voice_session_id = $3
               AND r.status = 'scheduled'
               AND r.schedule_schema_version = 1
               AND r.schedule_decision IS NOT NULL",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .fetch_all(executor)
        .await
        .map_err(pg_error)?;
        rows.into_iter()
            .map(|row| {
                let concept_id: String = row.try_get("concept_public_id").map_err(pg_error)?;
                let decision: Value = row.try_get("schedule_decision").map_err(pg_error)?;
                serde_json::from_value::<ReviewScheduleDecisionV1>(decision)
                    .map(|decision| (concept_id, decision))
                    .map_err(|error| json_invariant("review_schedule_decision_json", &error))
            })
            .collect()
    }

    /// The one progression cursor for this session, locked for the rest of `tx`
    /// and created at revision `0` if it does not exist yet.
    ///
    /// `progression_json` carries the canonical cursor's own fields at the top
    /// level, so the row's `revision` column and `progression_json.revision` are
    /// the same value, plus the store-owned `applied_response_ids` replay set.
    async fn locked_progression(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        voice_session_id: &str,
    ) -> Result<QuestionProgressionRecord, PortError> {
        let existing = sqlx::query_scalar::<_, Value>(
            "SELECT progression_json
             FROM question_progression_cursors
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3
             FOR UPDATE",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .fetch_optional(&mut **tx)
        .await
        .map_err(pg_error)?;
        if let Some(value) = existing {
            return progression_record_from_json(
                user_id,
                &Self::logical_id_for_uuid(study_set_uuid),
                voice_session_id,
                value,
            );
        }
        Ok(QuestionProgressionRecord {
            user_id: user_id.to_owned(),
            study_set_id: Self::logical_id_for_uuid(study_set_uuid),
            voice_session_id: voice_session_id.to_owned(),
            cursor: QuestionProgressionCursor {
                voice_session_id: voice_session_id.to_owned(),
                policy: ProgressionPolicyId::OrderedV1,
                current_question_id: None,
                completed_question_ids: Vec::new(),
                attempt_counts: std::collections::BTreeMap::new(),
                revision: 0,
            },
            applied_response_ids: Vec::new(),
        })
    }

    async fn persist_progression(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
        record: &QuestionProgressionRecord,
    ) -> Result<(), PortError> {
        let revision = i64::try_from(record.cursor.revision).map_err(|_| {
            PortError::internal(
                "postgres",
                &record.voice_session_id,
                "progression revision exceeds postgres bigint",
            )
        })?;
        sqlx::query(
            "INSERT INTO question_progression_cursors (
                 user_id, study_set_id, voice_session_id, policy_id,
                 progression_version, progression_json, revision, updated_at
             )
             VALUES ($1, $2, $3, 'ordered_v1', 1, $4, $5, NOW())
             ON CONFLICT (user_id, study_set_id, voice_session_id) DO UPDATE
             SET progression_json = EXCLUDED.progression_json,
                 revision = EXCLUDED.revision,
                 updated_at = NOW()",
        )
        .bind(&record.user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(progression_record_to_json(record)?)
        .bind(revision)
        .execute(&mut **tx)
        .await
        .map_err(pg_error)?;
        Ok(())
    }


    /// The selected D-01 v1 schedule write, inside a caller-owned transaction.
    ///
    /// This is the merged `0015` seam refactored, not reimplemented: the same
    /// advisory-lock serialization, the same graded-outcome replay key, the same
    /// single statement that lands the due date and the versioned decision/card
    /// together, and the same conformance behaviour. Task 6's outcome transaction
    /// calls it so a scheduled review can never commit without the outcome that
    /// caused it, and no second schedule table exists.
    ///
    /// **Bounded lock wait** (coordinator note 2 on the A-01/A-02 review pass):
    /// `pg_advisory_xact_lock` holds this transaction's pooled connection while it
    /// waits, so an unbounded wait lets racers occupy pool slots for as long as the
    /// slowest holder runs. `SET LOCAL lock_timeout` bounds that wait — verified to
    /// apply to advisory-lock waits on PostgreSQL 16 — and the timeout surfaces as
    /// a typed `Conflict` rather than a stalled connection.
    async fn persist_review_schedule_decision_locked(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        scope: ScheduleScope<'_>,
        decision: ReviewScheduleDecisionV1,
    ) -> Result<ScheduleWriteOutcome, PortError> {
        let ScheduleScope {
            user_id,
            study_set_uuid,
            voice_session_uuid,
            concept_uuid,
            concept_id,
            response_id,
        } = scope;
        decision
            .validate()
            .map_err(|error| PortError::invalid_input("postgres", concept_id, error.to_string()))?;

        // The graded-outcome digest is this write's durable replay key, persisted on
        // the review row itself by migration 0015. It is not a browser authorization
        // digest: no `authorize_*` path consults a review schedule, and migration
        // 0016's `event_kind` check admits only the three browser events that do.
        let payload = ReviewScheduleEventPayload::new(concept_id, &decision);
        let payload_digest = payload_sha256(
            "postgres",
            EventAuthorizationKind::ReviewSchedule,
            response_id,
            &payload,
        )?;

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
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        let replay_lock_key = format!(
            "viva.review_schedule:{user_id}:{study_set_uuid}:{voice_session_uuid}:{concept_uuid}"
        );
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&replay_lock_key)
            .execute(&mut **tx)
            .await
            .map_err(|error| match &error {
                sqlx::Error::Database(database) if database.code().as_deref() == Some("55P03") => {
                    PortError::conflict(
                        "postgres",
                        response_id,
                        "review schedule lock wait exceeded its bound",
                    )
                }
                _ => pg_error(error),
            })?;

        // A replay reads a later clock and so recomputes a different `due_at`; keying
        // the guard on the schedule would let it write a second scheduled review and
        // advance the persisted FSRS card. The first decision for this graded outcome
        // stays authoritative and is what the caller reports back.
        if let Some(persisted) = Self::persisted_review_schedule_decision(
            &mut **tx,
            user_id,
            study_set_uuid,
            voice_session_uuid,
            concept_uuid,
            response_id,
            &payload_digest,
        )
        .await?
        {
            return Ok(ScheduleWriteOutcome::Replayed(persisted));
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
        .execute(&mut **tx)
        .await;

        match inserted {
            Ok(result) if result.rows_affected() > 0 => {
                Ok(ScheduleWriteOutcome::Inserted(decision))
            }
            Ok(_) => Ok(ScheduleWriteOutcome::Replayed(decision)),
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                Ok(ScheduleWriteOutcome::RaceLost {
                    payload_sha256: payload_digest,
                })
            }
            Err(error) => Err(pg_error(error)),
        }
    }

    /// The authoritative scheduling inputs for one concept, read inside a
    /// caller-owned transaction. D-01 forbids taking either from tool arguments.
    async fn review_scheduling_context_locked(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
        concept_uuid: Uuid,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        let exam_at = sqlx::query_scalar::<sqlx::Postgres, Option<DateTime<Utc>>>(
            "SELECT exam_at FROM study_sets WHERE id = $1 AND user_id = $2",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&mut **tx)
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
        .fetch_optional(&mut **tx)
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
    RaceLost { payload_sha256: String },
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
        sqlx::query("DELETE FROM event_authorization_digests WHERE voice_session_id = $1")
            .bind(voice_session_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
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

        // One artifact writer for every ingestion path, so a column a new
        // migration adds cannot be bound on one path and silently missed on the
        // other.
        Self::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

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

        // A retry replaces this set's documents, spans, concepts, and questions, so
        // every browser authorization derived from the previous ones stops being
        // authority in the same transaction that replaces them. The progression
        // cursor points into the replaced question bank and goes with them;
        // recorded outcomes and their challenge resolutions cascade from the
        // questions themselves.
        sqlx::query("DELETE FROM event_authorization_digests WHERE study_set_id = $1")
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        sqlx::query("DELETE FROM question_progression_cursors WHERE study_set_id = $1")
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;

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
        // Learner-derived: canonical learning records carry feedback and retry
        // prompts, so they are removed with every other session artifact.
        // Challenge resolutions reference outcomes, so they go first.
        sqlx::query(
            "DELETE FROM learning_challenge_resolutions
             WHERE user_id = $1 AND study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM learning_turn_outcomes
             WHERE user_id = $1 AND study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM question_progression_cursors
             WHERE user_id = $1 AND study_set_id = $2",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM event_authorization_digests
             WHERE user_id = $1 AND study_set_id = $2",
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
        // Learner-derived: canonical learning records carry feedback and retry
        // prompts, so they are removed with every other session artifact.
        sqlx::query(
            "DELETE FROM learning_challenge_resolutions
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM learning_turn_outcomes
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM question_progression_cursors
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        sqlx::query(
            "DELETE FROM event_authorization_digests
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
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
        // The concept binding and the grading rubric are read back from the columns
        // that store them (migration `0018`), not recovered by rule from the
        // question id: an authored question whose concept is not `q-{concept}` is a
        // question the derivation could never have described.
        let owned = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM study_sets
                WHERE id = $1 AND user_id = $2 AND ingestion_status = 'ready'
             )",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .map_err(pg_error)?;
        if !owned {
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
        if !self
            .has_event_authorization(
                user_id,
                study_set_uuid,
                voice_session_uuid,
                response_id,
                EventAuthorizationKind::AnswerEvaluation,
                evaluation,
            )
            .await?
        {
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
        if !self
            .has_event_authorization(
                user_id,
                study_set_uuid,
                voice_session_uuid,
                response_id,
                EventAuthorizationKind::ConceptStatus,
                &payload,
            )
            .await?
        {
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
        if !self
            .has_event_authorization(
                user_id,
                study_set_uuid,
                voice_session_uuid,
                response_id,
                EventAuthorizationKind::StudySessionRecap,
                recap,
            )
            .await?
        {
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
        //
        // `DATA-005`: the attempt row and the browser authorization digest commit
        // in one transaction, so authority can never exist for an evaluation that
        // was rolled back.
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
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
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        let Some(inserted) = inserted else {
            tx.rollback().await.map_err(pg_error)?;
            return Err(PortError::conflict(
                "postgres",
                response_id,
                "answer evaluation does not match the persisted attempt for this response",
            ));
        };
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
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let concept_uuid = self.concept_uuid_for(study_set_uuid, concept_id).await?;
        self.ensure_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;

        // The transaction-owning wrapper. The write itself lives in the helper so
        // Task 6's outcome transaction can perform the same write inside its own
        // transaction, against the same 0015 seam, with the same replay key,
        // schema checks, exam policy, and sequence behaviour.
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        let written = Self::persist_review_schedule_decision_locked(
            &mut tx,
            ScheduleScope {
                user_id,
                study_set_uuid,
                voice_session_uuid,
                concept_uuid,
                concept_id,
                response_id,
            },
            decision,
        )
        .await;
        match written {
            Ok(ScheduleWriteOutcome::Inserted(decision)) => {
                tx.commit().await.map_err(pg_error)?;
                self.increment_count(WriteCountKind::ReviewItem);
                Ok(decision.public_summary(concept_id))
            }
            Ok(ScheduleWriteOutcome::Replayed(decision)) => {
                tx.commit().await.map_err(pg_error)?;
                Ok(decision.public_summary(concept_id))
            }
            Ok(ScheduleWriteOutcome::RaceLost { payload_sha256 }) => {
                // A concurrent replay won the race and its INSERT aborted this
                // transaction. Report what it persisted; never let this call become
                // a second scheduled review. The re-read runs on a fresh connection.
                tx.rollback().await.map_err(pg_error)?;
                let persisted = Self::persisted_review_schedule_decision(
                    &self.pool,
                    user_id,
                    study_set_uuid,
                    voice_session_uuid,
                    concept_uuid,
                    response_id,
                    &payload_sha256,
                )
                .await?
                .ok_or_else(|| {
                    PortError::conflict(
                        "postgres",
                        response_id,
                        "review schedule write conflicted with an unrelated scheduled row",
                    )
                })?;
                Ok(persisted.public_summary(concept_id))
            }
            Err(error) => Err(error),
        }
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

    /// `LEARN-003`/Task 6: the outcome, its concept transitions, its progression
    /// effect, its browser authorization digests, and the selected D-01 schedule
    /// seam all commit in one transaction, or none of them do.
    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        validate_turn_outcome("postgres", &outcome)?;
        let recorded_at = parse_utc_instant(&outcome.recorded_at).ok_or_else(|| {
            PortError::invalid_input(
                "postgres",
                &outcome.response_id,
                "turn outcome recorded_at is not an RFC3339 UTC instant",
            )
        })?;
        let digest = payload_sha256(
            "postgres",
            EventAuthorizationKind::AnswerEvaluation,
            &outcome.response_id,
            &outcome,
        )?;
        let outcome_json = serde_json::to_value(&outcome)
            .map_err(|error| json_invariant("learning_turn_outcome_json", &error))?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        Self::lock_open_session(&mut tx, user_id, study_set_uuid, voice_session_uuid).await?;

        // Replay-or-conflict, decided before anything is written.
        let existing = sqlx::query_scalar::<_, Value>(
            "SELECT outcome_json
             FROM learning_turn_outcomes
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND response_id = $4
               AND payload_sha256 = $5
             FOR UPDATE",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&outcome.response_id)
        .bind(&digest)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        if let Some(existing) = existing {
            let stored: TurnOutcome = serde_json::from_value(existing)
                .map_err(|error| json_invariant("learning_turn_outcome_json", &error))?;
            tx.commit().await.map_err(pg_error)?;
            if stored != outcome {
                return Err(PortError::conflict(
                    "postgres",
                    &outcome.response_id,
                    "turn outcome does not match the outcome already recorded for this response",
                ));
            }
            return Ok(PersistedTurnOutcome {
                record: TurnOutcomeRecordReceipt {
                    schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                    response_id: stored.response_id.clone(),
                    replayed: true,
                },
                turn_outcome: stored,
            });
        }

        // Tenant validation for every referenced question, source, and concept.
        let question_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM study_questions
                WHERE study_set_id = $1 AND question_id = $2
             )",
        )
        .bind(study_set_uuid)
        .bind(&outcome.question_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(pg_error)?;
        if !question_exists {
            return Err(PortError::unavailable(
                "postgres",
                &outcome.question_id,
                "question is not available for this study set",
            ));
        }
        for source_id in &outcome.source_ids {
            let source_uuid = Self::uuid_for(source_id)?;
            let owned = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1
                    FROM source_spans sp
                    JOIN study_documents d ON d.id = sp.document_id
                    WHERE sp.id = $1
                      AND d.study_set_id = $2
                      AND sp.deleted_at IS NULL
                      AND d.deleted_at IS NULL
                 )",
            )
            .bind(source_uuid)
            .bind(study_set_uuid)
            .fetch_one(&mut *tx)
            .await
            .map_err(pg_error)?;
            if !owned {
                return Err(PortError::unavailable(
                    "postgres",
                    source_id,
                    "source is not available for this study set",
                ));
            }
        }
        let mut transition_concepts = Vec::new();
        for transition in turn_outcome_transitions(&outcome) {
            let concept_uuid = sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM concepts WHERE study_set_id = $1 AND public_id = $2",
            )
            .bind(study_set_uuid)
            .bind(&transition.concept_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(pg_error)?
            .ok_or_else(|| {
                PortError::unavailable(
                    "postgres",
                    &transition.concept_id,
                    "concept is not available for this study set",
                )
            })?;
            transition_concepts.push((concept_uuid, transition));
        }

        // A replacement may only claim mastery behind a resolution that asked for
        // reevaluation.
        if let Some(challenged) = outcome.supersedes_response_id.as_deref() {
            let permitted = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1
                    FROM learning_challenge_resolutions
                    WHERE user_id = $1
                      AND study_set_id = $2
                      AND voice_session_id = $3
                      AND challenged_response_id = $4
                      AND resolution_json ->> 'disposition' = 'reevaluation_required'
                      AND (
                          replacement_response_id IS NULL
                          OR replacement_response_id = $5
                      )
                 )",
            )
            .bind(user_id)
            .bind(study_set_uuid)
            .bind(voice_session_uuid)
            .bind(challenged)
            .bind(&outcome.response_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(pg_error)?;
            if !permitted {
                return Err(PortError::conflict(
                    "postgres",
                    &outcome.response_id,
                    "supersession requires a challenge resolution that permits reevaluation",
                ));
            }
        }

        let inserted = sqlx::query_scalar::<_, String>(
            "INSERT INTO learning_turn_outcomes (
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
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
             ON CONFLICT (user_id, study_set_id, voice_session_id, response_id)
             DO NOTHING
             RETURNING payload_sha256",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&outcome.response_id)
        .bind(&outcome.question_id)
        .bind(&outcome.supersedes_response_id)
        .bind(&outcome_json)
        .bind(&digest)
        .bind(recorded_at)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        if inserted.is_none() {
            // A row exists under this response identity whose digest differs, which
            // the replay read above already excluded. That is a divergent replay.
            return Err(PortError::conflict(
                "postgres",
                &outcome.response_id,
                "turn outcome does not match the outcome already recorded for this response",
            ));
        }

        let mut scheduled = 0_usize;
        for (concept_uuid, transition) in transition_concepts {
            sqlx::query("UPDATE concepts SET status = $1, updated_at = NOW() WHERE id = $2")
                .bind(concept_status_str(&transition.to_status))
                .bind(concept_uuid)
                .execute(&mut *tx)
                .await
                .map_err(pg_error)?;
            Self::insert_event_authorization(
                &mut tx,
                user_id,
                study_set_uuid,
                voice_session_uuid,
                &outcome.response_id,
                EventAuthorizationKind::ConceptStatus,
                &ConceptStatusEventPayload {
                    concept_id: &transition.concept_id,
                    status: &transition.to_status,
                },
            )
            .await?;

            // D-01 `SERVER_PERSISTED_FSRS`: an evaluated turn is the graded outcome,
            // so its transition schedules the concept's next review in the same
            // transaction, against the merged `0015` seam. `LEARN-009` removed the
            // separate scheduling tool, so this is the only path that creates one —
            // and a rolled-back outcome can never leave a review behind.
            let context = Self::review_scheduling_context_locked(
                &mut tx,
                user_id,
                study_set_uuid,
                concept_uuid,
            )
            .await?;
            let decision = agent_domain::decide_review_schedule(
                recorded_at,
                &agent_domain::ReviewOutcomeV1 {
                    status: transition.to_status.clone(),
                    hint_count: None,
                    miss_count: None,
                },
                &context,
            )
            .map_err(|error| {
                PortError::invalid_input(
                    "postgres",
                    &transition.concept_id,
                    error.to_string(),
                )
            })?;
            match Self::persist_review_schedule_decision_locked(
                &mut tx,
                ScheduleScope {
                    user_id,
                    study_set_uuid,
                    voice_session_uuid,
                    concept_uuid,
                    concept_id: &transition.concept_id,
                    response_id: &outcome.response_id,
                },
                decision,
            )
            .await?
            {
                ScheduleWriteOutcome::Inserted(_) => scheduled += 1,
                ScheduleWriteOutcome::Replayed(_) => {}
                ScheduleWriteOutcome::RaceLost { .. } => {
                    return Err(PortError::conflict(
                        "postgres",
                        &outcome.response_id,
                        "review schedule write conflicted with an unrelated scheduled row",
                    ));
                }
            }
        }

        // The cursor exists from the first recorded outcome, and this outcome's
        // disposition is what moves it. The revision counts selections, so applying
        // a disposition never advances it.
        let mut progression = Self::locked_progression(
            &mut tx,
            user_id,
            study_set_uuid,
            voice_session_uuid,
            voice_session_id,
        )
        .await?;
        InMemoryStudyStore::apply_outcome_disposition(
            &mut progression,
            &outcome.question_id,
            turn_outcome_disposition(&outcome),
        );
        Self::persist_progression(&mut tx, study_set_uuid, voice_session_uuid, &progression).await?;

        tx.commit().await.map_err(pg_error)?;
        for _ in 0..scheduled {
            self.increment_count(WriteCountKind::ReviewItem);
        }
        Ok(PersistedTurnOutcome {
            record: TurnOutcomeRecordReceipt {
                schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                response_id: outcome.response_id.clone(),
                replayed: false,
            },
            turn_outcome: outcome,
        })
    }

    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        self.ensure_study_set(user_id, study_set_uuid).await?;
        self.ensure_readable_session(user_id, study_set_uuid, voice_session_uuid)
            .await?;

        let outcomes =
            Self::session_turn_outcomes(&self.pool, user_id, study_set_uuid, voice_session_uuid)
                .await?;
        let mut concept_ids = outcomes
            .iter()
            .flat_map(turn_outcome_transitions)
            .map(|transition| transition.concept_id.clone())
            .collect::<Vec<_>>();
        concept_ids.sort();
        concept_ids.dedup();
        let mut concept_labels = Vec::with_capacity(concept_ids.len());
        for concept_id in concept_ids {
            let label = sqlx::query_scalar::<_, String>(
                "SELECT label FROM concepts WHERE study_set_id = $1 AND public_id = $2",
            )
            .bind(study_set_uuid)
            .bind(&concept_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(pg_error)?
            .ok_or_else(|| {
                PortError::unavailable(
                    "postgres",
                    &concept_id,
                    "concept is not available for this study set",
                )
            })?;
            concept_labels.push(ConceptLabel { concept_id, label });
        }

        let decisions =
            Self::session_review_decisions(&self.pool, user_id, study_set_uuid, voice_session_uuid)
                .await?;
        let review_decisions = review_schedule_summaries(
            decisions
                .iter()
                .map(|(concept_id, decision)| (concept_id.as_str(), decision)),
        );

        Ok(SessionLearningEvidence {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            outcomes,
            concept_labels,
            review_decisions,
        })
    }

    async fn record_challenge_resolution(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        resolution: ChallengeResolution,
    ) -> Result<ChallengeResolution, PortError> {
        validate_challenge_resolution("postgres", &resolution)?;
        let digest = payload_sha256(
            "postgres",
            EventAuthorizationKind::AnswerEvaluation,
            &resolution.correction_id,
            &resolution,
        )?;
        let resolution_json = serde_json::to_value(&resolution)
            .map_err(|error| json_invariant("learning_challenge_resolution_json", &error))?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let source_uuid = Self::uuid_for(&resolution.source_id)?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        Self::lock_open_session(&mut tx, user_id, study_set_uuid, voice_session_uuid).await?;

        let source_owned = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1
                FROM source_spans sp
                JOIN study_documents d ON d.id = sp.document_id
                WHERE sp.id = $1
                  AND d.study_set_id = $2
                  AND sp.deleted_at IS NULL
                  AND d.deleted_at IS NULL
             )",
        )
        .bind(source_uuid)
        .bind(study_set_uuid)
        .fetch_one(&mut *tx)
        .await
        .map_err(pg_error)?;
        if !source_owned {
            return Err(PortError::unavailable(
                "postgres",
                &resolution.source_id,
                "source is not available for this study set",
            ));
        }

        let challenged_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM learning_turn_outcomes
                WHERE user_id = $1
                  AND study_set_id = $2
                  AND voice_session_id = $3
                  AND response_id = $4
             )",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&resolution.challenged_response_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(pg_error)?;
        if !challenged_exists {
            return Err(PortError::unavailable(
                "postgres",
                &resolution.challenged_response_id,
                "challenged response has no recorded outcome in this session",
            ));
        }

        let inserted = sqlx::query_scalar::<_, String>(
            "INSERT INTO learning_challenge_resolutions (
                 user_id,
                 study_set_id,
                 voice_session_id,
                 correction_id,
                 challenged_response_id,
                 replacement_response_id,
                 resolution_version,
                 resolution_json,
                 payload_sha256
             )
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
             ON CONFLICT (user_id, study_set_id, voice_session_id, correction_id)
             DO NOTHING
             RETURNING payload_sha256",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&resolution.correction_id)
        .bind(&resolution.challenged_response_id)
        .bind(&resolution.replacement_response_id)
        .bind(&resolution_json)
        .bind(&digest)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        if inserted.is_some() {
            tx.commit().await.map_err(pg_error)?;
            return Ok(resolution);
        }

        let stored = sqlx::query_scalar::<_, Value>(
            "SELECT resolution_json
             FROM learning_challenge_resolutions
             WHERE user_id = $1
               AND study_set_id = $2
               AND voice_session_id = $3
               AND correction_id = $4",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .bind(&resolution.correction_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(pg_error)?;
        tx.commit().await.map_err(pg_error)?;
        let stored: ChallengeResolution = serde_json::from_value(stored)
            .map_err(|error| json_invariant("learning_challenge_resolution_json", &error))?;
        if stored != resolution {
            return Err(PortError::conflict(
                "postgres",
                &resolution.correction_id,
                "challenge resolution does not match the one already recorded",
            ));
        }
        Ok(stored)
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        require_selected_progression_policy("postgres", policy)?;
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;

        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        Self::lock_open_session(&mut tx, user_id, study_set_uuid, voice_session_uuid).await?;
        let active = Self::active_questions(&mut *tx, study_set_uuid).await?;
        let mut progression = Self::locked_progression(
            &mut tx,
            user_id,
            study_set_uuid,
            voice_session_uuid,
            voice_session_id,
        )
        .await?;
        if InMemoryStudyStore::apply_ordered_selection(&mut progression, response_id, &active) {
            Self::persist_progression(&mut tx, study_set_uuid, voice_session_uuid, &progression)
                .await?;
        }
        tx.commit().await.map_err(pg_error)?;
        Ok(InMemoryStudyStore::ordered_progression_result(
            &progression.cursor,
            &active,
        ))
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<AuthenticatedStudyProjectionV1, PortError> {
        let study_set_uuid = Self::uuid_for(study_set_id)?;
        let voice_session_uuid = Self::uuid_for(voice_session_id)?;
        let set_row = sqlx::query(
            "SELECT title, course, ingestion_status, exam_at
             FROM study_sets
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?
        .ok_or_else(|| {
            PortError::unavailable(
                "postgres",
                study_set_id,
                "study set is not available for this user",
            )
        })?;
        let session_row = sqlx::query(
            "SELECT mode
             FROM voice_sessions
             WHERE id = $1 AND user_id = $2 AND study_set_id = $3 AND status <> 'deleted'",
        )
        .bind(voice_session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?
        .ok_or_else(|| {
            PortError::unavailable(
                "postgres",
                voice_session_id,
                "voice session is not available for this user and study set",
            )
        })?;

        let outcomes =
            Self::session_turn_outcomes(&self.pool, user_id, study_set_uuid, voice_session_uuid)
                .await?;
        let decisions =
            Self::session_review_decisions(&self.pool, user_id, study_set_uuid, voice_session_uuid)
                .await?;
        let review_schedule = review_schedule_summaries(
            decisions
                .iter()
                .map(|(concept_id, decision)| (concept_id.as_str(), decision)),
        );

        let concept_rows = sqlx::query(
            "SELECT COALESCE(public_id, id::text) AS concept_public_id, label, status
             FROM concepts
             WHERE study_set_id = $1
             ORDER BY COALESCE(public_id, id::text) ASC",
        )
        .bind(study_set_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_error)?;
        let mut concepts = Vec::with_capacity(concept_rows.len());
        for row in &concept_rows {
            let concept_id: String = row.try_get("concept_public_id").map_err(pg_error)?;
            let status = concept_status(
                row.try_get::<String, _>("status").map_err(pg_error)?.as_str(),
            )?;
            concepts.push(StudyProjectionConceptV1 {
                last_reviewed_at: last_reviewed_at(&outcomes, &concept_id),
                due_at: review_schedule
                    .iter()
                    .find(|item| item.concept_id == concept_id)
                    .map(|item| item.due_at.clone()),
                id: concept_id,
                label: row.try_get("label").map_err(pg_error)?,
                status,
            });
        }

        let ingestion_status = ingestion_status(
            row_string(&set_row, "ingestion_status")?.as_str(),
        )?;
        let active = Self::active_questions(&self.pool, study_set_uuid).await?;
        let cursor = sqlx::query_scalar::<_, Value>(
            "SELECT progression_json
             FROM question_progression_cursors
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_error)?
        .map(|value| {
            progression_record_from_json(user_id, study_set_id, voice_session_id, value)
        })
        .transpose()?
        .map(|record| record.cursor);

        let document_titles = sqlx::query(
            "SELECT id, display_name FROM study_documents WHERE study_set_id = $1",
        )
        .bind(study_set_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_error)?
        .into_iter()
        .map(|row| {
            Ok((
                Self::logical_id_for_uuid(row.try_get::<Uuid, _>("id").map_err(pg_error)?),
                row.try_get::<String, _>("display_name").map_err(pg_error)?,
            ))
        })
        .collect::<Result<std::collections::BTreeMap<_, _>, PortError>>()?;

        let active_question = cursor
            .as_ref()
            .and_then(|cursor| cursor.current_question_id.clone())
            .filter(|_| ingestion_status == StudySetIngestionStatus::Ready)
            .and_then(|question_id| {
                active
                    .iter()
                    .find(|question| question.question_id == question_id)
                    .map(|question| {
                        projection_active_question(question, |document_id| {
                            document_titles.get(document_id).cloned()
                        })
                    })
            });

        Ok(AuthenticatedStudyProjectionV1 {
            version: StudyProjectionVersionV1,
            study_set: StudyProjectionStudySetV1 {
                id: study_set_id.to_owned(),
                title: row_string(&set_row, "title")?,
                course: set_row.try_get("course").map_err(pg_error)?,
                exam_label: set_row
                    .try_get::<Option<DateTime<Utc>>, _>("exam_at")
                    .map_err(pg_error)?
                    .map(format_rfc3339_millis),
                ingestion_status,
            },
            session: StudyProjectionSessionV1 {
                id: voice_session_id.to_owned(),
                mode: study_mode(row_string(&session_row, "mode")?.as_str()),
                goal: None,
            },
            concepts,
            active_question,
            question_progress: StudyProjectionQuestionProgressV1 {
                completed: cursor.as_ref().map_or(0, |cursor| {
                    u32::try_from(cursor.completed_question_ids.len()).unwrap_or(u32::MAX)
                }),
                total: u32::try_from(active.len()).unwrap_or(u32::MAX),
            },
            review_schedule: review_schedule
                .into_iter()
                .map(|item| StudyProjectionReviewItemV1 {
                    concept_id: item.concept_id,
                    due_at: item.due_at,
                    authority: item.authority,
                })
                .collect(),
        })
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
    let object = value
        .as_object_mut()
        .ok_or_else(|| PortError::internal(
            "postgres",
            "question_progression_cursor_json",
            "a serialized progression cursor is always a JSON object",
        ))?;
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
    let object = value
        .as_object_mut()
        .ok_or_else(|| PortError::internal(
            "postgres",
            "question_progression_cursor_json",
            "a stored progression cursor is always a JSON object",
        ))?;
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
