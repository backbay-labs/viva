//! Domain-event projection for the Cartesia/Gemini adapter.
//!
//! `ADAPTER-11`: this module is provider-I/O-free by construction. It converts a
//! persisted Plan 04 `TurnOutcome`, a resolved source, an audio result, and a
//! legal Plan 06 `StudySessionState` transition into `BrainEvent`s, and it emits
//! them through the turn's one cooperative cancellation signal. It never parses
//! provider JSON, never builds an HTTP or WebSocket request, and never decides a
//! learner fact of its own.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use agent_domain::{
    learning_outcome::{VIVA_TURN_OUTCOME_RECORD_SCHEMA, VIVA_TURN_OUTCOME_SCHEMA},
    AnswerEvaluation, BrainError, BrainEvent, BrainFailureClass, BrainFailureStage,
    BrainProviderError, BrainProviderFailureParts, EvaluationLabel, PersistedTurnOutcome,
    StudyQuestion, StudySessionPhase, StudySessionRecap, StudySessionState, StudySourceReference,
    TurnOutcome, TurnResolution,
};

use super::brain_failure;

/// The session's phase, driven only through Plan 06's one legal-transition
/// table.
///
/// A raw `SessionPhase` send cannot exist behind this type: every emission is a
/// transition the domain accepted, and a rejected transition becomes a typed
/// domain failure *before* any event is produced.
#[derive(Clone)]
pub(crate) struct SessionPhaseTracker {
    state: Arc<Mutex<StudySessionState>>,
}

impl SessionPhaseTracker {
    pub(crate) fn ready() -> Self {
        Self {
            state: Arc::new(Mutex::new(StudySessionState::ready())),
        }
    }

    /// Enter `listening` for a newly accepted turn.
    ///
    /// A fresh or completed turn moves forward through the legal table; a turn
    /// that replaced one still in flight uses the machine's one explicit
    /// backward motion, which is exactly what a barge-in is. Neither path
    /// invents a transition the domain does not allow.
    pub(crate) fn begin_turn(&self) -> Result<BrainEvent, BrainError> {
        let mut state = self.state.lock().map_err(|_| phase_machine_failure())?;
        let phase = if state
            .phase()
            .can_transition_to(StudySessionPhase::Listening)
        {
            state.transition(StudySessionPhase::Listening)
        } else {
            state.restart_after_cancellation()
        }
        .map_err(|_| phase_machine_failure())?;
        Ok(BrainEvent::SessionPhase { phase })
    }

    pub(crate) fn phase_event(&self, to: StudySessionPhase) -> Result<BrainEvent, BrainError> {
        let mut state = self.state.lock().map_err(|_| phase_machine_failure())?;
        state
            .transition(to)
            .map(|phase| BrainEvent::SessionPhase { phase })
            .map_err(|_| phase_machine_failure())
    }

    /// The one deliberately permissive reader: session teardown claims the recap
    /// phase only when the session actually reached a phase that leads there. A
    /// session that never took a turn simply never claims it, which is not a
    /// rejected emission but an emission that is never attempted.
    pub(crate) fn phase_event_if_legal(&self, to: StudySessionPhase) -> Option<BrainEvent> {
        let mut state = self.state.lock().ok()?;
        state
            .transition(to)
            .ok()
            .map(|phase| BrainEvent::SessionPhase { phase })
    }

    #[cfg(test)]
    pub(crate) fn phase(&self) -> StudySessionPhase {
        self.state.lock().expect("phase lock poisoned").phase()
    }
}

fn phase_machine_failure() -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::ToolExecutorFailure,
        stage: BrainFailureStage::Session,
        retry_eligible: false,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "viva-session".to_owned(),
        metadata: "error_kind=illegal_phase_transition".to_owned(),
    })
}

