use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use serde_json::{json, Value};

use crate::{
    decide_review_schedule, format_rfc3339_millis,
    learning_outcome::{
        AnswerEvaluator, ChallengeDisposition, ChallengeResolution, ConceptStatusTransition,
        CriterionAssessment, CriterionAssessmentKind, EvaluationDecision, EvaluationDeferralReason,
        EvaluationError, EvaluationLabel, EvaluationRequest, EvaluationRubricV1,
        QuestionDisposition, RubricCriterionV1, TurnOutcome, TurnResolution,
        VIVA_CHALLENGE_RESOLUTION_SCHEMA, VIVA_SEMANTIC_RUBRIC_POLICY_VERSION,
        VIVA_TURN_OUTCOME_SCHEMA,
    },
    learning_recap::{RecapBuildError, SessionLearningEvidence},
    AnswerAttemptEnvelope, Clock, ConceptStatus, PortError, ReviewOutcomeV1, ReviewScheduleError,
    SessionConfig, StudyMemoryStore, StudyMode, StudyQuestion, StudySessionRecap,
    StudySourceReference, SystemClock, ToolProposal, ToolResult,
};

/// The locked `viva.semantic-rubric.v1` thresholds. These are policy, not tuning
/// knobs: changing one changes what a learner is told about their own mastery.
///
/// A present transcript confidence below this floor defers the turn instead of
/// grading a transcript the server does not trust.
const TRANSCRIPT_CONFIDENCE_FLOOR: f32 = 0.65;
/// A criterion assessed below this floor defers the whole turn rather than
/// forcing a grade out of evidence the evaluator itself is unsure of.
const SEMANTIC_EVIDENCE_FLOOR: f32 = 0.60;
/// Every required criterion must be satisfied at or above this confidence before
/// a concept may reach `Strong`.
const STRONG_CONFIDENCE_FLOOR: f32 = 0.85;
/// Bounds on evaluator copy, counted in Unicode scalar values after trimming.
const MAX_CONCISE_FEEDBACK_SCALARS: usize = 480;
const MAX_RETRY_PROMPT_SCALARS: usize = 240;
/// Source-identifier prefixes used by the study store. Evaluator copy naming a
/// source outside the bound rubric is invalid output, not feedback.
const SOURCE_ID_PREFIXES: [&str; 2] = ["src-", "source:"];

#[derive(Clone)]
pub struct AuthorizedStudySession {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub mode: StudyMode,
    pub active_concepts: Vec<String>,
}

impl AuthorizedStudySession {
    pub fn from_config(config: &SessionConfig) -> Result<Self, ToolExecutionError> {
        Ok(Self {
            user_id: required(config.user_id.as_deref(), "user_id")?.to_owned(),
            study_set_id: required(config.study_set_id.as_deref(), "study_set_id")?.to_owned(),
            voice_session_id: required(config.session_id.as_deref(), "session_id")?.to_owned(),
            mode: config.mode.clone().unwrap_or_default(),
            active_concepts: config.active_concepts.clone(),
        })
    }
}

#[derive(Clone)]
pub struct VivaToolExecutor {
    store: Arc<dyn StudyMemoryStore>,
    session: AuthorizedStudySession,
    evaluator: Arc<dyn AnswerEvaluator>,
    clock: Arc<dyn Clock>,
}

impl VivaToolExecutor {
    /// Production composition: the authoritative scheduling instant comes from the
    /// system clock, never from a tool argument, and the semantic evaluator is a
    /// required constructor argument. `LEARN-002` deliberately provides no default
    /// evaluator: a composition that cannot name one cannot grade an answer.
    pub fn new(
        store: Arc<dyn StudyMemoryStore>,
        session: AuthorizedStudySession,
        evaluator: Arc<dyn AnswerEvaluator>,
    ) -> Self {
        Self::with_clock(store, session, evaluator, Arc::new(SystemClock))
    }

