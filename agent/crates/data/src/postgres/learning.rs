//! Learning: Plan 04's canonical outcomes, progression, and projection, durably
//! (`DATA-011`, `DATA-015`).
//!
//! Owned invariant: one authoritative row per response identity, and every effect
//! of a turn commits in one transaction or none of them do — the outcome insert,
//! its concept transitions, the session's progression cursor at its exact
//! revision, the selected `D-01` `SERVER_PERSISTED_FSRS` seam, and the browser
//! authorization digests. Replay is decided on the stored payload digest, not on
//! anything the caller asserts, and a divergent payload under the same response
//! identity is a `Conflict` that leaves the committed row untouched.
//!
//! It also owns the two canonical reads assembled from those rows —
//! `SessionLearningEvidence` and `AuthenticatedStudyProjectionV1` — and their
//! deterministic ordering, which must match `memory::learning` exactly.
//!
//! `postgres.rs` keeps the port methods and delegates their whole body here.

use super::*;

impl PostgresStudyStore {
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
    pub(super) async fn active_questions<'e, E>(
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

    /// The session's committed progression cursor, read without locking it.
    ///
    /// Both canonical reads answer from this one query — the authenticated
    /// projection's active question and progress, and `A-14`'s
    /// `current_question` — so neither can drift into a second interpretation of
    /// the same row. A session that has never selected has no row and no cursor.
    async fn session_progression_cursor<'e, E>(
        executor: E,
        user_id: &str,
        study_set_id: &str,
        study_set_uuid: Uuid,
        voice_session_id: &str,
        voice_session_uuid: Uuid,
    ) -> Result<Option<QuestionProgressionCursor>, PortError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        Ok(sqlx::query_scalar::<_, Value>(
            "SELECT progression_json
             FROM question_progression_cursors
             WHERE user_id = $1 AND study_set_id = $2 AND voice_session_id = $3",
        )
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(voice_session_uuid)
        .fetch_optional(executor)
        .await
        .map_err(pg_error)?
        .map(|value| progression_record_from_json(user_id, study_set_id, voice_session_id, value))
        .transpose()?
        .map(|record| record.cursor))
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

/// The learning port bodies. `postgres.rs` keeps the trait signatures; the whole
/// transaction and the canonical reads live here.
pub(super) async fn review_scheduling_context(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    concept_id: &str,
) -> Result<ReviewSchedulingContextV1, PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let concept_uuid = store.concept_uuid_for(study_set_uuid, concept_id).await?;

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
    .fetch_optional(&store.pool)
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
    .fetch_optional(&store.pool)
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