/// The unclassified tool-contract failure, as parts.
///
/// Seams that hold a typed store error hand these to
/// [`super::classified_failure`] so a `PortErrorKind` that Plan 06 publishes a
/// class for overrides the class, stage, and retry policy chosen here.
pub(crate) fn outcome_contract_parts(error_kind: &'static str) -> BrainProviderFailureParts {
    BrainProviderFailureParts {
        failure_class: BrainFailureClass::ToolExecutorFailure,
        stage: BrainFailureStage::Tools,
        retry_eligible: false,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "viva-tools".to_owned(),
        metadata: format!("error_kind={error_kind}"),
    }
}

pub(crate) fn outcome_contract_failure(error_kind: &'static str) -> BrainError {
    brain_failure(outcome_contract_parts(error_kind))
}

/// Deserialize the Plan 04 executor's `evaluate_spoken_answer` payload.
///
/// The wrapper has exactly two members and the adapter reads exactly one of
/// them: `record` is checked for its schema and for naming this very response,
/// and is then never consulted for a learner fact. Validation happens before any
/// event, transition, disposition, schedule, or recap exists.
pub(crate) fn parse_persisted_turn_outcome(
    result: &Value,
    response_id: &str,
) -> Result<TurnOutcome, BrainError> {
    let persisted: PersistedTurnOutcome = serde_json::from_value(result.clone())
        .map_err(|_| outcome_contract_failure("persisted_turn_outcome_malformed"))?;
    if persisted.record.schema != VIVA_TURN_OUTCOME_RECORD_SCHEMA {
        return Err(outcome_contract_failure("turn_outcome_receipt_schema"));
    }
    if persisted.turn_outcome.schema != VIVA_TURN_OUTCOME_SCHEMA {
        return Err(outcome_contract_failure("turn_outcome_schema"));
    }
    if persisted.record.response_id != persisted.turn_outcome.response_id {
        return Err(outcome_contract_failure("turn_outcome_receipt_response_id"));
    }
    if persisted.turn_outcome.response_id != response_id {
        return Err(outcome_contract_failure("turn_outcome_response_id"));
    }
    Ok(persisted.turn_outcome)
}

/// The v2 recap the Plan 04 executor folded from persisted evidence.
pub(crate) fn recap_from_tool_result(result: &Value) -> Result<StudySessionRecap, BrainError> {
    serde_json::from_value(
        result
            .get("recap")
            .cloned()
            .ok_or_else(|| outcome_contract_failure("recap_payload_missing"))?,
    )
    .map_err(|_| outcome_contract_failure("recap_payload_malformed"))
}

/// The exact rubric wire token for a server-derived label. The adapter maps, it
/// never chooses: every arm is a `EvaluationLabel` the executor already decided.
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

/// Project a persisted evaluated outcome into the browser's evaluation payload.
///
/// Every graded field is copied from the outcome. `answer_text` is the
/// transcript this turn actually carried — a transport fact, never a grade — and
/// the source is the one the executor re-retrieved for a rubric-authorized id.
///
/// The learner-visible mastery value is the one the executor persisted for this
/// turn's own concept, or failing that the first concept the outcome names. An
/// evaluated outcome that names no concept at all has no honest status to show,
/// so it is a typed contract failure rather than an adapter-chosen default —
/// this is the last place an adapter could have picked a mastery value, and it
/// does not.
pub(crate) fn answer_evaluation_from_outcome(
    outcome: &TurnOutcome,
    answer_text: &str,
    source: &StudySourceReference,
    question: &StudyQuestion,
) -> Result<Option<AnswerEvaluation>, BrainError> {
    let TurnResolution::Evaluated {
        label,
        confidence,
        concept_transitions,
        concise_feedback,
        retry_prompt,
        ..
    } = &outcome.resolution
    else {
        return Ok(None);
    };
    let concept_status = concept_transitions
        .iter()
        .find(|transition| transition.concept_id == question.concept_id)
        .or_else(|| concept_transitions.first())
        .ok_or_else(|| outcome_contract_failure("turn_outcome_without_concept_transition"))?
        .to_status
        .clone();
    Ok(Some(AnswerEvaluation {
        question_id: outcome.question_id.clone(),
        answer_text: answer_text.to_owned(),
        label: evaluation_label_wire(*label).to_owned(),
        concise_feedback: concise_feedback.clone(),
        retry_prompt: retry_prompt.clone().unwrap_or_default(),
        source: source.clone(),
        concept_status,
        confidence_score: *confidence,
    }))
}