    /// Test/composition path with an injected clock.
    pub fn with_clock(
        store: Arc<dyn StudyMemoryStore>,
        session: AuthorizedStudySession,
        evaluator: Arc<dyn AnswerEvaluator>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            session,
            evaluator,
            clock,
        }
    }

    pub async fn execute(
        &self,
        response_id: &str,
        proposal: ToolProposal,
    ) -> Result<ToolResult, ToolExecutionError> {
        bind_study_set_and_session(&proposal, &self.session)?;
        let result = match proposal.name() {
            "select_next_question" => self.select_next_question().await?,
            "evaluate_spoken_answer" => self.evaluate_spoken_answer(response_id, &proposal).await?,
            "retrieve_source_reference" => self.retrieve_source_reference(&proposal).await?,
            "mark_concept_status" => self.mark_concept_status(response_id, &proposal).await?,
            "build_session_recap" => self.build_session_recap(response_id).await?,
            "challenge_correction" => self.challenge_correction(&proposal).await?,
            "schedule_review_item" => self.schedule_review_item(response_id, &proposal).await?,
            other => {
                return Err(ToolExecutionError::InvalidArguments(format!(
                    "unknown Viva tool `{other}`"
                )));
            }
        };
        Ok(ToolResult { proposal, result })
    }

    pub async fn record_answer_attempt_envelope(
        &self,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<Value, ToolExecutionError> {
        self.store
            .record_answer_attempt_envelope(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                envelope,
            )
            .await
            .map_err(ToolExecutionError::from)
    }

    async fn select_next_question(&self) -> Result<Value, ToolExecutionError> {
        let question = self.active_question().await?;
        Ok(json!({ "question": question, "mode": self.session.mode.as_str() }))
    }

    /// The only production path that can produce evaluated mastery.
    ///
    /// Nothing a provider says selects a question, a concept, a source, a due
    /// date, or a retry policy: the question, rubric, concept IDs, source IDs,
    /// recording instant, previous statuses, and retry disposition are all read
    /// back from server-owned state, and only the criterion-level verdicts come
    /// from the injected [`AnswerEvaluator`].
    async fn evaluate_spoken_answer(
        &self,
        response_id: &str,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let question_id = string_arg(proposal.arguments(), "question_id")?;
        let answer_text = raw_string_arg(proposal.arguments(), "answer_text")?;
        let transcript_confidence =
            optional_confidence_arg(proposal.arguments(), "transcript_confidence")?;

        let question = self.active_question().await?;
        if question.question_id != question_id {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "question `{question_id}` is not active"
            )));
        }
        validate_authorized_rubric(&question)?;
        let source_ids = authorized_source_ids(&question.rubric);

        // One session-evidence read serves three server-owned bindings: the
        // replay identity, the previous concept statuses, and the challenged
        // outcome a replacement may supersede.
        let evidence = self
            .store
            .session_learning_evidence(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
            )
            .await?;
        let recorded = RecordedResponse::find(&evidence, response_id);
        let supersedes_response_id =
            bind_supersedes(proposal.arguments(), &evidence, &question.question_id)?;
        let prior_statuses = self
            .prior_concept_statuses(&question.rubric, &evidence)
            .await?;
        let recorded_at = recorded
            .recorded_at
            .map_or_else(|| format_rfc3339_millis(self.clock.now()), str::to_owned);

        let resolution = if answer_text.trim().is_empty() {
            // Before provider invocation: an empty answer is a server fact.
            TurnResolution::deferred(EvaluationDeferralReason::EmptyAnswer)
        } else if transcript_confidence.is_some_and(|confidence| {
            !confidence.is_finite()
                || !(0.0..=1.0).contains(&confidence)
                || confidence < TRANSCRIPT_CONFIDENCE_FLOOR
        }) {
            TurnResolution::deferred(EvaluationDeferralReason::TranscriptUncertain)
        } else {
            let request = EvaluationRequest {
                response_id: response_id.to_owned(),
                question: question.clone(),
                answer_text,
                transcript_confidence,
            };
            match self.evaluator.evaluate(&request).await {
                Err(EvaluationError::Unavailable | EvaluationError::Timeout) => {
                    TurnResolution::deferred(EvaluationDeferralReason::EvaluatorUnavailable)
                }
                Err(EvaluationError::MalformedResponse | EvaluationError::ContractViolation) => {
                    TurnResolution::deferred(EvaluationDeferralReason::InvalidEvaluatorOutput)
                }
                // An evaluator may honestly report that it found too little
                // evidence or contradicted itself. It may not claim a server
                // fact (an empty answer, an uncertain transcript) or classify
                // its own availability, and it never chooses the retry policy.
                Ok(EvaluationDecision::Deferred { reason, .. }) => {
                    TurnResolution::deferred(match reason {
                        EvaluationDeferralReason::InsufficientSemanticEvidence
                        | EvaluationDeferralReason::ContradictoryEvidence => reason,
                        _ => EvaluationDeferralReason::InvalidEvaluatorOutput,
                    })
                }
                Ok(EvaluationDecision::Evaluated {
                    assessments,
                    concise_feedback,
                    retry_prompt,
                }) => convert_evaluated_decision(
                    &question.rubric,
                    &assessments,
                    &concise_feedback,
                    retry_prompt.as_deref(),
                    &source_ids,
                    &prior_statuses,
                    &recorded.from_statuses,
                ),
            }
        };

        let outcome = TurnOutcome {
            schema: VIVA_TURN_OUTCOME_SCHEMA.to_owned(),
            response_id: response_id.to_owned(),
            question_id: question.question_id.clone(),
            rubric_policy_version: question.rubric.policy_version.clone(),
            recorded_at,
            source_ids,
            supersedes_response_id,
            resolution,
        };
        let persisted = self
            .store
            .record_turn_outcome(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                outcome,
            )
            .await?;
        Ok(json!({
            "turn_outcome": persisted.turn_outcome,
            "record": persisted.record,
        }))
    }

    /// The persisted status each rubric concept holds immediately before this
    /// outcome. Session outcomes are the closest authority; a concept this
    /// session has never written falls back to the authenticated projection, and
    /// a concept the projection does not authorize fails closed rather than
    /// defaulting to a status.
    async fn prior_concept_statuses(
        &self,
        rubric: &EvaluationRubricV1,
        evidence: &SessionLearningEvidence,
    ) -> Result<BTreeMap<String, ConceptStatus>, ToolExecutionError> {
        let projection = self
            .store
            .authenticated_study_projection(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
            )
            .await?;
        let mut statuses = BTreeMap::new();
        for concept_id in rubric_concept_ids(rubric) {
            let projected = projection
                .concepts
                .iter()
                .find(|concept| concept.id == concept_id)
                .ok_or_else(|| {
                    ToolExecutionError::Unavailable(format!(
                        "concept `{concept_id}` is not in the authenticated study projection"
                    ))
                })?
                .status
                .clone();
            statuses.insert(concept_id, projected);
        }
        for outcome in &evidence.outcomes {
            if let TurnResolution::Evaluated {
                concept_transitions,
                ..
            } = &outcome.resolution
            {
                for transition in concept_transitions {
                    if let Some(slot) = statuses.get_mut(&transition.concept_id) {
                        *slot = transition.to_status.clone();
                    }
                }
            }
        }
        Ok(statuses)
    }

    async fn retrieve_source_reference(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let source_id = string_arg(proposal.arguments(), "source_id")?;
        let source = self.canonical_source(&source_id).await?;
        Ok(json!({ "source": source }))
    }

    async fn mark_concept_status(
        &self,
        response_id: &str,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let concept_id = string_arg(proposal.arguments(), "concept_id")?;
        let status = concept_status_arg(proposal.arguments(), "status")?;
        let status = self
            .store
            .record_concept_status(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                &concept_id,
                status,
            )
            .await?;
        Ok(json!({ "concept_id": concept_id, "status": status }))
    }

    /// A recap is a pure projection of persisted session evidence.
    ///
    /// The model's payload is ignored entirely: this reads the store's evidence,
    /// folds it with the Plan-04-owned pure fold, and persists exactly that. It
    /// inspects no question, no expected term, and no active source, so a recap
    /// can never describe a session that was not actually recorded.
    async fn build_session_recap(&self, response_id: &str) -> Result<Value, ToolExecutionError> {
        let evidence = self
            .store
            .session_learning_evidence(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
            )
            .await?;
        let recap = crate::learning_recap::build_session_recap(&evidence)?;
        let record = self
            .store
            .record_recap(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                StudySessionRecap::from_evidence_recap(&recap),
            )
            .await?;
        Ok(json!({ "recap": recap, "record": record }))
    }

    /// A challenge is a request to recheck a source against an outcome the server
    /// already persisted. It records a bound [`ChallengeResolution`] and moves no
    /// mastery: only a later validated outcome whose `supersedes_response_id`
    /// names the challenged response may replace it.
    async fn challenge_correction(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let source_id = string_arg(proposal.arguments(), "source_id")?;
        let correction_id = string_arg(proposal.arguments(), "correction_id")?;
        let source = self.canonical_source(&source_id).await?;
        let provided = source_from_args(proposal.arguments())?;
        if provided != source {
            return Err(ToolExecutionError::InvalidArguments(
                "challenge source tuple does not match deterministic retrieval".to_owned(),
            ));
        }

        let evidence = self
            .store
            .session_learning_evidence(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
            )
            .await?;
        let challenged = latest_unsuperseded_outcome(&evidence).ok_or_else(|| {
            ToolExecutionError::InvalidArguments(
                "no persisted outcome in this session can be challenged".to_owned(),
            )
        })?;
        if !challenged.source_ids.contains(&source_id) {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "source `{source_id}` is not bound to the challenged outcome"
            )));
        }

        // Every disposition is read off a persisted server decision, never off
        // the learner's or the model's opinion of the source.
        let disposition = match &challenged.resolution {
            TurnResolution::Deferred { .. } => ChallengeDisposition::Deferred,
            TurnResolution::Evaluated { disposition, .. } => match disposition {
                QuestionDisposition::Advance => ChallengeDisposition::SourceConfirmed,
                QuestionDisposition::RetryCurrent => ChallengeDisposition::ReevaluationRequired,
                QuestionDisposition::Deferred => ChallengeDisposition::Deferred,
            },
        };
        let resolution = self
            .store
            .record_challenge_resolution(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                ChallengeResolution {
                    schema: VIVA_CHALLENGE_RESOLUTION_SCHEMA.to_owned(),
                    correction_id,
                    challenged_response_id: challenged.response_id.clone(),
                    source_id,
                    disposition,
                    replacement_response_id: None,
                },
            )
            .await?;
        Ok(json!({ "challenge_resolution": resolution, "source": source }))
    }

    async fn schedule_review_item(
        &self,
        response_id: &str,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let concept_id = string_arg(proposal.arguments(), "concept_id")?;
        if proposal.arguments().get("due_at").is_some() {
            return Err(ToolExecutionError::InvalidArguments(
                "due_at is not an authoritative tool argument; @viva/core computes review dates"
                    .to_owned(),
            ));
        }
        let status = concept_status_arg(proposal.arguments(), "status")?;
        // D-01: read the injected clock exactly once for this outcome, then take
        // every other authoritative input from the scoped store context.
        let now = self.clock.now();
        let context = self
            .store
            .review_scheduling_context(
                &self.session.user_id,
                &self.session.study_set_id,
                &concept_id,
            )
            .await?;
        let outcome = ReviewOutcomeV1 {
            status,
            hint_count: optional_count_arg(proposal.arguments(), "hint_count")?,
            miss_count: optional_count_arg(proposal.arguments(), "miss_count")?,
        };
        let decision = decide_review_schedule(now, &outcome, &context)?;
        // The store is the single authority on what is actually scheduled: it owns the
        // per-response replay guard, so on a replayed tool call it keeps the first
        // decision and returns that one. Reporting the locally recomputed decision here
        // would tell the model a due date that is not the one on record.
        let record = self
            .store
            .persist_review_schedule_decision(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                &concept_id,
                decision,
            )
            .await?;
        let mut result = record.clone();
        if let Value::Object(fields) = &mut result {
            fields.insert("record".to_owned(), record);
        }
        Ok(result)
    }

    async fn canonical_source(
        &self,
        source_id: &str,
    ) -> Result<StudySourceReference, ToolExecutionError> {
        self.store
            .source_reference(&self.session.user_id, &self.session.study_set_id, source_id)
            .await?
            .ok_or_else(|| {
                ToolExecutionError::Unavailable(format!(
                    "source `{source_id}` is unavailable for this session"
                ))
            })
    }

    async fn active_question(&self) -> Result<StudyQuestion, ToolExecutionError> {
        let mut question = self
            .store
            .active_question(&self.session.user_id, &self.session.study_set_id)
            .await?
            .ok_or_else(|| {
                ToolExecutionError::Unavailable(format!(
                    "no active generated question is available for study set `{}`",
                    self.session.study_set_id
                ))
            })?;
        question.source = self.canonical_source(&question.source.source_id).await?;
        Ok(question)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolExecutionError {
    #[error("invalid tool arguments: {0}")]
    InvalidArguments(String),
    #[error("tool dependency unavailable: {0}")]
    Unavailable(String),
    #[error("tool store error: {0}")]
    Store(#[from] PortError),
    #[error("review scheduling error: {0}")]
    ReviewSchedule(#[from] ReviewScheduleError),
    /// Persisted session evidence that cannot be folded is a store invariant
    /// break. It fails the tool call rather than degrading into a partial recap.
    #[error("session evidence cannot be folded into a recap: {0:?}")]
    RecapEvidence(RecapBuildError),
}

impl From<RecapBuildError> for ToolExecutionError {
    fn from(error: RecapBuildError) -> Self {
        Self::RecapEvidence(error)
    }
}

fn bind_study_set_and_session(
    proposal: &ToolProposal,
    session: &AuthorizedStudySession,
) -> Result<(), ToolExecutionError> {
    let study_set_id = string_arg(proposal.arguments(), "study_set_id")?;
    let voice_session_id = string_arg(proposal.arguments(), "voice_session_id")?;
    if study_set_id != session.study_set_id || voice_session_id != session.voice_session_id {
        return Err(ToolExecutionError::InvalidArguments(
            "tool call is not bound to the authorized session".to_owned(),
        ));
    }
    Ok(())
}

fn string_arg(args: &Value, name: &str) -> Result<String, ToolExecutionError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolExecutionError::InvalidArguments(format!("missing `{name}`")))
}

/// An answer argument that may legitimately be blank. A blank answer is a
/// persisted `EmptyAnswer` deferral, not a malformed tool call, so it must not be
/// rejected by the non-empty string accessor.
fn raw_string_arg(args: &Value, name: &str) -> Result<String, ToolExecutionError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolExecutionError::InvalidArguments(format!("missing `{name}`")))
}