pub(super) async fn persist_review_schedule_decision(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    concept_id: &str,
    decision: ReviewScheduleDecisionV1,
) -> Result<Value, PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    let concept_uuid = store.concept_uuid_for(study_set_uuid, concept_id).await?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;

    // The transaction-owning wrapper. The write itself lives in the helper so
    // Task 6's outcome transaction can perform the same write inside its own
    // transaction, against the same 0015 seam, with the same replay key,
    // schema checks, exam policy, and sequence behaviour.
    let mut tx = store.pool.begin().await.map_err(pg_error)?;
    // `DATA-004`: take the session row's shared lock before writing, so a
    // concurrent deletion is either fully before this transaction or refused by
    // it. Without it a writer that validated first could commit its artifact
    // after the purge had already run.
    PostgresStudyStore::lock_open_session_shared(
        &mut tx,
        user_id,
        study_set_uuid,
        voice_session_uuid,
    )
    .await?;
    let written = PostgresStudyStore::persist_review_schedule_decision_locked(
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
            store.increment_count(WriteCountKind::ReviewItem);
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
            let persisted = PostgresStudyStore::persisted_review_schedule_decision(
                &store.pool,
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
/// `LEARN-003`/Task 6: the outcome, its concept transitions, its progression
/// effect, its browser authorization digests, and the selected D-01 schedule
/// seam all commit in one transaction, or none of them do.
pub(super) async fn record_turn_outcome(
    store: &PostgresStudyStore,
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
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;

    let mut tx = store.pool.begin().await.map_err(pg_error)?;
    PostgresStudyStore::lock_open_session(&mut tx, user_id, study_set_uuid, voice_session_uuid)
        .await?;

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
        let source_uuid = PostgresStudyStore::uuid_for(source_id)?;
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

    // `A-22`: an evaluated turn completes its own answer attempt and authorizes
    // its own browser evaluation, inside this same transaction — the attempt row's
    // evaluation columns and the digest commit with the outcome or roll back with
    // it, exactly as the retired `record_answer_evaluation` committed them
    // together. The published-question list is read through the transaction, so a
    // concurrent deletion cannot leave authority behind for a question it removed.
    if let Some(payload) = browser_answer_evaluation(
        &outcome,
        &PostgresStudyStore::active_questions(&mut *tx, study_set_uuid).await?,
    ) {
        let attempt_question = sqlx::query_scalar::<_, String>(
            "SELECT aa.question_id
             FROM answer_attempts aa
             JOIN voice_sessions vs ON vs.id = aa.voice_session_id
             WHERE aa.voice_session_id = $1
               AND vs.user_id = $2
               AND vs.study_set_id = $3
               AND aa.response_id = $4",
        )
        .bind(voice_session_uuid)
        .bind(user_id)
        .bind(study_set_uuid)
        .bind(&outcome.response_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        // The attempt row is the learner's capture record: this completes one a
        // capture already wrote and never invents one. An outcome with no recorded
        // attempt authorizes nothing, and the browser event that would have claimed
        // it fails closed at the gate.
        if let Some(attempt_question) = attempt_question {
            if attempt_question != outcome.question_id {
                return Err(PortError::conflict(
                    "postgres",
                    &outcome.response_id,
                    "turn outcome question does not match the recorded answer attempt",
                ));
            }
            sqlx::query(
                "UPDATE answer_attempts
                 SET evaluation_label = $1,
                     concept_status = $2,
                     confidence_score = $3,
                     source_span_id = $4
                 WHERE voice_session_id = $5
                   AND response_id = $6",
            )
            .bind(&payload.label)
            .bind(concept_status_str(&payload.concept_status))
            .bind(f64::from(payload.confidence_score))
            .bind(PostgresStudyStore::uuid_for(&payload.source.source_id)?)
            .bind(voice_session_uuid)
            .bind(&outcome.response_id)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
            PostgresStudyStore::insert_event_authorization(
                &mut tx,
                user_id,
                study_set_uuid,
                voice_session_uuid,
                &outcome.response_id,
                EventAuthorizationKind::AnswerEvaluation,
                &payload,
            )
            .await?;
        }
    }

    let mut scheduled = 0_usize;
    let mut status_events = 0_usize;
    for (concept_uuid, transition) in transition_concepts {
        sqlx::query("UPDATE concepts SET status = $1, updated_at = NOW() WHERE id = $2")
            .bind(concept_status_str(&transition.to_status))
            .bind(concept_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
        // `A-22` — SCOPE EXTENSION, awaiting coordinator ratification.
        //
        // The same session-scoped status write the retired `record_concept_status`
        // made, so the two backends hold the same rows for the same turn and the
        // `concept_status` browser event of a genuinely evaluated turn is backed by
        // a durable write, not by a digest alone.
        //
        // A-22's text obliges this authority to populate the attempt row and write
        // the event-authorization digest, and says nothing about the sibling
        // `concept_status` event — so this write is not covered by a ratified
        // amendment line. The necessity is memory-side (that backend's
        // `authorize_concept_status` refuses without the row) and the full record is
        // on the twin write in `memory/learning.rs`; this backend carries it because
        // the shared conformance suite holds the two to the same published counts.
        let status_event = sqlx::query(
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
        .bind(&outcome.response_id)
        .bind(concept_uuid)
        .bind(payload_sha256(
            "postgres",
            EventAuthorizationKind::ConceptStatus,
            &outcome.response_id,
            &ConceptStatusEventPayload {
                concept_id: &transition.concept_id,
                status: &transition.to_status,
            },
        )?)
        .bind(concept_status_str(&transition.to_status))
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        if status_event.rows_affected() == 1 {
            status_events += 1;
        }
        PostgresStudyStore::insert_event_authorization(
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
        let context = PostgresStudyStore::review_scheduling_context_locked(
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
            PortError::invalid_input("postgres", &transition.concept_id, error.to_string())
        })?;
        match PostgresStudyStore::persist_review_schedule_decision_locked(
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
    let mut progression = PostgresStudyStore::locked_progression(
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
    PostgresStudyStore::persist_progression(
        &mut tx,
        study_set_uuid,
        voice_session_uuid,
        &progression,
    )
    .await?;

    tx.commit().await.map_err(pg_error)?;
    for _ in 0..scheduled {
        store.increment_count(WriteCountKind::ReviewItem);
    }
    for _ in 0..status_events {
        store.increment_count(WriteCountKind::ConceptStatus);
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

pub(super) async fn session_learning_evidence(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<SessionLearningEvidence, PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store.ensure_study_set(user_id, study_set_uuid).await?;
    store
        .ensure_readable_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;

    let outcomes = PostgresStudyStore::session_turn_outcomes(
        &store.pool,
        user_id,
        study_set_uuid,
        voice_session_uuid,
    )
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
        .fetch_optional(&store.pool)
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

    let decisions = PostgresStudyStore::session_review_decisions(
        &store.pool,
        user_id,
        study_set_uuid,
        voice_session_uuid,
    )
    .await?;
    let review_decisions = review_schedule_summaries(
        decisions
            .iter()
            .map(|(concept_id, decision)| (concept_id.as_str(), decision)),
    );

    // `A-14`: both session-scoped question fields come from persisted rows — the
    // session's committed cursor and its committed outcomes — resolved against
    // the questions this set still publishes, through the same two shared rules
    // the in-memory backend uses.
    let published = PostgresStudyStore::active_questions(&store.pool, study_set_uuid).await?;
    let cursor = PostgresStudyStore::session_progression_cursor(
        &store.pool,
        user_id,
        study_set_id,
        study_set_uuid,
        voice_session_id,
        voice_session_uuid,
    )
    .await?;
    let current_question = cursor_current_question(cursor.as_ref(), &published);
    let answered_questions = session_answered_questions(&outcomes, &published);

    Ok(SessionLearningEvidence {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        current_question,
        answered_questions,
        outcomes,
        concept_labels,
        review_decisions,
    })
}

pub(super) async fn record_challenge_resolution(
    store: &PostgresStudyStore,
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
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    let source_uuid = PostgresStudyStore::uuid_for(&resolution.source_id)?;

    let mut tx = store.pool.begin().await.map_err(pg_error)?;
    PostgresStudyStore::lock_open_session(&mut tx, user_id, study_set_uuid, voice_session_uuid)
        .await?;

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

pub(super) async fn select_next_question(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    policy: ProgressionPolicyId,
) -> Result<QuestionProgressionResult, PortError> {
    require_selected_progression_policy("postgres", policy)?;
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;

    let mut tx = store.pool.begin().await.map_err(pg_error)?;
    PostgresStudyStore::lock_open_session(&mut tx, user_id, study_set_uuid, voice_session_uuid)
        .await?;
    let active = PostgresStudyStore::active_questions(&mut *tx, study_set_uuid).await?;
    let mut progression = PostgresStudyStore::locked_progression(
        &mut tx,
        user_id,
        study_set_uuid,
        voice_session_uuid,
        voice_session_id,
    )
    .await?;
    if InMemoryStudyStore::apply_ordered_selection(&mut progression, response_id, &active) {
        PostgresStudyStore::persist_progression(
            &mut tx,
            study_set_uuid,
            voice_session_uuid,
            &progression,
        )
        .await?;
    }
    tx.commit().await.map_err(pg_error)?;
    Ok(InMemoryStudyStore::ordered_progression_result(
        &progression.cursor,
        &active,
    ))
}

pub(super) async fn authenticated_study_projection(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<AuthenticatedStudyProjectionV1, PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    let set_row = sqlx::query(
        "SELECT title, course, ingestion_status, exam_at
         FROM study_sets
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(study_set_uuid)
    .bind(user_id)
    .fetch_optional(&store.pool)
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
    .fetch_optional(&store.pool)
    .await
    .map_err(pg_error)?
    .ok_or_else(|| {
        PortError::unavailable(
            "postgres",
            voice_session_id,
            "voice session is not available for this user and study set",
        )
    })?;

    let outcomes = PostgresStudyStore::session_turn_outcomes(
        &store.pool,
        user_id,
        study_set_uuid,
        voice_session_uuid,
    )
    .await?;
    let decisions = PostgresStudyStore::session_review_decisions(
        &store.pool,
        user_id,
        study_set_uuid,
        voice_session_uuid,
    )
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
    .fetch_all(&store.pool)
    .await
    .map_err(pg_error)?;
    let mut concepts = Vec::with_capacity(concept_rows.len());
    for row in &concept_rows {
        let concept_id: String = row.try_get("concept_public_id").map_err(pg_error)?;
        let status = concept_status(
            row.try_get::<String, _>("status")
                .map_err(pg_error)?
                .as_str(),
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

    let ingestion_status = ingestion_status(row_string(&set_row, "ingestion_status")?.as_str())?;
    let active = PostgresStudyStore::active_questions(&store.pool, study_set_uuid).await?;
    let cursor = PostgresStudyStore::session_progression_cursor(
        &store.pool,
        user_id,
        study_set_id,
        study_set_uuid,
        voice_session_id,
        voice_session_uuid,
    )
    .await?;

    let document_titles =
        sqlx::query("SELECT id, display_name FROM study_documents WHERE study_set_id = $1")
            .bind(study_set_uuid)
            .fetch_all(&store.pool)
            .await
            .map_err(pg_error)?
            .into_iter()
            .map(|row| {
                Ok((
                    PostgresStudyStore::logical_id_for_uuid(
                        row.try_get::<Uuid, _>("id").map_err(pg_error)?,
                    ),
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
