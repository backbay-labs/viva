//! Privacy: ownership, deletion, and what a tombstone is allowed to keep
//! (`DATA-004`, `DATA-010`, `COR-03`, `SEC-03`, `DATA-015`).
//!
//! Owned invariant: after the selected `D-05 HARD_PURGE_TEXT` deletion, no
//! learner-authored or learner-derived text remains anywhere, and every ordinary
//! read refuses the set. What survives is content-free by enumeration — ids,
//! timestamps, and three constants — kept only so a repeated delete stays
//! idempotent and a fixture seed cannot recreate the material behind it.
//!
//! The ownership guard is the other half of that: one tombstone-aware lookup that
//! every read and write path goes through, so "deleted" is a single decision
//! rather than a condition each caller re-derives. Deletion itself deliberately
//! does not use it — it runs its own tombstone-aware lookup so a repeated delete
//! answers idempotently instead of treating its own tombstone as an active set.
//!
//! `memory.rs` keeps the port methods and delegates their whole body here.

use super::*;

/// `D-05 HARD_PURGE_TEXT`: the constant title a deleted study set is scrubbed to.
///
/// The tombstone keeps only content-free idempotency and audit metadata — ids,
/// timestamps, and these constants — so a repeated delete stays idempotent and a
/// fixture seed cannot recreate the material behind it.
pub(crate) const DELETED_STUDY_SET_TITLE: &str = "[deleted]";

/// The constant a deleted study set's ingestion status and a deleted session's
/// mode, status, and terminal reason are all set to.
pub(crate) const DELETED_ROW_CONSTANT: &str = "deleted";

/// The selected `D-05` retention policy, reported verbatim by the deletion
/// receipt so a caller never has to infer which branch ran.
pub(crate) const DATA_RETENTION_POLICY: &str = "hard_purge_text";

/// The one deletion receipt both backends return.
///
/// Every field is content-free: the set's own identifier, the constant status and
/// policy, and the durable `deleted_at` instant. It is derivable from the
/// tombstone alone, which is what lets a repeated delete return byte-identical
/// bytes without re-reading anything it just purged.
pub(crate) fn deletion_receipt(study_set_id: &str, deleted_at: &str) -> Value {
    json!({
        "study_set_id": study_set_id,
        "status": DELETED_ROW_CONSTANT,
        "policy": DATA_RETENTION_POLICY,
        "deleted_at": deleted_at,
    })
}

impl InMemoryStudyStore {
    pub(super) fn study_set_locked<'a>(
        state: &'a InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<&'a StudySetRecord, PortError> {
        let study_set = state.study_sets.get(study_set_id).ok_or_else(|| {
            PortError::unavailable("memory", study_set_id, "study set does not exist")
        })?;
        if study_set.user_id != user_id {
            return Err(PortError::unavailable(
                "memory",
                study_set_id,
                "study set is not available for this user",
            ));
        }
        // `DATA-004`: the ordinary ownership guard is tombstone-aware. Deletion
        // itself deliberately does not come through here — it runs its own locked,
        // tombstone-aware lookup so a repeated delete can answer idempotently
        // instead of treating its own tombstone as an active set.
        if state.deleted_study_sets.contains_key(study_set_id) {
            return Err(PortError::unavailable(
                "memory",
                study_set_id,
                "study set has been deleted",
            ));
        }
        Ok(study_set)
    }

    pub(super) fn ensure_session_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<(), PortError> {
        if state.sessions.iter().any(|session| {
            session.user_id == user_id
                && session.study_set_id == study_set_id
                && session.voice_session_id == voice_session_id
                && session.status == "open"
        }) {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            voice_session_id,
            "voice session is not available for this user and study set",
        ))
    }

    /// A session that can still be read: the tenant owns it and it is not deleted.
    ///
    /// Evidence and recaps outlive the live session, so a closed session must
    /// still answer; a deleted one must not.
    pub(super) fn ensure_readable_session_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<(), PortError> {
        if state.sessions.iter().any(|session| {
            session.user_id == user_id
                && session.study_set_id == study_set_id
                && session.voice_session_id == voice_session_id
                && session.status != "deleted"
        }) {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            voice_session_id,
            "voice session is not available for this user and study set",
        ))
    }
}

