//! Plan 04 learning-core authority suite (integration node `04b`).
//!
//! Every store used here is a Plan-04-owned in-test fake with real hand-derived
//! behaviour: an unimplemented path fails closed with `PortError`, and no path
//! ever answers `Ok` with a fabricated learner fact. The evaluator is scripted,
//! never inferred from the answer text, so a substring grader could not make any
//! assertion below pass.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use agent_domain::{
    learning_outcome::{
        VIVA_CHALLENGE_RESOLUTION_SCHEMA, VIVA_SEMANTIC_RUBRIC_POLICY_VERSION,
        VIVA_TURN_OUTCOME_RECORD_SCHEMA, VIVA_TURN_OUTCOME_SCHEMA,
    },
    // The v2 recap keeps its full module path: the crate root still exports the
    // `study.rs` V1 recap under that name until Plan 06's second PR swaps it.
    learning_recap::{
        build_session_recap, RecapSourceMoment as RecapSourceMomentV2,
        StudySessionRecap as StudySessionRecapV2, VIVA_STUDY_SESSION_RECAP_SCHEMA,
    },
    study_projection::{
        StudyProjectionConceptV1, StudyProjectionQuestionProgressV1, StudyProjectionReviewItemV1,
        StudyProjectionSessionV1, StudyProjectionStudySetV1, StudyProjectionVersionV1,
    },
    AnswerEvaluation,
    AnswerEvaluator,
    AuthenticatedStudyProjectionV1,
    AuthorizedStudySession,
    ChallengeDisposition,
    ChallengeResolution,
    ConceptLabel,
    ConceptStatus,
    CriterionAssessment,
    CriterionAssessmentKind,
    EvaluationDecision,
    EvaluationDeferralReason,
    EvaluationError,
    EvaluationLabel,
    EvaluationRequest,
    EvaluationRubricV1,
    FixedClock,
    PersistedTurnOutcome,
    PortError,
    PortErrorKind,
    ProgressionPolicyId,
    QuestionDisposition,
    QuestionProgressionCursor,
    QuestionProgressionResult,
    RecapBuildError,
    ReviewScheduleAuthority,
    ReviewScheduleCapReasonV1,
    ReviewScheduleDecisionV1,
    ReviewScheduleSummary,
    ReviewSchedulingContextV1,
    RubricCriterionV1,
    SessionLearningEvidence,
    SourceConfidence,
    StudyMode,
    StudyQuestion,
    StudySetIngestionStatus,
    StudySourceReference,
    ToolExecutionError,
    ToolProposal,
    TurnOutcome,
    TurnOutcomeRecordReceipt,
    TurnResolution,
    VivaToolExecutor,
    VIVA_REVIEW_EXAM_MARGIN_SECONDS,
    VIVA_REVIEW_SCHEDULE_POLICY_ID,
    VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
use serde_json::{json, Value};

const USER_ID: &str = "user-101";
const STUDY_SET_ID: &str = "set-cellular-respiration";
const VOICE_SESSION_ID: &str = "vs-0001";
const QUESTION_ID: &str = "q-etc-electron-flow";
const CONCEPT_ETC: &str = "concept-electron-transport-chain";
const CONCEPT_GRADIENT: &str = "concept-proton-gradient";
const SOURCE_DONOR: &str = "src-lec5-slide-18";
const SOURCE_GRADIENT: &str = "src-lec5-slide-19";
const SOURCE_COUPLING: &str = "src-lec5-slide-20";
const NOW: &str = "2026-08-24T14:30:00.000Z";
/// A later wall clock for replay/retry cases: a replayed tool call reads a new
/// instant, so a schedule guard keyed on the computed date would silently write a
/// second review. Plan 03 keys the guard on the graded outcome instead.
const LATER: &str = "2026-08-24T18:45:00.000Z";
/// Persisted exam instants. Only the instant is authoritative; the study set's
/// `exam_label` is display copy and never enters the calculation.
const EXAM_FAR_AT: &str = "2026-10-24T14:30:00.000Z";
const EXAM_INSIDE_MARGIN_AT: &str = "2026-08-27T09:00:00.000Z";
const EXAM_INSIDE_MARGIN_DUE_AT: &str = "2026-08-26T09:00:00.000Z";
const EXAM_ALREADY_PAST_AT: &str = "2026-08-23T09:00:00.000Z";

const TURN_OUTCOMES_FIXTURE: &str =
    include_str!("../../../fixtures/learning-core/turn-outcomes-v1.json");

// ---------------------------------------------------------------------------
// Server-owned fixtures for the authorized question, rubric, and sources.
// ---------------------------------------------------------------------------

fn source(source_id: &str, span: &str, excerpt: &str) -> StudySourceReference {
    StudySourceReference {
        source_id: source_id.to_owned(),
        document_id: "lec5".to_owned(),
        span: span.to_owned(),
        excerpt: excerpt.to_owned(),
        confidence: SourceConfidence::High,
        retrieval_reason: "server-bound rubric source".to_owned(),
    }
}

fn criterion(
    criterion_id: &str,
    concept_id: &str,
    source_id: &str,
    required: bool,
) -> RubricCriterionV1 {
    RubricCriterionV1 {
        criterion_id: criterion_id.to_owned(),
        concept_id: concept_id.to_owned(),
        claim: format!("authorized claim for {criterion_id}"),
        source_id: source_id.to_owned(),
        required,
    }
}

fn rubric() -> EvaluationRubricV1 {
    EvaluationRubricV1 {
        policy_version: VIVA_SEMANTIC_RUBRIC_POLICY_VERSION.to_owned(),
        criteria: vec![
            criterion("crit-etc-donor", CONCEPT_ETC, SOURCE_DONOR, true),
            criterion("crit-etc-complex-order", CONCEPT_ETC, SOURCE_DONOR, true),
            criterion("crit-etc-gradient", CONCEPT_GRADIENT, SOURCE_GRADIENT, true),
            criterion(
                "crit-etc-coupling",
                CONCEPT_GRADIENT,
                SOURCE_COUPLING,
                false,
            ),
        ],
    }
}

fn authorized_question() -> StudyQuestion {
    StudyQuestion {
        question_id: QUESTION_ID.to_owned(),
        concept_id: CONCEPT_ETC.to_owned(),
        prompt: "Explain how NADH starts electron flow through the chain.".to_owned(),
        expected_terms: vec![
            "electron donor".to_owned(),
            "electron transport chain".to_owned(),
            "proton gradient".to_owned(),
            "ATP synthase".to_owned(),
        ],
        follow_up: "Now connect that flow to ATP synthase in one sentence.".to_owned(),
        rubric: rubric(),
        source: source(
            SOURCE_DONOR,
            "slide:18",
            "NADH donates high-energy electrons to complex I.",
        ),
    }
}

fn assessment(
    criterion_id: &str,
    kind: CriterionAssessmentKind,
    confidence: f32,
) -> CriterionAssessment {
    CriterionAssessment {
        criterion_id: criterion_id.to_owned(),
        assessment: kind,
        confidence,
    }
}

/// All four rubric criteria satisfied at the supplied confidences.
fn all_satisfied(donor: f32, order: f32, gradient: f32, coupling: f32) -> Vec<CriterionAssessment> {
    vec![
        assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, donor),
        assessment(
            "crit-etc-complex-order",
            CriterionAssessmentKind::Satisfied,
            order,
        ),
        assessment(
            "crit-etc-gradient",
            CriterionAssessmentKind::Satisfied,
            gradient,
        ),
        assessment(
            "crit-etc-coupling",
            CriterionAssessmentKind::Satisfied,
            coupling,
        ),
    ]
}

fn evaluated(assessments: Vec<CriterionAssessment>) -> EvaluationDecision {
    EvaluationDecision::Evaluated {
        assessments,
        concise_feedback: "Server-authorized feedback about the bound rubric claims.".to_owned(),
        retry_prompt: None,
    }
}

// ---------------------------------------------------------------------------
// Plan-04-owned in-test evaluator.
// ---------------------------------------------------------------------------

struct ScriptedEvaluator {
    script: Vec<Result<EvaluationDecision, EvaluationError>>,
    requests: Mutex<Vec<EvaluationRequest>>,
}

impl ScriptedEvaluator {
    fn new(script: Vec<Result<EvaluationDecision, EvaluationError>>) -> Arc<Self> {
        Arc::new(Self {
            script,
            requests: Mutex::new(Vec::new()),
        })
    }

    fn once(decision: EvaluationDecision) -> Arc<Self> {
        Self::new(vec![Ok(decision)])
    }

    fn failing(error: EvaluationError) -> Arc<Self> {
        Self::new(vec![Err(error)])
    }

    fn call_count(&self) -> usize {
        self.requests.lock().expect("requests lock").len()
    }

    fn last_request(&self) -> EvaluationRequest {
        self.requests
            .lock()
            .expect("requests lock")
            .last()
            .cloned()
            .expect("the evaluator was invoked at least once")
    }
}

#[async_trait::async_trait]
impl AnswerEvaluator for ScriptedEvaluator {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationDecision, EvaluationError> {
        let mut requests = self.requests.lock().expect("requests lock");
        let index = requests.len().min(self.script.len().saturating_sub(1));
        requests.push(request.clone());
        self.script[index].clone()
    }
}

/// The evaluator a test uses when the boundary must never be reached.
struct UnreachableEvaluator;

#[async_trait::async_trait]
impl AnswerEvaluator for UnreachableEvaluator {
    async fn evaluate(
        &self,
        _request: &EvaluationRequest,
    ) -> Result<EvaluationDecision, EvaluationError> {
        panic!("the evaluator must not be invoked on this path");
    }
}

// ---------------------------------------------------------------------------
// Plan-04-owned in-test store.
// ---------------------------------------------------------------------------

/// One persisted D-01A decision row.
///
/// The replay key is exactly the one Plan 03's `persist_review_schedule_decision`
/// documents: the graded outcome's identity plus the outcome payload, never the
/// schedule that payload produced. A replay reads a later wall clock and therefore
/// recomputes a different `due_at`/`generated_at`, so a guard keyed on those would
/// let the replay write a second review and advance the persisted card.
#[derive(Clone, Debug)]
struct PersistedScheduleDecision {
    user_id: String,
    study_set_id: String,
    voice_session_id: String,
    response_id: String,
    concept_id: String,
    payload_key: String,
    decision: ReviewScheduleDecisionV1,
}

impl PersistedScheduleDecision {
    fn identifies(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
    ) -> bool {
        self.user_id == user_id
            && self.study_set_id == study_set_id
            && self.voice_session_id == voice_session_id
            && self.response_id == response_id
            && self.concept_id == concept_id
    }
}

/// The graded-outcome half of the replay key: concept, policy, status, rating, and
/// provenance. Dates are deliberately absent.
fn schedule_payload_key(concept_id: &str, decision: &ReviewScheduleDecisionV1) -> String {
    format!(
        "{concept_id}|{}|{:?}|{}|{:?}|{:?}",
        decision.policy_id,
        decision.status,
        decision.rating,
        decision.hint_count,
        decision.miss_count,
    )
}

#[derive(Default)]
struct FakeLearningStore {
    question: Option<StudyQuestion>,
    sources: BTreeMap<String, StudySourceReference>,
    concept_labels: Vec<ConceptLabel>,
    statuses: Mutex<BTreeMap<String, ConceptStatus>>,
    outcomes: Mutex<Vec<TurnOutcome>>,
    challenges: Mutex<Vec<ChallengeResolution>>,
    persisted_recaps: Mutex<Vec<Value>>,
    evidence_unavailable: bool,
    recap_persistence_fails: bool,
    /// The store-owned exam instant. D-01 forbids taking it from a tool argument.
    exam_at: Option<String>,
    /// Display copy only. Nothing below reads it while scheduling.
    exam_label: Option<String>,
    schedule_decisions: Mutex<Vec<PersistedScheduleDecision>>,
    schedule_persistence_fails: Mutex<bool>,
}

impl FakeLearningStore {
    fn ready() -> Self {
        let mut sources = BTreeMap::new();
        for (id, span, excerpt) in [
            (
                SOURCE_DONOR,
                "slide:18",
                "NADH donates high-energy electrons to complex I.",
            ),
            (
                SOURCE_GRADIENT,
                "slide:19",
                "Electron flow pumps protons into the intermembrane space.",
            ),
            (
                SOURCE_COUPLING,
                "slide:20",
                "The gradient drives ATP synthesis.",
            ),
        ] {
            sources.insert(id.to_owned(), source(id, span, excerpt));
        }
        Self {
            question: Some(authorized_question()),
            sources,
            concept_labels: vec![
                ConceptLabel {
                    concept_id: CONCEPT_ETC.to_owned(),
                    label: "Electron transport chain".to_owned(),
                },
                ConceptLabel {
                    concept_id: CONCEPT_GRADIENT.to_owned(),
                    label: "Proton gradient".to_owned(),
                },
            ],
            ..Self::default()
        }
    }

    fn status(&self, concept_id: &str) -> ConceptStatus {
        self.statuses
            .lock()
            .expect("statuses lock")
            .get(concept_id)
            .cloned()
            .unwrap_or_default()
    }

    fn recorded_outcomes(&self) -> Vec<TurnOutcome> {
        self.outcomes.lock().expect("outcomes lock").clone()
    }

    fn recorded_challenges(&self) -> Vec<ChallengeResolution> {
        self.challenges.lock().expect("challenges lock").clone()
    }

    fn without_session_evidence(mut self) -> Self {
        self.evidence_unavailable = true;
        self
    }

    fn persisted_recaps(&self) -> Vec<Value> {
        self.persisted_recaps.lock().expect("recaps lock").clone()
    }

    /// Bind a persisted exam instant plus its display label.
    fn with_exam(mut self, exam_at: &str, exam_label: &str) -> Self {
        self.exam_at = Some(exam_at.to_owned());
        self.exam_label = Some(exam_label.to_owned());
        self
    }

    /// A study set that shows an exam label but has recorded no exam instant.
    fn with_exam_label_only(mut self, exam_label: &str) -> Self {
        self.exam_label = Some(exam_label.to_owned());
        self
    }

    fn set_schedule_persistence_failure(&self, fails: bool) {
        *self
            .schedule_persistence_fails
            .lock()
            .expect("schedule failure lock") = fails;
    }

    fn schedule_decisions(&self) -> Vec<PersistedScheduleDecision> {
        self.schedule_decisions
            .lock()
            .expect("schedule decisions lock")
            .clone()
    }

    fn decisions_for(&self, concept_id: &str) -> Vec<ReviewScheduleDecisionV1> {
        self.schedule_decisions()
            .into_iter()
            .filter(|row| row.concept_id == concept_id)
            .map(|row| row.decision)
            .collect()
    }

