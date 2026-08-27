//! Learning: Plan 04's canonical outcomes, progression, and projection
//! (`DATA-011`, `DATA-015`).
//!
//! Owned invariant: one authoritative record per response identity, and every
//! effect of a turn commits together or not at all. A turn outcome, its concept
//! transitions, the session's progression cursor, the selected `D-01`
//! `SERVER_PERSISTED_FSRS` schedule, and the browser authorization digest are one
//! mutation under one state write lock; an identical replay adds nothing and says
//! it replayed; one changed field under the same response identity is a `Conflict`
//! that leaves the stored value untouched.
//!
//! It also owns the two canonical reads built from those records —
//! `SessionLearningEvidence` and `AuthenticatedStudyProjectionV1` — including
//! their deterministic ordering, because a projection assembled anywhere else
//! would be a second interpretation of the same rows.
//!
//! `memory.rs` keeps the port methods and delegates their whole body here.

use super::*;

impl InMemoryStudyStore {
    /// The one progression cursor for this session, created at revision `0` if it
    /// does not exist yet.
    fn progression_record_locked<'a>(
        state: &'a mut InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> &'a mut QuestionProgressionRecord {
        let existing = state.question_progressions.iter().position(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
        });
        let index = match existing {
            Some(index) => index,
            None => {
                state.question_progressions.push(QuestionProgressionRecord {
                    user_id: user_id.to_owned(),
                    study_set_id: study_set_id.to_owned(),
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
                });
                state.question_progressions.len() - 1
            }
        };
        &mut state.question_progressions[index]
    }

    /// The one selection rule for `D-02B` ordered progression, shared by both
    /// backends through this module's semantics.
    ///
    /// A result is a pure function of the committed cursor: `current_question_id`
    /// with one recorded attempt is a fresh selection, the same question with more
    /// than one is a retry, and no current question with every active question
    /// completed is exhaustion. Nothing is inferred from the caller.
    pub(crate) fn ordered_progression_result(
        cursor: &QuestionProgressionCursor,
        active: &[StudyQuestion],
    ) -> QuestionProgressionResult {
        let total = u32::try_from(active.len()).unwrap_or(u32::MAX);
        let Some(current) = cursor.current_question_id.as_deref() else {
            return QuestionProgressionResult::Exhausted {
                completed: u32::try_from(cursor.completed_question_ids.len()).unwrap_or(u32::MAX),
                total,
                revision: cursor.revision,
            };
        };
        let position = active
            .iter()
            .position(|question| question.question_id == current)
            .unwrap_or(0);
        let ordinal = u32::try_from(position + 1).unwrap_or(u32::MAX);
        let question = active[position].clone();
        let attempt = cursor.attempt_counts.get(current).copied().unwrap_or(1);
        if attempt <= 1 {
            QuestionProgressionResult::Selected {
                question,
                ordinal,
                total,
                selection_reason: ORDERED_PROGRESSION_SELECTION_REASON.to_owned(),
                revision: cursor.revision,
            }
        } else {
            QuestionProgressionResult::Retry {
                question,
                ordinal,
                total,
                attempt,
                revision: cursor.revision,
            }
        }
    }

    /// Advance the cursor for one newly authorized response, in place.
    ///
    /// Returns `true` when the caller must persist the mutation. A response that
    /// has already been applied mutates nothing at all — replay is not a second
    /// selection, and it does not advance the revision.
    pub(crate) fn apply_ordered_selection(
        record: &mut QuestionProgressionRecord,
        response_id: &str,
        active: &[StudyQuestion],
    ) -> bool {
        if record
            .applied_response_ids
            .iter()
            .any(|applied| applied == response_id)
        {
            return false;
        }
        if record.cursor.current_question_id.is_none() {
            let next = active.iter().find(|question| {
                !record
                    .cursor
                    .completed_question_ids
                    .iter()
                    .any(|completed| completed == &question.question_id)
            });
            if let Some(next) = next {
                record.cursor.current_question_id = Some(next.question_id.clone());
                *record
                    .cursor
                    .attempt_counts
                    .entry(next.question_id.clone())
                    .or_insert(0) += 1;
            }
        } else if let Some(current) = record.cursor.current_question_id.clone() {
            *record.cursor.attempt_counts.entry(current).or_insert(0) += 1;
        }
        record.cursor.revision += 1;
        record.applied_response_ids.push(response_id.to_owned());
        true
    }

    /// Apply one recorded turn outcome's disposition to the cursor.
    ///
    /// `Advance` completes the question the cursor is actually on; `RetryCurrent`
    /// and `Deferred` keep it, and `Deferred` never adds it to
    /// `completed_question_ids`. The revision counts selections, not outcomes, so
    /// this never advances it.
    pub(crate) fn apply_outcome_disposition(
        record: &mut QuestionProgressionRecord,
        question_id: &str,
        disposition: QuestionDisposition,
    ) {
        if disposition != QuestionDisposition::Advance {
            return;
        }
        if record.cursor.current_question_id.as_deref() != Some(question_id) {
            return;
        }
        if !record
            .cursor
            .completed_question_ids
            .iter()
            .any(|completed| completed == question_id)
        {
            record
                .cursor
                .completed_question_ids
                .push(question_id.to_owned());
        }
        record.cursor.current_question_id = None;
    }

    /// The selected D-01 v1 schedule write, under a caller-held state write lock.
    ///
    /// Returns the authoritative decision and whether this call was the one that
    /// wrote it. A replay is identified by the graded outcome, never by the
    /// schedule it produced: the wall clock has moved, so a recomputed `due_at`
    /// differs. The first decision stays authoritative.
    fn persist_review_schedule_decision_locked(
        state: &mut InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: ReviewScheduleDecisionV1,
    ) -> Result<(ReviewScheduleDecisionV1, bool), PortError> {
        decision
            .validate()
            .map_err(|error| PortError::invalid_input("memory", concept_id, error.to_string()))?;
        let authorization = event_authorization_record(
            "memory",
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ReviewSchedule,
            &ReviewScheduleEventPayload::new(concept_id, &decision),
        )?;
        let review_item = ReviewItemRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            concept_id: concept_id.to_owned(),
            due_at: format_rfc3339_millis(decision.due_at),
        };
        let decision_record = ReviewScheduleDecisionRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            response_id: response_id.to_owned(),
            concept_id: concept_id.to_owned(),
            payload_sha256: authorization.payload_sha256.clone(),
            decision,
        };
        if let Some(persisted) = state
            .review_schedule_decisions
            .iter()
            .find(|record| record.is_replay_of(&decision_record))
        {
            return Ok((persisted.decision.clone(), false));
        }
        if !state.review_items.contains(&review_item) {
            state.review_items.push(review_item);
        }
        let persisted = decision_record.decision.clone();
        state.review_schedule_decisions.push(decision_record);
        // The authorization ledger stays complete across every authorized write kind.
        state.event_authorizations.insert(authorization);
        Ok((persisted, true))
    }

    /// The authoritative scheduling inputs for one concept, under a caller-held
    /// lock. D-01 forbids taking either from tool arguments.
    fn review_scheduling_context_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> ReviewSchedulingContextV1 {
        let exam_at = state
            .study_set_exam_dates
            .get(study_set_id)
            .and_then(|recorded| parse_utc_instant(recorded));
        let card = state
            .review_schedule_decisions
            .iter()
            .filter(|record| {
                record.user_id == user_id
                    && record.study_set_id == study_set_id
                    && record.concept_id == concept_id
            })
            .max_by_key(|record| record.decision.generated_at)
            .map(|record| record.decision.card.clone());
        ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at,
            card,
        }
    }

    pub(super) fn ensure_question_locked(
        study_set: &StudySetRecord,
        state: &InMemoryStudyState,
        question_id: &str,
    ) -> Result<(), PortError> {
        if study_set
            .question_ids
            .iter()
            .any(|known| known == question_id)
            && state
                .questions
                .get(&question_key(&study_set.study_set_id, question_id))
                .is_some_and(|record| record.active)
        {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            question_id,
            "question is not active for this study set",
        ))
    }

    pub(super) fn active_question_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        let study_set = Self::study_set_locked(state, user_id, study_set_id)?;
        if study_set.ingestion_status != StudySetIngestionStatus::Ready {
            return Ok(None);
        }
        for question_id in &study_set.question_ids {
            let Some(record) = state
                .questions
                .get(&question_key(study_set_id, question_id))
                .filter(|record| record.active)
            else {
                continue;
            };
            let Some(source) = Self::source_reference_locked(
                state,
                user_id,
                study_set_id,
                &record.question.source.source_id,
            ) else {
                continue;
            };
            if source != record.question.source {
                return Err(PortError::internal(
                    "memory",
                    &record.question.question_id,
                    "active question source tuple does not match deterministic retrieval",
                ));
            }
            return Ok(Some(record.question.clone()));
        }
        Ok(None)
    }

    pub(super) fn retrievable_question_count_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
    ) -> usize {
        let Some(study_set) = state.study_sets.get(study_set_id) else {
            return 0;
        };
        if study_set.user_id != user_id
            || study_set.ingestion_status != StudySetIngestionStatus::Ready
        {
            return 0;
        }
        study_set
            .question_ids
            .iter()
            .filter_map(|question_id| {
                state
                    .questions
                    .get(&question_key(study_set_id, question_id))
            })
            .filter(|record| record.active)
            .filter(|record| {
                Self::source_reference_locked(
                    state,
                    user_id,
                    study_set_id,
                    &record.question.source.source_id,
                )
                .is_some_and(|source| source == record.question.source)
            })
            .count()
    }
}