fn optional_string_arg(args: &Value, name: &str) -> Result<Option<String>, ToolExecutionError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| {
                ToolExecutionError::InvalidArguments(format!(
                    "`{name}` must be a non-empty string when supplied"
                ))
            }),
    }
}

/// An absent transcript confidence stays absent; it is never read as certainty.
fn optional_confidence_arg(args: &Value, name: &str) -> Result<Option<f32>, ToolExecutionError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .map(|confidence| Some(confidence as f32))
            .ok_or_else(|| {
                ToolExecutionError::InvalidArguments(format!(
                    "`{name}` must be a number when supplied"
                ))
            }),
    }
}

/// Concept IDs in rubric order, deduplicated.
fn rubric_concept_ids(rubric: &EvaluationRubricV1) -> Vec<String> {
    let mut seen = BTreeSet::new();
    rubric
        .criteria
        .iter()
        .filter(|criterion| seen.insert(criterion.concept_id.clone()))
        .map(|criterion| criterion.concept_id.clone())
        .collect()
}

/// Source IDs in rubric order, deduplicated. These are the only sources a turn
/// outcome may ever cite.
fn authorized_source_ids(rubric: &EvaluationRubricV1) -> Vec<String> {
    let mut seen = BTreeSet::new();
    rubric
        .criteria
        .iter()
        .filter(|criterion| seen.insert(criterion.source_id.clone()))
        .map(|criterion| criterion.source_id.clone())
        .collect()
}