    fn latest_decision_for(&self, concept_id: &str) -> Option<ReviewScheduleDecisionV1> {
        self.decisions_for(concept_id).pop()
    }

    /// The D-01 authenticated read model: the latest persisted decision per
    /// concept, with `past_exam`-capped decisions excluded because no future
    /// review exists for them. Ordered by concept ID so two reads agree.
    fn learner_visible_reviews(&self) -> Vec<(String, String)> {
        let mut latest: BTreeMap<String, ReviewScheduleDecisionV1> = BTreeMap::new();
        for row in self.schedule_decisions() {
            latest.insert(row.concept_id.clone(), row.decision);
        }
        latest
            .into_iter()
            .filter(|(_, decision)| {
                decision.cap_reason != Some(ReviewScheduleCapReasonV1::PastExam)
            })
            .map(|(concept_id, decision)| {
                (
                    concept_id,
                    agent_domain::format_rfc3339_millis(decision.due_at),
                )
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl agent_domain::StudyMemoryStore for FakeLearningStore {
    async fn study_context(
        &self,
        _user_id: &str,
        _study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        Ok(None)
    }

    async fn active_question(
        &self,
        _user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        self.question.clone().map(Some).ok_or_else(|| {
            PortError::unavailable("fake_store", study_set_id, "no authorized question")
        })
    }

    async fn source_reference(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        Ok(self.sources.get(source_id).cloned())
    }

    /// Retired by `LEARN-002`: the live path must never reach the independent
    /// evaluation write, so this fake refuses instead of returning a receipt.
    async fn record_answer_evaluation(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "fake_store",
            response_id,
            "record_answer_evaluation is retired by the turn-outcome authority",
        ))
    }

    /// Retired by `LEARN-002`: mastery moves only inside `record_turn_outcome`.
    async fn record_concept_status(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _response_id: &str,
        concept_id: &str,
        _status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        Err(PortError::unavailable(
            "fake_store",
            concept_id,
            "independent concept status writes are retired",
        ))
    }

    async fn schedule_review_item(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        concept_id: &str,
        _due_at: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "fake_store",
            concept_id,
            "legacy due-date writes are not implemented by this store",
        ))
    }

    /// Plan 03's authoritative scheduling inputs: the store's own exam instant and
    /// the latest persisted v1 card for the concept. Neither can come from a tool
    /// argument.
    async fn review_scheduling_context(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        let exam_at = match self.exam_at.as_deref() {
            Some(raw) => Some(agent_domain::parse_utc_instant(raw).ok_or_else(|| {
                PortError::invalid_input(
                    "fake_store",
                    concept_id,
                    "the persisted exam instant does not parse",
                )
            })?),
            None => None,
        };
        Ok(ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at,
            card: self
                .latest_decision_for(concept_id)
                .map(|decision| decision.card),
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
        decision.validate().map_err(|error| {
            PortError::invalid_input("fake_store", concept_id, error.to_string())
        })?;
        if *self
            .schedule_persistence_fails
            .lock()
            .expect("schedule failure lock")
        {
            return Err(PortError::durability(
                "fake_store",
                concept_id,
                "the review schedule decision could not be committed",
            ));
        }

        let payload_key = schedule_payload_key(concept_id, &decision);
        let mut rows = self
            .schedule_decisions
            .lock()
            .expect("schedule decisions lock");
        if let Some(stored) = rows.iter().find(|row| {
            row.identifies(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
            )
        }) {
            if stored.payload_key != payload_key {
                return Err(PortError::conflict(
                    "fake_store",
                    concept_id,
                    "a different graded payload was already scheduled under this response",
                ));
            }
            // A replay writes nothing: the first decision stays authoritative and
            // the persisted FSRS memory does not advance.
            return Ok(stored.decision.public_summary(concept_id));
        }
        let summary = decision.public_summary(concept_id);
        rows.push(PersistedScheduleDecision {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            response_id: response_id.to_owned(),
            concept_id: concept_id.to_owned(),
            payload_key,
            decision,
        });
        Ok(summary)
    }

    async fn record_recap(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
        _response_id: &str,
        recap: agent_domain::StudySessionRecap,
    ) -> Result<Value, PortError> {
        if self.recap_persistence_fails {
            return Err(PortError::durability(
                "fake_store",
                voice_session_id,
                "recap could not be committed",
            ));
        }
        let encoded = serde_json::to_value(&recap).expect("recap serializes");
        self.persisted_recaps
            .lock()
            .expect("recaps lock")
            .push(encoded);
        Ok(json!({ "voice_session_id": voice_session_id, "stored": true }))
    }

    async fn record_turn_outcome(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        let mut outcomes = self.outcomes.lock().expect("outcomes lock");
        if let Some(stored) = outcomes
            .iter()
            .find(|stored| stored.response_id == outcome.response_id)
        {
            if *stored != outcome {
                return Err(PortError::conflict(
                    "fake_store",
                    &outcome.response_id,
                    "a different payload was already recorded for this response",
                ));
            }
            return Ok(PersistedTurnOutcome {
                turn_outcome: stored.clone(),
                record: TurnOutcomeRecordReceipt {
                    schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                    response_id: outcome.response_id.clone(),
                    replayed: true,
                },
            });
        }

        // Atomic in the only sense a single-process fake can be: every transition
        // is validated against the persisted previous status before any of them
        // is applied, so a rejected transition leaves mastery untouched.
        if let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &outcome.resolution
        {
            let statuses = self.statuses.lock().expect("statuses lock");
            for transition in concept_transitions {
                let previous = statuses
                    .get(&transition.concept_id)
                    .cloned()
                    .unwrap_or_default();
                if previous != transition.from_status {
                    return Err(PortError::conflict(
                        "fake_store",
                        &transition.concept_id,
                        "transition does not start from the persisted status",
                    ));
                }
            }
            drop(statuses);
            let mut statuses = self.statuses.lock().expect("statuses lock");
            for transition in concept_transitions {
                statuses.insert(transition.concept_id.clone(), transition.to_status.clone());
            }
        }

        outcomes.push(outcome.clone());
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
        if self.evidence_unavailable {
            return Err(PortError::unavailable(
                "fake_store",
                voice_session_id,
                "session evidence is not readable",
            ));
        }
        Ok(SessionLearningEvidence {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            outcomes: self.recorded_outcomes(),
            concept_labels: self.concept_labels.clone(),
            // Under D-01A the recap's review entries are the persisted decisions,
            // never a schedule this store recomputed.
            review_decisions: self
                .learner_visible_reviews()
                .into_iter()
                .map(|(concept_id, due_at)| ReviewScheduleSummary {
                    concept_id,
                    due_at,
                    authority: ReviewScheduleAuthority::ServerPersistedFsrs,
                })
                .collect(),
        })
    }

    async fn record_challenge_resolution(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        resolution: ChallengeResolution,
    ) -> Result<ChallengeResolution, PortError> {
        let outcomes = self.outcomes.lock().expect("outcomes lock");
        if !outcomes
            .iter()
            .any(|outcome| outcome.response_id == resolution.challenged_response_id)
        {
            return Err(PortError::invalid_input(
                "fake_store",
                &resolution.challenged_response_id,
                "a challenge must bind a persisted outcome",
            ));
        }
        drop(outcomes);
        self.challenges
            .lock()
            .expect("challenges lock")
            .push(resolution.clone());
        Ok(resolution)
    }

    async fn authenticated_study_projection(
        &self,
        _user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<AuthenticatedStudyProjectionV1, PortError> {
        // One persisted decision set feeds both the concept `due_at` and the
        // projection's `review_schedule`; nothing here recomputes a due date.
        let reviews = self
            .learner_visible_reviews()
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        let concepts = self
            .concept_labels
            .iter()
            .map(|label| StudyProjectionConceptV1 {
                id: label.concept_id.clone(),
                label: label.label.clone(),
                status: self.status(&label.concept_id),
                last_reviewed_at: None,
                due_at: reviews.get(&label.concept_id).cloned(),
            })
            .collect::<Vec<_>>();
        Ok(AuthenticatedStudyProjectionV1 {
            version: StudyProjectionVersionV1,
            study_set: StudyProjectionStudySetV1 {
                id: study_set_id.to_owned(),
                title: "Cellular respiration".to_owned(),
                course: None,
                exam_label: self.exam_label.clone(),
                ingestion_status: StudySetIngestionStatus::Ready,
            },
            session: StudyProjectionSessionV1 {
                id: voice_session_id.to_owned(),
                mode: StudyMode::Quiz,
                goal: None,
            },
            concepts,
            active_question: None,
            question_progress: StudyProjectionQuestionProgressV1 {
                completed: 0,
                total: 3,
            },
            review_schedule: reviews
                .into_iter()
                .map(|(concept_id, due_at)| StudyProjectionReviewItemV1 {
                    concept_id,
                    due_at,
                    authority: ReviewScheduleAuthority::ServerPersistedFsrs,
                })
                .collect(),
        })
    }
}

// ---------------------------------------------------------------------------
// Executor composition helpers.
// ---------------------------------------------------------------------------

fn session() -> AuthorizedStudySession {
    AuthorizedStudySession {
        user_id: USER_ID.to_owned(),
        study_set_id: STUDY_SET_ID.to_owned(),
        voice_session_id: VOICE_SESSION_ID.to_owned(),
        mode: StudyMode::Quiz,
        active_concepts: vec![CONCEPT_ETC.to_owned(), CONCEPT_GRADIENT.to_owned()],
    }
}

fn executor(
    store: Arc<FakeLearningStore>,
    evaluator: Arc<dyn AnswerEvaluator>,
) -> VivaToolExecutor {
    executor_at(store, evaluator, NOW)
}

/// The same composition at an explicit instant, so a replay or retry can read a
/// wall clock that has genuinely moved.
fn executor_at(
    store: Arc<FakeLearningStore>,
    evaluator: Arc<dyn AnswerEvaluator>,
    now: &str,
) -> VivaToolExecutor {
    VivaToolExecutor::with_clock(
        store,
        session(),
        evaluator,
        Arc::new(FixedClock::new(
            agent_domain::parse_utc_instant(now).expect("clock instant parses"),
        )),
    )
}

fn answer_proposal(answer_text: &str) -> ToolProposal {
    ToolProposal::evaluate_spoken_answer(STUDY_SET_ID, VOICE_SESSION_ID, QUESTION_ID, answer_text)
}

fn answer_proposal_with(extra: Vec<(&str, Value)>) -> ToolProposal {
    let mut fields = match answer_proposal("A bound spoken answer.")
        .arguments()
        .clone()
    {
        Value::Object(fields) => fields,
        _ => panic!("tool arguments are an object"),
    };
    for (key, value) in extra {
        fields.insert(key.to_owned(), value);
    }
    ToolProposal::new("evaluate_spoken_answer", Value::Object(fields))
}

async fn evaluate(
    store: &Arc<FakeLearningStore>,
    evaluator: Arc<dyn AnswerEvaluator>,
    response_id: &str,
    proposal: ToolProposal,
) -> Result<Value, ToolExecutionError> {
    executor(Arc::clone(store), evaluator)
        .execute(response_id, proposal)
        .await
        .map(|result| result.result)
}

fn turn_outcome_from(result: &Value) -> TurnOutcome {
    serde_json::from_value(result["turn_outcome"].clone())
        .expect("tool result carries a TurnOutcome")
}

fn deferral_reason(outcome: &TurnOutcome) -> EvaluationDeferralReason {
    match &outcome.resolution {
        TurnResolution::Deferred { reason, .. } => reason.clone(),
        TurnResolution::Evaluated { .. } => {
            panic!("expected a deferred resolution, found an evaluated one")
        }
    }
}

fn evaluated_parts(outcome: &TurnOutcome) -> (EvaluationLabel, f32, Vec<(String, ConceptStatus)>) {
    match &outcome.resolution {
        TurnResolution::Evaluated {
            label,
            confidence,
            concept_transitions,
            ..
        } => (
            *label,
            *confidence,
            concept_transitions
                .iter()
                .map(|transition| (transition.concept_id.clone(), transition.to_status.clone()))
                .collect(),
        ),
        TurnResolution::Deferred { reason, .. } => {
            panic!("expected an evaluated resolution, found deferred {reason:?}")
        }
    }
}

/// Run one scripted decision through the whole authority path and return the
/// persisted outcome.
async fn record_decision(decision: EvaluationDecision) -> (Arc<FakeLearningStore>, TurnOutcome) {
    let store = Arc::new(FakeLearningStore::ready());
    let result = evaluate(
        &store,
        ScriptedEvaluator::once(decision),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("evaluate_spoken_answer succeeds");
    let outcome = turn_outcome_from(&result);
    (store, outcome)
}

// ===========================================================================
// LEARN-002 — versioned semantic evaluation and persisted turn outcomes
// ===========================================================================

#[tokio::test]
async fn turn_outcome_negated_expected_terms_cannot_become_strong() {
    // Every expected term is present verbatim, negated. A substring grader would
    // call this Strong; the semantic evaluator contradicts the required claim.
    let answer = "NADH is not an electron donor, the electron transport chain does not run, \
                  there is no proton gradient, and ATP synthase does nothing.";
    let store = Arc::new(FakeLearningStore::ready());
    let decision = EvaluationDecision::Evaluated {
        assessments: vec![
            assessment(
                "crit-etc-donor",
                CriterionAssessmentKind::Contradicted,
                0.94,
            ),
            assessment(
                "crit-etc-complex-order",
                CriterionAssessmentKind::NotDemonstrated,
                0.9,
            ),
            assessment(
                "crit-etc-gradient",
                CriterionAssessmentKind::Contradicted,
                0.92,
            ),
            assessment(
                "crit-etc-coupling",
                CriterionAssessmentKind::NotDemonstrated,
                0.88,
            ),
        ],
        concise_feedback: "The answer denied each required claim.".to_owned(),
        retry_prompt: Some("Say what NADH actually hands off.".to_owned()),
    };

    let result = evaluate(
        &store,
        ScriptedEvaluator::once(decision),
        "response-1",
        answer_proposal(answer),
    )
    .await
    .expect("evaluate_spoken_answer succeeds");

    let (label, _, transitions) = evaluated_parts(&turn_outcome_from(&result));
    assert_eq!(label, EvaluationLabel::Wrong);
    assert_eq!(
        transitions,
        vec![
            (CONCEPT_ETC.to_owned(), ConceptStatus::Missed),
            (CONCEPT_GRADIENT.to_owned(), ConceptStatus::Missed),
        ]
    );
    assert_eq!(store.status(CONCEPT_ETC), ConceptStatus::Missed);
}

#[tokio::test]
async fn turn_outcome_accepts_a_synonym_that_repeats_no_expected_term() {
    let answer = "The reduced coenzyme hands its high-energy pair to the first respiratory \
                  complex, and that flow shoves hydrogen ions outward.";
    let store = Arc::new(FakeLearningStore::ready());
    let evaluator = ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.89, 0.87, 0.86)));