pub(super) fn remove_session_artifacts(
    state: &mut InMemoryStudyState,
    user_id: &str,
    study_set_id: &str,
    voice_session_ids: &HashSet<String>,
) {
    if voice_session_ids.is_empty() {
        return;
    }
    state.recaps.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.review_items.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.review_schedule_decisions.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.concept_statuses.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state
        .answer_attempts
        .retain(|record| !voice_session_ids.contains(&record.voice_session_id));
    state.voice_usage_events.retain(|record| {
        record
            .voice_session_id
            .as_ref()
            .is_none_or(|session_id| !voice_session_ids.contains(session_id))
    });
    state.event_authorizations.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.turn_outcomes.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.challenge_resolutions.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.question_progressions.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.session_token_nonces.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
}

/// Whether this set has been deleted, under the caller's already-held state
/// lock.
///
/// `DATA-004`: the one place a read path asks "is this a tombstone?", so every
/// projection excludes a deleted set for the same reason and by the same test.
pub(super) fn is_deleted_locked(state: &InMemoryStudyState, study_set_id: &str) -> bool {
    state.deleted_study_sets.contains_key(study_set_id)
}

/// The privacy port bodies. `memory.rs` keeps the trait signatures; the locked
/// deletion, the usage/delete serialization, and the receipt live here.
pub(super) fn delete_study_set(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
) -> Result<Value, PortError> {
    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;

    // `DATA-004`: deletion runs its own tombstone-aware ownership lookup rather
    // than `study_set_locked`, which now refuses a tombstone. Without that split
    // a repeated delete would treat its own tombstone as an unavailable set and
    // stop being idempotent.
    let owned = state.study_sets.get(study_set_id).ok_or_else(|| {
        PortError::unavailable("memory", study_set_id, "study set does not exist")
    })?;
    if owned.user_id != user_id {
        return Err(PortError::unavailable(
            "memory",
            study_set_id,
            "study set is not available for this user",
        ));
    }

    if let Some(deleted_at) = state.deleted_study_sets.get(study_set_id).cloned() {
        // Already finalized. Perform no session update and no child mutation:
        // return the receipt the tombstone itself implies. A tombstone that does
        // not look like one is a durability failure, not a licence to rescrub.
        let tombstone = state
            .study_sets
            .get(study_set_id)
            .expect("the tombstone was just read under this lock");
        if tombstone.title != DELETED_STUDY_SET_TITLE
            || tombstone.course.is_some()
            || tombstone.ingestion_error.is_some()
            || !tombstone.concept_ids.is_empty()
            || !tombstone.question_ids.is_empty()
        {
            return Err(PortError::durability(
                "memory",
                study_set_id,
                "deleted study set tombstone is malformed",
            ));
        }
        return Ok(deletion_receipt(study_set_id, &deleted_at));
    }

    // Sessions keep their identity and nothing else.
    let mut affected_sessions = HashSet::new();
    for session in state
        .sessions
        .iter_mut()
        .filter(|session| session.user_id == user_id && session.study_set_id == study_set_id)
    {
        affected_sessions.insert(session.voice_session_id.clone());
        session.status = DELETED_ROW_CONSTANT.to_owned();
        session
            .ended_at
            .get_or_insert_with(|| DELETED_ROW_CONSTANT.to_owned());
        session.terminal_reason = Some(DELETED_ROW_CONSTANT.to_owned());
    }
    remove_session_artifacts(&mut state, user_id, study_set_id, &affected_sessions);
    // `DATA-008`/`DATA-004`: nonces are scoped to the *set*, not to the session
    // rows that happen to exist. A nonce is legitimately claimable before its
    // session row is written — `claim_session_token_nonce` locks the study set
    // for exactly that reason — so scoping this removal by `affected_sessions`
    // would leave a learner-scoped row behind for every session that never
    // opened. The durable backend deletes by `(user_id, study_set_id)`; this is
    // the same statement.
    state
        .session_token_nonces
        .retain(|record| record.user_id != user_id || record.study_set_id != study_set_id);

    // `D-05 HARD_PURGE_TEXT`: learner-authored and learner-derived material is
    // removed, not deactivated. Tombstoning a document and deactivating a
    // question left the excerpt, the display name, the concept label, and the
    // prompt in memory forever, which is exactly what this branch forbids.
    state
        .questions
        .retain(|_, record| record.study_set_id != study_set_id);
    state
        .concepts
        .retain(|_, record| record.study_set_id != study_set_id);
    state
        .source_spans
        .retain(|_, record| record.study_set_id != study_set_id);
    state
        .documents
        .retain(|_, record| record.study_set_id != study_set_id);
    state.study_set_exam_dates.remove(study_set_id);

    let deleted_at = format_rfc3339_millis(Utc::now());
    let tombstone = state
        .study_sets
        .get_mut(study_set_id)
        .expect("the study set was just read under this lock");
    tombstone.title = DELETED_STUDY_SET_TITLE.to_owned();
    tombstone.course = None;
    tombstone.ingestion_error = None;
    tombstone.concept_ids.clear();
    tombstone.question_ids.clear();
    state
        .deleted_study_sets
        .insert(study_set_id.to_owned(), deleted_at.clone());

    Ok(deletion_receipt(study_set_id, &deleted_at))
}

