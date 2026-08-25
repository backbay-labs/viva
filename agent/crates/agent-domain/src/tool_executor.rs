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
    learning_progression::ProgressionPolicyId,
    learning_recap::{RecapBuildError, SessionLearningEvidence},
    AnswerAttemptEnvelope, Clock, ConceptStatus, PortError, ReviewOutcomeV1, ReviewScheduleError,
    SessionConfig, StudyMemoryStore, StudyMode, StudyQuestion, StudySourceReference, SystemClock,
    ToolProposal, ToolResult,
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

/// Tool arguments that would let a model, adapter, browser, or route claim
/// review-scheduling authority.
///
/// D-01 makes every one of these a server fact: the due date and its cap come
/// from `review_schedule.rs`, the card state and store revision never leave the
/// server, the exam instant and its label come from the persisted study set, and
/// the policy identifier is the recorded D-01 constant. A tool call that names one
/// is refused rather than silently ignored, so a caller cannot believe it steered
/// a schedule it did not steer.
const RESERVED_SCHEDULING_ARGUMENTS: [&str; 12] = [
    "due_at",
    "uncapped_due_at",
    "card",
    "card_state",
    "stability",
    "difficulty",
    "exam_at",
    "exam_label",
    "policy_id",
    "cap_reason",
    "revision",
    "schema_version",
];

/// Tool arguments that would let a model, adapter, browser, or route assert a
/// learner fact about mastery.
///
/// `LEARN-009` leaves exactly one path to mastery: a persisted `TurnOutcome`
/// whose concepts come from the authorized question's rubric and whose statuses
/// come from the locked `viva.semantic-rubric.v1` mapping. A caller that names a
/// concept or a status is proposing a grade, so the call is refused rather than
/// quietly ignored — being overruled in silence teaches a caller nothing.
const RESERVED_MASTERY_ARGUMENTS: [&str; 2] = ["concept_id", "status"];

/// The one execution engine this server publishes (`LEARN-005B`, D-03B).
///
/// It is a server-owned constant, not a client value: every tool result reports
/// this identifier, and no code path derives a mode from a session config, a
/// claim, a query parameter, or a tool argument. The learner never sees this
/// token — the public action is Plan 13's exact `Begin oral exam` label — so
/// `quiz` is an internal wire identifier and never a second choice on offer.
pub const VIVA_STUDY_MODE: &str = "quiz";

#[derive(Clone)]
pub struct AuthorizedStudySession {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub active_concepts: Vec<String>,
}