/// The one `selection_reason` `D-02B` ordered progression ever reports.
pub(crate) const ORDERED_PROGRESSION_SELECTION_REASON: &str = "ordered_v1:first_active_uncompleted";

/// `D-02B` is the recorded selection, so `AdaptiveV1` has no store implementation
/// and no store artifact. It is refused as typed invalid input rather than
/// silently answered with the ordered rule under another name.
pub(crate) fn require_selected_progression_policy(
    port: &'static str,
    policy: ProgressionPolicyId,
) -> Result<(), PortError> {
    match policy {
        ProgressionPolicyId::OrderedV1 => Ok(()),
        ProgressionPolicyId::AdaptiveV1 => Err(PortError::invalid_input(
            port,
            "adaptive_v1",
            "the recorded progression decision is ordered_v1",
        )),
    }
}

/// The learner-payload field names no persisted schema and no persisted document
/// may carry.
///
/// Migration SQL is checked against this list at build time by
/// [`crate::assert_schema_has_no_raw_payload_columns`]; canonical learning
/// documents are checked against the same list at run time, because a JSONB
/// column's shape is the type's shape and a column check cannot see inside it.
pub(crate) const FORBIDDEN_RAW_LEARNER_PAYLOAD_FIELDS: &[&str] = &[
    "raw_audio",
    "audio_blob",
    "audio_bytes",
    "document_blob",
    "document_bytes",
    "source_file_bytes",
    "answer_text",
    "prompt_text",
    "raw_prompt",
    "raw_transcript",
    "transcript_text",
    "answer_transcript",
    "source_excerpt",
    "recap_text",
];

