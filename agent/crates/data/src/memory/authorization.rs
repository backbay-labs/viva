//! Authorization and nonces: what a browser event is allowed to claim
//! (`DATA-005`, `DATA-008`, `DATA-015`).
//!
//! Owned invariant: a browser event is authoritative only if this store already
//! wrote that exact payload, for that exact tenant, set, session, response, and
//! event kind. The canonical digest is one implementation shared by both backends
//! — kind bytes, NUL, response-id bytes, NUL, canonical JSON — so a payload one
//! backend accepts cannot be one the other rejects, and no raw event JSON is ever
//! stored.
//!
//! It also owns the replay ledger's retention: a nonce is kept for as long as any
//! token carrying it can still be presented (`expires_at` plus the published
//! 60-second skew) and no longer, and a duplicate claim is a `Conflict`.
//!
//! `memory.rs` keeps the port methods and delegates their whole body here.

use super::*;

/// The one canonical authorization record both backends build.
///
/// `DATA-005`: memory and Postgres have to agree, byte for byte, on what a
/// digest is — a digest one backend accepts and the other rejects is a browser
/// event that is authoritative on exactly one deployment. So there is one
/// implementation, taking only the backend's own port label for error
/// attribution, and neither backend hashes an ad hoc map or a
/// backend-specific projection.
pub(crate) fn event_authorization_record<T: Serialize>(
    port: &'static str,
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
        payload_sha256: payload_sha256(port, kind, response_id, payload)?,
    })
}

/// Exactly 64 lowercase hexadecimal characters over event-kind bytes, NUL,
/// response-id bytes, NUL, and the canonical JSON encoding of the typed payload.
pub(crate) fn payload_sha256<T: Serialize>(
    port: &'static str,
    kind: EventAuthorizationKind,
    response_id: &str,
    payload: &T,
) -> Result<String, PortError> {
    let payload = serde_json::to_vec(payload).map_err(|error| {
        PortError::internal(port, "event_authorization_payload", error.to_string())
    })?;
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

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventAuthorizationKind {
    AnswerEvaluation,
    ConceptStatus,
    ReviewSchedule,
    StudySessionRecap,
}

impl EventAuthorizationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AnswerEvaluation => "answer_evaluation",
            Self::ConceptStatus => "concept_status",
            Self::ReviewSchedule => "review_schedule",
            Self::StudySessionRecap => "study_session_recap",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct EventAuthorizationRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub response_id: String,
    pub kind: EventAuthorizationKind,
    pub payload_sha256: String,
}

#[derive(Serialize)]
pub(crate) struct ConceptStatusEventPayload<'a> {
    pub(crate) concept_id: &'a str,
    pub(crate) status: &'a ConceptStatus,
}

/// The server-derived half of the browser's `answer_evaluation` payload.
///
/// `A-22`: the browser event is an [`AnswerEvaluation`], and every field of it
/// except `answer_text` is something this store decided — the wire label, the
/// feedback, the retry prompt, the re-retrieved source, the mastery value, and
/// the confidence all come from the persisted [`TurnOutcome`] and the question it
/// names. `answer_text` is the transcript the transport carried. No canonical
/// persistence type has a field for it (`TurnOutcome` has none, and the store
/// publishes `transcript_persistence: false`), so the store cannot bind it and
/// must not pretend to: a digest may only bind what the store itself decided.
/// This is the same rule [`ReviewScheduleEventPayload`] follows when it hashes
/// the graded inputs and not the clock-derived date they produce.
///
/// Nothing is left unguarded by that boundary. The same transcript reaches the
/// same browser through `transcript_delta`/`transcript_final`, which the socket
/// hands over with no authorization at all, so binding it here would protect
/// nothing. Every field that *is* a server fact is bound, including the two —
/// `concise_feedback` and `retry_prompt` — that the `answer_attempts` row does
/// not carry and that only this digest can hold the event to.
///
/// The field order is [`AnswerEvaluation`]'s own, minus the transcript, so the
/// canonical JSON this hashes reads as the browser payload it stands for.
#[derive(Serialize)]
pub(crate) struct AnswerEvaluationEventPayload {
    pub(crate) question_id: String,
    pub(crate) label: String,
    pub(crate) concise_feedback: String,
    pub(crate) retry_prompt: String,
    pub(crate) source: StudySourceReference,
    pub(crate) concept_status: ConceptStatus,
    pub(crate) confidence_score: f32,
}