/// The server-side half of `viva.semantic-rubric.v1`: a question whose rubric
/// cannot ground a grade is a store invariant break, not evaluator output, so it
/// fails the tool call instead of being converted into a learner fact.
fn validate_authorized_rubric(question: &StudyQuestion) -> Result<(), ToolExecutionError> {
    let rubric = &question.rubric;
    let reject = |reason: String| Err(ToolExecutionError::Unavailable(reason));

    if rubric.policy_version != VIVA_SEMANTIC_RUBRIC_POLICY_VERSION {
        return reject(format!(
            "question `{}` carries rubric policy `{}`, not `{VIVA_SEMANTIC_RUBRIC_POLICY_VERSION}`",
            question.question_id, rubric.policy_version
        ));
    }
    if rubric.criteria.is_empty() {
        return reject(format!(
            "question `{}` carries an empty rubric",
            question.question_id
        ));
    }
    let mut criterion_ids = BTreeSet::new();
    for criterion in &rubric.criteria {
        if criterion.criterion_id.trim().is_empty()
            || criterion.concept_id.trim().is_empty()
            || criterion.source_id.trim().is_empty()
        {
            return reject(format!(
                "question `{}` carries a rubric criterion with a blank identifier",
                question.question_id
            ));
        }
        if !criterion_ids.insert(criterion.criterion_id.as_str()) {
            return reject(format!(
                "question `{}` repeats rubric criterion `{}`",
                question.question_id, criterion.criterion_id
            ));
        }
    }
    for concept_id in rubric_concept_ids(rubric) {
        if !rubric
            .criteria
            .iter()
            .any(|criterion| criterion.concept_id == concept_id && criterion.required)
        {
            return reject(format!(
                "concept `{concept_id}` has no required rubric criterion"
            ));
        }
    }
    if !rubric_concept_ids(rubric).contains(&question.concept_id) {
        return reject(format!(
            "question `{}` is bound to concept `{}`, which its rubric never grades",
            question.question_id, question.concept_id
        ));
    }
    if !authorized_source_ids(rubric).contains(&question.source.source_id) {
        return reject(format!(
            "question `{}` cites source `{}`, which its rubric never authorizes",
            question.question_id, question.source.source_id
        ));
    }
    Ok(())
}

/// The stable server-owned half of a response that was already graded once.
///
/// A replay re-derives the graded facts from the same authorized inputs and must
/// reproduce the persisted outcome exactly, so the recording instant and the
/// previous concept statuses come from the stored row rather than from a later
/// clock read or from a status this very response already moved.
#[derive(Default)]
struct RecordedResponse<'a> {
    recorded_at: Option<&'a str>,
    from_statuses: BTreeMap<&'a str, ConceptStatus>,
}

impl<'a> RecordedResponse<'a> {
    fn find(evidence: &'a SessionLearningEvidence, response_id: &str) -> Self {
        let Some(outcome) = evidence
            .outcomes
            .iter()
            .find(|outcome| outcome.response_id == response_id)
        else {
            return Self::default();
        };
        let mut from_statuses = BTreeMap::new();
        if let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &outcome.resolution
        {
            for transition in concept_transitions {
                from_statuses.insert(
                    transition.concept_id.as_str(),
                    transition.from_status.clone(),
                );
            }
        }
        Self {
            recorded_at: Some(outcome.recorded_at.as_str()),
            from_statuses,
        }
    }
}

/// The most recent outcome no later outcome supersedes.
fn latest_unsuperseded_outcome(evidence: &SessionLearningEvidence) -> Option<&TurnOutcome> {
    let superseded = evidence
        .outcomes
        .iter()
        .filter_map(|outcome| outcome.supersedes_response_id.as_deref())
        .collect::<BTreeSet<_>>();
    evidence
        .outcomes
        .iter()
        .rev()
        .find(|outcome| !superseded.contains(outcome.response_id.as_str()))
}

/// A replacement may only supersede an outcome the server itself asked the
/// learner to retry, on the same authorized question.
fn bind_supersedes(
    args: &Value,
    evidence: &SessionLearningEvidence,
    question_id: &str,
) -> Result<Option<String>, ToolExecutionError> {
    let Some(candidate) = optional_string_arg(args, "supersedes_response_id")? else {
        return Ok(None);
    };
    let challenged = evidence
        .outcomes
        .iter()
        .find(|outcome| outcome.response_id == candidate)
        .ok_or_else(|| {
            ToolExecutionError::InvalidArguments(format!(
                "`supersedes_response_id` `{candidate}` names no persisted outcome in this session"
            ))
        })?;
    if challenged.question_id != question_id {
        return Err(ToolExecutionError::InvalidArguments(format!(
            "`supersedes_response_id` `{candidate}` belongs to a different question"
        )));
    }
    match &challenged.resolution {
        TurnResolution::Evaluated {
            disposition: QuestionDisposition::RetryCurrent,
            ..
        } => Ok(Some(candidate)),
        _ => Err(ToolExecutionError::InvalidArguments(format!(
            "outcome `{candidate}` was not left open for a retry, so it cannot be superseded"
        ))),
    }
}