pub(super) fn delete_session_history(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<Value, PortError> {
    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
    InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;

    let session = state
        .sessions
        .iter_mut()
        .find(|session| session.voice_session_id == voice_session_id)
        .ok_or_else(|| {
            PortError::unavailable("memory", voice_session_id, "voice session does not exist")
        })?;
    if session.user_id != user_id || session.study_set_id != study_set_id {
        return Err(PortError::unavailable(
            "memory",
            voice_session_id,
            "voice session is not available for this user and study set",
        ));
    }

    session.status = DELETED_ROW_CONSTANT.to_owned();
    session
        .ended_at
        .get_or_insert_with(|| DELETED_ROW_CONSTANT.to_owned());
    session.terminal_reason = Some(DELETED_ROW_CONSTANT.to_owned());

    let affected_sessions = HashSet::from([voice_session_id.to_owned()]);
    remove_session_artifacts(&mut state, user_id, study_set_id, &affected_sessions);

    // The same content-free shape the durable backend returns. The old
    // `already_deleted` flag existed on this backend only, had no reader, and
    // made a repeated delete's response differ from the first one's.
    Ok(json!({
        "voice_session_id": voice_session_id,
        "study_set_id": study_set_id,
        "status": DELETED_ROW_CONSTANT,
        "policy": DATA_RETENTION_POLICY,
    }))
}
/// `DATA-010` for this backend: the session-status check and the usage append
/// happen under one state write lock, which is the same lock both deletion
/// paths hold while they mutate session status and remove artifacts.
///
/// That leaves exactly two serial orders — usage commits and the deletion then
/// removes it, or the deletion commits and usage observes `deleted` and writes
/// nothing. Usage carries no stable event identity, so an accepted write is
/// always a real `Inserted`; this backend never reports a replay it cannot
/// identify.
pub(super) fn record_voice_usage(
    store: &InMemoryStudyStore,
    event: VoiceUsageRecord,
) -> Result<StudyStoreWriteOutcome, PortError> {
    let record = PersistedVoiceUsage::from(&event);
    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
    if let Some(voice_session_id) = record.voice_session_id.as_deref() {
        let status = state
            .sessions
            .iter()
            .find(|session| session.voice_session_id == voice_session_id)
            .map(|session| session.status.as_str());
        if status == Some("deleted") {
            // No record was written, so neither write outcome is true here.
            return Err(PortError::conflict(
                "memory",
                voice_session_id,
                "voice session was deleted before usage could be recorded",
            ));
        }
    }
    #[cfg(test)]
    store.pause_hook(MutationSite::VoiceUsage);
    state.voice_usage_events.push(record);
    Ok(StudyStoreWriteOutcome::Inserted)
}