    let result = evaluate(
        &store,
        Arc::clone(&evaluator) as Arc<dyn AnswerEvaluator>,
        "response-1",
        answer_proposal(answer),
    )
    .await
    .expect("evaluate_spoken_answer succeeds");

    let outcome = turn_outcome_from(&result);
    let (label, confidence, transitions) = evaluated_parts(&outcome);
    assert_eq!(label, EvaluationLabel::Strong);
    assert!((confidence - 0.87).abs() < f32::EPSILON, "{confidence}");
    assert_eq!(
        transitions,
        vec![
            (CONCEPT_ETC.to_owned(), ConceptStatus::Strong),
            (CONCEPT_GRADIENT.to_owned(), ConceptStatus::Strong),
        ]
    );
    // The evaluator received the ephemeral answer and the server-bound question.
    let request = evaluator.last_request();
    assert_eq!(request.answer_text, answer);
    assert_eq!(request.question.question_id, QUESTION_ID);
    assert_eq!(request.question.rubric, rubric());
    for term in &request.question.expected_terms {
        assert!(
            !answer.to_lowercase().contains(&term.to_lowercase()),
            "the accepted answer must repeat no expected term ({term})"
        );
    }
}

#[tokio::test]
async fn turn_outcome_satisfied_plus_contradicted_cannot_cross_the_strong_boundary() {
    // Required criteria all satisfied above the Strong threshold, one optional
    // criterion contradicted: the concept may not reach Strong.
    let decision = EvaluationDecision::Evaluated {
        assessments: vec![
            assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, 0.93),
            assessment(
                "crit-etc-complex-order",
                CriterionAssessmentKind::Satisfied,
                0.9,
            ),
            assessment(
                "crit-etc-gradient",
                CriterionAssessmentKind::Satisfied,
                0.95,
            ),
            assessment(
                "crit-etc-coupling",
                CriterionAssessmentKind::Contradicted,
                0.9,
            ),
        ],
        concise_feedback: "Required claims held; the optional coupling claim was contradicted."
            .to_owned(),
        retry_prompt: None,
    };
    let (_, outcome) = record_decision(decision).await;
    let (label, _, transitions) = evaluated_parts(&outcome);

    assert_eq!(label, EvaluationLabel::MostlyCorrect);
    assert_eq!(
        transitions,
        vec![
            (CONCEPT_ETC.to_owned(), ConceptStatus::Strong),
            (CONCEPT_GRADIENT.to_owned(), ConceptStatus::Shaky),
        ]
    );
}

#[tokio::test]
async fn turn_outcome_defers_an_empty_answer_before_invoking_the_evaluator() {
    let store = Arc::new(FakeLearningStore::ready());
    let result = evaluate(
        &store,
        Arc::new(UnreachableEvaluator),
        "response-1",
        answer_proposal("   \u{2003}\u{00a0}\t\n "),
    )
    .await
    .expect("an empty answer is a persisted fact, not an error");

    let outcome = turn_outcome_from(&result);
    assert_eq!(
        deferral_reason(&outcome),
        EvaluationDeferralReason::EmptyAnswer
    );
    assert_eq!(store.recorded_outcomes().len(), 1);
}

#[tokio::test]
async fn turn_outcome_defers_an_uncertain_transcript_at_the_exact_boundary() {
    for (confidence, expected) in [
        (json!(0.65), None),
        (
            json!(0.64),
            Some(EvaluationDeferralReason::TranscriptUncertain),
        ),
        (
            json!(1.01),
            Some(EvaluationDeferralReason::TranscriptUncertain),
        ),
        (
            json!(-0.01),
            Some(EvaluationDeferralReason::TranscriptUncertain),
        ),
    ] {
        let store = Arc::new(FakeLearningStore::ready());
        let evaluator = ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9)));
        let result = evaluate(
            &store,
            Arc::clone(&evaluator) as Arc<dyn AnswerEvaluator>,
            "response-1",
            answer_proposal_with(vec![("transcript_confidence", confidence.clone())]),
        )
        .await
        .expect("transcript uncertainty is a persisted fact");
        let outcome = turn_outcome_from(&result);
        match expected {
            None => {
                assert!(matches!(
                    outcome.resolution,
                    TurnResolution::Evaluated { .. }
                ));
                assert_eq!(evaluator.call_count(), 1, "confidence={confidence}");
            }
            Some(reason) => {
                assert_eq!(deferral_reason(&outcome), reason, "confidence={confidence}");
                assert_eq!(
                    evaluator.call_count(),
                    0,
                    "an uncertain transcript must not reach the evaluator"
                );
            }
        }
    }
}

#[tokio::test]
async fn turn_outcome_defers_an_absent_transcript_confidence_without_inventing_certainty() {
    let store = Arc::new(FakeLearningStore::ready());
    let evaluator = ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9)));
    let result = evaluate(
        &store,
        Arc::clone(&evaluator) as Arc<dyn AnswerEvaluator>,
        "response-1",
        answer_proposal_with(vec![("transcript_confidence", Value::Null)]),
    )
    .await
    .expect("an absent transcript confidence is allowed");

    assert!(matches!(
        turn_outcome_from(&result).resolution,
        TurnResolution::Evaluated { .. }
    ));
    assert_eq!(evaluator.last_request().transcript_confidence, None);
}

#[tokio::test]
async fn turn_outcome_maps_every_evaluator_error_to_its_deferral_reason() {
    for (error, reason) in [
        (
            EvaluationError::Unavailable,
            EvaluationDeferralReason::EvaluatorUnavailable,
        ),
        (
            EvaluationError::Timeout,
            EvaluationDeferralReason::EvaluatorUnavailable,
        ),
        (
            EvaluationError::MalformedResponse,
            EvaluationDeferralReason::InvalidEvaluatorOutput,
        ),
        (
            EvaluationError::ContractViolation,
            EvaluationDeferralReason::InvalidEvaluatorOutput,
        ),
    ] {
        let store = Arc::new(FakeLearningStore::ready());
        let result = evaluate(
            &store,
            ScriptedEvaluator::failing(error),
            "response-1",
            answer_proposal("A bound spoken answer."),
        )
        .await
        .expect("an evaluator failure is a persisted deferral");
        let outcome = turn_outcome_from(&result);
        assert_eq!(deferral_reason(&outcome), reason, "error={error:?}");
        assert_eq!(store.status(CONCEPT_ETC), ConceptStatus::Review);
    }
}

#[tokio::test]
async fn turn_outcome_defers_incomplete_and_unknown_criterion_coverage() {
    let cases: Vec<(&str, Vec<CriterionAssessment>)> = vec![
        (
            "missing criterion",
            vec![
                assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, 0.9),
                assessment(
                    "crit-etc-complex-order",
                    CriterionAssessmentKind::Satisfied,
                    0.9,
                ),
                assessment("crit-etc-gradient", CriterionAssessmentKind::Satisfied, 0.9),
            ],
        ),
        ("unknown criterion", {
            let mut assessments = all_satisfied(0.9, 0.9, 0.9, 0.9);
            assessments.push(assessment(
                "crit-invented",
                CriterionAssessmentKind::Satisfied,
                0.9,
            ));
            assessments
        }),
        ("duplicate criterion", {
            let mut assessments = all_satisfied(0.9, 0.9, 0.9, 0.9);
            assessments.push(assessment(
                "crit-etc-donor",
                CriterionAssessmentKind::Satisfied,
                0.9,
            ));
            assessments
        }),
        ("empty assessment set", Vec::new()),
    ];

    for (case, assessments) in cases {
        let (store, outcome) = record_decision(evaluated(assessments)).await;
        assert_eq!(
            deferral_reason(&outcome),
            EvaluationDeferralReason::InvalidEvaluatorOutput,
            "case={case}"
        );
        assert_eq!(store.status(CONCEPT_GRADIENT), ConceptStatus::Review);
    }
}

#[tokio::test]
async fn turn_outcome_defers_internally_contradictory_evaluator_output() {
    let mut assessments = all_satisfied(0.9, 0.9, 0.9, 0.9);
    assessments.push(assessment(
        "crit-etc-donor",
        CriterionAssessmentKind::Contradicted,
        0.9,
    ));
    let (store, outcome) = record_decision(evaluated(assessments)).await;

    assert_eq!(
        deferral_reason(&outcome),
        EvaluationDeferralReason::ContradictoryEvidence
    );
    assert_eq!(store.status(CONCEPT_ETC), ConceptStatus::Review);
}

#[tokio::test]
async fn turn_outcome_grades_a_clean_required_contradiction_instead_of_deferring_it() {
    let decision = EvaluationDecision::Evaluated {
        assessments: vec![
            assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, 0.92),
            assessment(
                "crit-etc-complex-order",
                CriterionAssessmentKind::Satisfied,
                0.9,
            ),
            assessment(
                "crit-etc-gradient",
                CriterionAssessmentKind::Contradicted,
                0.9,
            ),
            assessment(
                "crit-etc-coupling",
                CriterionAssessmentKind::NotDemonstrated,
                0.74,
            ),
        ],
        concise_feedback: "A required claim was contradicted.".to_owned(),
        retry_prompt: Some("Which side gains protons?".to_owned()),
    };
    let (_, outcome) = record_decision(decision).await;
    let (label, _, transitions) = evaluated_parts(&outcome);

    assert_eq!(label, EvaluationLabel::Wrong);
    assert_eq!(
        transitions,
        vec![
            (CONCEPT_ETC.to_owned(), ConceptStatus::Strong),
            (CONCEPT_GRADIENT.to_owned(), ConceptStatus::Missed),
        ]
    );
    match outcome.resolution {
        TurnResolution::Evaluated { disposition, .. } => {
            assert_eq!(disposition, QuestionDisposition::RetryCurrent);
        }
        TurnResolution::Deferred { .. } => panic!("a clean contradiction is graded"),
    }
}

#[tokio::test]
async fn turn_outcome_defers_confidence_below_the_semantic_evidence_floor() {
    let (store, low) = record_decision(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.59))).await;
    assert_eq!(
        deferral_reason(&low),
        EvaluationDeferralReason::InsufficientSemanticEvidence
    );
    assert_eq!(store.status(CONCEPT_ETC), ConceptStatus::Review);

    let (_, boundary) = record_decision(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.6))).await;
    assert!(matches!(
        boundary.resolution,
        TurnResolution::Evaluated { .. }
    ));
}

#[tokio::test]
async fn turn_outcome_rejects_out_of_range_and_non_finite_confidence() {
    for invalid in [1.01_f32, -0.01_f32, f32::NAN, f32::INFINITY] {
        let (_, outcome) = record_decision(evaluated(all_satisfied(0.9, 0.9, 0.9, invalid))).await;
        assert_eq!(
            deferral_reason(&outcome),
            EvaluationDeferralReason::InvalidEvaluatorOutput,
            "confidence={invalid}"
        );
    }
}

#[tokio::test]
async fn turn_outcome_deferral_produces_zero_concept_transitions() {
    for reason in [
        EvaluationDeferralReason::EmptyAnswer,
        EvaluationDeferralReason::TranscriptUncertain,
        EvaluationDeferralReason::EvaluatorUnavailable,
        EvaluationDeferralReason::InvalidEvaluatorOutput,
        EvaluationDeferralReason::InsufficientSemanticEvidence,
        EvaluationDeferralReason::ContradictoryEvidence,
    ] {
        let store = Arc::new(FakeLearningStore::ready());
        let (evaluator, proposal): (Arc<dyn AnswerEvaluator>, ToolProposal) = match reason {
            EvaluationDeferralReason::EmptyAnswer => {
                (Arc::new(UnreachableEvaluator), answer_proposal("   "))
            }
            EvaluationDeferralReason::TranscriptUncertain => (
                Arc::new(UnreachableEvaluator),
                answer_proposal_with(vec![("transcript_confidence", json!(0.2))]),
            ),
            EvaluationDeferralReason::EvaluatorUnavailable => (
                ScriptedEvaluator::failing(EvaluationError::Unavailable),
                answer_proposal("A bound spoken answer."),
            ),
            EvaluationDeferralReason::InvalidEvaluatorOutput => (
                ScriptedEvaluator::once(evaluated(Vec::new())),
                answer_proposal("A bound spoken answer."),
            ),
            EvaluationDeferralReason::InsufficientSemanticEvidence => (
                ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.1))),
                answer_proposal("A bound spoken answer."),
            ),
            EvaluationDeferralReason::ContradictoryEvidence => {
                let mut assessments = all_satisfied(0.9, 0.9, 0.9, 0.9);
                assessments.push(assessment(
                    "crit-etc-gradient",
                    CriterionAssessmentKind::Contradicted,
                    0.9,
                ));
                (
                    ScriptedEvaluator::once(evaluated(assessments)),
                    answer_proposal("A bound spoken answer."),
                )
            }
        };

        let result = evaluate(&store, evaluator, "response-1", proposal)
            .await
            .expect("every deferral is persisted");
        let outcome = turn_outcome_from(&result);
        assert_eq!(deferral_reason(&outcome), reason);

        let encoded = serde_json::to_value(&outcome).expect("outcome serializes");
        assert!(
            encoded["resolution"].get("concept_transitions").is_none(),
            "a deferred resolution carries no transitions: {encoded}"
        );
        assert_eq!(store.status(CONCEPT_ETC), ConceptStatus::Review);
        assert_eq!(store.status(CONCEPT_GRADIENT), ConceptStatus::Review);
    }
}