impl TurnResolution {
    /// A deferral is a persisted fact with no label, no confidence, and no
    /// transition. The retry policy is server-owned: a learner-recoverable
    /// deferral keeps the current question, while a system fault holds the turn.
    fn deferred(reason: EvaluationDeferralReason) -> Self {
        let can_retry_same_question = matches!(
            reason,
            EvaluationDeferralReason::EmptyAnswer
                | EvaluationDeferralReason::TranscriptUncertain
                | EvaluationDeferralReason::InsufficientSemanticEvidence
                | EvaluationDeferralReason::ContradictoryEvidence
        );
        Self::Deferred {
            reason,
            can_retry_same_question,
            disposition: if can_retry_same_question {
                QuestionDisposition::RetryCurrent
            } else {
                QuestionDisposition::Deferred
            },
        }
    }
}

/// Convert one complete evaluated decision into the locked
/// `viva.semantic-rubric.v1` resolution, or into the deferral that decision
/// actually warrants. Workers do not tune the thresholds this function applies.
#[allow(clippy::too_many_arguments)]
fn convert_evaluated_decision(
    rubric: &EvaluationRubricV1,
    assessments: &[CriterionAssessment],
    concise_feedback: &str,
    retry_prompt: Option<&str>,
    authorized_sources: &[String],
    prior_statuses: &BTreeMap<String, ConceptStatus>,
    recorded_from_statuses: &BTreeMap<&str, ConceptStatus>,
) -> TurnResolution {
    // The one conflicting-duplicate exception, checked before the duplicate rule:
    // the same criterion assessed both ways is contradictory evidence, not a
    // malformed payload.
    let mut kinds: BTreeMap<&str, (bool, bool)> = BTreeMap::new();
    for assessment in assessments {
        let seen = kinds.entry(assessment.criterion_id.as_str()).or_default();
        match assessment.assessment {
            CriterionAssessmentKind::Satisfied => seen.0 = true,
            CriterionAssessmentKind::Contradicted => seen.1 = true,
            CriterionAssessmentKind::NotDemonstrated => {}
        }
    }
    if kinds
        .values()
        .any(|(satisfied, contradicted)| *satisfied && *contradicted)
    {
        return TurnResolution::deferred(EvaluationDeferralReason::ContradictoryEvidence);
    }

    // Criteria are counted by exact ID: equal cardinality plus equal ID sets is
    // exactly "assessed once each", with no denominator shortcut.
    let rubric_ids = rubric
        .criteria
        .iter()
        .map(|criterion| criterion.criterion_id.as_str())
        .collect::<BTreeSet<_>>();
    let assessed_ids = assessments
        .iter()
        .map(|assessment| assessment.criterion_id.as_str())
        .collect::<BTreeSet<_>>();
    if assessments.len() != rubric.criteria.len() || assessed_ids != rubric_ids {
        return TurnResolution::deferred(EvaluationDeferralReason::InvalidEvaluatorOutput);
    }
    if assessments
        .iter()
        .any(|assessment| !is_valid_confidence(assessment.confidence))
    {
        return TurnResolution::deferred(EvaluationDeferralReason::InvalidEvaluatorOutput);
    }
    if assessments
        .iter()
        .any(|assessment| assessment.confidence < SEMANTIC_EVIDENCE_FLOOR)
    {
        return TurnResolution::deferred(EvaluationDeferralReason::InsufficientSemanticEvidence);
    }
    if !is_authorized_copy(
        concise_feedback,
        MAX_CONCISE_FEEDBACK_SCALARS,
        authorized_sources,
    ) || retry_prompt.is_some_and(|prompt| {
        !is_authorized_copy(prompt, MAX_RETRY_PROMPT_SCALARS, authorized_sources)
    }) {
        return TurnResolution::deferred(EvaluationDeferralReason::InvalidEvaluatorOutput);
    }

    let by_criterion = assessments
        .iter()
        .map(|assessment| (assessment.criterion_id.as_str(), assessment))
        .collect::<BTreeMap<_, _>>();
    let kind_of =
        |criterion: &RubricCriterionV1| by_criterion[criterion.criterion_id.as_str()].assessment;
    let confidence_of =
        |criterion: &RubricCriterionV1| by_criterion[criterion.criterion_id.as_str()].confidence;

    let mut concept_transitions = Vec::new();
    for concept_id in rubric_concept_ids(rubric) {
        let criteria = rubric
            .criteria
            .iter()
            .filter(|criterion| criterion.concept_id == concept_id)
            .collect::<Vec<_>>();
        let required = criteria
            .iter()
            .copied()
            .filter(|criterion| criterion.required)
            .collect::<Vec<_>>();
        let satisfied_required = required
            .iter()
            .filter(|criterion| kind_of(criterion) == CriterionAssessmentKind::Satisfied)
            .count();
        let contradicted_required = required
            .iter()
            .any(|criterion| kind_of(criterion) == CriterionAssessmentKind::Contradicted);
        let contradicted_optional = criteria
            .iter()
            .filter(|criterion| !criterion.required)
            .any(|criterion| kind_of(criterion) == CriterionAssessmentKind::Contradicted);
        let weakest_required = required
            .iter()
            .map(|criterion| confidence_of(criterion))
            .fold(f32::INFINITY, f32::min);

        let to_status = if contradicted_required {
            ConceptStatus::Missed
        } else if satisfied_required == required.len() {
            if weakest_required >= STRONG_CONFIDENCE_FLOOR && !contradicted_optional {
                ConceptStatus::Strong
            } else {
                ConceptStatus::Shaky
            }
        } else if satisfied_required * 2 >= required.len() {
            ConceptStatus::Shaky
        } else if satisfied_required >= 1 {
            ConceptStatus::Review
        } else {
            ConceptStatus::Missed
        };

        let from_status = recorded_from_statuses
            .get(concept_id.as_str())
            .or_else(|| prior_statuses.get(&concept_id))
            .cloned()
            .unwrap_or_default();
        concept_transitions.push(ConceptStatusTransition {
            concept_id,
            from_status,
            to_status,
            criterion_ids: criteria
                .iter()
                .map(|criterion| criterion.criterion_id.clone())
                .collect(),
        });
    }

    let all_required = rubric
        .criteria
        .iter()
        .filter(|criterion| criterion.required)
        .collect::<Vec<_>>();
    let satisfied_required = all_required
        .iter()
        .filter(|criterion| kind_of(criterion) == CriterionAssessmentKind::Satisfied)
        .count();
    let contradicted_required = all_required
        .iter()
        .any(|criterion| kind_of(criterion) == CriterionAssessmentKind::Contradicted);
    let confidence = all_required
        .iter()
        .map(|criterion| confidence_of(criterion))
        .fold(f32::INFINITY, f32::min);

    let label = if contradicted_required {
        EvaluationLabel::Wrong
    } else if concept_transitions
        .iter()
        .all(|transition| transition.to_status == ConceptStatus::Strong)
    {
        EvaluationLabel::Strong
    } else if concept_transitions.iter().all(|transition| {
        matches!(
            transition.to_status,
            ConceptStatus::Strong | ConceptStatus::Shaky
        )
    }) {
        EvaluationLabel::MostlyCorrect
    } else if satisfied_required * 2 >= all_required.len() {
        EvaluationLabel::PartiallyCorrect
    } else if satisfied_required >= 1 {
        EvaluationLabel::Vague
    } else {
        EvaluationLabel::InsufficientEvidence
    };

    TurnResolution::Evaluated {
        // A required contradiction is the only graded verdict that keeps the
        // learner on the same question.
        disposition: if label == EvaluationLabel::Wrong {
            QuestionDisposition::RetryCurrent
        } else {
            QuestionDisposition::Advance
        },
        label,
        confidence,
        assessments: assessments.to_vec(),
        concept_transitions,
        concise_feedback: concise_feedback.to_owned(),
        retry_prompt: retry_prompt.map(ToOwned::to_owned),
    }
}