/// The complete set of learner-visible events one persisted outcome authorizes.
///
/// An evaluated outcome yields its source, its evaluation, and one
/// `ConceptStatus` per persisted transition, in persisted order. A deferred
/// outcome yields exactly one `TurnDeferred` carrying only Plan 04's four fields
/// — no feedback, no confidence, no status, no schedule, no recap.
pub(crate) fn learning_event_projection(
    outcome: &TurnOutcome,
    response_id: &str,
    source: &StudySourceReference,
    evaluation: Option<AnswerEvaluation>,
) -> Vec<BrainEvent> {
    match &outcome.resolution {
        TurnResolution::Evaluated {
            concept_transitions,
            ..
        } => {
            let mut events = vec![BrainEvent::SourceReference {
                response_id: response_id.to_owned(),
                source: source.clone(),
            }];
            if let Some(evaluation) = evaluation {
                events.push(BrainEvent::AnswerEvaluated {
                    response_id: response_id.to_owned(),
                    evaluation,
                });
            }
            events.extend(
                concept_transitions
                    .iter()
                    .map(|transition| BrainEvent::ConceptStatus {
                        response_id: response_id.to_owned(),
                        concept_id: transition.concept_id.clone(),
                        status: transition.to_status.clone(),
                    }),
            );
            events
        }
        TurnResolution::Deferred {
            reason,
            can_retry_same_question,
            ..
        } => vec![BrainEvent::TurnDeferred {
            response_id: response_id.to_owned(),
            question_id: outcome.question_id.clone(),
            reason: reason.clone(),
            can_retry_same_question: *can_retry_same_question,
        }],
    }
}

/// Emit one event unless the turn it belongs to was cancelled.
///
/// `ADAPTER-03`: the signal is the same cooperative token the provider stages
/// select on, so a barge-in suppresses this turn's remaining events and the
/// provider's cancel/close controls through one source of truth.
pub(crate) async fn send_fake_unless_cancelled(
    event_tx: &mpsc::Sender<BrainEvent>,
    event: BrainEvent,
    cancelled: &CancellationToken,
) -> bool {
    if cancelled.is_cancelled() {
        return false;
    }
    if event_tx.send(event).await.is_err() {
        return false;
    }
    tokio::task::yield_now().await;
    !cancelled.is_cancelled()
}