#[tokio::test]
async fn turn_outcome_labels_and_status_bands_are_exhaustive_and_reachable_at_boundaries() {
    // (assessments, expected label, expected [ETC, gradient] statuses)
    let cases: Vec<(
        &str,
        Vec<CriterionAssessment>,
        EvaluationLabel,
        [ConceptStatus; 2],
    )> = vec![
        (
            "strong at the exact 0.85 boundary",
            all_satisfied(0.85, 0.85, 0.85, 0.85),
            EvaluationLabel::Strong,
            [ConceptStatus::Strong, ConceptStatus::Strong],
        ),
        (
            "one hundredth below the boundary is shaky",
            all_satisfied(0.85, 0.85, 0.84, 0.85),
            EvaluationLabel::MostlyCorrect,
            [ConceptStatus::Strong, ConceptStatus::Shaky],
        ),
        (
            "two of three required criteria satisfied is partially correct",
            vec![
                assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, 0.86),
                assessment(
                    "crit-etc-complex-order",
                    CriterionAssessmentKind::Satisfied,
                    0.87,
                ),
                assessment(
                    "crit-etc-gradient",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.7,
                ),
                assessment(
                    "crit-etc-coupling",
                    CriterionAssessmentKind::Satisfied,
                    0.83,
                ),
            ],
            EvaluationLabel::PartiallyCorrect,
            [ConceptStatus::Strong, ConceptStatus::Missed],
        ),
        (
            "one of three required criteria satisfied is vague",
            vec![
                assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, 0.78),
                assessment(
                    "crit-etc-complex-order",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.68,
                ),
                assessment(
                    "crit-etc-gradient",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.64,
                ),
                assessment(
                    "crit-etc-coupling",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.61,
                ),
            ],
            EvaluationLabel::Vague,
            [ConceptStatus::Shaky, ConceptStatus::Missed],
        ),
        (
            "nothing satisfied is insufficient evidence",
            vec![
                assessment(
                    "crit-etc-donor",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.72,
                ),
                assessment(
                    "crit-etc-complex-order",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.69,
                ),
                assessment(
                    "crit-etc-gradient",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.66,
                ),
                assessment(
                    "crit-etc-coupling",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.63,
                ),
            ],
            EvaluationLabel::InsufficientEvidence,
            [ConceptStatus::Missed, ConceptStatus::Missed],
        ),
        (
            "a required contradiction is wrong",
            vec![
                assessment("crit-etc-donor", CriterionAssessmentKind::Contradicted, 0.9),
                assessment(
                    "crit-etc-complex-order",
                    CriterionAssessmentKind::Satisfied,
                    0.9,
                ),
                assessment("crit-etc-gradient", CriterionAssessmentKind::Satisfied, 0.9),
                assessment("crit-etc-coupling", CriterionAssessmentKind::Satisfied, 0.9),
            ],
            EvaluationLabel::Wrong,
            [ConceptStatus::Missed, ConceptStatus::Strong],
        ),
    ];

    let mut seen_labels = BTreeSet::new();
    let mut seen_statuses = BTreeSet::new();
    for (case, assessments, expected_label, expected_statuses) in cases {
        let (_, outcome) = record_decision(evaluated(assessments)).await;
        let (label, _, transitions) = evaluated_parts(&outcome);
        assert_eq!(label, expected_label, "case={case}");
        assert_eq!(
            transitions,
            vec![
                (CONCEPT_ETC.to_owned(), expected_statuses[0].clone()),
                (CONCEPT_GRADIENT.to_owned(), expected_statuses[1].clone()),
            ],
            "case={case}"
        );
        seen_labels.insert(format!("{label:?}"));
        for status in &expected_statuses {
            seen_statuses.insert(format!("{status:?}"));
        }
    }

    assert_eq!(
        seen_labels.len(),
        6,
        "every evaluation label must be reachable"
    );
    // `Review` is only reachable when a concept carries three or more required
    // criteria, so it gets its own rubric rather than a fabricated band.
    assert_eq!(seen_statuses.len(), 3, "{seen_statuses:?}");
}

#[tokio::test]
async fn turn_outcome_review_band_is_reachable_below_half_coverage() {
    let mut wide = FakeLearningStore::ready();
    let mut question = authorized_question();
    question.rubric = EvaluationRubricV1 {
        policy_version: VIVA_SEMANTIC_RUBRIC_POLICY_VERSION.to_owned(),
        criteria: vec![
            criterion("crit-a", CONCEPT_ETC, SOURCE_DONOR, true),
            criterion("crit-b", CONCEPT_ETC, SOURCE_DONOR, true),
            criterion("crit-c", CONCEPT_ETC, SOURCE_DONOR, true),
        ],
    };
    wide.question = Some(question);
    let wide = Arc::new(wide);

    let decision = evaluated(vec![
        assessment("crit-a", CriterionAssessmentKind::Satisfied, 0.9),
        assessment("crit-b", CriterionAssessmentKind::NotDemonstrated, 0.9),
        assessment("crit-c", CriterionAssessmentKind::NotDemonstrated, 0.9),
    ]);
    let result = evaluate(
        &wide,
        ScriptedEvaluator::once(decision),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("evaluate_spoken_answer succeeds");

    let (label, _, transitions) = evaluated_parts(&turn_outcome_from(&result));
    assert_eq!(label, EvaluationLabel::Vague);
    assert_eq!(
        transitions,
        vec![(CONCEPT_ETC.to_owned(), ConceptStatus::Review)]
    );
}

#[tokio::test]
async fn turn_outcome_replay_returns_the_identical_outcome_and_a_replay_receipt() {
    let store = Arc::new(FakeLearningStore::ready());
    let first = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("first evaluation succeeds");
    let second = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("replay succeeds");

    assert_eq!(first["turn_outcome"], second["turn_outcome"]);
    assert_eq!(first["record"]["replayed"], json!(false));
    assert_eq!(second["record"]["replayed"], json!(true));
    assert_eq!(store.recorded_outcomes().len(), 1);
}

#[tokio::test]
async fn turn_outcome_changed_payload_under_one_response_id_fails_closed() {
    let store = Arc::new(FakeLearningStore::ready());
    evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("first evaluation succeeds");

    let error = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.7, 0.7, 0.7, 0.7))),
        "response-1",
        answer_proposal("A different spoken answer."),
    )
    .await
    .expect_err("a changed payload under one response id must fail closed");

    match error {
        ToolExecutionError::Store(port) => assert_eq!(port.kind(), PortErrorKind::Conflict),
        other => panic!("expected a store conflict, found {other:?}"),
    }
    assert_eq!(store.recorded_outcomes().len(), 1);
    assert_eq!(store.status(CONCEPT_ETC), ConceptStatus::Strong);
}

#[tokio::test]
async fn turn_outcome_challenge_alone_cannot_mutate_mastery() {
    let store = Arc::new(FakeLearningStore::ready());
    // A graded turn whose required gradient claim was contradicted.
    evaluate(
        &store,
        ScriptedEvaluator::once(EvaluationDecision::Evaluated {
            assessments: vec![
                assessment("crit-etc-donor", CriterionAssessmentKind::Satisfied, 0.92),
                assessment(
                    "crit-etc-complex-order",
                    CriterionAssessmentKind::Satisfied,
                    0.9,
                ),
                assessment(
                    "crit-etc-gradient",
                    CriterionAssessmentKind::Contradicted,
                    0.9,
                ),
                assessment(
                    "crit-etc-coupling",
                    CriterionAssessmentKind::NotDemonstrated,
                    0.74,
                ),
            ],
            concise_feedback: "A required claim was contradicted.".to_owned(),
            retry_prompt: Some("Which side gains protons?".to_owned()),
        }),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("first evaluation succeeds");
    assert_eq!(store.status(CONCEPT_GRADIENT), ConceptStatus::Missed);

    let challenge = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-2",
            ToolProposal::challenge_correction(
                STUDY_SET_ID,
                VOICE_SESSION_ID,
                &source(
                    SOURCE_GRADIENT,
                    "slide:19",
                    "Electron flow pumps protons into the intermembrane space.",
                ),
                "correction-1",
                "The slide reads differently to me.",
            ),
        )
        .await
        .expect("challenge_correction succeeds");

    let resolution: ChallengeResolution =
        serde_json::from_value(challenge.result["challenge_resolution"].clone())
            .expect("challenge result carries a ChallengeResolution");
    assert_eq!(resolution.schema, VIVA_CHALLENGE_RESOLUTION_SCHEMA);
    assert_eq!(resolution.challenged_response_id, "response-1");
    assert_eq!(resolution.source_id, SOURCE_GRADIENT);
    assert_eq!(
        resolution.disposition,
        ChallengeDisposition::ReevaluationRequired
    );
    assert_eq!(store.recorded_challenges().len(), 1);
    // Mastery is untouched by the challenge itself.
    assert_eq!(store.status(CONCEPT_GRADIENT), ConceptStatus::Missed);

    // Only a replacement outcome that supersedes the challenged response moves it.
    let replacement = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.92, 0.9, 0.88, 0.86))),
        "response-3",
        answer_proposal_with(vec![("supersedes_response_id", json!("response-1"))]),
    )
    .await
    .expect("the replacement evaluation succeeds");
    let replacement = turn_outcome_from(&replacement);
    assert_eq!(
        replacement.supersedes_response_id.as_deref(),
        Some("response-1")
    );
    assert_eq!(store.status(CONCEPT_GRADIENT), ConceptStatus::Strong);
}

#[tokio::test]
async fn turn_outcome_supersede_must_name_a_persisted_retryable_outcome() {
    let store = Arc::new(FakeLearningStore::ready());
    let error = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal_with(vec![("supersedes_response_id", json!("response-invented"))]),
    )
    .await
    .expect_err("an invented supersede identity must be rejected");
    assert!(matches!(error, ToolExecutionError::InvalidArguments(_)));
    assert!(store.recorded_outcomes().is_empty());
}

#[tokio::test]
async fn turn_outcome_result_is_exactly_the_outcome_and_its_receipt() {
    let store = Arc::new(FakeLearningStore::ready());
    let result = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("evaluate_spoken_answer succeeds");

    let mut keys = result
        .as_object()
        .expect("tool result is an object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["record".to_owned(), "turn_outcome".to_owned()]);

    let outcome = turn_outcome_from(&result);
    assert_eq!(outcome.schema, VIVA_TURN_OUTCOME_SCHEMA);
    assert_eq!(outcome.question_id, QUESTION_ID);
    assert_eq!(
        outcome.rubric_policy_version,
        VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
    );
    assert_eq!(outcome.recorded_at, NOW);
    assert_eq!(
        outcome.source_ids,
        vec![
            SOURCE_DONOR.to_owned(),
            SOURCE_GRADIENT.to_owned(),
            SOURCE_COUPLING.to_owned()
        ]
    );
    assert_eq!(result["record"]["schema"], VIVA_TURN_OUTCOME_RECORD_SCHEMA);
    assert_eq!(result["record"]["response_id"], "response-1");
}

#[tokio::test]
async fn turn_outcome_never_persists_the_answer_text() {
    let answer = "a distinctive spoken sentence about respiration";
    let store = Arc::new(FakeLearningStore::ready());
    evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal(answer),
    )
    .await
    .expect("evaluate_spoken_answer succeeds");

    let encoded =
        serde_json::to_string(&store.recorded_outcomes()).expect("persisted outcomes serialize");
    assert!(!encoded.contains(answer), "{encoded}");
    assert!(!encoded.contains("answer_text"), "{encoded}");
}

#[tokio::test]
async fn turn_outcome_rejects_evaluator_feedback_outside_the_authorized_bounds() {
    let cases: Vec<(&str, String, Option<String>)> = vec![
        ("empty feedback", "   ".to_owned(), None),
        ("overlong feedback", "x".repeat(481), None),
        (
            "control character",
            "feedback with a bell \u{0007} inside".to_owned(),
            None,
        ),
        (
            "line break",
            "feedback split\nacross lines".to_owned(),
            None,
        ),
        ("tab", "feedback with a\ttab".to_owned(), None),
        (
            "line break in the retry prompt",
            "acceptable feedback".to_owned(),
            Some("retry\nprompt".to_owned()),
        ),
        (
            "overlong retry prompt",
            "acceptable feedback".to_owned(),
            Some("y".repeat(241)),
        ),
        (
            "empty retry prompt",
            "acceptable feedback".to_owned(),
            Some("  ".to_owned()),
        ),
        (
            "unauthorized source reference",
            "See src-lec9-slide-02 for the real claim.".to_owned(),
            None,
        ),
    ];

    for (case, feedback, retry_prompt) in cases {
        let decision = EvaluationDecision::Evaluated {
            assessments: all_satisfied(0.9, 0.9, 0.9, 0.9),
            concise_feedback: feedback,
            retry_prompt,
        };
        let (store, outcome) = record_decision(decision).await;
        assert_eq!(
            deferral_reason(&outcome),
            EvaluationDeferralReason::InvalidEvaluatorOutput,
            "case={case}"
        );
        assert_eq!(
            store.status(CONCEPT_ETC),
            ConceptStatus::Review,
            "case={case}"
        );
    }
}

#[tokio::test]
async fn turn_outcome_accepts_feedback_at_the_exact_length_bounds() {
    let decision = EvaluationDecision::Evaluated {
        assessments: all_satisfied(0.9, 0.9, 0.9, 0.9),
        concise_feedback: "z".repeat(480),
        retry_prompt: Some("w".repeat(240)),
    };
    let (_, outcome) = record_decision(decision).await;
    assert!(matches!(
        outcome.resolution,
        TurnResolution::Evaluated { .. }
    ));
}

#[tokio::test]
async fn turn_outcome_rejects_a_question_that_is_not_the_authorized_one() {
    let store = Arc::new(FakeLearningStore::ready());
    let error = evaluate(
        &store,
        Arc::new(UnreachableEvaluator),
        "response-1",
        ToolProposal::evaluate_spoken_answer(
            STUDY_SET_ID,
            VOICE_SESSION_ID,
            "q-model-invented",
            "An answer to a question the server never asked.",
        ),
    )
    .await
    .expect_err("an unauthorized question must be rejected");
    assert!(matches!(error, ToolExecutionError::InvalidArguments(_)));
    assert!(store.recorded_outcomes().is_empty());
}

#[tokio::test]
async fn turn_outcome_rejects_a_rubric_without_a_required_criterion_per_concept() {
    let mut store = FakeLearningStore::ready();
    let mut question = authorized_question();
    question.rubric = EvaluationRubricV1 {
        policy_version: VIVA_SEMANTIC_RUBRIC_POLICY_VERSION.to_owned(),
        criteria: vec![
            criterion("crit-etc-donor", CONCEPT_ETC, SOURCE_DONOR, true),
            criterion(
                "crit-etc-coupling",
                CONCEPT_GRADIENT,
                SOURCE_COUPLING,
                false,
            ),
        ],
    };
    store.question = Some(question);
    let store = Arc::new(store);

    let error = evaluate(
        &store,
        Arc::new(UnreachableEvaluator),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect_err("a rubric with an unrequired concept must fail closed");
    assert!(matches!(error, ToolExecutionError::Unavailable(_)));
    assert!(store.recorded_outcomes().is_empty());
}

#[tokio::test]
async fn turn_outcome_rejects_a_concept_absent_from_the_authenticated_projection() {
    let mut store = FakeLearningStore::ready();
    store
        .concept_labels
        .retain(|label| label.concept_id == CONCEPT_ETC);
    let store = Arc::new(store);

    let error = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect_err("an unauthorized concept must fail closed");
    assert!(matches!(error, ToolExecutionError::Unavailable(_)));
    assert!(store.recorded_outcomes().is_empty());
}

#[test]
fn turn_outcome_decision_carries_no_provider_selected_concept_id() {
    let decision = evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9));
    let encoded = serde_json::to_string(&decision).expect("decision serializes");
    assert!(
        !encoded.contains("concept_id"),
        "an evaluator decision may not name a concept: {encoded}"
    );
}

