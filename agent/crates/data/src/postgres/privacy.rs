//! Privacy: ownership, lock order, deletion, and what a tombstone is allowed to
//! keep (`DATA-004`, `DATA-010`, `COR-03`, `SEC-03`, `DATA-015`).
//!
//! Owned invariant: after the selected `D-05 HARD_PURGE_TEXT` deletion, no
//! learner-authored or learner-derived text remains in any table, and every
//! ordinary read refuses the set. What survives is content-free by enumeration —
//! identifiers, timestamps, and three constants — kept only so a repeated delete
//! stays idempotent and a fixture seed cannot recreate the material behind it.
//!
//! It also owns the one global lock order every other subsystem takes its locks
//! through: study-set row, then session rows in `id` order, then children. A
//! writer holds the study set `FOR KEY SHARE` and the deletion holds it
//! `FOR UPDATE`, which leaves exactly two serial orders — write-then-delete, or
//! delete-then-refuse — and no cycle for two transactions to deadlock on.
//!
//! `postgres.rs` keeps the port methods and delegates their whole body here.

use super::*;

impl PostgresStudyStore {
    /// `DATA-004`/`DATA-010`: one global lock order — study-set row, then session
    /// rows, then children.
    ///
    /// Every artifact writer already ends up holding a `FOR KEY SHARE` lock on its
    /// study set's row, because every artifact table has a foreign key to
    /// `study_sets` and PostgreSQL takes that lock when the row is inserted — which
    /// is *after* the writer locked its session row. `delete_study_set` takes the
    /// same two locks in the opposite order (`study_sets FOR UPDATE`, then sessions
    /// `FOR UPDATE`). Two transactions taking the same two locks in opposite orders
    /// is a deadlock, and a delete racing a concept-status or turn-outcome write
    /// produced exactly that, intermittently, as a `Durability` error on a delete
    /// that `DATA-004` requires to succeed.
    ///
    /// Taking the study-set lock explicitly and first makes the order global. It
    /// stays `FOR KEY SHARE`, which is what the foreign key would have taken
    /// anyway: concurrent writers still do not serialize against each other, and
    /// only the deletion's `FOR UPDATE` excludes them. It also carries the
    /// tombstone guard, so a writer that arrives after a committed deletion is
    /// refused here instead of at its own insert.
    pub(super) async fn lock_active_study_set(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
    ) -> Result<(), PortError> {
        let locked = sqlx::query_scalar::<_, Uuid>(
            "SELECT id
             FROM study_sets
             WHERE id = $1
               AND user_id = $2
               AND deleted_at IS NULL
             FOR KEY SHARE",
        )
        .bind(study_set_uuid)
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(pg_error)?;
        if locked.is_some() {
            return Ok(());
        }
        Err(PortError::unavailable(
            "postgres",
            study_set_uuid.to_string(),
            "study set is not available for this user",
        ))
    }