impl AnswerEvaluationEventPayload {
    /// The projection of an event a browser is presenting, for the gate.
    pub(crate) fn from_browser_event(evaluation: &AnswerEvaluation) -> Self {
        Self {
            question_id: evaluation.question_id.clone(),
            label: evaluation.label.clone(),
            concise_feedback: evaluation.concise_feedback.clone(),
            retry_prompt: evaluation.retry_prompt.clone(),
            source: evaluation.source.clone(),
            concept_status: evaluation.concept_status.clone(),
            confidence_score: evaluation.confidence_score,
        }
    }

    /// The row projection the `answer_attempts` tuple keeps for the same event.
    pub(crate) fn persisted_evaluation(&self) -> PersistedAnswerEvaluation {
        PersistedAnswerEvaluation {
            question_id: self.question_id.clone(),
            label: self.label.clone(),
            concept_status: self.concept_status.clone(),
            confidence_score: self.confidence_score,
            source: PersistedSourceReference::from(&self.source),
        }
    }
}

/// The replay-stable half of a scheduling outcome: the graded inputs, never the
/// clock-derived schedule they produce. Two calls that differ only because the wall
/// clock moved hash identically here, which is what makes a replay detectable.
#[derive(Serialize)]
pub(crate) struct ReviewScheduleEventPayload<'a> {
    concept_id: &'a str,
    policy_id: &'a str,
    status: &'a ConceptStatus,
    rating: u8,
    hint_count: Option<u32>,
    miss_count: Option<u32>,
}