#[test]
fn turn_outcome_types_reject_unknown_inner_keys() {
    let fixture: Value =
        serde_json::from_str(TURN_OUTCOMES_FIXTURE).expect("turn outcomes fixture is valid JSON");

    let mut outcome = fixture["outcomes"]["evaluated_strong"].clone();
    outcome
        .as_object_mut()
        .expect("outcome is an object")
        .insert(
            "fabricated_due_at".to_owned(),
            json!("2099-01-01T00:00:00Z"),
        );
    serde_json::from_value::<TurnOutcome>(outcome)
        .expect_err("an unknown TurnOutcome key must be rejected, not ignored");

    let mut resolution = fixture["outcomes"]["evaluated_strong"].clone();
    resolution["resolution"]
        .as_object_mut()
        .expect("resolution is an object")
        .insert("fabricated_status".to_owned(), json!("strong"));
    serde_json::from_value::<TurnOutcome>(resolution)
        .expect_err("an unknown resolution key must be rejected, not ignored");

    let mut assessment_value = fixture["outcomes"]["evaluated_strong"].clone();
    assessment_value["resolution"]["assessments"][0]
        .as_object_mut()
        .expect("assessment is an object")
        .insert("concept_id".to_owned(), json!(CONCEPT_ETC));
    serde_json::from_value::<TurnOutcome>(assessment_value)
        .expect_err("a provider-selected concept id must be rejected, not ignored");

    let mut rubric_value = fixture["rubric"].clone();
    rubric_value["criteria"][0]
        .as_object_mut()
        .expect("criterion is an object")
        .insert("weight".to_owned(), json!(2));
    serde_json::from_value::<EvaluationRubricV1>(rubric_value)
        .expect_err("an unknown rubric criterion key must be rejected, not ignored");

    let mut receipt = fixture["persisted"]["first_record"].clone();
    receipt["record"]
        .as_object_mut()
        .expect("record is an object")
        .insert("granted_status".to_owned(), json!("strong"));
    serde_json::from_value::<PersistedTurnOutcome>(receipt)
        .expect_err("an unknown receipt key must be rejected, not ignored");

    let mut challenge = fixture["challenges"]["source_confirmed"].clone();
    challenge
        .as_object_mut()
        .expect("challenge is an object")
        .insert("granted_status".to_owned(), json!("strong"));
    serde_json::from_value::<ChallengeResolution>(challenge)
        .expect_err("an unknown challenge key must be rejected, not ignored");
}