    /// Locks exactly the tenant-owned open session row for the rest of `tx`.
    ///
    /// `DATA-010`: every learner-data mutation that must not outlive a deletion
    /// takes this lock inside its own transaction, and both deletion paths take
    /// the same lock before they mutate status or remove artifacts. That leaves
    /// only two serial orders — write-then-delete, or delete-then-refuse — and no
    /// interleaving in which a late learning artifact survives the deletion.
    /// The same tenant-owned open-session lock, taken in `SHARE` mode.
    ///
    /// `DATA-004`: an artifact writer needs to exclude *deletion*, which takes the
    /// row `FOR UPDATE`, but it must not exclude another artifact writer — two
    /// concurrent evaluations, recaps, status events, or schedule decisions still
    /// have to race each other so their conflict-safe upserts are what proves
    /// convergence. `FOR SHARE` conflicts with `FOR UPDATE` and with the deletion's
    /// `UPDATE`, and with nothing else.
    pub(super) async fn lock_open_session_shared(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
    ) -> Result<(), PortError> {
        Self::lock_active_study_set(tx, user_id, study_set_uuid).await?;
        let locked = sqlx::query_scalar::<_, Uuid>(
            "SELECT id
             FROM voice_sessions
             WHERE id = $1
               AND user_id = $2
               AND study_set_id = $3
               AND status = 'open'
             FOR SHARE",
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

    pub(super) async fn lock_open_session(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: &str,
        study_set_uuid: Uuid,
        voice_session_uuid: Uuid,
    ) -> Result<(), PortError> {
        Self::lock_active_study_set(tx, user_id, study_set_uuid).await?;
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
    pub(super) async fn ensure_readable_session(
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

    /// Locks every session row a deletion is about to mutate, in a stable order.
    ///
    /// `ORDER BY id` is the deadlock-avoidance rule: two deletions that touch
    /// overlapping session sets take the same row locks in the same sequence.
    pub(super) async fn lock_sessions_for_deletion(
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

    /// The ordinary ownership guard, used by the session, nonce, outcome,
    /// challenge, progression, and projection paths.
    ///
    /// `DATA-004`: it requires `deleted_at IS NULL`, so a tombstone is `Unavailable`
    /// to every one of them. Deletion itself does not come through here — it runs
    /// its own locked, tombstone-aware lookup so a repeated delete can answer
    /// idempotently instead of refusing its own tombstone.
    pub(super) async fn ensure_study_set(
        &self,
        user_id: &str,
        study_set_uuid: Uuid,
    ) -> Result<(), PortError> {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM study_sets
                WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
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

    pub(super) async fn ensure_session(
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
}

/// The privacy port bodies. `postgres.rs` keeps the trait signatures; the
/// locked deletion, the usage/delete serialization, and the receipt live here.
/// The recorded `D-04` selection is `CONFIRM_DELETE`, so this finalizer runs
/// immediately: there is no pending window, no `study_set_deletions` row, and no
/// restore path. What survives is the scrubbed `study_sets` tombstone and the
/// content-free deleted `voice_sessions` tombstones — identifiers, timestamps,
/// and constants — which exist only to keep a repeated delete idempotent and to
/// stop a fixture seed or a reconnect recreating the material.
pub(super) async fn delete_study_set(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
) -> Result<Value, PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let mut tx = store.pool.begin().await.map_err(pg_error)?;

    // Deletion deliberately does not call `ensure_study_set`: that guard now
    // refuses a tombstone, and a repeated delete has to be able to read its own.
    let owned = sqlx::query(
        "SELECT title, course, exam_at, exam_date, ingestion_status, ingestion_error,
                deleted_at
         FROM study_sets
         WHERE id = $1 AND user_id = $2
         FOR UPDATE",
    )
    .bind(study_set_uuid)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(pg_error)?;
    let Some(row) = owned else {
        tx.rollback().await.map_err(pg_error)?;
        return Err(PortError::unavailable(
            "postgres",
            study_set_id,
            "study set is not available for this user",
        ));
    };
    // `DATA-010`: every affected session row lock, in `id` order, before any
    // status mutation or artifact removal. A concurrent usage write is then
    // either fully before this transaction or fully refused by it.
    PostgresStudyStore::lock_sessions_for_deletion(&mut tx, user_id, study_set_uuid).await?;

    let existing_deleted_at: Option<DateTime<Utc>> = row.try_get("deleted_at").map_err(pg_error)?;
    if let Some(deleted_at) = existing_deleted_at {
        // Already a finalized tombstone. Perform no `ensure_study_set`, no seed,
        // no session update, and no child mutation; return the receipt the
        // tombstone itself implies. A tombstone that does not look like one is a
        // durability failure, never a licence to rehydrate or rescrub it.
        let title: String = row.try_get("title").map_err(pg_error)?;
        let course: Option<String> = row.try_get("course").map_err(pg_error)?;
        let exam_at: Option<DateTime<Utc>> = row.try_get("exam_at").map_err(pg_error)?;
        let exam_date: Option<chrono::NaiveDate> = row.try_get("exam_date").map_err(pg_error)?;
        let ingestion_status: String = row.try_get("ingestion_status").map_err(pg_error)?;
        let ingestion_error: Option<String> = row.try_get("ingestion_error").map_err(pg_error)?;
        let malformed = title != DELETED_STUDY_SET_TITLE
            || course.is_some()
            || exam_at.is_some()
            || exam_date.is_some()
            || ingestion_status != DELETED_ROW_CONSTANT
            || ingestion_error.is_some();
        if malformed {
            tx.rollback().await.map_err(pg_error)?;
            return Err(PortError::durability(
                "postgres",
                study_set_id,
                "deleted study set tombstone is malformed",
            ));
        }
        tx.commit().await.map_err(pg_error)?;
        return Ok(deletion_receipt(
            study_set_id,
            &format_rfc3339_millis(deleted_at),
        ));
    }

    // Sessions keep their identifiers and their original `started_at`, and
    // nothing else: mode, status, and terminal reason all become the constant.
    sqlx::query(
        "UPDATE voice_sessions
         SET mode = $3,
             status = $3,
             terminal_reason = $3,
             ended_at = COALESCE(ended_at, clock_timestamp())
         WHERE user_id = $1
           AND study_set_id = $2",
    )
    .bind(user_id)
    .bind(study_set_uuid)
    .bind(DELETED_ROW_CONSTANT)
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;

    // Session-scoped artifacts, in foreign-key order. Challenge resolutions
    // reference outcomes, and outcomes reference questions, so both go before
    // the question purge below.
    for statement in [
        "DELETE FROM session_recaps WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM concept_status_events WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM review_items WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM answer_attempts aa
         USING voice_sessions vs
         WHERE aa.voice_session_id = vs.id
           AND vs.user_id = $1
           AND vs.study_set_id = $2",
        "DELETE FROM voice_usage_events vue
         USING voice_sessions vs
         WHERE vue.voice_session_id = vs.id
           AND vs.user_id = $1
           AND vs.study_set_id = $2",
        "DELETE FROM learning_challenge_resolutions WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM learning_turn_outcomes WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM question_progression_cursors WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM event_authorization_digests WHERE user_id = $1 AND study_set_id = $2",
        "DELETE FROM voice_session_token_nonces WHERE user_id = $1 AND study_set_id = $2",
    ] {
        sqlx::query(statement)
            .bind(user_id)
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
    }

    // `D-05 HARD_PURGE_TEXT`: questions, concepts, and documents are deleted
    // outright. Deleting documents cascades their source spans; the explicit
    // question and concept deletes make the intended text purge auditable rather
    // than leaving it to `ON DELETE SET NULL`.
    for statement in [
        "DELETE FROM study_question_ingestion_cursors WHERE study_set_id = $1",
        "DELETE FROM study_questions WHERE study_set_id = $1",
        "DELETE FROM concepts WHERE study_set_id = $1",
        "DELETE FROM study_documents WHERE study_set_id = $1",
    ] {
        sqlx::query(statement)
            .bind(study_set_uuid)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;
    }

    // `exam_at` is the authoritative exam instant migration `0015` introduced and
    // `exam_date` its legacy calendar projection. Both are learner-supplied, so
    // both are cleared; the plan's Branch A SQL predates the `exam_at` column.
    let deleted_at: DateTime<Utc> = sqlx::query_scalar(
        "UPDATE study_sets
         SET title = $3,
             course = NULL,
             exam_at = NULL,
             exam_date = NULL,
             ingestion_status = $4,
             ingestion_error = NULL,
             deleted_at = COALESCE(deleted_at, clock_timestamp()),
             updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2
         RETURNING deleted_at",
    )
    .bind(study_set_uuid)
    .bind(user_id)
    .bind(DELETED_STUDY_SET_TITLE)
    .bind(DELETED_ROW_CONSTANT)
    .fetch_one(&mut *tx)
    .await
    .map_err(pg_error)?;

    tx.commit().await.map_err(pg_error)?;

    Ok(deletion_receipt(
        study_set_id,
        &format_rfc3339_millis(deleted_at),
    ))
}

pub(super) async fn delete_session_history(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<Value, PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    let owner = sqlx::query(
        "SELECT user_id, study_set_id
         FROM voice_sessions
         WHERE id = $1",
    )
    .bind(voice_session_uuid)
    .fetch_optional(&store.pool)
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

    let mut tx = store.pool.begin().await.map_err(pg_error)?;
    // `DATA-010`: same session-row lock the usage writer takes, before any
    // status mutation or artifact removal.
    sqlx::query("SELECT id FROM voice_sessions WHERE id = $1 FOR UPDATE")
        .bind(voice_session_uuid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
    // The session tombstone keeps its identifiers and its original `started_at`
    // and nothing else; mode, status, and terminal reason are all the constant.
    sqlx::query(
        "UPDATE voice_sessions
         SET mode = $2,
             status = $2,
             terminal_reason = $2,
             ended_at = COALESCE(ended_at, clock_timestamp())
         WHERE id = $1",
    )
    .bind(voice_session_uuid)
    .bind(DELETED_ROW_CONSTANT)
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
        "status": DELETED_ROW_CONSTANT,
        "policy": DATA_RETENTION_POLICY,
    }))
}
pub(super) async fn record_voice_usage(
    store: &PostgresStudyStore,
    event: VoiceUsageRecord,
) -> Result<StudyStoreWriteOutcome, PortError> {
    let voice_session_uuid = event
        .voice_session_id
        .as_deref()
        .map(PostgresStudyStore::uuid_for)
        .transpose()?;
    // `DATA-010`: the status read and the insert are one transaction, and the
    // read takes the session row's `FOR UPDATE` lock that both deletion paths
    // also take. That leaves exactly two serial orders — usage commits and
    // deletion then removes it, or deletion commits and usage observes
    // `deleted` and writes nothing — and no interleaving in which a usage row
    // outlives the deletion.
    let mut tx = store.pool.begin().await.map_err(pg_error)?;
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
    store.increment_count(WriteCountKind::VoiceUsage);
    Ok(StudyStoreWriteOutcome::Inserted)
}