fn is_valid_confidence(confidence: f32) -> bool {
    confidence.is_finite() && (0.0..=1.0).contains(&confidence)
}

/// Evaluator copy is learner-facing text, so it is bounded, control-free, and may
/// not name a source the bound rubric does not authorize.
///
/// "Control-free" is literal and admits no whitespace exception: a line break or
/// a tab is a control character, and this boundary fails closed rather than
/// deciding which controls are harmless in a provider-supplied string.
///
/// The source rule is enforceable in one direction and is documented as such: any
/// token shaped like a study-store source identifier must be one the bound rubric
/// authorizes. Verbatim excerpt text from a source outside the rubric is not
/// detectable here, because the executor can only retrieve authorized sources.
fn is_authorized_copy(text: &str, max_scalars: usize, authorized_sources: &[String]) -> bool {
    let trimmed = text.trim();
    let scalars = trimmed.chars().count();
    if scalars == 0 || scalars > max_scalars {
        return false;
    }
    if text.chars().any(char::is_control) {
        return false;
    }
    !text
        .split(|scalar: char| !(scalar.is_alphanumeric() || matches!(scalar, '-' | '_' | ':')))
        .any(|token| {
            SOURCE_ID_PREFIXES
                .iter()
                .any(|prefix| token.starts_with(prefix))
                && !authorized_sources.iter().any(|source| source == token)
        })
}

/// Hint and miss counts are D-01 provenance only: they are recorded when the
/// authorized outcome supplies them, stay `None` when it does not (never zero), and
/// can never move the rating or the scheduled date.
fn optional_count_arg(args: &Value, name: &str) -> Result<Option<u32>, ToolExecutionError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .map(Some)
            .ok_or_else(|| {
                ToolExecutionError::InvalidArguments(format!(
                    "`{name}` must be a non-negative whole number when supplied"
                ))
            }),
    }
}

fn concept_status_arg(args: &Value, name: &str) -> Result<ConceptStatus, ToolExecutionError> {
    match string_arg(args, name)?.as_str() {
        "strong" => Ok(ConceptStatus::Strong),
        "shaky" => Ok(ConceptStatus::Shaky),
        "missed" => Ok(ConceptStatus::Missed),
        "review" => Ok(ConceptStatus::Review),
        other => Err(ToolExecutionError::InvalidArguments(format!(
            "unknown concept status `{other}`"
        ))),
    }
}

fn source_from_args(args: &Value) -> Result<StudySourceReference, ToolExecutionError> {
    let confidence = match string_arg(args, "confidence")?.as_str() {
        "high" => crate::SourceConfidence::High,
        "medium" => crate::SourceConfidence::Medium,
        "low" => crate::SourceConfidence::Low,
        other => {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "unknown source confidence `{other}`"
            )));
        }
    };
    Ok(StudySourceReference {
        source_id: string_arg(args, "source_id")?,
        document_id: string_arg(args, "document_id")?,
        span: string_arg(args, "span")?,
        excerpt: string_arg(args, "excerpt")?,
        confidence,
        retrieval_reason: string_arg(args, "retrieval_reason")?,
    })
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, ToolExecutionError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolExecutionError::InvalidArguments(format!("missing `{label}`")))
}

#[cfg(test)]
mod review_schedule_tests {
    use super::*;
    use crate::{
        AnswerEvaluation, FixedClock, PersistedFsrsCardV1, ReviewScheduleCapReasonV1,
        ReviewScheduleDecisionV1, ReviewSchedulingContextV1, StudySourceReference,
        VIVA_REVIEW_SCHEDULE_POLICY_ID, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
    };
    use chrono::{DateTime, Utc};
    use std::sync::Mutex;

    /// Literals copied from `packages/core/src/review-scheduling-conformance-v1.json`
    /// (`new-shaky-hinted-one-miss-no-exam` and `exam-inside-cap-window`). They are
    /// never regenerated from this code's own output.
    const GRADED_AT: &str = "2031-04-05T12:00:00.000Z";
    const SHAKY_DUE_AT: &str = "2031-04-07T12:00:00.000Z";
    const STRONG_DUE_AT: &str = "2031-04-13T12:00:00.000Z";
    const EXAM_INSIDE_WINDOW_AT: &str = "2031-04-09T06:00:00.000Z";
    const EXAM_INSIDE_WINDOW_DUE_AT: &str = "2031-04-08T06:00:00.000Z";