/// The first forbidden field name anywhere in a serialized document, if any.
///
/// Keys are compared case-insensitively and at every depth: a raw payload nested
/// inside a resolution is still a raw payload.
pub(crate) fn raw_learner_payload_field(value: &Value) -> Option<&'static str> {
    match value {
        Value::Object(fields) => {
            for (key, nested) in fields {
                let lowered = key.to_ascii_lowercase();
                if let Some(forbidden) = FORBIDDEN_RAW_LEARNER_PAYLOAD_FIELDS
                    .iter()
                    .find(|forbidden| lowered == **forbidden)
                {
                    return Some(forbidden);
                }
                if let Some(found) = raw_learner_payload_field(nested) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(raw_learner_payload_field),
        _ => None,
    }
}

fn reject_raw_learner_payload<T: Serialize>(
    port: &'static str,
    id: &str,
    payload: &T,
) -> Result<(), PortError> {
    let value = serde_json::to_value(payload)
        .map_err(|error| PortError::internal(port, "canonical_payload_json", error.to_string()))?;
    if let Some(field) = raw_learner_payload_field(&value) {
        return Err(PortError::invalid_input(
            port,
            id,
            format!("canonical payload carries a raw learner field: {field}"),
        ));
    }
    Ok(())
}

/// Shape checks a store owes the canonical type before it stores it.
///
/// These are the invariants the durable schema also enforces, restated here so
/// both backends refuse the same value: an outcome that only one of them accepts
/// is a learner fact that exists on exactly one deployment.
pub(crate) fn validate_turn_outcome(
    port: &'static str,
    outcome: &TurnOutcome,
) -> Result<(), PortError> {
    if outcome.schema != VIVA_TURN_OUTCOME_SCHEMA {
        return Err(PortError::invalid_input(
            port,
            &outcome.response_id,
            "turn outcome schema is not viva.turn_outcome.v1",
        ));
    }
    if outcome.response_id.trim().is_empty() {
        return Err(PortError::invalid_input(
            port,
            "<missing>",
            "turn outcome is missing response_id",
        ));
    }
    if outcome.question_id.trim().is_empty() {
        return Err(PortError::invalid_input(
            port,
            &outcome.response_id,
            "turn outcome is missing question_id",
        ));
    }
    if parse_utc_instant(&outcome.recorded_at).is_none() {
        return Err(PortError::invalid_input(
            port,
            &outcome.response_id,
            "turn outcome recorded_at is not an RFC3339 UTC instant",
        ));
    }
    if outcome
        .supersedes_response_id
        .as_deref()
        .is_some_and(|superseded| superseded == outcome.response_id)
    {
        return Err(PortError::invalid_input(
            port,
            &outcome.response_id,
            "a turn outcome cannot supersede itself",
        ));
    }
    reject_raw_learner_payload(port, &outcome.response_id, outcome)
}

pub(crate) fn validate_challenge_resolution(
    port: &'static str,
    resolution: &ChallengeResolution,
) -> Result<(), PortError> {
    if resolution.schema != VIVA_CHALLENGE_RESOLUTION_SCHEMA {
        return Err(PortError::invalid_input(
            port,
            &resolution.correction_id,
            "challenge resolution schema is not viva.challenge_resolution.v1",
        ));
    }
    if resolution.correction_id.trim().is_empty() {
        return Err(PortError::invalid_input(
            port,
            "<missing>",
            "challenge resolution is missing correction_id",
        ));
    }
    if resolution.challenged_response_id.trim().is_empty() {
        return Err(PortError::invalid_input(
            port,
            &resolution.correction_id,
            "challenge resolution is missing challenged_response_id",
        ));
    }
    if resolution
        .replacement_response_id
        .as_deref()
        .is_some_and(|replacement| replacement == resolution.challenged_response_id)
    {
        return Err(PortError::invalid_input(
            port,
            &resolution.correction_id,
            "a replacement response cannot be the response it replaces",
        ));
    }
    reject_raw_learner_payload(port, &resolution.correction_id, resolution)
}

/// The concept transitions an outcome claims. A deferred turn claims none — the
/// canonical type has no field for them, so an empty list is structural.
pub(crate) fn turn_outcome_transitions(outcome: &TurnOutcome) -> &[ConceptStatusTransition] {
    match &outcome.resolution {
        TurnResolution::Evaluated {
            concept_transitions,
            ..
        } => concept_transitions,
        TurnResolution::Deferred { .. } => &[],
    }
}

pub(crate) fn turn_outcome_disposition(outcome: &TurnOutcome) -> QuestionDisposition {
    match &outcome.resolution {
        TurnResolution::Evaluated { disposition, .. }
        | TurnResolution::Deferred { disposition, .. } => *disposition,
    }
}

/// The learner-visible review schedule for one session, under the selected D-01
/// authority.
///
/// A decision capped by `past_exam` is persisted fail-closed but is not a review
/// the learner can act on, so D-01 excludes it from the authenticated read model;
/// this is the one place both backends apply that rule. Ordering is
/// `due_at ASC, concept_id ASC`, and a concept's latest decision is the one that
/// counts.
pub(crate) fn review_schedule_summaries<'a>(
    decisions: impl Iterator<Item = (&'a str, &'a ReviewScheduleDecisionV1)>,
) -> Vec<ReviewScheduleSummary> {
    let mut latest: std::collections::BTreeMap<String, &ReviewScheduleDecisionV1> =
        std::collections::BTreeMap::new();
    for (concept_id, decision) in decisions {
        if decision.cap_reason == Some(ReviewScheduleCapReasonV1::PastExam) {
            continue;
        }
        latest
            .entry(concept_id.to_owned())
            .and_modify(|existing| {
                if decision.generated_at > existing.generated_at {
                    *existing = decision;
                }
            })
            .or_insert(decision);
    }
    let mut summaries = latest
        .into_iter()
        .map(|(concept_id, decision)| ReviewScheduleSummary {
            concept_id,
            due_at: format_rfc3339_millis(decision.due_at),
            authority: ReviewScheduleAuthority::ServerPersistedFsrs,
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        left.due_at
            .cmp(&right.due_at)
            .then_with(|| left.concept_id.cmp(&right.concept_id))
    });
    summaries
}