impl AuthorizedStudySession {
    /// Admission binds identity, and only identity.
    ///
    /// D-03B removed the untrusted mode: an absent mode is not "quiz by
    /// default", it is simply no longer an input, so there is nothing here to
    /// default. A config that still names a non-quiz mode is a forged or stale
    /// client value describing behaviour this server cannot execute, and it is
    /// refused rather than silently downgraded to the one engine that exists —
    /// a caller told its `cram` session was admitted would be told a falsehood.
    pub fn from_config(config: &SessionConfig) -> Result<Self, ToolExecutionError> {
        if let Some(mode) = config.mode.as_ref().map(StudyMode::as_str) {
            if mode != VIVA_STUDY_MODE {
                return Err(ToolExecutionError::InvalidArguments(format!(
                    "session mode `{mode}` is not the one oral-exam engine"
                )));
            }
        }
        Ok(Self {
            user_id: required(config.user_id.as_deref(), "user_id")?.to_owned(),
            study_set_id: required(config.study_set_id.as_deref(), "study_set_id")?.to_owned(),
            voice_session_id: required(config.session_id.as_deref(), "session_id")?.to_owned(),
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
        // `LEARN-009`: one refusal for the whole surface. Every live tool derives
        // its answer from server state, so no live tool has a legitimate reason to
        // read a due date, a card, an exam instant, a concept, or a status off the
        // proposal — and a name the surface does not declare is refused outright.
        reject_server_owned_arguments(proposal.arguments())?;
        let result = match proposal.name() {
            "select_next_question" => self.select_next_question(response_id).await?,
            "evaluate_spoken_answer" => self.evaluate_spoken_answer(response_id, &proposal).await?,
            "retrieve_source_reference" => self.retrieve_source_reference(&proposal).await?,
            "build_session_recap" => self.build_session_recap(response_id).await?,
            "challenge_correction" => self.challenge_correction(&proposal).await?,
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

    /// `LEARN-004B` (D-02B): return the session's own next question.
    ///
    /// Progression is a persisted, session-scoped cursor, so this asks the store
    /// for the authorized selection under the selected `OrderedV1` policy and
    /// reports exactly what came back. It never calls the global
    /// [`StudyMemoryStore::active_question`] shortcut, which answers with the
    /// study set's first active question and therefore cannot advance, retry,
    /// resume, or exhaust a session.
    ///
    /// The authorized response identity is the idempotency source: the store
    /// authorizes one selection per response, so a replay — or two callers racing
    /// on one response — settles on a single cursor revision. An exhausted session
    /// returns [`QuestionProgressionResult::Exhausted`], which carries no question
    /// at all rather than a fabricated one.
    async fn select_next_question(&self, response_id: &str) -> Result<Value, ToolExecutionError> {
        let progression = self
            .store
            .select_next_question(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                ProgressionPolicyId::OrderedV1,
            )
            .await?;
        // D-03B: the reported mode is the server-owned engine constant. Nothing a
        // client sent reaches this field.
        Ok(json!({ "progression": progression, "mode": VIVA_STUDY_MODE }))
    }

    /// The only production path that can produce evaluated mastery.
    ///
    /// Nothing a provider says selects a question, a concept, a source, a due
    /// date, or a retry policy: the question, rubric, concept IDs, source IDs,
    /// recording instant, previous statuses, and retry disposition are all read
    /// back from server-owned state, and only the criterion-level verdicts come
    /// from the injected [`AnswerEvaluator`].
    ///
    /// The question comes from this session's own progression cursor, never from
    /// the study set's global `active_question` shortcut. `LEARN-004B` made
    /// progression a per-session cursor, so the shortcut — which takes no session
    /// and answers with the study set's first active question — names the right
    /// question only until the cursor first advances. Gating an answer on it
    /// would refuse the second answer of every session.
    async fn evaluate_spoken_answer(
        &self,
        response_id: &str,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let question_id = string_arg(proposal.arguments(), "question_id")?;
        let answer_text = raw_string_arg(proposal.arguments(), "answer_text")?;
        let transcript_confidence =
            optional_confidence_arg(proposal.arguments(), "transcript_confidence")?;

        // One session-evidence read serves four server-owned bindings: the
        // authorized question this session is on, the replay identity, the
        // previous concept statuses, and the challenged outcome a replacement may
        // supersede.
        let evidence = self
            .store
            .session_learning_evidence(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
            )
            .await?;
        let question = self.session_question(&evidence, &question_id).await?;
        validate_authorized_rubric(&question)?;
        let source_ids = authorized_source_ids(&question.rubric);
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
        // The schedule is derived from the row the store actually kept, so a
        // replay schedules the persisted outcome rather than the one this call
        // recomputed.
        self.schedule_persisted_outcome(&persisted.turn_outcome)
            .await?;
        Ok(json!({
            "turn_outcome": persisted.turn_outcome,
            "record": persisted.record,
        }))
    }

    /// `LEARN-003A` (D-01A): bind a persisted evaluated outcome to the one
    /// authoritative review schedule.
    ///
    /// Everything Plan 03 owns stays Plan 03's: this reads
    /// `review_scheduling_context` for the store's exam instant and prior card,
    /// hands `review_schedule.rs` only the server-derived status plus provenance
    /// and the injected clock, and writes through
    /// `persist_review_schedule_decision`. It computes no date, keeps no second
    /// card, and returns no learner-visible schedule of its own.
    ///
    /// A deferred outcome skips this path entirely: a deferral is a persisted
    /// fact, not a graded review.
    ///
    /// The authorized response identity is the idempotency source, so a replay
    /// reaches the store's existing per-response guard and the first decision
    /// stays authoritative. That is also what repairs a turn whose outcome
    /// committed and whose schedule did not: the retry replays the outcome and
    /// completes the schedule instead of grading the answer twice.
    async fn schedule_persisted_outcome(
        &self,
        outcome: &TurnOutcome,
    ) -> Result<(), ToolExecutionError> {
        let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &outcome.resolution
        else {
            return Ok(());
        };
        // D-01: read the injected clock exactly once for this outcome.
        let now = self.clock.now();
        for transition in concept_transitions {
            let context = self
                .store
                .review_scheduling_context(
                    &self.session.user_id,
                    &self.session.study_set_id,
                    &transition.concept_id,
                )
                .await?;
            let review = ReviewOutcomeV1 {
                status: transition.to_status.clone(),
                // A graded turn carries no server-owned hint or miss counter.
                // D-01 keeps unknown provenance null rather than coercing it to
                // zero, and provenance can never move the rating or the date.
                hint_count: None,
                miss_count: None,
            };
            let decision = decide_review_schedule(now, &review, &context)?;
            self.store
                .persist_review_schedule_decision(
                    &self.session.user_id,
                    &self.session.study_set_id,
                    &self.session.voice_session_id,
                    &outcome.response_id,
                    &transition.concept_id,
                    decision,
                )
                .await?;
        }
        Ok(())
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
                recap.clone(),
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

    /// The question this session is actually on, bound from its own persisted
    /// progression state.
    ///
    /// Two facts are server-owned here and neither comes from the proposal: which
    /// question this session is on, and what that question's rubric says. The
    /// caller's `question_id` is only ever checked against the cursor's question —
    /// a mismatch, or a session that is on no question at all, refuses the turn
    /// rather than grading an answer against a question the server did not ask.
    ///
    /// The source tuple is re-resolved through deterministic retrieval, so a
    /// stored question citing a source this session cannot retrieve fails closed
    /// instead of carrying an unverified citation into a persisted outcome.
    async fn session_question(
        &self,
        evidence: &SessionLearningEvidence,
        question_id: &str,
    ) -> Result<StudyQuestion, ToolExecutionError> {
        let mut question = evidence.current_question.clone().ok_or_else(|| {
            ToolExecutionError::Unavailable(format!(
                "session `{}` is not on a question, so `{question_id}` cannot be answered",
                self.session.voice_session_id
            ))
        })?;
        if question.question_id != question_id {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "question `{question_id}` is not the question session `{}` is on",
                self.session.voice_session_id
            )));
        }
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

/// Refuse any tool argument that would claim review-scheduling or mastery
/// authority.
///
/// Refusal rather than silent removal is the point: a caller that believes it set
/// a due date or graded a concept and is quietly overruled learns nothing, while
/// a caller that is refused cannot later be told its value was honoured.
fn reject_server_owned_arguments(args: &Value) -> Result<(), ToolExecutionError> {
    for name in RESERVED_SCHEDULING_ARGUMENTS {
        if args.get(name).is_some() {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "`{name}` is a server-owned review scheduling fact and is not an \
                 authoritative tool argument"
            )));
        }
    }
    for name in RESERVED_MASTERY_ARGUMENTS {
        if args.get(name).is_some() {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "`{name}` is a server-derived learner fact and is not an \
                 authoritative tool argument"
            )));
        }
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