#[test]
fn turn_outcome_shared_fixture_covers_every_required_case() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        rubric: EvaluationRubricV1,
        outcomes: BTreeMap<String, TurnOutcome>,
        persisted: BTreeMap<String, PersistedTurnOutcome>,
        challenges: BTreeMap<String, ChallengeResolution>,
        #[allow(dead_code)]
        schema: String,
    }

    let fixture: Fixture =
        serde_json::from_str(TURN_OUTCOMES_FIXTURE).expect("turn outcomes fixture parses");
    assert_eq!(
        fixture.rubric.policy_version,
        VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
    );

    // Every evaluated fixture case must satisfy the same complete-coverage rule
    // the production policy enforces: exactly one assessment per rubric criterion.
    // A fixture that omitted a required criterion would be invalid evaluator
    // output, not an evaluated outcome.
    let rubric_ids = fixture
        .rubric
        .criteria
        .iter()
        .map(|criterion| criterion.criterion_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut evaluated_cases = 0_usize;
    for (case, outcome) in &fixture.outcomes {
        let TurnResolution::Evaluated { assessments, .. } = &outcome.resolution else {
            continue;
        };
        evaluated_cases += 1;
        let assessed = assessments
            .iter()
            .map(|assessment| assessment.criterion_id.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            assessed, rubric_ids,
            "evaluated case {case} must assess exactly the rubric criteria",
        );
        assert_eq!(
            assessments.len(),
            fixture.rubric.criteria.len(),
            "evaluated case {case} must assess each rubric criterion exactly once",
        );
    }
    assert!(evaluated_cases >= 6, "{evaluated_cases}");

    let deferral_reasons = fixture
        .outcomes
        .values()
        .filter_map(|outcome| match &outcome.resolution {
            TurnResolution::Deferred { reason, .. } => Some(format!("{reason:?}")),
            TurnResolution::Evaluated { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        deferral_reasons.len(),
        6,
        "every deferral reason must be pinned: {deferral_reasons:?}"
    );

    // Contradiction, synonym, replay, and challenge cases.
    assert!(fixture.outcomes.contains_key("evaluated_synonym_accepted"));
    assert!(fixture
        .outcomes
        .contains_key("evaluated_required_contradiction_is_wrong"));
    assert!(fixture
        .outcomes
        .values()
        .any(|outcome| outcome.supersedes_response_id.is_some()));
    assert!(fixture
        .persisted
        .values()
        .any(|persisted| persisted.record.replayed));
    assert!(fixture
        .challenges
        .values()
        .any(|challenge| { challenge.disposition == ChallengeDisposition::ReevaluationRequired }));

    // Answer text is absent from every persisted fixture value.
    assert!(!TURN_OUTCOMES_FIXTURE.contains("answer_text"));
}

// ===========================================================================
// LEARN-001 — recaps derived only from persisted session evidence
// ===========================================================================

const RECAPS_FIXTURE: &str = include_str!("../../../fixtures/learning-core/recaps-v1.json");

#[derive(serde::Deserialize)]
struct RecapsFixture {
    #[allow(dead_code)]
    schema: String,
    evidence: BTreeMap<String, SessionLearningEvidence>,
    recaps: BTreeMap<String, StudySessionRecapV2>,
}

fn recaps_fixture() -> RecapsFixture {
    serde_json::from_str(RECAPS_FIXTURE).expect("recaps fixture parses")
}

fn evidence_case(case: &str) -> SessionLearningEvidence {
    recaps_fixture()
        .evidence
        .remove(case)
        .unwrap_or_else(|| panic!("recaps fixture declares case {case}"))
}

fn fold(evidence: &SessionLearningEvidence) -> StudySessionRecapV2 {
    build_session_recap(evidence).expect("evidence folds into a recap")
}

#[test]
fn recap_fold_matches_every_shared_fixture_case() {
    let fixture = recaps_fixture();
    assert_eq!(fixture.evidence.len(), 9, "every RED case must be pinned");

    for (case, evidence) in &fixture.evidence {
        let expected = fixture
            .recaps
            .get(case)
            .unwrap_or_else(|| panic!("case {case} has an expected recap"));
        let built = build_session_recap(evidence)
            .unwrap_or_else(|error| panic!("case {case} must fold: {error:?}"));
        assert_eq!(&built, expected, "case={case}");
        assert_eq!(built.schema, VIVA_STUDY_SESSION_RECAP_SCHEMA, "case={case}");
    }
}

#[test]
fn recap_replay_and_reconnect_rebuild_the_identical_recap() {
    // A replayed row contributes once, so the recap equals the single-outcome one.
    let replayed = evidence_case("evaluated_then_idempotent_replay");
    let mut single = replayed.clone();
    single.outcomes.truncate(1);
    assert_eq!(fold(&replayed), fold(&single));

    // Reconnecting rebuilds from the same persisted rows.
    let first = evidence_case("mixed_strong_shaky_missed");
    let reconnected = evidence_case("reconnect_rebuild");
    assert_eq!(fold(&first), fold(&reconnected));
    assert_eq!(
        serde_json::to_string(&fold(&first)).expect("recap serializes"),
        serde_json::to_string(&fold(&reconnected)).expect("recap serializes"),
    );
}

#[test]
fn recap_never_duplicates_a_concept() {
    for case in recaps_fixture().evidence.keys() {
        let recap = fold(&evidence_case(case));
        let unique = recap
            .concepts
            .iter()
            .map(|concept| concept.concept_id.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(unique.len(), recap.concepts.len(), "case={case}");
    }
}

#[test]
fn recap_deferred_only_session_has_no_graded_bucket() {
    let recap = fold(&evidence_case("deferred_only"));
    assert!(recap.concepts.is_empty());
    assert!(recap.review_schedule.is_empty());
    assert!(recap.source_moments.is_empty());
    assert_eq!(recap.deferred_turns, 2);
    assert_eq!(recap.headline, "No graded concepts this session.");
    assert_eq!(
        recap.summary,
        "No graded outcome was saved for this session."
    );
    assert_eq!(
        recap.next_action,
        "Answer one question to start building evidence."
    );
}

#[test]
fn recap_no_outcomes_states_that_nothing_was_saved() {
    let recap = fold(&evidence_case("no_outcomes"));
    assert_eq!(
        recap.summary,
        "No graded outcome was saved for this session."
    );
    assert_eq!(recap.deferred_turns, 0);
    for claim in ["strong", "weak", "due", "review the scheduled"] {
        assert!(
            !recap.summary.to_lowercase().contains(claim),
            "the no-evidence summary must claim nothing: {}",
            recap.summary
        );
    }
}

#[test]
fn recap_graded_without_a_schedule_asks_for_more_evidence() {
    let mut evidence = evidence_case("mixed_strong_shaky_missed");
    evidence.review_decisions.clear();
    let recap = fold(&evidence);
    assert!(recap.review_schedule.is_empty());
    assert_eq!(recap.next_action, "Keep answering to build more evidence.");
    assert_eq!(recap.concepts.len(), 3);
}

#[test]
fn recap_source_moment_requires_a_nonsuperseded_evaluated_outcome() {
    let recap = fold(&evidence_case("source_moment_outside_outcome"));
    assert_eq!(
        recap.source_moments,
        vec![RecapSourceMomentV2 {
            response_id: "resp-9001".to_owned(),
            source_id: "src-lec5-slide-18".to_owned(),
        }]
    );
    assert_eq!(recap.deferred_turns, 1);

    // The superseded outcome's source moment disappears with the outcome.
    let superseded = fold(&evidence_case("superseded_challenged_outcome"));
    assert_eq!(superseded.source_moments.len(), 1);
    assert_eq!(superseded.source_moments[0].response_id, "resp-6002");
}

#[test]
fn recap_same_label_on_distinct_concepts_stays_two_entries() {
    let recap = fold(&evidence_case("same_label_distinct_concepts"));
    assert_eq!(recap.concepts.len(), 2);
    assert_eq!(recap.concepts[0].label, recap.concepts[1].label);
    assert_ne!(recap.concepts[0].concept_id, recap.concepts[1].concept_id);
    assert_ne!(recap.concepts[0].status, recap.concepts[1].status);
}

#[test]
fn recap_fails_closed_on_missing_or_duplicate_concept_label() {
    let mut missing = evidence_case("all_missed");
    missing
        .concept_labels
        .retain(|label| label.concept_id != CONCEPT_ETC);
    assert_eq!(
        build_session_recap(&missing),
        Err(RecapBuildError::MissingConceptLabel {
            concept_id: CONCEPT_ETC.to_owned()
        })
    );

    let mut duplicated = evidence_case("all_missed");
    duplicated.concept_labels.push(ConceptLabel {
        concept_id: CONCEPT_ETC.to_owned(),
        label: "A second label for one concept".to_owned(),
    });
    assert_eq!(
        build_session_recap(&duplicated),
        Err(RecapBuildError::DuplicateConceptLabel {
            concept_id: CONCEPT_ETC.to_owned()
        })
    );
}

#[test]
fn recap_fails_closed_on_duplicate_or_invalid_review_decision() {
    let mut duplicated = evidence_case("all_missed");
    duplicated.review_decisions.push(ReviewScheduleSummary {
        concept_id: CONCEPT_ETC.to_owned(),
        due_at: "2026-09-09T09:00:00.000Z".to_owned(),
        authority: ReviewScheduleAuthority::ServerPersistedFsrs,
    });
    assert_eq!(
        build_session_recap(&duplicated),
        Err(RecapBuildError::DuplicateReviewDecision {
            concept_id: CONCEPT_ETC.to_owned()
        })
    );

    let mut invalid = evidence_case("all_missed");
    invalid.review_decisions[0].due_at = "soon".to_owned();
    assert_eq!(
        build_session_recap(&invalid),
        Err(RecapBuildError::InvalidReviewDecision {
            concept_id: CONCEPT_ETC.to_owned()
        })
    );

    let mut ungraded = evidence_case("all_missed");
    ungraded.review_decisions.push(ReviewScheduleSummary {
        concept_id: "concept-never-graded".to_owned(),
        due_at: "2026-09-09T09:00:00.000Z".to_owned(),
        authority: ReviewScheduleAuthority::ServerPersistedFsrs,
    });
    assert_eq!(
        build_session_recap(&ungraded),
        Err(RecapBuildError::InvalidReviewDecision {
            concept_id: "concept-never-graded".to_owned()
        })
    );
}

#[test]
fn recap_fails_closed_on_blank_evidence_identity() {
    for mutate in [
        |evidence: &mut SessionLearningEvidence| evidence.user_id = "  ".to_owned(),
        |evidence: &mut SessionLearningEvidence| evidence.study_set_id = String::new(),
        |evidence: &mut SessionLearningEvidence| evidence.voice_session_id = "\t".to_owned(),
    ] {
        let mut evidence = evidence_case("all_missed");
        mutate(&mut evidence);
        assert_eq!(
            build_session_recap(&evidence),
            Err(RecapBuildError::EvidenceIdentityMismatch)
        );
    }
}

#[test]
fn recap_reads_no_expected_term_positions() {
    // The evidence a recap folds carries no expected terms at all, so a recap can
    // never be a projection of a question's term list.
    let encoded = serde_json::to_string(&evidence_case("mixed_strong_shaky_missed"))
        .expect("evidence serializes");
    assert!(!encoded.contains("expected_terms"), "{encoded}");
    assert!(!RECAPS_FIXTURE.contains("expected_terms"));
}

#[test]
fn recap_types_reject_unknown_inner_keys() {
    let fixture: Value = serde_json::from_str(RECAPS_FIXTURE).expect("recaps fixture is JSON");

    let mut recap = fixture["recaps"]["all_missed"].clone();
    recap
        .as_object_mut()
        .expect("recap is an object")
        .insert("strong_concepts".to_owned(), json!(["fabricated"]));
    serde_json::from_value::<StudySessionRecapV2>(recap)
        .expect_err("a legacy bucket key must be rejected, not ignored");

    let mut concept = fixture["recaps"]["all_missed"].clone();
    concept["concepts"][0]
        .as_object_mut()
        .expect("concept is an object")
        .insert("due_at".to_owned(), json!("2099-01-01T00:00:00Z"));
    serde_json::from_value::<StudySessionRecapV2>(concept)
        .expect_err("an unknown recap concept key must be rejected, not ignored");

    let mut evidence = fixture["evidence"]["all_missed"].clone();
    evidence
        .as_object_mut()
        .expect("evidence is an object")
        .insert("granted_status".to_owned(), json!("strong"));
    serde_json::from_value::<SessionLearningEvidence>(evidence)
        .expect_err("an unknown evidence key must be rejected, not ignored");
}

#[tokio::test]
async fn recap_tool_folds_persisted_evidence_and_persists_it() {
    // The review entries below are not seeded: they are the decisions the graded
    // turn itself persisted through the selected D-01A seam.
    let store = Arc::new(FakeLearningStore::ready());
    evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("the graded turn is persisted");

    let result = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-2",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect("build_session_recap succeeds");

    let recap: StudySessionRecapV2 = serde_json::from_value(result.result["recap"].clone())
        .expect("the tool returns the evidence-derived recap");
    assert_eq!(recap.schema, VIVA_STUDY_SESSION_RECAP_SCHEMA);
    assert_eq!(recap.voice_session_id, VOICE_SESSION_ID);
    assert_eq!(recap.headline, "Strong concepts: 2 of 2.");
    assert_eq!(
        recap.summary,
        "Graded concepts: 2. Evaluated turns: 1. Deferred turns: 0."
    );
    assert_eq!(
        recap
            .concepts
            .iter()
            .map(|concept| (concept.concept_id.as_str(), concept.status.clone()))
            .collect::<Vec<_>>(),
        vec![
            (CONCEPT_ETC, ConceptStatus::Strong),
            (CONCEPT_GRADIENT, ConceptStatus::Strong),
        ]
    );
    assert_eq!(
        recap
            .review_schedule
            .iter()
            .map(|item| (item.concept_id.clone(), item.due_at.clone()))
            .collect::<Vec<_>>(),
        store.learner_visible_reviews()
    );
    assert_eq!(recap.review_schedule.len(), 2);
    assert_eq!(recap.source_moments.len(), 3);

    // Rebuilding is a pure projection: the second call equals the first exactly.
    let again = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-3",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect("rebuild succeeds");
    assert_eq!(again.result["recap"], result.result["recap"]);

    // The recap actually reached the store, and it carries no question term text.
    let persisted = store.persisted_recaps();
    assert_eq!(persisted.len(), 2);
    let encoded = serde_json::to_string(&persisted).expect("persisted recaps serialize");
    assert!(!encoded.contains("electron donor"), "{encoded}");
    assert!(!encoded.contains("ATP synthase"), "{encoded}");
}

#[tokio::test]
async fn recap_tool_fails_closed_when_session_evidence_is_unavailable() {
    let store = Arc::new(FakeLearningStore::ready().without_session_evidence());
    let error = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-1",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect_err("an unreadable evidence store cannot produce a recap");
    match error {
        ToolExecutionError::Store(port) => assert_eq!(port.kind(), PortErrorKind::Unavailable),
        other => panic!("expected a store failure, found {other:?}"),
    }
    assert!(store.persisted_recaps().is_empty());
}

#[tokio::test]
async fn recap_tool_fails_closed_on_unfoldable_evidence() {
    let mut store = FakeLearningStore::ready();
    store.concept_labels.clear();
    let store = Arc::new(store);
    evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect_err("an unauthorized concept never grades");

    let mut store = FakeLearningStore::ready();
    let store_with_outcome = Arc::new(FakeLearningStore::ready());
    evaluate(
        &store_with_outcome,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("the graded turn is persisted");
    *store.outcomes.lock().expect("outcomes lock") = store_with_outcome.recorded_outcomes();
    store.concept_labels.clear();
    let store = Arc::new(store);

    let error = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-2",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect_err("evidence missing a concept label cannot be folded");
    assert!(
        matches!(error, ToolExecutionError::RecapEvidence(_)),
        "{error:?}"
    );
    assert!(store.persisted_recaps().is_empty());
}

// ===========================================================================
// LEARN-003A — evaluated outcomes bound to the selected D-01A v1 seam
//
// Every case below drives the real `evaluate_spoken_answer` path. Plan 03 owns
// `PersistedFsrsCardV1`, `ReviewScheduleDecisionV1`, and `decide_review_schedule`;
// nothing here redeclares them, recomputes a due date, or seeds a schedule the
// executor did not actually persist.
// ===========================================================================

/// Grade one turn and return the store it was graded against.
async fn graded_session(now: &str, response_id: &str, store: &Arc<FakeLearningStore>) {
    executor_at(
        Arc::clone(store),
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        now,
    )
    .execute(response_id, answer_proposal("A bound spoken answer."))
    .await
    .expect("the graded turn is persisted");
}

#[tokio::test]
async fn scheduling_outcome_binds_the_evaluated_status_to_one_persisted_decision() {
    let store = Arc::new(FakeLearningStore::ready());
    graded_session(NOW, "response-1", &store).await;

    let rows = store.schedule_decisions();
    assert_eq!(
        rows.iter()
            .map(|row| row.concept_id.as_str())
            .collect::<Vec<_>>(),
        vec![CONCEPT_ETC, CONCEPT_GRADIENT],
        "one decision per evaluated concept transition, in rubric order"
    );
    for row in &rows {
        assert_eq!(row.response_id, "response-1");
        assert_eq!(row.user_id, USER_ID);
        assert_eq!(row.study_set_id, STUDY_SET_ID);
        assert_eq!(row.voice_session_id, VOICE_SESSION_ID);
        let decision = &row.decision;
        assert_eq!(decision.schema_version, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION);
        assert_eq!(decision.policy_id, VIVA_REVIEW_SCHEDULE_POLICY_ID);
        // The status is the server-derived transition, and its rating is the one
        // D-01 mapping: strong -> 4 (Easy).
        assert_eq!(decision.status, ConceptStatus::Strong);
        assert_eq!(decision.rating, 4);
        assert_eq!(
            agent_domain::format_rfc3339_millis(decision.generated_at),
            NOW
        );
        assert_eq!(decision.exam_at, None);
        assert_eq!(decision.cap_reason, None);
        assert_eq!(decision.card.reps, 1);
        // Unknown provenance stays null; it is never coerced to zero.
        assert_eq!(decision.hint_count, None);
        assert_eq!(decision.miss_count, None);
        decision
            .validate()
            .expect("the persisted decision is valid");
    }
}

#[tokio::test]
async fn scheduling_outcome_a_shaky_turn_schedules_the_shaky_rating() {
    let store = Arc::new(FakeLearningStore::ready());
    // Every required criterion satisfied, but below the strong floor.
    evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.7, 0.7, 0.7, 0.7))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect("the graded turn is persisted");

    let rows = store.schedule_decisions();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert_eq!(row.decision.status, ConceptStatus::Shaky);
        assert_eq!(row.decision.rating, 3);
    }
}

#[tokio::test]
async fn scheduling_outcome_deferred_turn_creates_no_decision() {
    for (label, evaluator, proposal) in [
        (
            "empty answer",
            Arc::new(UnreachableEvaluator) as Arc<dyn AnswerEvaluator>,
            answer_proposal("   "),
        ),
        (
            "evaluator unavailable",
            ScriptedEvaluator::failing(EvaluationError::Unavailable),
            answer_proposal("A bound spoken answer."),
        ),
        (
            "uncertain transcript",
            Arc::new(UnreachableEvaluator),
            answer_proposal_with(vec![("transcript_confidence", json!(0.2))]),
        ),
    ] {
        let store = Arc::new(FakeLearningStore::ready());
        let result = evaluate(&store, evaluator, "response-1", proposal)
            .await
            .unwrap_or_else(|error| panic!("{label} defers rather than failing: {error:?}"));
        let outcome = turn_outcome_from(&result);
        assert!(
            matches!(outcome.resolution, TurnResolution::Deferred { .. }),
            "{label}"
        );
        assert!(
            store.schedule_decisions().is_empty(),
            "{label} must schedule nothing"
        );
    }
}

#[tokio::test]
async fn scheduling_outcome_second_and_tenth_reviews_reload_the_persisted_card() {
    let store = Arc::new(FakeLearningStore::ready());
    for turn in 1..=10 {
        graded_session(NOW, &format!("response-{turn}"), &store).await;
    }

    let decisions = store.decisions_for(CONCEPT_ETC);
    assert_eq!(decisions.len(), 10);
    for (index, decision) in decisions.iter().enumerate() {
        assert_eq!(
            decision.card.reps,
            u32::try_from(index + 1).expect("small count"),
            "review {} must continue the persisted card, not restart a New one",
            index + 1
        );
    }
    // A New card would produce the identical memory state and interval every time.
    assert_ne!(decisions[1].card.stability, decisions[0].card.stability);
    assert_ne!(decisions[9].card.stability, decisions[0].card.stability);
    assert_ne!(decisions[9].uncapped_due_at, decisions[0].uncapped_due_at);
    assert_eq!(decisions[9].card.lapses, 0);
}

#[tokio::test]
async fn scheduling_outcome_replay_returns_the_stored_decision_without_advancing_memory() {
    let store = Arc::new(FakeLearningStore::ready());
    graded_session(NOW, "response-1", &store).await;
    let first = store.decisions_for(CONCEPT_ETC);
    assert_eq!(first.len(), 1);

    // The replay reads a later wall clock, so a guard keyed on the computed date
    // would let it write a second review.
    graded_session(LATER, "response-1", &store).await;

    let after = store.decisions_for(CONCEPT_ETC);
    assert_eq!(after.len(), 1, "a replay writes no second decision");
    assert_eq!(after[0], first[0]);
    assert_eq!(after[0].card.reps, 1, "FSRS memory did not advance");
    assert_eq!(
        agent_domain::format_rfc3339_millis(after[0].generated_at),
        NOW
    );
    assert_eq!(store.recorded_outcomes().len(), 1);
}

#[tokio::test]
async fn scheduling_outcome_changed_payload_under_one_response_identity_fails_closed() {
    let store = Arc::new(FakeLearningStore::ready());
    graded_session(NOW, "response-1", &store).await;
    let before = store.schedule_decisions();

    // The same authorized response, a different graded payload.
    let contradicted = evaluated(vec![
        assessment(
            "crit-etc-donor",
            CriterionAssessmentKind::Contradicted,
            0.95,
        ),
        assessment(
            "crit-etc-complex-order",
            CriterionAssessmentKind::Satisfied,
            0.95,
        ),
        assessment(
            "crit-etc-gradient",
            CriterionAssessmentKind::Satisfied,
            0.95,
        ),
        assessment(
            "crit-etc-coupling",
            CriterionAssessmentKind::Satisfied,
            0.95,
        ),
    ]);
    let error = evaluate(
        &store,
        ScriptedEvaluator::once(contradicted),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect_err("a changed payload under one response identity must fail closed");
    match error {
        ToolExecutionError::Store(port) => assert_eq!(port.kind(), PortErrorKind::Conflict),
        other => panic!("expected a conflict, found {other:?}"),
    }
    assert_eq!(
        store
            .schedule_decisions()
            .iter()
            .map(|row| row.decision.clone())
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|row| row.decision.clone())
            .collect::<Vec<_>>()
    );

    // The scheduling port itself carries the same guard: the replay key is the
    // graded payload, not the schedule it produced.
    let stored = store
        .latest_decision_for(CONCEPT_ETC)
        .expect("a decision is persisted");
    let mut mutated = stored.clone();
    mutated.status = ConceptStatus::Missed;
    mutated.rating = 1;
    let conflict = agent_domain::StudyMemoryStore::persist_review_schedule_decision(
        store.as_ref(),
        USER_ID,
        STUDY_SET_ID,
        VOICE_SESSION_ID,
        "response-1",
        CONCEPT_ETC,
        mutated,
    )
    .await
    .expect_err("a changed decision payload must not silently replace the stored one");
    assert_eq!(conflict.kind(), PortErrorKind::Conflict);
    assert_eq!(store.decisions_for(CONCEPT_ETC).len(), 1);
}

#[tokio::test]
async fn scheduling_outcome_applies_the_persisted_exam_rule_at_every_boundary() {
    // A far exam cannot cap an eight-day strong interval.
    let far = Arc::new(FakeLearningStore::ready().with_exam(EXAM_FAR_AT, "Final exam"));
    graded_session(NOW, "response-1", &far).await;
    let decision = far
        .latest_decision_for(CONCEPT_ETC)
        .expect("a decision is persisted");
    assert_eq!(decision.cap_reason, None);
    assert_eq!(decision.due_at, decision.uncapped_due_at);
    assert_eq!(
        decision.exam_at.map(agent_domain::format_rfc3339_millis),
        Some(EXAM_FAR_AT.to_owned())
    );
    assert_eq!(
        decision.exam_margin_seconds,
        VIVA_REVIEW_EXAM_MARGIN_SECONDS
    );

    // An exam inside the interval pulls the review back to exactly one margin.
    let close = Arc::new(FakeLearningStore::ready().with_exam(EXAM_INSIDE_MARGIN_AT, "Final exam"));
    graded_session(NOW, "response-1", &close).await;
    let decision = close
        .latest_decision_for(CONCEPT_ETC)
        .expect("a decision is persisted");
    assert_eq!(
        decision.cap_reason,
        Some(ReviewScheduleCapReasonV1::ExamMargin)
    );
    assert_eq!(
        agent_domain::format_rfc3339_millis(decision.due_at),
        EXAM_INSIDE_MARGIN_DUE_AT
    );
    assert!(decision.uncapped_due_at > decision.due_at);

    // A past exam fails closed at the exam instant and never invents a future review.
    let past = Arc::new(FakeLearningStore::ready().with_exam(EXAM_ALREADY_PAST_AT, "Final exam"));
    graded_session(NOW, "response-1", &past).await;
    let decision = past
        .latest_decision_for(CONCEPT_ETC)
        .expect("a decision is persisted");
    assert_eq!(
        decision.cap_reason,
        Some(ReviewScheduleCapReasonV1::PastExam)
    );
    assert_eq!(
        agent_domain::format_rfc3339_millis(decision.due_at),
        EXAM_ALREADY_PAST_AT
    );
}

#[tokio::test]
async fn scheduling_outcome_exam_label_never_enters_the_calculation() {
    let labelled = Arc::new(
        FakeLearningStore::ready().with_exam(EXAM_INSIDE_MARGIN_AT, "Exam Friday, 8am, room 12"),
    );
    graded_session(NOW, "response-1", &labelled).await;
    let renamed =
        Arc::new(FakeLearningStore::ready().with_exam(EXAM_INSIDE_MARGIN_AT, "midterm 2 (moved)"));
    graded_session(NOW, "response-1", &renamed).await;
    assert_eq!(
        labelled.latest_decision_for(CONCEPT_ETC),
        renamed.latest_decision_for(CONCEPT_ETC)
    );

    // A label with no recorded instant schedules exactly as an unexamined set does.
    let label_only = Arc::new(FakeLearningStore::ready().with_exam_label_only("Exam Friday"));
    graded_session(NOW, "response-1", &label_only).await;
    let none = Arc::new(FakeLearningStore::ready());
    graded_session(NOW, "response-1", &none).await;
    assert_eq!(
        label_only.latest_decision_for(CONCEPT_ETC),
        none.latest_decision_for(CONCEPT_ETC)
    );
    assert_eq!(
        label_only
            .latest_decision_for(CONCEPT_ETC)
            .expect("a decision is persisted")
            .exam_at,
        None
    );
}

#[tokio::test]
async fn scheduling_outcome_recap_concept_and_projection_report_one_persisted_decision() {
    let store = Arc::new(FakeLearningStore::ready());
    graded_session(NOW, "response-1", &store).await;
    let persisted = store.learner_visible_reviews();
    assert_eq!(persisted.len(), 2);

    let recap_result = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-2",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect("build_session_recap succeeds");
    let recap: StudySessionRecapV2 =
        serde_json::from_value(recap_result.result["recap"].clone()).expect("recap parses");
    assert_eq!(
        recap
            .review_schedule
            .iter()
            .map(|item| (item.concept_id.clone(), item.due_at.clone()))
            .collect::<Vec<_>>(),
        persisted
    );
    for item in &recap.review_schedule {
        assert_eq!(item.authority, ReviewScheduleAuthority::ServerPersistedFsrs);
    }

    let projection = agent_domain::StudyMemoryStore::authenticated_study_projection(
        store.as_ref(),
        USER_ID,
        STUDY_SET_ID,
        VOICE_SESSION_ID,
    )
    .await
    .expect("the authenticated projection is readable");
    assert_eq!(
        projection
            .review_schedule
            .iter()
            .map(|item| (item.concept_id.clone(), item.due_at.clone()))
            .collect::<Vec<_>>(),
        persisted
    );
    for concept in &projection.concepts {
        let expected = persisted
            .iter()
            .find(|(concept_id, _)| concept_id == &concept.id)
            .map(|(_, due_at)| due_at.clone());
        assert_eq!(concept.due_at, expected, "concept {}", concept.id);
    }

    // The wire token is the selected D-01A authority on both surfaces.
    let encoded = serde_json::to_value(&projection).expect("projection serializes");
    assert_eq!(
        encoded["reviewSchedule"][0]["authority"],
        json!("server_persisted_fsrs")
    );
    let recap_encoded = serde_json::to_value(&recap).expect("recap serializes");
    assert_eq!(
        recap_encoded["review_schedule"][0]["authority"],
        json!("server_persisted_fsrs")
    );

    // The browser-safe summary is all a tool result may carry.
    let summary = store
        .latest_decision_for(CONCEPT_ETC)
        .expect("a decision is persisted")
        .public_summary(CONCEPT_ETC);
    let mut keys = summary
        .as_object()
        .expect("summary is an object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "cap_reason".to_owned(),
            "concept_id".to_owned(),
            "due_at".to_owned(),
            "policy_id".to_owned(),
            "schema_version".to_owned(),
            "status".to_owned(),
        ]
    );
}