impl<'a> ReviewScheduleEventPayload<'a> {
    pub(crate) fn new(concept_id: &'a str, decision: &'a ReviewScheduleDecisionV1) -> Self {
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

/// `DATA-008`: the published session-token clock skew, in seconds.
///
/// This mirrors `agent_service::config::EXPIRY_CLOCK_SKEW_SECONDS`, whose
/// verification rule is `claims.expires_at + EXPIRY_CLOCK_SKEW_SECONDS < now`
/// rejects. `data` cannot import it — `agent-service` depends on this crate, not
/// the other way round — so the number is restated here with the rule it serves:
/// a nonce must outlive every token that can still be presented with it, or
/// bounding retention would open exactly the replay window the ledger exists to
/// close. If Plan 08 ever changes that constant, this one changes with it.
pub(crate) const SESSION_TOKEN_NONCE_SKEW_SECONDS: u64 = 60;

/// Wall-clock epoch seconds, read once per port call.
///
/// A clock before the epoch is impossible in practice and would only make the
/// retention window wider, never narrower, so it saturates to zero rather than
/// panicking inside a store write.
pub(crate) fn current_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

impl InMemoryStudyStore {
    /// `DATA-008`: the deterministic nonce claim, with the clock as an argument.
    ///
    /// The public port method reads the clock once and calls this; nothing else
    /// injects a clock, so a caller cannot move the retention boundary.
    pub(crate) fn claim_session_token_nonce_at(
        &self,
        claim: SessionTokenNonceClaim,
        now: u64,
    ) -> Result<(), PortError> {
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        Self::study_set_locked(&state, &claim.user_id, &claim.study_set_id)?;
        // Prune before the claim, under the same write lock, so no observer can see
        // a ledger that has forgotten a nonce whose token is still presentable.
        //
        // The boundary is `expires_at + skew >= now`, not `expires_at >= now`:
        // service verification accepts a token for a further
        // `SESSION_TOKEN_NONCE_SKEW_SECONDS`, and dropping the nonce at `expires_at`
        // would hand that whole interval to a replay.
        state.session_token_nonces.retain(|record| {
            record
                .expires_at
                .saturating_add(SESSION_TOKEN_NONCE_SKEW_SECONDS)
                >= now
        });
        if state.session_token_nonces.iter().any(|used| {
            used.user_id == claim.user_id
                && used.study_set_id == claim.study_set_id
                && used.voice_session_id == claim.voice_session_id
                && used.nonce == claim.nonce
        }) {
            return Err(PortError::conflict(
                "memory",
                format!(
                    "{}/{}/{}",
                    claim.user_id, claim.study_set_id, claim.voice_session_id
                ),
                "session token nonce already used",
            ));
        }
        state.session_token_nonces.push(claim);
        Ok(())
    }
}

/// Record one authorization under the caller's already-held state write lock.
///
/// `DATA-005`: the digest and the domain record it authorizes are committed by
/// the same locked mutation, and the collection deduplicates, so an identical
/// replay cannot grow it.
pub(super) fn record_locked(state: &mut InMemoryStudyState, record: EventAuthorizationRecord) {
    state.event_authorizations.insert(record);
}

/// Whether this exact authorization is already on record, under the caller's
/// already-held state lock. The idempotency test for a replayed write.
pub(super) fn is_recorded_locked(
    state: &InMemoryStudyState,
    record: &EventAuthorizationRecord,
) -> bool {
    state.event_authorizations.contains(record)
}

/// End one session's browser authority, under the caller's already-held state
/// write lock.
///
/// `DATA-005`: an *open* session may resume across a restart or on a second
/// instance; a closed or deleted one may not replay browser authority anywhere.
pub(super) fn evict_session_locked(state: &mut InMemoryStudyState, voice_session_id: &str) {
    state
        .event_authorizations
        .retain(|record| record.voice_session_id != voice_session_id);
}

/// The six authorization port bodies. `memory.rs` keeps the trait signatures; the
/// digest comparison that decides whether a browser event is authoritative lives
/// here.
pub(super) fn authorize_question_started(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    question: &StudyQuestion,
) -> Result<(), PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    let canonical = InMemoryStudyStore::active_question_locked(&state, user_id, study_set_id)?
        .ok_or_else(|| {
            PortError::unavailable(
                "memory",
                &question.question_id,
                "question is not active for this study set",
            )
        })?;
    if canonical != *question {
        return Err(PortError::invalid_input(
            "memory",
            &question.question_id,
            "question tuple does not match deterministic retrieval",
        ));
    }
    Ok(())
}

pub(super) fn authorize_answer_evaluation(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    evaluation: &AnswerEvaluation,
) -> Result<(), PortError> {
    evaluation
        .validate_fail_closed()
        .map_err(|reason| PortError::invalid_input("memory", &evaluation.question_id, reason))?;
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    let canonical_source = InMemoryStudyStore::active_question_source_locked(
        study_set,
        &state,
        user_id,
        &evaluation.question_id,
    )?;
    if canonical_source != evaluation.source {
        return Err(PortError::invalid_input(
            "memory",
            &evaluation.question_id,
            "answer evaluation source tuple does not match active question source",
        ));
    }
    let persisted = PersistedAnswerEvaluation::from(evaluation);
    if !state.answer_attempts.iter().any(|record| {
        record.user_id == user_id
            && record.study_set_id == study_set_id
            && record.voice_session_id == voice_session_id
            && record.response_id == response_id
            && record.evaluation.as_ref() == Some(&persisted)
    }) {
        return Err(PortError::conflict(
            "memory",
            response_id,
            "answer evaluation event does not match persisted answer attempt",
        ));
    }
    let authorization = event_authorization_record(
        "memory",
        user_id,
        study_set_id,
        voice_session_id,
        response_id,
        EventAuthorizationKind::AnswerEvaluation,
        &AnswerEvaluationEventPayload::from_browser_event(evaluation),
    )?;
    if !state.event_authorizations.contains(&authorization) {
        return Err(PortError::conflict(
            "memory",
            response_id,
            "answer evaluation event does not match authorized browser payload",
        ));
    }
    Ok(())
}

pub(super) fn authorize_source_reference(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    source: &StudySourceReference,
) -> Result<(), PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    let canonical = InMemoryStudyStore::source_reference_locked(
        &state,
        user_id,
        study_set_id,
        &source.source_id,
    )
    .ok_or_else(|| {
        PortError::unavailable(
            "memory",
            &source.source_id,
            "source reference is not available for this user and study set",
        )
    })?;
    if canonical != *source {
        return Err(PortError::invalid_input(
            "memory",
            &source.source_id,
            "source tuple does not match deterministic retrieval",
        ));
    }
    Ok(())
}

