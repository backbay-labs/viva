//! Authorization and nonces: what a browser event is allowed to claim, durably
//! (`DATA-005`, `DATA-008`, `DATA-015`).
//!
//! Owned invariant: authority is a committed row, not process state. The digest
//! and the domain row it authorizes commit in one transaction or roll back
//! together, so a restart, a second instance, and the writer itself all see the
//! same answer. There is no shadow cache: a durable store that kept one would
//! lose every authorization on restart and show none of them to a second
//! instance.
//!
//! It also owns the replay ledger's retention: the prune runs inside the claiming
//! transaction on the `expires_at` index, its cutoff is `now - 60s` so a nonce
//! outlives every token that can still present it, and a duplicate claim is a
//! `Conflict` rather than a leaked unique-violation.
//!
//! `postgres.rs` keeps the port methods and delegates their whole body here.

use super::*;

impl PostgresStudyStore {
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
    pub(super) async fn insert_event_authorization<T: Serialize>(
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
    pub(super) async fn has_event_authorization<T: Serialize>(
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

    /// `DATA-008`: the deterministic nonce claim, with the clock as an argument.
    ///
    /// The public port method reads the clock once and calls this; nothing else
    /// injects a clock, so a caller cannot move the retention boundary.
    pub(crate) async fn claim_session_token_nonce_at(
        &self,
        claim: SessionTokenNonceClaim,
        now: u64,
    ) -> Result<(), PortError> {
        let study_set_uuid = Self::uuid_for(&claim.study_set_id)?;
        let voice_session_uuid = Self::uuid_for(&claim.voice_session_id)?;
        let expires_at = i64::try_from(claim.expires_at).map_err(|_| {
            PortError::invalid_input(
                "postgres",
                &claim.nonce,
                "session token expiry exceeds postgres bigint",
            )
        })?;

        // `DATA-004`: a nonce may be claimed before its session row exists, so the
        // serialization point is the study-set row the deletion finalizer locks
        // first, not the session row. Taking it here makes a concurrent deletion
        // either fully before this claim or the reason it is refused.
        let mut tx = self.pool.begin().await.map_err(pg_error)?;
        let deleted_at = sqlx::query_scalar::<sqlx::Postgres, Option<DateTime<Utc>>>(
            "SELECT deleted_at
             FROM study_sets
             WHERE id = $1 AND user_id = $2
             FOR UPDATE",
        )
        .bind(study_set_uuid)
        .bind(&claim.user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_error)?;
        if !matches!(deleted_at, Some(None)) {
            tx.rollback().await.map_err(pg_error)?;
            return Err(PortError::unavailable(
                "postgres",
                study_set_uuid.to_string(),
                "study set is not available for this user",
            ));
        }

        // `DATA-008`, statement 1 — prune. It runs inside the claim transaction, so
        // the bound advances on the same traffic that creates the rows and needs no
        // sweeper. The predicate is `expires_at < now - skew`, matching the service's
        // acceptance rule `expires_at + skew >= now`: a nonce is kept for as long as
        // any token carrying it can still be presented, and no longer. Migration
        // 0010's `voice_session_token_nonces_expiry_idx` serves it directly.
        let exclusive_cutoff =
            i64::try_from(now.saturating_sub(SESSION_TOKEN_NONCE_SKEW_SECONDS)).unwrap_or(i64::MAX);
        sqlx::query("DELETE FROM voice_session_token_nonces WHERE expires_at < $1")
            .bind(exclusive_cutoff)
            .execute(&mut *tx)
            .await
            .map_err(pg_error)?;

        // Statement 2 — claim.
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
        .bind(expires_at)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
        if result.rows_affected() == 0 {
            // Commit rather than roll back: the refused insert changed nothing, and
            // discarding the prune would mean a replay flood — the one workload that
            // grows this table fastest — never advances its own retention bound.
            tx.commit().await.map_err(pg_error)?;
            return Err(PortError::conflict(
                "postgres",
                format!(
                    "{}/{}/{}",
                    claim.user_id, claim.study_set_id, claim.voice_session_id
                ),
                "session token nonce already used",
            ));
        }
        tx.commit().await.map_err(pg_error)?;
        Ok(())
    }
}

/// The six authorization port bodies. `postgres.rs` keeps the trait signatures;
/// the durable digest comparison that decides whether a browser event is
/// authoritative lives here.
pub(super) async fn authorize_question_started(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    question: &StudyQuestion,
) -> Result<(), PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;
    let canonical = store
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

pub(super) async fn authorize_answer_evaluation(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    evaluation: &AnswerEvaluation,
) -> Result<(), PortError> {
    evaluation
        .validate_fail_closed()
        .map_err(|reason| PortError::invalid_input("postgres", &evaluation.question_id, reason))?;
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;
    let canonical = store
        .active_question_source(user_id, study_set_id, &evaluation.question_id)
        .await?;
    if canonical != evaluation.source {
        return Err(PortError::invalid_input(
            "postgres",
            &evaluation.question_id,
            "answer evaluation source tuple does not match active question source",
        ));
    }
    if !store
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
    if !store
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

pub(super) async fn authorize_source_reference(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    source: &StudySourceReference,
) -> Result<(), PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;
    let canonical = store
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

pub(super) async fn authorize_concept_status(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    concept_id: &str,
    status: &ConceptStatus,
) -> Result<(), PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;
    store.concept_uuid_for(study_set_uuid, concept_id).await?;
    let payload = ConceptStatusEventPayload { concept_id, status };
    if !store
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

pub(super) async fn authorize_manuscript_intent(
    store: &PostgresStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    intent: &agent_domain::ManuscriptIntent,
) -> Result<(), PortError> {
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;
    match intent {
        agent_domain::ManuscriptIntent::Scene { .. } => Ok(()),
        agent_domain::ManuscriptIntent::Entity {
            entity_id,
            entity_kind,
            ..
        } => match entity_kind {
            agent_domain::ManuscriptEntityKind::Concept => {
                store.concept_uuid_for(study_set_uuid, entity_id).await?;
                Ok(())
            }
            agent_domain::ManuscriptEntityKind::Source => store
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
            if store
                .concept_uuid_for(study_set_uuid, anchor_entity_id)
                .await
                .is_ok()
                || store
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

pub(super) async fn authorize_recap(
    store: &PostgresStudyStore,
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
    let study_set_uuid = PostgresStudyStore::uuid_for(study_set_id)?;
    let voice_session_uuid = PostgresStudyStore::uuid_for(voice_session_id)?;
    store
        .ensure_session(user_id, study_set_uuid, voice_session_uuid)
        .await?;
    for moment in &recap.source_moments {
        // The v2 recap moment carries only the response and source identity, so
        // deterministic retrieval is proven by resolving that source id against
        // this tenant's own spans; there is no client-supplied tuple left to
        // disagree with.
        store
            .source_reference(user_id, study_set_id, &moment.source_id)
            .await?
            .ok_or_else(|| {
                PortError::unavailable(
                    "postgres",
                    moment.source_id.clone(),
                    "recap source reference unavailable",
                )
            })?;
    }
    if !store
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