/// The latest instant this session recorded a status transition for one concept.
///
/// It is read from the session's own persisted outcomes, so both backends answer
/// from the same evidence rather than from a row timestamp only one of them has.
pub(crate) fn last_reviewed_at(outcomes: &[TurnOutcome], concept_id: &str) -> Option<String> {
    outcomes
        .iter()
        .filter(|outcome| {
            turn_outcome_transitions(outcome)
                .iter()
                .any(|transition| transition.concept_id == concept_id)
        })
        .map(|outcome| outcome.recorded_at.clone())
        .max()
}

/// The whole question a session's progression cursor is on (`A-14`).
///
/// This is the server fact a *new* spoken turn is authorized by, so it carries
/// the rubric that grades the turn, not just an identity. It is derived from
/// persisted state only: the session's own committed cursor, resolved against
/// the questions this study set still publishes.
///
/// `None` — a session with no cursor, a cursor sitting on no question (a fresh
/// session, or one whose last outcome advanced past its question), or a cursor
/// naming a question the set no longer publishes — means the store cannot
/// confirm which question the server asked, and the turn fails closed rather
/// than being graded against a guess.
pub(crate) fn cursor_current_question(
    cursor: Option<&QuestionProgressionCursor>,
    published: &[StudyQuestion],
) -> Option<StudyQuestion> {
    let question_id = cursor?.current_question_id.as_deref()?;
    published
        .iter()
        .find(|question| question.question_id == question_id)
        .cloned()
}

/// The whole questions a session's persisted outcomes were graded against
/// (`A-14`).
///
/// This is the server fact a *redelivery* is rebound by: the recorded turn's own
/// disposition is what moved the cursor off its question, so the cursor cannot
/// authorize the replay and this can. Like the cursor's question it carries the
/// rubric, so a replay recomputes the same payload and the store keeps its
/// per-response payload guard instead of taking a value on trust.
///
/// Walking the published questions rather than the outcomes is what makes the
/// result structurally correct: one entry per distinct `question_id` even when
/// several outcomes (or replay rows) name the same question, the same committed
/// ingestion order in both backends, and fail-closed omission of any question
/// the set no longer publishes.
pub(crate) fn session_answered_questions(
    outcomes: &[TurnOutcome],
    published: &[StudyQuestion],
) -> Vec<StudyQuestion> {
    let answered = outcomes
        .iter()
        .map(|outcome| outcome.question_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    published
        .iter()
        .filter(|question| answered.contains(question.question_id.as_str()))
        .cloned()
        .collect()
}

/// The exact rubric wire token the browser is shown for a server-derived label
/// (`A-22`).
///
/// `EvaluationLabel`'s own serde encoding is `mostly_correct`; the browser
/// contract's token is `mostly correct`, and `AnswerEvaluation::validate_fail_closed`
/// accepts only the browser tokens. The projection that builds the event lives in
/// `agent-adapters` and this store cannot call it — `data` is a dependency of the
/// adapters, not the other way round — so the mapping is restated here.
///
/// # Known hazard: this is a duplicated mapping with no compile-time link
///
/// `agent_adapters::cartesia_gemini::projection::evaluation_label_wire` holds an
/// independent copy of the same six arms. A new `EvaluationLabel` variant breaks
/// both crates' builds (the enum is not `#[non_exhaustive]` and both matches are
/// exhaustive), but a *renamed token* in one copy compiles cleanly in the other,
/// and the divergence surfaces only at run time: the adapter's event no longer
/// hashes to the digest this store wrote, `authorize_answer_evaluation` returns
/// `Conflict`, and the socket closes a live session with `provider source
/// authority rejected`. Fail-closed, but a session kill.
///
/// `a22_evaluation_label_wire_pins_every_arm` (in `memory.rs`'s test module) pins
/// all six arms of *this* copy against literals and against
/// `AnswerEvaluation::validate_fail_closed`, so a rename here cannot pass
/// silently; the adapter copy is Plan 07's file and is pinned only where a fixture
/// happens to exercise it (`strong` in the v5 replays, `mostly correct` in
/// `store_conformance`). **Handoff:** hoisting the mapping
/// into `agent-domain` beside `is_known_evaluation_label` — the one crate both
/// sides already depend on — would delete the duplication outright, and is a
/// Plan-04-owned change this lane may not make.
pub(crate) fn evaluation_label_wire(label: EvaluationLabel) -> &'static str {
    match label {
        EvaluationLabel::Strong => "strong",
        EvaluationLabel::MostlyCorrect => "mostly correct",
        EvaluationLabel::PartiallyCorrect => "partially correct",
        EvaluationLabel::Vague => "vague",
        EvaluationLabel::Wrong => "wrong",
        EvaluationLabel::InsufficientEvidence => "insufficient evidence",
    }
}