pub(super) fn authorize_concept_status(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    concept_id: &str,
    status: &ConceptStatus,
) -> Result<(), PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    InMemoryStudyStore::ensure_concept_locked(study_set, &state, concept_id)?;
    if !state.concept_statuses.iter().any(|record| {
        record.user_id == user_id
            && record.study_set_id == study_set_id
            && record.voice_session_id == voice_session_id
            && record.concept_id == concept_id
            && record.status == *status
    }) {
        return Err(PortError::conflict(
            "memory",
            response_id,
            "concept status event does not match persisted concept status write",
        ));
    }
    let payload = ConceptStatusEventPayload { concept_id, status };
    let authorization = event_authorization_record(
        "memory",
        user_id,
        study_set_id,
        voice_session_id,
        response_id,
        EventAuthorizationKind::ConceptStatus,
        &payload,
    )?;
    if !state.event_authorizations.contains(&authorization) {
        return Err(PortError::conflict(
            "memory",
            response_id,
            "concept status event does not match authorized browser payload",
        ));
    }
    Ok(())
}

pub(super) fn authorize_manuscript_intent(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    intent: &agent_domain::ManuscriptIntent,
) -> Result<(), PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    match intent {
        agent_domain::ManuscriptIntent::Scene { .. } => Ok(()),
        agent_domain::ManuscriptIntent::Entity {
            entity_id,
            entity_kind,
            ..
        } => match entity_kind {
            agent_domain::ManuscriptEntityKind::Concept => {
                InMemoryStudyStore::ensure_concept_locked(study_set, &state, entity_id)
            }
            agent_domain::ManuscriptEntityKind::Source => {
                InMemoryStudyStore::source_reference_locked(
                    &state,
                    user_id,
                    study_set_id,
                    entity_id,
                )
                .map(|_| ())
                .ok_or_else(|| {
                    PortError::unavailable(
                        "memory",
                        entity_id,
                        "source entity is not available for this study set",
                    )
                })
            }
            agent_domain::ManuscriptEntityKind::MarginalNote => Err(PortError::unavailable(
                "memory",
                entity_id,
                "marginal note entity is not server-owned",
            )),
        },
        agent_domain::ManuscriptIntent::Marginalia {
            anchor_entity_id, ..
        } => {
            if InMemoryStudyStore::ensure_concept_locked(study_set, &state, anchor_entity_id)
                .is_ok()
                || InMemoryStudyStore::source_reference_locked(
                    &state,
                    user_id,
                    study_set_id,
                    anchor_entity_id,
                )
                .is_some()
            {
                return Ok(());
            }
            Err(PortError::unavailable(
                "memory",
                anchor_entity_id,
                "marginalia anchor is not available for this study set",
            ))
        }
    }
}

pub(super) fn authorize_recap(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    recap: &StudySessionRecap,
) -> Result<(), PortError> {
    if recap.voice_session_id != voice_session_id {
        return Err(PortError::invalid_input(
            "memory",
            voice_session_id,
            "recap session does not match authorized session",
        ));
    }
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let _study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    for moment in &recap.source_moments {
        // The v2 recap moment carries only the response and source identity, so
        // deterministic retrieval is proven by resolving that source id against
        // this tenant's own spans; there is no client-supplied tuple left to
        // disagree with.
        InMemoryStudyStore::source_reference_locked(
            &state,
            user_id,
            study_set_id,
            &moment.source_id,
        )
        .ok_or_else(|| {
            PortError::unavailable(
                "memory",
                moment.source_id.clone(),
                "recap source reference unavailable",
            )
        })?;
    }
    let authorization = event_authorization_record(
        "memory",
        user_id,
        study_set_id,
        voice_session_id,
        response_id,
        EventAuthorizationKind::StudySessionRecap,
        recap,
    )?;
    if !state.event_authorizations.contains(&authorization) {
        return Err(PortError::conflict(
            "memory",
            response_id,
            "recap event does not match authorized browser payload",
        ));
    }
    Ok(())
}