    fn instant(raw: &str) -> DateTime<Utc> {
        crate::parse_utc_instant(raw).expect("test instant parses")
    }

    #[derive(Default)]
    struct RecordingStore {
        exam_at: Option<DateTime<Utc>>,
        card: Mutex<Option<PersistedFsrsCardV1>>,
        decisions: Mutex<Vec<ReviewScheduleDecisionV1>>,
        legacy_due_dates: Mutex<Vec<String>>,
    }

    impl RecordingStore {
        fn with_exam(exam_at: &str) -> Self {
            Self {
                exam_at: Some(instant(exam_at)),
                ..Self::default()
            }
        }

        fn only_decision(&self) -> ReviewScheduleDecisionV1 {
            let decisions = self.decisions.lock().expect("decisions lock");
            assert_eq!(decisions.len(), 1, "exactly one decision must be persisted");
            decisions[0].clone()
        }
    }

    #[async_trait::async_trait]
    impl StudyMemoryStore for RecordingStore {
        async fn record_answer_evaluation(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            _evaluation: AnswerEvaluation,
        ) -> Result<Value, PortError> {
            Ok(json!({}))
        }

        async fn source_reference(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _source_id: &str,
        ) -> Result<Option<StudySourceReference>, PortError> {
            Ok(None)
        }

        async fn study_context(
            &self,
            _user_id: &str,
            _study_set_id: &str,
        ) -> Result<Option<Value>, PortError> {
            Ok(None)
        }

        async fn record_concept_status(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            _concept_id: &str,
            status: ConceptStatus,
        ) -> Result<ConceptStatus, PortError> {
            Ok(status)
        }

        async fn schedule_review_item(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _concept_id: &str,
            due_at: &str,
        ) -> Result<Value, PortError> {
            self.legacy_due_dates
                .lock()
                .expect("legacy lock")
                .push(due_at.to_owned());
            Ok(json!({ "due_at": due_at }))
        }

        async fn record_recap(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            _recap: StudySessionRecap,
        ) -> Result<Value, PortError> {
            Ok(json!({}))
        }

        async fn review_scheduling_context(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _concept_id: &str,
        ) -> Result<ReviewSchedulingContextV1, PortError> {
            Ok(ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: self.exam_at,
                card: self.card.lock().expect("card lock").clone(),
            })
        }