#[tokio::test]
async fn scheduling_outcome_past_exam_decision_is_persisted_but_hidden_from_learner_reviews() {
    let store = Arc::new(FakeLearningStore::ready().with_exam(EXAM_ALREADY_PAST_AT, "Exam Friday"));
    graded_session(NOW, "response-1", &store).await;
    assert_eq!(store.schedule_decisions().len(), 2);

    let projection = agent_domain::StudyMemoryStore::authenticated_study_projection(
        store.as_ref(),
        USER_ID,
        STUDY_SET_ID,
        VOICE_SESSION_ID,
    )
    .await
    .expect("the authenticated projection is readable");
    assert!(projection.review_schedule.is_empty());
    for concept in &projection.concepts {
        assert_eq!(concept.due_at, None, "concept {}", concept.id);
    }

    let recap_result = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-2",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect("build_session_recap succeeds");
    let recap: StudySessionRecapV2 =
        serde_json::from_value(recap_result.result["recap"].clone()).expect("recap parses");
    assert!(recap.review_schedule.is_empty());
    assert_eq!(recap.next_action, "Keep answering to build more evidence.");
}

#[tokio::test]
async fn scheduling_outcome_rejects_model_supplied_scheduling_authority() {
    for (name, value) in [
        ("due_at", json!("2099-01-01T00:00:00.000Z")),
        ("uncapped_due_at", json!("2099-01-01T00:00:00.000Z")),
        ("card", json!({ "stability": 400.0 })),
        ("card_state", json!("review")),
        ("stability", json!(400.0)),
        ("difficulty", json!(1.0)),
        ("exam_at", json!("2099-01-01T00:00:00.000Z")),
        ("exam_label", json!("Exam Friday")),
        ("policy_id", json!("viva.attacker.1")),
        ("cap_reason", json!("exam_margin")),
        ("revision", json!(9)),
    ] {
        let store = Arc::new(FakeLearningStore::ready());
        let error = match evaluate(
            &store,
            ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
            "response-1",
            answer_proposal_with(vec![(name, value)]),
        )
        .await
        {
            Ok(result) => panic!("`{name}` must be rejected, the tool returned {result}"),
            Err(error) => error,
        };
        assert!(
            matches!(error, ToolExecutionError::InvalidArguments(_)),
            "`{name}` produced {error:?}"
        );
        assert!(store.schedule_decisions().is_empty(), "`{name}`");
        assert!(store.recorded_outcomes().is_empty(), "`{name}`");
    }
}

#[tokio::test]
async fn scheduling_outcome_persistence_failure_fails_the_turn_and_retry_repairs_it() {
    let store = Arc::new(FakeLearningStore::ready());
    store.set_schedule_persistence_failure(true);

    let error = evaluate(
        &store,
        ScriptedEvaluator::once(evaluated(all_satisfied(0.9, 0.9, 0.9, 0.9))),
        "response-1",
        answer_proposal("A bound spoken answer."),
    )
    .await
    .expect_err("a scheduling write failure must fail the turn");
    match error {
        // Durability is the retryable class: nothing about the request was wrong.
        ToolExecutionError::Store(port) => assert_eq!(port.kind(), PortErrorKind::Durability),
        other => panic!("expected a retryable store failure, found {other:?}"),
    }
    assert!(store.schedule_decisions().is_empty());

    // No recap may report a session whose scheduling never committed.
    let recap_result = executor(Arc::clone(&store), Arc::new(UnreachableEvaluator))
        .execute(
            "response-2",
            ToolProposal::build_session_recap(STUDY_SET_ID, VOICE_SESSION_ID),
        )
        .await
        .expect("the recap fold still runs over persisted evidence");
    let recap: StudySessionRecapV2 =
        serde_json::from_value(recap_result.result["recap"].clone()).expect("recap parses");
    assert!(recap.review_schedule.is_empty());

    // Retry repairs through Plan 03 idempotency: the outcome replays and the
    // schedule lands exactly once, without grading the turn a second time.
    store.set_schedule_persistence_failure(false);
    graded_session(LATER, "response-1", &store).await;
    assert_eq!(store.recorded_outcomes().len(), 1);
    assert_eq!(store.decisions_for(CONCEPT_ETC).len(), 1);
    assert_eq!(store.decisions_for(CONCEPT_GRADIENT).len(), 1);
    assert_eq!(
        store
            .latest_decision_for(CONCEPT_ETC)
            .expect("a decision is persisted")
            .card
            .reps,
        1
    );
}

// ===========================================================================
// LEARN-004B — deterministic ordered question progression (D-02B)
//
// The store below is a Plan-04-owned in-test `OrderedV1` cursor with real
// hand-derived behaviour, and every expectation is read from the shared fixture
// `agent/fixtures/learning-core/question-progression-v1.json` rather than from
// this file. `active_question` fails closed here, so a selection that took the
// store's global first-active-question shortcut could not pass any case below.
// ===========================================================================

const QUESTION_PROGRESSION_FIXTURE: &str =
    include_str!("../../../fixtures/learning-core/question-progression-v1.json");

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgressionFixture {
    #[allow(dead_code)]
    schema: String,
    policy: ProgressionPolicyId,
    voice_session_id: String,
    active_question_ids: Vec<String>,
    inactive_question_ids: Vec<String>,
    questions: BTreeMap<String, StudyQuestion>,
    cursors: BTreeMap<String, QuestionProgressionCursor>,
    results: BTreeMap<String, QuestionProgressionResult>,
}

fn progression_fixture() -> ProgressionFixture {
    serde_json::from_str(QUESTION_PROGRESSION_FIXTURE)
        .expect("the shared question-progression fixture parses into the Plan 04 types")
}

/// The Plan-04-owned `OrderedV1` cursor.
///
/// `OrderedV1` selects the first active, source-valid question by persisted
/// ingestion ordinal that is not already completed. Inactive questions are skipped
/// and never counted in `total`. A selection is authorized once per `response_id`,
/// so a replay — or two callers racing on one response — returns the stored result
/// and leaves the revision alone.
struct FakeProgressionStore {
    voice_session_id: String,
    questions: BTreeMap<String, StudyQuestion>,
    /// Active question IDs in persisted ingestion order.
    active_order: Vec<String>,
    cursor: Mutex<QuestionProgressionCursor>,
    selections: Mutex<BTreeMap<String, QuestionProgressionResult>>,
    outcomes: Mutex<Vec<TurnOutcome>>,
    requested_policies: Mutex<Vec<ProgressionPolicyId>>,
}

impl FakeProgressionStore {
    fn from_fixture(fixture: &ProgressionFixture) -> Self {
        Self {
            voice_session_id: fixture.voice_session_id.clone(),
            questions: fixture.questions.clone(),
            active_order: fixture.active_question_ids.clone(),
            cursor: Mutex::new(
                fixture
                    .cursors
                    .get("initial")
                    .expect("the fixture pins an initial cursor")
                    .clone(),
            ),
            selections: Mutex::new(BTreeMap::new()),
            outcomes: Mutex::new(Vec::new()),
            requested_policies: Mutex::new(Vec::new()),
        }
    }

    fn cursor(&self) -> QuestionProgressionCursor {
        self.cursor.lock().expect("cursor lock").clone()
    }

    fn requested_policies(&self) -> Vec<ProgressionPolicyId> {
        self.requested_policies
            .lock()
            .expect("policies lock")
            .clone()
    }

    fn total(&self) -> u32 {
        u32::try_from(self.active_order.len()).expect("small question count")
    }
}

#[async_trait::async_trait]
impl agent_domain::StudyMemoryStore for FakeProgressionStore {
    /// The global shortcut `LEARN-004B` replaces. A selection that still called it
    /// would fail rather than quietly return the first active question.
    async fn active_question(
        &self,
        _user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        Err(PortError::unavailable(
            "fake_progression_store",
            study_set_id,
            "session progression replaced the global active-question shortcut",
        ))
    }

    async fn study_context(
        &self,
        _user_id: &str,
        _study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        Ok(None)
    }

    async fn source_reference(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        Ok(None)
    }

    async fn record_answer_evaluation(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "fake_progression_store",
            response_id,
            "record_answer_evaluation is retired by the turn-outcome authority",
        ))
    }

    async fn record_concept_status(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _response_id: &str,
        concept_id: &str,
        _status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        Err(PortError::unavailable(
            "fake_progression_store",
            concept_id,
            "independent concept status writes are retired",
        ))
    }

    async fn schedule_review_item(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        concept_id: &str,
        _due_at: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "fake_progression_store",
            concept_id,
            "legacy due-date writes are not implemented by this store",
        ))
    }

    async fn record_recap(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
        _response_id: &str,
        _recap: agent_domain::StudySessionRecap,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "fake_progression_store",
            voice_session_id,
            "recap persistence is not part of the progression contract",
        ))
    }

    /// The outcome transaction is where a disposition reaches the cursor: an
    /// `Advance` completes the current question, while `RetryCurrent` and
    /// `Deferred` keep it and complete nothing.
    async fn record_turn_outcome(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        let mut outcomes = self.outcomes.lock().expect("outcomes lock");
        if let Some(stored) = outcomes
            .iter()
            .find(|stored| stored.response_id == outcome.response_id)
        {
            if *stored != outcome {
                return Err(PortError::conflict(
                    "fake_progression_store",
                    &outcome.response_id,
                    "a different payload was already recorded for this response",
                ));
            }
            return Ok(PersistedTurnOutcome {
                turn_outcome: stored.clone(),
                record: TurnOutcomeRecordReceipt {
                    schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                    response_id: outcome.response_id.clone(),
                    replayed: true,
                },
            });
        }

        let disposition = match &outcome.resolution {
            TurnResolution::Evaluated { disposition, .. }
            | TurnResolution::Deferred { disposition, .. } => *disposition,
        };
        let mut cursor = self.cursor.lock().expect("cursor lock");
        if disposition == QuestionDisposition::Advance {
            if let Some(current) = cursor.current_question_id.take() {
                if !cursor.completed_question_ids.contains(&current) {
                    cursor.completed_question_ids.push(current);
                }
            }
        }
        drop(cursor);

        outcomes.push(outcome.clone());
        Ok(PersistedTurnOutcome {
            record: TurnOutcomeRecordReceipt {
                schema: VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                response_id: outcome.response_id.clone(),
                replayed: false,
            },
            turn_outcome: outcome,
        })
    }

    async fn select_next_question(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        self.requested_policies
            .lock()
            .expect("policies lock")
            .push(policy);
        if voice_session_id != self.voice_session_id {
            return Err(PortError::invalid_input(
                "fake_progression_store",
                voice_session_id,
                "the cursor belongs to a different voice session",
            ));
        }
        // D-02B selected the ordered policy; the adaptive one has no
        // implementation here and fails closed rather than answering.
        if policy != ProgressionPolicyId::OrderedV1 {
            return Err(PortError::unavailable(
                "fake_progression_store",
                voice_session_id,
                "only the selected ordered_v1 progression policy is implemented",
            ));
        }

        // One authorized selection per response: a replay, and two callers racing
        // on the same response, both settle on the stored result.
        let mut selections = self.selections.lock().expect("selections lock");
        if let Some(stored) = selections.get(response_id) {
            return Ok(stored.clone());
        }

        let mut cursor = self.cursor.lock().expect("cursor lock");
        let total = self.total();
        let current = cursor
            .current_question_id
            .clone()
            .filter(|id| !cursor.completed_question_ids.contains(id));
        let selected = match current {
            Some(id) => Some(id),
            None => self
                .active_order
                .iter()
                .find(|id| !cursor.completed_question_ids.contains(id))
                .cloned(),
        };

        let result = match selected {
            None => {
                cursor.current_question_id = None;
                cursor.revision += 1;
                QuestionProgressionResult::Exhausted {
                    completed: u32::try_from(cursor.completed_question_ids.len())
                        .expect("small question count"),
                    total,
                    revision: cursor.revision,
                }
            }
            Some(question_id) => {
                let ordinal = self
                    .active_order
                    .iter()
                    .position(|id| id == &question_id)
                    .map(|index| u32::try_from(index + 1).expect("small question count"))
                    .ok_or_else(|| {
                        PortError::invalid_input(
                            "fake_progression_store",
                            &question_id,
                            "the cursor names a question that is not active",
                        )
                    })?;
                let question = self.questions.get(&question_id).cloned().ok_or_else(|| {
                    PortError::invalid_input(
                        "fake_progression_store",
                        &question_id,
                        "the cursor names a question this store does not hold",
                    )
                })?;
                let repeat = cursor.current_question_id.as_deref() == Some(question_id.as_str());
                let attempt = cursor
                    .attempt_counts
                    .entry(question_id.clone())
                    .or_insert(0);
                *attempt += 1;
                let attempt = *attempt;
                cursor.current_question_id = Some(question_id);
                cursor.revision += 1;
                if repeat {
                    QuestionProgressionResult::Retry {
                        question,
                        ordinal,
                        total,
                        attempt,
                        revision: cursor.revision,
                    }
                } else {
                    QuestionProgressionResult::Selected {
                        question,
                        ordinal,
                        total,
                        selection_reason: "ordered_v1:first_active_uncompleted".to_owned(),
                        revision: cursor.revision,
                    }
                }
            }
        };
        selections.insert(response_id.to_owned(), result.clone());
        Ok(result)
    }
}

