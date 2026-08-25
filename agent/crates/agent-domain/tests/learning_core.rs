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
    study_projection::{
        StudyProjectionConceptV1, StudyProjectionQuestionProgressV1, StudyProjectionSessionV1,
        StudyProjectionStudySetV1, StudyProjectionVersionV1,
    },
    AnswerEvaluation, AnswerEvaluator, AuthenticatedStudyProjectionV1, AuthorizedStudySession,
    ChallengeDisposition, ChallengeResolution, ConceptLabel, ConceptStatus, CriterionAssessment,
    CriterionAssessmentKind, EvaluationDecision, EvaluationDeferralReason, EvaluationError,
    EvaluationLabel, EvaluationRequest, EvaluationRubricV1, FixedClock, PersistedTurnOutcome,
    PortError, PortErrorKind, QuestionDisposition, ReviewScheduleSummary, RubricCriterionV1,
    SessionLearningEvidence, SourceConfidence, StudyMode, StudyQuestion, StudySetIngestionStatus,
    StudySourceReference, ToolExecutionError, ToolProposal, TurnOutcome, TurnOutcomeRecordReceipt,
    TurnResolution, VivaToolExecutor,
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

#[derive(Default)]
struct FakeLearningStore {
    question: Option<StudyQuestion>,
    sources: BTreeMap<String, StudySourceReference>,
    concept_labels: Vec<ConceptLabel>,
    review_decisions: Vec<ReviewScheduleSummary>,
    statuses: Mutex<BTreeMap<String, ConceptStatus>>,
    outcomes: Mutex<Vec<TurnOutcome>>,
    challenges: Mutex<Vec<ChallengeResolution>>,
    persisted_recaps: Mutex<Vec<Value>>,
    evidence_unavailable: bool,
    recap_persistence_fails: bool,
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
            review_decisions: self.review_decisions.clone(),
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
        let concepts = self
            .concept_labels
            .iter()
            .map(|label| StudyProjectionConceptV1 {
                id: label.concept_id.clone(),
                label: label.label.clone(),
                status: self.status(&label.concept_id),
                last_reviewed_at: None,
                due_at: None,
            })
            .collect::<Vec<_>>();
        Ok(AuthenticatedStudyProjectionV1 {
            version: StudyProjectionVersionV1,
            study_set: StudyProjectionStudySetV1 {
                id: study_set_id.to_owned(),
                title: "Cellular respiration".to_owned(),
                course: None,
                exam_label: None,
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
            review_schedule: Vec::new(),
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
    VivaToolExecutor::with_clock(
        store,
        session(),
        evaluator,
        Arc::new(FixedClock::new(
            agent_domain::parse_utc_instant(NOW).expect("clock instant parses"),
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