        async fn persist_review_schedule_decision(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            concept_id: &str,
            decision: ReviewScheduleDecisionV1,
        ) -> Result<Value, PortError> {
            decision
                .validate()
                // Plan 06 Task 3 (`DOMAIN-006`) removed the unclassified
                // `PortError::adapter`; a failed decision validation is semantic
                // `InvalidInput` per this plan's Plan 09 handoff. Mechanical
                // constructor rename inside this `#[cfg(test)]` helper only — no
                // Plan 04 authority, algorithm, or assertion is changed.
                .map_err(|error| {
                    PortError::invalid_input("test_store", concept_id, error.to_string())
                })?;
            let summary = decision.public_summary(concept_id);
            *self.card.lock().expect("card lock") = Some(decision.card.clone());
            self.decisions
                .lock()
                .expect("decisions lock")
                .push(decision);
            Ok(summary)
        }
    }

    fn session() -> AuthorizedStudySession {
        AuthorizedStudySession {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            mode: StudyMode::Quiz,
            active_concepts: vec!["nadh".to_owned()],
        }
    }

    /// D-01 scheduling never reaches the evaluator boundary, so this composition
    /// supplies one that refuses rather than a stub that could answer.
    struct RefusingEvaluator;

    #[async_trait::async_trait]
    impl AnswerEvaluator for RefusingEvaluator {
        async fn evaluate(
            &self,
            _request: &EvaluationRequest,
        ) -> Result<EvaluationDecision, EvaluationError> {
            Err(EvaluationError::Unavailable)
        }
    }

    fn executor(store: Arc<RecordingStore>, now: &str) -> VivaToolExecutor {
        VivaToolExecutor::with_clock(
            store,
            session(),
            Arc::new(RefusingEvaluator),
            Arc::new(FixedClock::new(instant(now))),
        )
    }

    fn proposal(status: &str) -> ToolProposal {
        ToolProposal::schedule_review_item("biology-midterm", "voice-session-1", "nadh", status)
    }

    #[tokio::test]
    async fn review_schedule_tool_persists_the_authoritative_decision_not_a_fixed_date() {
        let store = Arc::new(RecordingStore::default());
        let result = executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("shaky"))
            .await
            .expect("schedule_review_item succeeds");

        let decision = store.only_decision();
        assert_eq!(crate::format_rfc3339_millis(decision.due_at), SHAKY_DUE_AT);
        assert_eq!(decision.policy_id, VIVA_REVIEW_SCHEDULE_POLICY_ID);
        assert_eq!(decision.rating, 3);
        assert_eq!(decision.card.reps, 1);
        assert!(store
            .legacy_due_dates
            .lock()
            .expect("legacy lock")
            .is_empty());

        let encoded = serde_json::to_string(&result.result).expect("tool result serializes");
        assert!(!encoded.contains("2026-06-"), "{encoded}");
        assert!(!encoded.contains("stability"), "{encoded}");
        assert!(!encoded.contains("difficulty"), "{encoded}");
        assert_eq!(result.result["due_at"], SHAKY_DUE_AT);
        assert_eq!(result.result["policy_id"], VIVA_REVIEW_SCHEDULE_POLICY_ID);
        assert_eq!(result.result["schema_version"], 1);
    }

    #[tokio::test]
    async fn review_schedule_tool_maps_every_status_to_the_recorded_rating() {
        for (status, rating) in [("missed", 1), ("review", 2), ("shaky", 3), ("strong", 4)] {
            let store = Arc::new(RecordingStore::default());
            executor(Arc::clone(&store), GRADED_AT)
                .execute("response-1", proposal(status))
                .await
                .expect("schedule_review_item succeeds");
            assert_eq!(store.only_decision().rating, rating, "status={status}");
        }
    }

    #[tokio::test]
    async fn review_schedule_tool_uses_the_injected_clock_for_every_outcome() {
        let store = Arc::new(RecordingStore::default());
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("strong"))
            .await
            .expect("schedule_review_item succeeds");
        let decision = store.only_decision();
        assert_eq!(
            crate::format_rfc3339_millis(decision.generated_at),
            GRADED_AT
        );
        assert_eq!(crate::format_rfc3339_millis(decision.due_at), STRONG_DUE_AT);
    }

    #[tokio::test]
    async fn review_schedule_tool_advances_a_prior_card_instead_of_restarting_it() {
        let store = Arc::new(RecordingStore::default());
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("strong"))
            .await
            .expect("first outcome");
        let first = store.only_decision();

        let second_now = crate::format_rfc3339_millis(first.card.due_at);
        executor(Arc::clone(&store), &second_now)
            .execute("response-2", proposal("strong"))
            .await
            .expect("second outcome");

        let decisions = store.decisions.lock().expect("decisions lock").clone();
        assert_eq!(decisions.len(), 2);
        let second = &decisions[1];
        assert_eq!(second.card.reps, 2);
        assert_eq!(second.card.elapsed_days, first.card.scheduled_days);
        assert!(
            second.card.scheduled_days > first.card.scheduled_days,
            "a second strong review must schedule further out than the first"
        );
    }

    #[tokio::test]
    async fn review_schedule_tool_caps_at_the_recorded_exam_margin() {
        let store = Arc::new(RecordingStore::with_exam(EXAM_INSIDE_WINDOW_AT));
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("strong"))
            .await
            .expect("schedule_review_item succeeds");
        let decision = store.only_decision();
        assert_eq!(
            crate::format_rfc3339_millis(decision.due_at),
            EXAM_INSIDE_WINDOW_DUE_AT
        );
        assert_eq!(
            crate::format_rfc3339_millis(decision.uncapped_due_at),
            STRONG_DUE_AT
        );
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::ExamMargin)
        );
        assert!(decision.due_at <= decision.exam_at.expect("exam instant"));
    }

    #[tokio::test]
    async fn review_schedule_tool_never_schedules_after_the_exam() {
        for exam_at in [
            "2031-04-05T12:00:01.000Z",
            "2031-04-05T18:30:00.000Z",
            "2031-04-06T12:00:00.000Z",
            "2031-04-13T12:00:00.000Z",
            "2031-09-01T08:00:00.000Z",
        ] {
            let store = Arc::new(RecordingStore::with_exam(exam_at));
            executor(Arc::clone(&store), GRADED_AT)
                .execute("response-1", proposal("strong"))
                .await
                .expect("schedule_review_item succeeds");
            let decision = store.only_decision();
            assert!(
                decision.due_at <= instant(exam_at),
                "exam_at={exam_at} due_at={}",
                decision.due_at
            );
        }
    }

    #[tokio::test]
    async fn review_schedule_tool_fails_closed_for_an_already_past_exam() {
        let store = Arc::new(RecordingStore::with_exam("2031-03-30T09:15:00.000Z"));
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("missed"))
            .await
            .expect("schedule_review_item succeeds");
        let decision = store.only_decision();
        assert_eq!(
            crate::format_rfc3339_millis(decision.due_at),
            "2031-03-30T09:15:00.000Z"
        );
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::PastExam)
        );
    }

    #[tokio::test]
    async fn review_schedule_tool_rejects_a_model_supplied_due_at() {
        let store = Arc::new(RecordingStore::default());
        let mut proposal = proposal("strong");
        let arguments = proposal.arguments().clone();
        let Value::Object(mut fields) = arguments else {
            panic!("tool arguments are an object");
        };
        fields.insert(
            "due_at".to_owned(),
            Value::String("2099-01-01T00:00:00Z".to_owned()),
        );
        proposal = ToolProposal::new("schedule_review_item", Value::Object(fields));

        let error = executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal)
            .await
            .expect_err("model-supplied due_at must be rejected");
        assert!(matches!(error, ToolExecutionError::InvalidArguments(_)));
        assert!(store.decisions.lock().expect("decisions lock").is_empty());
    }

    #[tokio::test]
    async fn review_schedule_tool_records_hint_and_miss_provenance_without_moving_the_date() {
        let plain = Arc::new(RecordingStore::default());
        executor(Arc::clone(&plain), GRADED_AT)
            .execute("response-1", proposal("shaky"))
            .await
            .expect("plain outcome");
        let plain_decision = plain.only_decision();
        assert_eq!(plain_decision.hint_count, None);
        assert_eq!(plain_decision.miss_count, None);

        let annotated = Arc::new(RecordingStore::default());
        let Value::Object(mut fields) = proposal("shaky").arguments().clone() else {
            panic!("tool arguments are an object");
        };
        fields.insert("hint_count".to_owned(), json!(2));
        fields.insert("miss_count".to_owned(), json!(1));
        executor(Arc::clone(&annotated), GRADED_AT)
            .execute(
                "response-1",
                ToolProposal::new("schedule_review_item", Value::Object(fields)),
            )
            .await
            .expect("annotated outcome");
        let annotated_decision = annotated.only_decision();
        assert_eq!(annotated_decision.hint_count, Some(2));
        assert_eq!(annotated_decision.miss_count, Some(1));
        assert_eq!(annotated_decision.rating, plain_decision.rating);
        assert_eq!(annotated_decision.due_at, plain_decision.due_at);
    }

    #[tokio::test]
    async fn review_schedule_tool_rejects_negative_hint_or_miss_provenance() {
        let store = Arc::new(RecordingStore::default());
        let Value::Object(mut fields) = proposal("shaky").arguments().clone() else {
            panic!("tool arguments are an object");
        };
        fields.insert("miss_count".to_owned(), json!(-1));
        let error = executor(Arc::clone(&store), GRADED_AT)
            .execute(
                "response-1",
                ToolProposal::new("schedule_review_item", Value::Object(fields)),
            )
            .await
            .expect_err("negative provenance must be rejected");
        assert!(matches!(error, ToolExecutionError::InvalidArguments(_)));
        assert!(store.decisions.lock().expect("decisions lock").is_empty());
    }
}