/// The one provider-error emission path.
///
/// Plan 06 collapsed `BrainError` to a single classified variant, so the class,
/// stage, retry policy, and terminal reason were all chosen at the boundary that
/// observed the failure. Nothing here re-reads a message to guess any of them,
/// and there is no second emitter a generic code path could pick by accident.
pub(crate) async fn emit_provider_failure(event_tx: &mpsc::Sender<BrainEvent>, error: BrainError) {
    let _ = event_tx
        .send(BrainEvent::Error(BrainProviderError::from_failure(
            error.failure().clone(),
        )))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_tracker_emits_only_legal_transitions_and_fails_closed_otherwise() {
        let tracker = SessionPhaseTracker::ready();

        for phase in [
            StudySessionPhase::Listening,
            StudySessionPhase::Thinking,
            StudySessionPhase::Feedback,
            StudySessionPhase::Correction,
        ] {
            assert_eq!(
                tracker.phase_event(phase).expect("legal transition"),
                BrainEvent::SessionPhase { phase }
            );
        }
        assert_eq!(tracker.phase(), StudySessionPhase::Correction);

        // A second Feedback claim is backward motion the domain refuses, and the
        // refusal is a typed failure rather than an emitted phase.
        let error = tracker
            .phase_event(StudySessionPhase::Feedback)
            .expect_err("backward motion is illegal");
        assert_eq!(
            error.failure().failure_class(),
            BrainFailureClass::ToolExecutorFailure
        );
        assert_eq!(error.failure().stage(), BrainFailureStage::Session);
        assert_eq!(tracker.phase(), StudySessionPhase::Correction);

        // A barge-in during a turn takes the machine's one explicit backward
        // motion rather than an illegal forward claim.
        assert_eq!(
            tracker.begin_turn().expect("a replacement turn restarts"),
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Listening
            }
        );
        assert!(tracker.phase_event(StudySessionPhase::Thinking).is_ok());
        assert_eq!(
            tracker.begin_turn().expect("a second barge-in restarts"),
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Listening
            }
        );
        for phase in [
            StudySessionPhase::Thinking,
            StudySessionPhase::Feedback,
            StudySessionPhase::Correction,
        ] {
            tracker.phase_event(phase).expect("legal transition");
        }
        assert!(tracker
            .phase_event_if_legal(StudySessionPhase::Recap)
            .is_some());
        assert!(SessionPhaseTracker::ready()
            .phase_event_if_legal(StudySessionPhase::Recap)
            .is_none());
    }

    /// The projection copies a persisted mastery value; it never picks one.
    #[test]
    fn evaluation_projection_copies_a_persisted_status_and_never_defaults_one() {
        let mut outcome = crate::synthetic::learning_core_turn_outcome("evaluated_mostly_correct")
            .expect("the immutable corpus publishes the case");
        let source = agent_domain::fixture_source_reference();
        let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &outcome.resolution
        else {
            panic!("the corpus case is evaluated");
        };
        let transitions = concept_transitions.clone();
        assert!(
            transitions.len() > 1,
            "the case must name more than one concept for the preference to be observable"
        );

        // This turn's own concept wins, whichever position it holds.
        for expected in &transitions {
            let mut question = agent_domain::fixture_question();
            question.concept_id = expected.concept_id.clone();
            let evaluation =
                answer_evaluation_from_outcome(&outcome, "the answer", &source, &question)
                    .expect("a transition-bearing outcome projects")
                    .expect("an evaluated outcome carries an evaluation");
            assert_eq!(evaluation.concept_status, expected.to_status);
            assert_eq!(evaluation.answer_text, "the answer");
        }

        // A concept the outcome never mentions falls back to the outcome's own
        // first transition, still a persisted value.
        let mut unrelated = agent_domain::fixture_question();
        unrelated.concept_id = "concept-the-outcome-never-names".to_owned();
        assert_eq!(
            answer_evaluation_from_outcome(&outcome, "the answer", &source, &unrelated)
                .expect("a transition-bearing outcome projects")
                .expect("an evaluated outcome carries an evaluation")
                .concept_status,
            transitions[0].to_status
        );

        // With no transition at all there is nothing honest to show.
        if let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &mut outcome.resolution
        {
            concept_transitions.clear();
        }
        let error = answer_evaluation_from_outcome(&outcome, "the answer", &source, &unrelated)
            .expect_err("a transition-less evaluated outcome has no status to show");
        assert_eq!(
            error.failure().failure_class(),
            BrainFailureClass::ToolExecutorFailure
        );
        assert_eq!(error.failure().stage(), BrainFailureStage::Tools);
        assert_eq!(
            error.failure().metadata(),
            "error_kind=turn_outcome_without_concept_transition"
        );

        // A deferral carries no evaluation and is not a failure.
        let deferred =
            crate::synthetic::learning_core_turn_outcome("deferred_insufficient_semantic_evidence")
                .expect("the immutable corpus publishes the case");
        assert!(
            answer_evaluation_from_outcome(&deferred, "the answer", &source, &unrelated)
                .expect("a deferral projects")
                .is_none()
        );
    }
}