/// The browser `answer_evaluation` payload one persisted turn authorizes
/// (`A-22`).
///
/// Plan 04's turn-outcome authority is the only writer of an evaluated turn, so
/// it is the only thing that can make that turn's browser events authoritative.
/// This is the one rule both backends derive that payload with — a second
/// interpretation would be a browser event authoritative on exactly one
/// deployment, the same failure `DATA-005` exists to prevent.
///
/// It mirrors the adapter projection exactly, because the gate compares against
/// the event the adapter will actually send: the wire label token, the outcome's
/// own feedback, its retry prompt (absent means the empty string the browser
/// contract requires), the question's canonically retrieved source, and the
/// mastery value of *this question's own concept* — falling back to the first
/// transition only when the outcome names no transition for it, which is the
/// adapter's rule too.
///
/// `None` — a deferred turn, an evaluated turn that moved no concept at all, or a
/// question this set no longer publishes — means there is no honest payload to
/// authorize, so nothing is written and the browser event fails closed at the
/// gate. `None` is never a silent success: the gate performs the same lookups and
/// refuses the event on its own.
pub(crate) fn browser_answer_evaluation(
    outcome: &TurnOutcome,
    published: &[StudyQuestion],
) -> Option<AnswerEvaluationEventPayload> {
    let TurnResolution::Evaluated {
        label,
        confidence,
        concept_transitions,
        concise_feedback,
        retry_prompt,
        ..
    } = &outcome.resolution
    else {
        return None;
    };
    let question = published
        .iter()
        .find(|question| question.question_id == outcome.question_id)?;
    let concept_status = concept_transitions
        .iter()
        .find(|transition| transition.concept_id == question.concept_id)
        .or_else(|| concept_transitions.first())?
        .to_status
        .clone();
    Some(AnswerEvaluationEventPayload {
        question_id: outcome.question_id.clone(),
        label: evaluation_label_wire(*label).to_owned(),
        concise_feedback: concise_feedback.clone(),
        retry_prompt: retry_prompt.clone().unwrap_or_default(),
        source: question.source.clone(),
        concept_status,
        confidence_score: *confidence,
    })
}

/// The projection's active question.
///
/// `LEARN-008` excludes expected terms, rubric answers, and source excerpts: a
/// citation carries identifiers, span, label, and confidence and nothing else.
/// The label is the citing document's stored display name — a fact the store
/// holds, never a calendar or prose string it invents.
pub(crate) fn projection_active_question(
    question: &StudyQuestion,
    document_title: impl Fn(&str) -> Option<String>,
) -> StudyProjectionActiveQuestionV1 {
    StudyProjectionActiveQuestionV1 {
        id: question.question_id.clone(),
        concept_id: question.concept_id.clone(),
        prompt: question.prompt.clone(),
        source_citations: vec![StudyProjectionSourceCitationV1 {
            source_id: question.source.source_id.clone(),
            document_id: question.source.document_id.clone(),
            span: question.source.span.clone(),
            label: document_title(&question.source.document_id)
                .unwrap_or_else(|| question.source.document_id.clone()),
            confidence: question.source.confidence.clone(),
        }],
    }
}

/// The learning port bodies. `memory.rs` keeps the trait signatures; the whole
/// validated mutation and the canonical reads live here.
pub(super) fn review_scheduling_context(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    concept_id: &str,
) -> Result<ReviewSchedulingContextV1, PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_concept_locked(study_set, &state, concept_id)?;

    // D-01: the exam instant is authoritative store context, never a tool argument.
    let exam_at = match state
        .study_set_exam_dates
        .get(study_set_id)
        .map(String::as_str)
    {
        None => None,
        Some(raw) => Some(parse_utc_instant(raw).ok_or_else(|| {
            PortError::internal(
                "memory",
                study_set_id,
                "study set exam date is not a parseable UTC instant",
            )
        })?),
    };

    // Only the latest valid v1 decision seeds the next review; a superseded or
    // legacy review item never becomes FSRS input.
    let card = state
        .review_schedule_decisions
        .iter()
        .filter(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.concept_id == concept_id
                && record.decision.validate().is_ok()
        })
        .max_by_key(|record| record.decision.generated_at)
        .map(|record| record.decision.card.clone());

    Ok(ReviewSchedulingContextV1 {
        schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
        exam_at,
        card,
    })
}