fn progression_session(fixture: &ProgressionFixture) -> AuthorizedStudySession {
    AuthorizedStudySession {
        user_id: USER_ID.to_owned(),
        study_set_id: STUDY_SET_ID.to_owned(),
        voice_session_id: fixture.voice_session_id.clone(),
        mode: StudyMode::Quiz,
        active_concepts: Vec::new(),
    }
}

fn progression_executor(
    store: Arc<FakeProgressionStore>,
    fixture: &ProgressionFixture,
) -> VivaToolExecutor {
    VivaToolExecutor::with_clock(
        store,
        progression_session(fixture),
        Arc::new(UnreachableEvaluator),
        Arc::new(FixedClock::new(
            agent_domain::parse_utc_instant(NOW).expect("clock instant parses"),
        )),
    )
}

/// Run the `select_next_question` tool and return its whole result payload.
async fn select_next(
    store: &Arc<FakeProgressionStore>,
    fixture: &ProgressionFixture,
    response_id: &str,
) -> Value {
    progression_executor(Arc::clone(store), fixture)
        .execute(
            response_id,
            ToolProposal::select_next_question(STUDY_SET_ID, &fixture.voice_session_id, "quiz"),
        )
        .await
        .expect("select_next_question succeeds")
        .result
}

fn progression_from(result: &Value) -> QuestionProgressionResult {
    serde_json::from_value(result["progression"].clone())
        .expect("the tool result carries a QuestionProgressionResult")
}

/// A persisted outcome whose only job here is to carry a disposition to the cursor.
fn outcome_with(
    response_id: &str,
    question_id: &str,
    disposition: QuestionDisposition,
) -> TurnOutcome {
    let resolution = if disposition == QuestionDisposition::Deferred {
        TurnResolution::Deferred {
            reason: EvaluationDeferralReason::EvaluatorUnavailable,
            can_retry_same_question: false,
            disposition,
        }
    } else {
        TurnResolution::Evaluated {
            label: EvaluationLabel::Strong,
            confidence: 0.9,
            assessments: Vec::new(),
            concept_transitions: Vec::new(),
            concise_feedback: "Server-authorized feedback.".to_owned(),
            retry_prompt: None,
            disposition,
        }
    };
    TurnOutcome {
        schema: VIVA_TURN_OUTCOME_SCHEMA.to_owned(),
        response_id: response_id.to_owned(),
        question_id: question_id.to_owned(),
        rubric_policy_version: VIVA_SEMANTIC_RUBRIC_POLICY_VERSION.to_owned(),
        recorded_at: NOW.to_owned(),
        source_ids: Vec::new(),
        supersedes_response_id: None,
        resolution,
    }
}

async fn record_disposition(
    store: &Arc<FakeProgressionStore>,
    response_id: &str,
    question_id: &str,
    disposition: QuestionDisposition,
) {
    agent_domain::StudyMemoryStore::record_turn_outcome(
        store.as_ref(),
        USER_ID,
        STUDY_SET_ID,
        &store.voice_session_id,
        outcome_with(response_id, question_id, disposition),
    )
    .await
    .expect("the outcome and its disposition are persisted together");
}

/// Advance the canonical fixture sequence up to (but not including) the second
/// question's selection: q1 selected, retried, deferred, then advanced.
async fn walk_to_second_question(store: &Arc<FakeProgressionStore>, fixture: &ProgressionFixture) {
    select_next(store, fixture, "sel-1").await;
    record_disposition(
        store,
        "out-1",
        "q-etc-electron-flow",
        QuestionDisposition::RetryCurrent,
    )
    .await;
    select_next(store, fixture, "sel-2").await;
    record_disposition(
        store,
        "out-2",
        "q-etc-electron-flow",
        QuestionDisposition::Deferred,
    )
    .await;
    select_next(store, fixture, "sel-3").await;
    record_disposition(
        store,
        "out-3",
        "q-etc-electron-flow",
        QuestionDisposition::Advance,
    )
    .await;
}

#[tokio::test]
async fn ordered_progression_walks_the_shared_fixture_sequence() {
    let fixture = progression_fixture();
    assert_eq!(fixture.policy, ProgressionPolicyId::OrderedV1);
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));

    let expect = |name: &str| fixture.results[name].clone();
    let expect_cursor = |name: &str| fixture.cursors[name].clone();

    let first = select_next(&store, &fixture, "sel-1").await;
    assert_eq!(progression_from(&first), expect("selected_first"));
    assert_eq!(store.cursor(), expect_cursor("after_first_selection"));

    record_disposition(
        &store,
        "out-1",
        "q-etc-electron-flow",
        QuestionDisposition::RetryCurrent,
    )
    .await;
    let retried = select_next(&store, &fixture, "sel-2").await;
    assert_eq!(
        progression_from(&retried),
        expect("retry_current_increments_attempt")
    );
    assert_eq!(store.cursor(), expect_cursor("after_retry_current"));

    record_disposition(
        &store,
        "out-2",
        "q-etc-electron-flow",
        QuestionDisposition::Deferred,
    )
    .await;
    let deferred = select_next(&store, &fixture, "sel-3").await;
    assert_eq!(
        progression_from(&deferred),
        expect("deferred_keeps_current_question")
    );
    assert_eq!(store.cursor(), expect_cursor("after_deferred_retry"));
    assert!(
        !store
            .cursor()
            .completed_question_ids
            .contains(&"q-etc-electron-flow".to_owned()),
        "a deferral completes nothing"
    );

    record_disposition(
        &store,
        "out-3",
        "q-etc-electron-flow",
        QuestionDisposition::Advance,
    )
    .await;
    let second = select_next(&store, &fixture, "sel-4").await;
    assert_eq!(
        progression_from(&second),
        expect("selected_second_after_advance")
    );
    assert_eq!(store.cursor(), expect_cursor("after_advance_to_second"));

    record_disposition(
        &store,
        "out-4",
        "q-gradient-direction",
        QuestionDisposition::Advance,
    )
    .await;
    let third = select_next(&store, &fixture, "sel-5").await;
    assert_eq!(
        progression_from(&third),
        expect("selected_third_after_advance")
    );
    assert_eq!(store.cursor(), expect_cursor("after_advance_to_third"));

    record_disposition(
        &store,
        "out-5",
        "q-atp-synthase-coupling",
        QuestionDisposition::Advance,
    )
    .await;
    let exhausted = select_next(&store, &fixture, "sel-6").await;
    assert_eq!(
        progression_from(&exhausted),
        expect("exhausted_emits_no_question")
    );
    assert_eq!(store.cursor(), expect_cursor("after_exhaustion"));
}

#[tokio::test]
async fn ordered_progression_exhaustion_emits_no_fabricated_question() {
    let fixture = progression_fixture();
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));
    walk_to_second_question(&store, &fixture).await;
    select_next(&store, &fixture, "sel-4").await;
    record_disposition(
        &store,
        "out-4",
        "q-gradient-direction",
        QuestionDisposition::Advance,
    )
    .await;
    select_next(&store, &fixture, "sel-5").await;
    record_disposition(
        &store,
        "out-5",
        "q-atp-synthase-coupling",
        QuestionDisposition::Advance,
    )
    .await;

    let result = select_next(&store, &fixture, "sel-6").await;
    let mut keys = result["progression"]
        .as_object()
        .expect("the progression is an object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "completed".to_owned(),
            "result".to_owned(),
            "revision".to_owned(),
            "total".to_owned()
        ],
        "an exhausted session carries no question at all"
    );
    let encoded = serde_json::to_string(&result).expect("the tool result serializes");
    for question_id in fixture.questions.keys() {
        assert!(!encoded.contains(question_id.as_str()), "{encoded}");
    }
}

#[tokio::test]
async fn ordered_progression_replay_does_not_advance_twice() {
    let fixture = progression_fixture();
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));
    walk_to_second_question(&store, &fixture).await;

    let first = select_next(&store, &fixture, "sel-4").await;
    let cursor_after_first = store.cursor();
    let replayed = select_next(&store, &fixture, "sel-4").await;

    assert_eq!(
        progression_from(&replayed),
        fixture.results["replay_returns_same_selection"]
    );
    assert_eq!(progression_from(&replayed), progression_from(&first));
    assert_eq!(store.cursor(), cursor_after_first);
    assert_eq!(store.cursor(), fixture.cursors["after_advance_to_second"]);
}

#[tokio::test]
async fn ordered_progression_reconnect_resumes_the_persisted_cursor() {
    let fixture = progression_fixture();
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));
    walk_to_second_question(&store, &fixture).await;
    let before = select_next(&store, &fixture, "sel-4").await;

    // A reconnect is a brand-new executor over the same persisted cursor.
    let resumed = progression_executor(Arc::clone(&store), &fixture)
        .execute(
            "sel-4",
            ToolProposal::select_next_question(STUDY_SET_ID, &fixture.voice_session_id, "quiz"),
        )
        .await
        .expect("the reconnected session resumes")
        .result;

    assert_eq!(progression_from(&resumed), progression_from(&before));
    assert_eq!(store.cursor(), fixture.cursors["reconnect_resumes_cursor"]);
}

#[tokio::test]
async fn ordered_progression_concurrent_selection_settles_on_one_revision() {
    let fixture = progression_fixture();
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));
    walk_to_second_question(&store, &fixture).await;

    let (left, right) = tokio::join!(
        select_next(&store, &fixture, "sel-4"),
        select_next(&store, &fixture, "sel-4"),
    );

    assert_eq!(progression_from(&left), progression_from(&right));
    assert_eq!(
        progression_from(&left),
        fixture.results["concurrent_selection_single_revision"]
    );
    assert_eq!(
        store.cursor(),
        fixture.cursors["concurrent_selection_single_revision"]
    );
}

#[tokio::test]
async fn ordered_progression_skips_inactive_questions_and_never_counts_them() {
    let fixture = progression_fixture();
    let archived = fixture
        .inactive_question_ids
        .first()
        .expect("the fixture pins an inactive question")
        .clone();
    assert!(fixture.questions.contains_key(&archived));
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));

    let mut seen: Vec<String> = Vec::new();
    for (index, response_id) in ["sel-1", "sel-4", "sel-5", "sel-6"].iter().enumerate() {
        if index > 0 {
            let previous = seen[index - 1].clone();
            record_disposition(
                &store,
                &format!("out-{index}"),
                &previous,
                QuestionDisposition::Advance,
            )
            .await;
        }
        let result = select_next(&store, &fixture, response_id).await;
        match progression_from(&result) {
            QuestionProgressionResult::Selected {
                question, total, ..
            }
            | QuestionProgressionResult::Retry {
                question, total, ..
            } => {
                assert_eq!(total, 3, "an inactive question is never counted");
                assert_ne!(question.question_id, archived);
                seen.push(question.question_id);
            }
            QuestionProgressionResult::Exhausted { total, .. } => {
                assert_eq!(total, 3);
                seen.push(String::new());
            }
        }
    }
    assert_eq!(seen[..3], fixture.active_question_ids[..3]);
}

#[tokio::test]
async fn ordered_progression_tool_returns_the_progression_and_the_bound_mode() {
    let fixture = progression_fixture();
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));

    let result = select_next(&store, &fixture, "sel-1").await;
    let mut keys = result
        .as_object()
        .expect("the tool result is an object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["mode".to_owned(), "progression".to_owned()]);
    assert_eq!(result["mode"], json!("quiz"));
    assert_eq!(
        result["progression"],
        serde_json::to_value(&fixture.results["selected_first"])
            .expect("fixture result serializes")
    );

    // The tool asked for exactly the selected D-02B policy, and never reached the
    // fail-closed global active-question shortcut.
    assert_eq!(
        store.requested_policies(),
        vec![ProgressionPolicyId::OrderedV1]
    );
    let shortcut =
        agent_domain::StudyMemoryStore::active_question(store.as_ref(), USER_ID, STUDY_SET_ID)
            .await
            .expect_err("the global shortcut is unavailable in a session-scoped progression");
    assert_eq!(shortcut.kind(), PortErrorKind::Unavailable);
}

#[tokio::test]
async fn ordered_progression_binds_the_authorized_session() {
    let fixture = progression_fixture();
    let store = Arc::new(FakeProgressionStore::from_fixture(&fixture));

    let error = progression_executor(Arc::clone(&store), &fixture)
        .execute(
            "sel-1",
            ToolProposal::select_next_question(STUDY_SET_ID, "vs-someone-else", "quiz"),
        )
        .await
        .expect_err("a selection for another session must be refused");
    assert!(
        matches!(error, ToolExecutionError::InvalidArguments(_)),
        "{error:?}"
    );
    assert_eq!(store.cursor(), fixture.cursors["initial"]);
}