pub(super) fn persist_review_schedule_decision(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    concept_id: &str,
    decision: ReviewScheduleDecisionV1,
) -> Result<Value, PortError> {
    // The lock-owning wrapper. The write itself lives in the `_locked` helper so
    // Task 6's outcome mutation can perform the same write under the same single
    // state write lock, with the same replay key and the same v1 checks.
    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
    {
        let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
        InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        InMemoryStudyStore::ensure_concept_locked(study_set, &state, concept_id)?;
    }
    let (persisted, _inserted) = InMemoryStudyStore::persist_review_schedule_decision_locked(
        &mut state,
        user_id,
        study_set_id,
        voice_session_id,
        response_id,
        concept_id,
        decision,
    )?;
    Ok(persisted.public_summary(concept_id))
}
pub(super) fn record_turn_outcome(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    outcome: TurnOutcome,
) -> Result<PersistedTurnOutcome, PortError> {
    validate_turn_outcome("memory", &outcome)?;
    let digest = payload_sha256(
        "memory",
        EventAuthorizationKind::AnswerEvaluation,
        &outcome.response_id,
        &outcome,
    )?;

    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
    // `A-22`: derived under the same write lock that commits the outcome, from the
    // questions this set publishes, so the browser payload cannot be assembled
    // from state a concurrent deletion has already removed.
    let browser_evaluation = browser_answer_evaluation(
        &outcome,
        &InMemoryStudyStore::active_questions_locked(&state, study_set_id),
    );
    {
        let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
        InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        if !study_set
            .question_ids
            .iter()
            .any(|known| known == &outcome.question_id)
        {
            return Err(PortError::unavailable(
                "memory",
                &outcome.question_id,
                "question is not available for this study set",
            ));
        }
        for source_id in &outcome.source_ids {
            if InMemoryStudyStore::source_reference_locked(&state, user_id, study_set_id, source_id)
                .is_none()
            {
                return Err(PortError::unavailable(
                    "memory",
                    source_id,
                    "source is not available for this study set",
                ));
            }
        }
        for transition in turn_outcome_transitions(&outcome) {
            InMemoryStudyStore::ensure_concept_locked(study_set, &state, &transition.concept_id)?;
        }
    }
    #[cfg(test)]
    store.pause_hook(MutationSite::TurnOutcome);

    // Replay or conflict, decided on the canonical digest.
    if let Some(existing) = state.turn_outcomes.iter().find(|record| {
        record.user_id == user_id
            && record.study_set_id == study_set_id
            && record.voice_session_id == voice_session_id
            && record.response_id == outcome.response_id
    }) {
        if existing.payload_sha256 != digest || existing.outcome != outcome {
            return Err(PortError::conflict(
                "memory",
                &outcome.response_id,
                "turn outcome does not match the outcome already recorded for this response",
            ));
        }
        return Ok(PersistedTurnOutcome {
            turn_outcome: existing.outcome.clone(),
            record: TurnOutcomeRecordReceipt {
                schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                response_id: existing.outcome.response_id.clone(),
                replayed: true,
            },
        });
    }

    // A replacement may only claim mastery behind a resolution that asked for
    // reevaluation.
    if let Some(challenged) = outcome.supersedes_response_id.as_deref() {
        let challenged_exists = state.turn_outcomes.iter().any(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.response_id == challenged
        });
        if !challenged_exists {
            return Err(PortError::conflict(
                "memory",
                &outcome.response_id,
                "superseded response has no recorded outcome in this session",
            ));
        }
        let permitted = state.challenge_resolutions.iter().any(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.resolution.challenged_response_id == challenged
                && record.resolution.disposition == ChallengeDisposition::ReevaluationRequired
                && record
                    .resolution
                    .replacement_response_id
                    .as_deref()
                    .is_none_or(|replacement| replacement == outcome.response_id)
        });
        if !permitted {
            return Err(PortError::conflict(
                "memory",
                &outcome.response_id,
                "supersession requires a challenge resolution that permits reevaluation",
            ));
        }
    }

    let recorded_at = parse_utc_instant(&outcome.recorded_at).ok_or_else(|| {
        PortError::invalid_input(
            "memory",
            &outcome.response_id,
            "turn outcome recorded_at is not an RFC3339 UTC instant",
        )
    })?;

    // `A-22`: the last refusal this write can make, decided here — before the
    // first mutation below — because on this backend a late refusal is not a
    // refusal at all.
    //
    // An evaluated outcome completes the answer attempt its response identity
    // captured, so it must be grading the question that capture recorded. Postgres
    // decides the same thing at the write itself (`postgres/learning.rs`), which is
    // safe there: the whole write is one transaction and a refusal rolls it back.
    // This backend has no rollback. Refusing after the loop below would leave the
    // refused turn's `concept_statuses` rows and `ConceptStatus` authorization
    // digests behind, and `authorize_concept_status` reads exactly those two — so
    // the browser would hold live authority for a turn this call refused, on memory
    // and not on Postgres. `DATA-005` and the shared conformance suite exist to stop
    // exactly that split; `Turn F` there pins it on both backends.
    //
    // Ordered after the replay and supersession decisions above so both backends
    // still answer a replay with its receipt and rank the same conflicts the same
    // way; the checks it joins are all reads.
    if browser_evaluation.is_some() {
        let captured = state
            .answer_attempts
            .iter()
            .find(|record| {
                record.user_id == user_id
                    && record.study_set_id == study_set_id
                    && record.voice_session_id == voice_session_id
                    && record.response_id == outcome.response_id
            })
            .map(|record| record.envelope.question_id.clone());
        if captured.is_some_and(|question_id| question_id != outcome.question_id) {
            return Err(PortError::conflict(
                "memory",
                &outcome.response_id,
                "turn outcome question does not match the recorded answer attempt",
            ));
        }
    }

    for transition in turn_outcome_transitions(&outcome).to_vec() {
        if let Some(concept) = state
            .concepts
            .get_mut(&concept_key(study_set_id, &transition.concept_id))
        {
            concept.status = transition.to_status.clone();
        }
        let authorization = event_authorization_record(
            "memory",
            user_id,
            study_set_id,
            voice_session_id,
            &outcome.response_id,
            EventAuthorizationKind::ConceptStatus,
            &ConceptStatusEventPayload {
                concept_id: &transition.concept_id,
                status: &transition.to_status,
            },
        )?;
        // `A-22` — SCOPE EXTENSION, awaiting coordinator ratification.
        //
        // A-22's text obliges this authority to "populate the attempt row's
        // evaluation payload and write the event-authorization digest" — it says
        // nothing about the sibling `concept_status` event, and this write is
        // therefore not covered by a ratified amendment line. It is here because
        // the obligation is unsatisfiable in practice without it: A-22's stated
        // purpose is that a genuinely evaluated turn reaches the browser, and
        // `authorize_concept_status` in this backend refuses a `concept_status`
        // event unless a session-scoped `concept_statuses` row exists (see
        // `memory/authorization.rs`), whose only writer was the same retired
        // `record_concept_status`. Without this row the evaluated turn is admitted
        // and then dies one frame later. Recorded rather than assumed: reverting
        // this write (and its Postgres twin) turns the two Group C replays red
        // again and un-forces the four cross-lane assertion flips this unit's
        // report asks the coordinator to sanction.
        //
        // The digest alone is not what this backend's gate reads. It requires the
        // persisted status write as well, so the turn-outcome authority records the
        // same session-scoped row the retired `record_concept_status` wrote —
        // otherwise the `concept_status` browser event of a genuinely evaluated
        // turn is refused for a write that did happen.
        //
        // Guarded on the digest exactly as that retired writer was, because the
        // two backends must publish the same count for the same turn: Postgres
        // inserts this row `ON CONFLICT (…, response_id, concept_id,
        // payload_sha256) DO NOTHING` and counts only what it inserted, so an
        // unguarded push here would publish `concept_statuses + 1` where Postgres
        // publishes `+ 0` the moment any other path records the same transition
        // for the same response first. The shared conformance suite pins that
        // parity (`Turn E`); without the guard it reads as an unexplained
        // cross-backend drift rather than as a missing dedup.
        if !authorization::is_recorded_locked(&state, &authorization) {
            state.concept_statuses.push(ConceptStatusRecord {
                user_id: user_id.to_owned(),
                study_set_id: study_set_id.to_owned(),
                voice_session_id: voice_session_id.to_owned(),
                concept_id: transition.concept_id.clone(),
                status: transition.to_status.clone(),
            });
        }
        state.event_authorizations.insert(authorization);

        // D-01 `SERVER_PERSISTED_FSRS`: an evaluated turn is the graded outcome,
        // so its transition schedules the concept's next review under the same
        // lock. `LEARN-009` removed the separate scheduling tool, so this is the
        // only path that creates one.
        let context = InMemoryStudyStore::review_scheduling_context_locked(
            &state,
            user_id,
            study_set_id,
            &transition.concept_id,
        );
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
            PortError::invalid_input("memory", &transition.concept_id, error.to_string())
        })?;
        InMemoryStudyStore::persist_review_schedule_decision_locked(
            &mut state,
            user_id,
            study_set_id,
            voice_session_id,
            &outcome.response_id,
            &transition.concept_id,
            decision,
        )?;
    }

    let disposition = turn_outcome_disposition(&outcome);
    let question_id = outcome.question_id.clone();
    let progression = InMemoryStudyStore::progression_record_locked(
        &mut state,
        user_id,
        study_set_id,
        voice_session_id,
    );
    InMemoryStudyStore::apply_outcome_disposition(progression, &question_id, disposition);

    // `A-22`: an evaluated turn completes its own answer attempt and authorizes
    // its own browser evaluation, in this same locked mutation — the attempt row's
    // evaluation payload and the digest land together with the outcome or not at
    // all, exactly as the retired `record_answer_evaluation` committed them
    // together. The attempt row is the learner's capture record, so this completes
    // one that a capture already wrote and never invents one: an outcome with no
    // recorded attempt authorizes nothing, and the browser event that would have
    // claimed it fails closed at the gate.
    if let Some(payload) = browser_evaluation {
        let authorization = event_authorization_record(
            "memory",
            user_id,
            study_set_id,
            voice_session_id,
            &outcome.response_id,
            EventAuthorizationKind::AnswerEvaluation,
            &payload,
        )?;
        // The captured question was matched against this outcome above, before the
        // first mutation, and this call has held the write lock throughout — so
        // this row is the one that check passed, and there is no second place a
        // mismatch can be refused from.
        if let Some(existing) = state.answer_attempts.iter_mut().find(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.response_id == outcome.response_id
        }) {
            existing.evaluation = Some(payload.persisted_evaluation());
            authorization::record_locked(&mut state, authorization);
        }
    }

    state.turn_outcomes.push(TurnOutcomeRecord {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        response_id: outcome.response_id.clone(),
        payload_sha256: digest,
        outcome: outcome.clone(),
    });

    Ok(PersistedTurnOutcome {
        record: TurnOutcomeRecordReceipt {
            schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
            response_id: outcome.response_id.clone(),
            replayed: false,
        },
        turn_outcome: outcome,
    })
}

pub(super) fn session_learning_evidence(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<SessionLearningEvidence, PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_readable_session_locked(
        &state,
        user_id,
        study_set_id,
        voice_session_id,
    )?;

    let mut outcomes = state
        .turn_outcomes
        .iter()
        .filter(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
        })
        .map(|record| record.outcome.clone())
        .collect::<Vec<_>>();
    outcomes.sort_by(|left, right| {
        left.recorded_at
            .cmp(&right.recorded_at)
            .then_with(|| left.response_id.cmp(&right.response_id))
    });

    let mut concept_ids = outcomes
        .iter()
        .flat_map(turn_outcome_transitions)
        .map(|transition| transition.concept_id.clone())
        .collect::<Vec<_>>();
    concept_ids.sort();
    concept_ids.dedup();
    let mut concept_labels = Vec::with_capacity(concept_ids.len());
    for concept_id in concept_ids {
        let label = state
            .concepts
            .get(&concept_key(study_set_id, &concept_id))
            .map(|concept| concept.label.clone())
            .ok_or_else(|| {
                PortError::unavailable(
                    "memory",
                    &concept_id,
                    "concept is not available for this study set",
                )
            })?;
        concept_labels.push(ConceptLabel { concept_id, label });
    }
    let _ = study_set;

    let review_decisions = review_schedule_summaries(
        state
            .review_schedule_decisions
            .iter()
            .filter(|record| {
                record.user_id == user_id
                    && record.study_set_id == study_set_id
                    && record.voice_session_id == voice_session_id
            })
            .map(|record| (record.concept_id.as_str(), &record.decision)),
    );

    // `A-14`: both session-scoped question fields come from persisted state — the
    // session's committed cursor and its committed outcomes — resolved against
    // the questions this set still publishes. Nothing here is derived from a
    // caller, and a question the set no longer publishes is simply absent, which
    // fails the corresponding turn closed.
    let published = InMemoryStudyStore::active_questions_locked(&state, study_set_id);
    let cursor = state
        .question_progressions
        .iter()
        .find(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
        })
        .map(|record| &record.cursor);
    let current_question = cursor_current_question(cursor, &published);
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

pub(super) fn record_challenge_resolution(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    resolution: ChallengeResolution,
) -> Result<ChallengeResolution, PortError> {
    validate_challenge_resolution("memory", &resolution)?;
    let digest = payload_sha256(
        "memory",
        EventAuthorizationKind::AnswerEvaluation,
        &resolution.correction_id,
        &resolution,
    )?;

    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
    InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    if InMemoryStudyStore::source_reference_locked(
        &state,
        user_id,
        study_set_id,
        &resolution.source_id,
    )
    .is_none()
    {
        return Err(PortError::unavailable(
            "memory",
            &resolution.source_id,
            "source is not available for this study set",
        ));
    }
    let challenged_exists = state.turn_outcomes.iter().any(|record| {
        record.user_id == user_id
            && record.study_set_id == study_set_id
            && record.voice_session_id == voice_session_id
            && record.response_id == resolution.challenged_response_id
    });
    if !challenged_exists {
        return Err(PortError::unavailable(
            "memory",
            &resolution.challenged_response_id,
            "challenged response has no recorded outcome in this session",
        ));
    }

    if let Some(existing) = state.challenge_resolutions.iter().find(|record| {
        record.user_id == user_id
            && record.study_set_id == study_set_id
            && record.voice_session_id == voice_session_id
            && record.resolution.correction_id == resolution.correction_id
    }) {
        if existing.payload_sha256 != digest || existing.resolution != resolution {
            return Err(PortError::conflict(
                "memory",
                &resolution.correction_id,
                "challenge resolution does not match the one already recorded",
            ));
        }
        return Ok(existing.resolution.clone());
    }

    state.challenge_resolutions.push(ChallengeResolutionRecord {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        payload_sha256: digest,
        resolution: resolution.clone(),
    });
    Ok(resolution)
}

pub(super) fn select_next_question(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    policy: ProgressionPolicyId,
) -> Result<QuestionProgressionResult, PortError> {
    require_selected_progression_policy("memory", policy)?;
    let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
    InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    InMemoryStudyStore::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
    let active = InMemoryStudyStore::active_questions_locked(&state, study_set_id);
    let progression = InMemoryStudyStore::progression_record_locked(
        &mut state,
        user_id,
        study_set_id,
        voice_session_id,
    );
    InMemoryStudyStore::apply_ordered_selection(progression, response_id, &active);
    Ok(InMemoryStudyStore::ordered_progression_result(
        &progression.cursor,
        &active,
    ))
}

pub(super) fn authenticated_study_projection(
    store: &InMemoryStudyStore,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<AuthenticatedStudyProjectionV1, PortError> {
    let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
    let study_set = InMemoryStudyStore::study_set_locked(&state, user_id, study_set_id)?;
    let session = state
        .sessions
        .iter()
        .find(|session| {
            session.user_id == user_id
                && session.study_set_id == study_set_id
                && session.voice_session_id == voice_session_id
                && session.status != "deleted"
        })
        .ok_or_else(|| {
            PortError::unavailable(
                "memory",
                voice_session_id,
                "voice session is not available for this user and study set",
            )
        })?;

    let outcomes = state
        .turn_outcomes
        .iter()
        .filter(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
        })
        .map(|record| record.outcome.clone())
        .collect::<Vec<_>>();
    let review_schedule = review_schedule_summaries(
        state
            .review_schedule_decisions
            .iter()
            .filter(|record| {
                record.user_id == user_id
                    && record.study_set_id == study_set_id
                    && record.voice_session_id == voice_session_id
            })
            .map(|record| (record.concept_id.as_str(), &record.decision)),
    );

    let mut concept_ids = study_set.concept_ids.clone();
    concept_ids.sort();
    let concepts = concept_ids
        .iter()
        .filter_map(|concept_id| {
            state
                .concepts
                .get(&concept_key(study_set_id, concept_id))
                .map(|concept| StudyProjectionConceptV1 {
                    id: concept.concept_id.clone(),
                    label: concept.label.clone(),
                    status: concept.status.clone(),
                    last_reviewed_at: last_reviewed_at(&outcomes, concept_id),
                    due_at: review_schedule
                        .iter()
                        .find(|item| &item.concept_id == concept_id)
                        .map(|item| item.due_at.clone()),
                })
        })
        .collect::<Vec<_>>();

    let active = InMemoryStudyStore::active_questions_locked(&state, study_set_id);
    let cursor = state
        .question_progressions
        .iter()
        .find(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
        })
        .map(|record| record.cursor.clone());
    let active_question = cursor
        .as_ref()
        .and_then(|cursor| cursor.current_question_id.clone())
        .filter(|_| study_set.ingestion_status == StudySetIngestionStatus::Ready)
        .and_then(|question_id| {
            active
                .iter()
                .find(|question| question.question_id == question_id)
                .map(|question| {
                    projection_active_question(question, |document_id| {
                        state
                            .documents
                            .get(document_id)
                            .map(|document| document.title.clone())
                    })
                })
        });

    Ok(AuthenticatedStudyProjectionV1 {
        version: StudyProjectionVersionV1,
        study_set: StudyProjectionStudySetV1 {
            id: study_set.study_set_id.clone(),
            title: study_set.title.clone(),
            course: study_set.course.clone(),
            exam_label: state.study_set_exam_dates.get(study_set_id).cloned(),
            ingestion_status: study_set.ingestion_status.clone(),
        },
        session: StudyProjectionSessionV1 {
            id: session.voice_session_id.clone(),
            mode: session.mode.clone(),
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
