//! The synthetic (offline, keyless) study runtime and the fixture evaluator both
//! it and the fake Cartesia/Gemini runtime inject.
//!
//! `ADAPTER-01`: nothing in this file decides a learner fact. The verdict pattern
//! and the examiner's copy come from the immutable Plan 04 learning-core corpus,
//! the label/status/schedule/recap come from the persisted `TurnOutcome` the Plan
//! 04 executor returned, and a runtime with no store emits no learner fact at all
//! rather than inventing one.

use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

use serde_json::Value;
use tokio::{sync::mpsc, task::AbortHandle, time::sleep};

use agent_domain::{
    fixture_question, learning_outcome::VIVA_SEMANTIC_RUBRIC_POLICY_VERSION, AnswerAttemptEnvelope,
    AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy, AnswerEvaluator,
    AuthorizedStudySession, BrainError, BrainEvent, BrainFailureClass, BrainFailureStage,
    BrainInput, BrainProviderError, BrainProviderFailureParts, BrainUsage, Clock,
    CriterionAssessment, EvaluationDecision, EvaluationDeferralReason, EvaluationError,
    EvaluationRequest, ManuscriptEmphasis, ManuscriptEntityKind, ManuscriptIntent,
    ManuscriptRegister, RealtimeBrain, RealtimeBrainCapabilities, RealtimeSession,
    RealtimeSessionTaskGuard, SessionConfig, StudyMemoryStore, StudyQuestion, StudySessionPhase,
    SystemClock, ToolProposal, TurnOutcome, TurnResolution, VivaToolExecutor,
};

use crate::cartesia_gemini::{
    answer_evaluation_from_outcome, brain_failure, learning_event_projection,
    parse_persisted_turn_outcome, recap_from_tool_result, select_session_question,
    SessionPhaseTracker,
};

/// The immutable Plan 04 turn-outcome corpus. It is read-only input: this crate
/// never writes it, and every synthetic verdict below is derived from it.
pub(crate) const LEARNING_CORE_TURN_OUTCOMES_V1: &str =
    include_str!("../../../fixtures/learning-core/turn-outcomes-v1.json");

/// The corpus's evaluated cases, in the order the synthetic rotation walks them.
/// Naming them explicitly keeps the rotation deterministic even if the fixture
/// gains cases later, and keeps a deferral in the rotation so the deferred branch
/// is exercised by the fixture runtimes rather than only by focused tests.
pub(crate) const SYNTHETIC_FIXTURE_CASE_IDS: [&str; 4] = [
    "evaluated_mostly_correct",
    "evaluated_strong",
    "evaluated_required_contradiction_is_wrong",
    "deferred_insufficient_semantic_evidence",
];

fn learning_core_document() -> Option<&'static Value> {
    static DOCUMENT: OnceLock<Option<Value>> = OnceLock::new();
    DOCUMENT
        .get_or_init(|| serde_json::from_str(LEARNING_CORE_TURN_OUTCOMES_V1).ok())
        .as_ref()
}

/// One complete persisted outcome from the immutable corpus.
pub(crate) fn learning_core_turn_outcome(case_id: &str) -> Option<TurnOutcome> {
    let case = learning_core_document()?.get("outcomes")?.get(case_id)?;
    serde_json::from_value(case.clone()).ok()
}

/// The corpus's server-owned rubric.
#[cfg(test)]
pub(crate) fn learning_core_rubric() -> Option<agent_domain::EvaluationRubricV1> {
    let rubric = learning_core_document()?.get("rubric")?;
    serde_json::from_value(rubric.clone()).ok()
}

/// The fixture-derived [`AnswerEvaluator`] the fake and synthetic runtimes
/// inject.
///
/// It is deliberately not a general evaluator and never sees a live session: it
/// reads one corpus case and replays that case's criterion verdicts, so a fixture
/// runtime's grade is a property of a checked-in file rather than of the answer
/// text. `A-13.3` places it here; the only way to obtain one is
/// [`synthetic_fixture_answer_evaluator`], so no live composition can reach it by
/// default or through the environment.
pub(crate) struct SyntheticFixtureAnswerEvaluator {
    case_ids: Vec<String>,
}

impl SyntheticFixtureAnswerEvaluator {
    /// Private on purpose: see the type documentation.
    fn new() -> Self {
        Self {
            case_ids: SYNTHETIC_FIXTURE_CASE_IDS
                .iter()
                .map(|case_id| (*case_id).to_owned())
                .collect(),
        }
    }

    /// Which corpus case grades this response. Deterministic in the response
    /// identity, so a replay of one response replays one case.
    fn case_for(&self, response_id: &str) -> Option<TurnOutcome> {
        if self.case_ids.is_empty() {
            return None;
        }
        let index = response_id
            .bytes()
            .fold(0_usize, |total, byte| total.wrapping_add(byte as usize))
            % self.case_ids.len();
        learning_core_turn_outcome(&self.case_ids[index])
    }
}

#[async_trait]
impl AnswerEvaluator for SyntheticFixtureAnswerEvaluator {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationDecision, EvaluationError> {
        let case = self
            .case_for(&request.response_id)
            .ok_or(EvaluationError::Unavailable)?;
        match case.resolution {
            // The corpus case's criterion verdicts are replayed positionally onto
            // the rubric this session actually authorizes: the pattern is fixture
            // data, and the criterion identities stay server-owned.
            TurnResolution::Evaluated {
                assessments,
                concise_feedback,
                retry_prompt,
                ..
            } => {
                if assessments.is_empty() {
                    return Err(EvaluationError::Unavailable);
                }
                Ok(EvaluationDecision::Evaluated {
                    assessments: request
                        .question
                        .rubric
                        .criteria
                        .iter()
                        .enumerate()
                        .map(|(index, criterion)| {
                            let pattern = &assessments[index % assessments.len()];
                            CriterionAssessment {
                                criterion_id: criterion.criterion_id.clone(),
                                assessment: pattern.assessment,
                                confidence: pattern.confidence,
                            }
                        })
                        .collect(),
                    concise_feedback,
                    retry_prompt,
                })
            }
            TurnResolution::Deferred { reason, .. } => Ok(EvaluationDecision::Deferred {
                // Only the two verdicts an evaluator may honestly report about its
                // own evidence; the rest are server facts it must never claim.
                reason: match reason {
                    EvaluationDeferralReason::InsufficientSemanticEvidence
                    | EvaluationDeferralReason::ContradictoryEvidence => reason,
                    _ => EvaluationDeferralReason::InsufficientSemanticEvidence,
                },
                can_retry_same_question: true,
            }),
        }
    }
}

/// The one named builder for the fixture evaluator.
pub(crate) fn synthetic_fixture_answer_evaluator() -> Arc<dyn AnswerEvaluator> {
    Arc::new(SyntheticFixtureAnswerEvaluator::new())
}

/// The fixture runtimes' spoken response text.
///
/// It is the persisted outcome's own feedback plus, when the server left the
/// question open, its retry prompt — never a shared runner fallback sentence and
/// never copy about a topic this session did not grade. A deferred outcome has
/// no response to speak, so it yields nothing at all.
pub(crate) fn fixture_response_text(outcome: &TurnOutcome) -> Option<String> {
    match &outcome.resolution {
        TurnResolution::Evaluated {
            concise_feedback,
            retry_prompt,
            ..
        } => Some(match retry_prompt {
            Some(prompt) => format!("{concise_feedback} {prompt}"),
            None => concise_feedback.clone(),
        }),
        TurnResolution::Deferred { .. } => None,
    }
}

#[derive(Clone)]
pub struct SyntheticBrain {
    study_store: Option<Arc<dyn StudyMemoryStore>>,
    clock: Arc<dyn Clock>,
}

impl Default for SyntheticBrain {
    fn default() -> Self {
        Self {
            study_store: None,
            clock: Arc::new(SystemClock),
        }
    }
}

impl SyntheticBrain {
    pub fn with_study_store(study_store: Arc<dyn StudyMemoryStore>) -> Self {
        Self {
            study_store: Some(study_store),
            clock: Arc::new(SystemClock),
        }
    }

    /// Test/composition path: pin the authoritative D-01 grading instant.
    pub fn with_study_store_and_clock(
        study_store: Arc<dyn StudyMemoryStore>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            study_store: Some(study_store),
            clock,
        }
    }
}

#[async_trait]
impl RealtimeBrain for SyntheticBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "synthetic".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(32);
        let (event_tx, events) = mpsc::channel::<BrainEvent>(32);
        let spec = SyntheticStudySessionSpec::from_config(&config)?;
        let study_store = self.study_store.clone();
        let clock = Arc::clone(&self.clock);
        let executor = match &study_store {
            Some(store) => {
                let _ = store.record_voice_session(&config).await.map_err(|error| {
                    store_failure(&error, BrainFailureClass::DurabilityDegraded)
                })?;
                Some(VivaToolExecutor::with_clock(
                    Arc::clone(store),
                    AuthorizedStudySession::from_config(&config).map_err(|error| {
                        tool_failure(BrainFailureClass::ToolExecutorFailure, &error.to_string())
                    })?,
                    synthetic_fixture_answer_evaluator(),
                    Arc::clone(&clock),
                ))
            }
            None => None,
        };
        let first_response_id = spec.response_id(1);
        let question = match &executor {
            Some(executor) => {
                select_session_question(
                    executor,
                    &spec.study_set_id,
                    &spec.voice_session_id,
                    &first_response_id,
                )
                .await?
            }
            None => fixture_question(),
        };
        let phases = SessionPhaseTracker::ready();
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: first_response_id,
                    question: question.clone(),
                })
                .await;

            let mut turn = 1_usize;
            let mut active_response: Option<ActiveResponse> = None;
            while let Some(input) = input_rx.recv().await {
                let answer_input = match input {
                    BrainInput::Audio(frame) => SyntheticAnswerInput::audio(frame, None),
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => SyntheticAnswerInput::audio(frame, client_generation_id),
                    BrainInput::Text(text) => SyntheticAnswerInput::text(text, None),
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => SyntheticAnswerInput::text(text, client_generation_id),
                    BrainInput::CancelResponse => {
                        let response_id = active_response
                            .as_ref()
                            .filter(|active| !active.completed.load(Ordering::SeqCst))
                            .map(|active| {
                                active.cancelled.store(true, Ordering::SeqCst);
                                active.response_id.clone()
                            })
                            .unwrap_or_else(|| {
                                let response_id = spec.response_id(turn);
                                turn += 1;
                                response_id
                            });
                        active_response = None;
                        let _ = event_tx
                            .send(BrainEvent::ResponseCancelledFor { response_id })
                            .await;
                        continue;
                    }
                    BrainInput::Stop => {
                        cancel_active_response(&mut active_response);
                        emit_session_recap(&event_tx, &spec, executor.as_ref(), &phases).await;
                        break;
                    }
                    BrainInput::ToolResult(_)
                    | BrainInput::SessionContextRefresh(_)
                    | BrainInput::ProactiveTurn { .. } => continue,
                    _ => continue,
                };
                cancel_active_response(&mut active_response);
                let response_id = spec
                    .response_id_for_generation(turn, answer_input.client_generation_id.as_deref());
                let answer_turn = turn;
                turn += 1;
                active_response = Some(spawn_study_answer_sequence(
                    event_tx.clone(),
                    spec.clone(),
                    question.clone(),
                    &response_id,
                    answer_input,
                    answer_turn,
                    executor.clone(),
                    phases.clone(),
                ));
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

fn store_failure(error: &agent_domain::PortError, class: BrainFailureClass) -> BrainError {
    let _ = error;
    brain_failure(BrainProviderFailureParts {
        failure_class: class,
        stage: BrainFailureStage::Store,
        retry_eligible: true,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "synthetic".to_owned(),
        metadata: "error_kind=store_write_failed".to_owned(),
    })
}

fn tool_failure(class: BrainFailureClass, reason: &str) -> BrainError {
    let _ = reason;
    brain_failure(BrainProviderFailureParts {
        failure_class: class,
        stage: BrainFailureStage::Tools,
        retry_eligible: true,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "synthetic".to_owned(),
        metadata: "error_kind=tool_executor_failure".to_owned(),
    })
}

#[derive(Clone, Debug)]
struct SyntheticStudySessionSpec {
    client_generation_id: Option<String>,
    voice_session_id: String,
    study_set_id: String,
}

impl SyntheticStudySessionSpec {
    fn from_config(config: &SessionConfig) -> Result<Self, BrainError> {
        // Identity is validated here and owned by the executor's authorized
        // session; this spec keeps only what event correlation needs.
        let _ = required(config.user_id.as_deref(), "user_id")?;
        let voice_session_id = required(config.session_id.as_deref(), "session_id")?;
        let study_set_id = required(config.study_set_id.as_deref(), "study_set_id")?;
        Ok(Self {
            client_generation_id: config.client_generation_id.clone(),
            voice_session_id: voice_session_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
        })
    }

    fn response_id(&self, turn: usize) -> String {
        self.response_id_for_generation(turn, self.client_generation_id.as_deref())
    }

    fn response_id_for_generation(
        &self,
        turn: usize,
        client_generation_id: Option<&str>,
    ) -> String {
        let base = format!("response-{turn}");
        let generation_id = client_generation_id.or(self.client_generation_id.as_deref());
        let Some(generation_id) = generation_id else {
            return base;
        };
        let generation_id = sanitized_response_generation_id(generation_id);
        if generation_id.is_empty() {
            base
        } else {
            format!("{base}-generation-{generation_id}")
        }
    }
}

fn sanitized_response_generation_id(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '-',
        })
        .take(96)
        .collect()
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, BrainError> {
    let _ = label;
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            brain_failure(BrainProviderFailureParts {
                failure_class: BrainFailureClass::ToolExecutorFailure,
                stage: BrainFailureStage::Session,
                retry_eligible: false,
                latency_ms: 0,
                provider: "server".to_owned(),
                model: "synthetic".to_owned(),
                metadata: "error_kind=missing_session_identity".to_owned(),
            })
        })
}

struct ActiveResponse {
    response_id: String,
    cancelled: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
    abort_handle: AbortHandle,
}

impl Drop for ActiveResponse {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            self.cancelled.store(true, Ordering::SeqCst);
            self.abort_handle.abort();
        }
    }
}

fn cancel_active_response(active_response: &mut Option<ActiveResponse>) {
    if let Some(active) = active_response.take() {
        if !active.completed.load(Ordering::SeqCst) {
            active.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_study_answer_sequence(
    event_tx: mpsc::Sender<BrainEvent>,
    spec: SyntheticStudySessionSpec,
    question: StudyQuestion,
    response_id: &str,
    answer_input: SyntheticAnswerInput,
    turn: usize,
    executor: Option<VivaToolExecutor>,
    phases: SessionPhaseTracker,
) -> ActiveResponse {
    let response_id = response_id.to_owned();
    let cancelled = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicBool::new(false));
    let task_cancelled = Arc::clone(&cancelled);
    let task_completed = Arc::clone(&completed);
    let task_response_id = response_id.clone();
    let abort_handle = tokio::spawn(async move {
        emit_study_answer_sequence(
            &event_tx,
            StudyAnswerJob {
                spec,
                question,
                response_id: task_response_id,
                answer_input,
                turn,
                executor,
                phases,
                cancelled: task_cancelled,
                completed: task_completed,
            },
        )
        .await;
    })
    .abort_handle();
    ActiveResponse {
        response_id,
        cancelled,
        completed,
        abort_handle,
    }
}

struct StudyAnswerJob {
    spec: SyntheticStudySessionSpec,
    question: StudyQuestion,
    response_id: String,
    answer_input: SyntheticAnswerInput,
    turn: usize,
    executor: Option<VivaToolExecutor>,
    phases: SessionPhaseTracker,
    cancelled: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
}

struct SyntheticAnswerInput {
    text: String,
    capture_mode: AnswerCaptureMode,
    byte_count: Option<u64>,
    char_count: Option<u64>,
    client_generation_id: Option<String>,
}

impl SyntheticAnswerInput {
    fn audio(frame: agent_domain::AudioFrame, client_generation_id: Option<String>) -> Self {
        let byte_count = frame.pcm16_bytes().len().try_into().unwrap_or(u64::MAX);
        Self {
            text: format!("received {byte_count} PCM16 bytes"),
            capture_mode: AnswerCaptureMode::Audio,
            byte_count: Some(byte_count),
            char_count: None,
            client_generation_id,
        }
    }

    fn text(text: String, client_generation_id: Option<String>) -> Self {
        Self {
            byte_count: Some(text.len().try_into().unwrap_or(u64::MAX)),
            char_count: Some(text.chars().count().try_into().unwrap_or(u64::MAX)),
            capture_mode: AnswerCaptureMode::Typed,
            text,
            client_generation_id,
        }
    }
}

fn synthetic_answer_attempt_envelope(job: &StudyAnswerJob) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        response_id: job.response_id.clone(),
        question_id: job.question.question_id.clone(),
        submission_sequence: job.turn.try_into().unwrap_or(u32::MAX),
        idempotency_key: format!(
            "{}:{}:{}:{}:synthetic",
            job.spec.voice_session_id, job.question.question_id, job.turn, job.response_id
        ),
        capture_mode: job.answer_input.capture_mode,
        byte_count: job.answer_input.byte_count,
        char_count: job.answer_input.char_count,
        duration_ms: None,
        client_generation_id: job.answer_input.client_generation_id.clone(),
        locale: None,
        capture_status: AnswerCaptureStatus::Accepted,
        content_policy: AnswerContentPolicy::None,
        answer_digest_hmac: None,
        transcript_status: None,
        transcript_confidence_bucket: None,
        pre_provider_state: "synthetic_before_evaluation".to_owned(),
    }
}

async fn emit_study_answer_sequence(event_tx: &mpsc::Sender<BrainEvent>, job: StudyAnswerJob) {
    // Re-ask on a fresh attempt so the client's active-response correlation
    // resets and the new evaluation is applied rather than dropped as stale.
    if job.turn > 1
        && !send_unless_cancelled(
            event_tx,
            BrainEvent::QuestionStarted {
                response_id: job.response_id.clone(),
                question: job.question.clone(),
            },
            &job.cancelled,
        )
        .await
    {
        return;
    }

    sleep(Duration::from_millis(280)).await;
    for phase in [StudySessionPhase::Listening, StudySessionPhase::Thinking] {
        let transition = if phase == StudySessionPhase::Listening {
            job.phases.begin_turn()
        } else {
            job.phases.phase_event(phase)
        };
        match transition {
            Ok(event) => {
                if !send_unless_cancelled(event_tx, event, &job.cancelled).await {
                    return;
                }
            }
            Err(error) => {
                emit_provider_failure(event_tx, error).await;
                return;
            }
        }
        if phase == StudySessionPhase::Listening {
            sleep(Duration::from_millis(240)).await;
            if !send_unless_cancelled(
                event_tx,
                BrainEvent::TranscriptDelta {
                    response_id: job.response_id.clone(),
                    text: job.answer_input.text.clone(),
                },
                &job.cancelled,
            )
            .await
            {
                return;
            }
            // The synthetic runtime runs no speech recognizer, so there is no
            // transcription confidence to report and none is invented.
            if !send_unless_cancelled(
                event_tx,
                BrainEvent::TranscriptFinal {
                    response_id: job.response_id.clone(),
                    text: job.answer_input.text.clone(),
                    confidence: None,
                },
                &job.cancelled,
            )
            .await
            {
                return;
            }
            sleep(Duration::from_millis(260)).await;
        }
    }
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::ManuscriptIntent {
            response_id: job.response_id.clone(),
            intent: ManuscriptIntent::Scene {
                register: ManuscriptRegister::Examining,
                emphasis: ManuscriptEmphasis::Measured,
            },
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    // The examiner takes a beat to cross-reference the sources.
    sleep(Duration::from_millis(850)).await;
    if job.cancelled.load(Ordering::SeqCst) {
        return;
    }

    // Without a store there is no persisted outcome, so this runtime states no
    // learner fact at all. Fabricating one here is exactly the defect ADAPTER-01
    // closes.
    if let Some(executor) = job.executor.clone() {
        if let Err(error) = executor
            .record_answer_attempt_envelope(synthetic_answer_attempt_envelope(&job))
            .await
        {
            emit_provider_failure(
                event_tx,
                tool_failure(BrainFailureClass::DurabilityDegraded, &error.to_string()),
            )
            .await;
            return;
        }
        let outcome = match executor
            .execute(
                &job.response_id,
                ToolProposal::evaluate_spoken_answer(
                    &job.spec.study_set_id,
                    &job.spec.voice_session_id,
                    &job.question.question_id,
                    &job.answer_input.text,
                ),
            )
            .await
            .map_err(|error| {
                tool_failure(BrainFailureClass::ToolExecutorFailure, &error.to_string())
            })
            .and_then(|result| parse_persisted_turn_outcome(&result.result, &job.response_id))
        {
            Ok(outcome) => outcome,
            Err(error) => {
                emit_provider_failure(event_tx, error).await;
                return;
            }
        };

        let source = match executor
            .execute(
                &job.response_id,
                ToolProposal::retrieve_source_reference(
                    &job.spec.study_set_id,
                    &job.spec.voice_session_id,
                    outcome
                        .source_ids
                        .first()
                        .map_or(job.question.source.source_id.as_str(), String::as_str),
                ),
            )
            .await
            .map_err(|error| {
                tool_failure(BrainFailureClass::ToolExecutorFailure, &error.to_string())
            })
            .and_then(|result| {
                serde_json::from_value(result.result["source"].clone()).map_err(|_| {
                    tool_failure(BrainFailureClass::ToolExecutorFailure, "source payload")
                })
            }) {
            Ok(source) => source,
            Err(error) => {
                emit_provider_failure(event_tx, error).await;
                return;
            }
        };

        let evaluation = match answer_evaluation_from_outcome(
            &outcome,
            &job.answer_input.text,
            &source,
            &job.question,
        ) {
            Ok(evaluation) => evaluation,
            Err(error) => {
                emit_provider_failure(event_tx, error).await;
                return;
            }
        };
        for event in learning_event_projection(&outcome, &job.response_id, &source, evaluation) {
            let concept_intent = match &event {
                BrainEvent::ConceptStatus { concept_id, .. } => Some(concept_id.clone()),
                _ => None,
            };
            if !send_unless_cancelled(event_tx, event, &job.cancelled).await {
                return;
            }
            if let Some(concept_id) = concept_intent {
                if !send_unless_cancelled(
                    event_tx,
                    BrainEvent::ManuscriptIntent {
                        response_id: job.response_id.clone(),
                        intent: ManuscriptIntent::Entity {
                            entity_id: concept_id,
                            entity_kind: ManuscriptEntityKind::Concept,
                            register: ManuscriptRegister::Correcting,
                            emphasis: ManuscriptEmphasis::Marked,
                        },
                    },
                    &job.cancelled,
                )
                .await
                {
                    return;
                }
            }
        }
    }

    if !send_unless_cancelled(
        event_tx,
        BrainEvent::Usage(BrainUsage {
            text_input_tokens: 20,
            text_output_tokens: 10,
            source_grounded_correction_count: 1,
            ..BrainUsage::default()
        }),
        &job.cancelled,
    )
    .await
    {
        return;
    }
    // Terminal state for the attempt: the page dwells in correction. There is no
    // auto-recap — recap is emitted on Stop. The student answers again or ends.
    for phase in [StudySessionPhase::Feedback, StudySessionPhase::Correction] {
        match job.phases.phase_event(phase) {
            Ok(event) => {
                if !send_unless_cancelled(event_tx, event, &job.cancelled).await {
                    return;
                }
            }
            Err(error) => {
                emit_provider_failure(event_tx, error).await;
                return;
            }
        }
    }
    job.completed.store(true, Ordering::SeqCst);
    let _ = send_unless_cancelled(
        event_tx,
        BrainEvent::ResponseCompleted {
            response_id: job.response_id.clone(),
        },
        &job.cancelled,
    )
    .await;
}

async fn emit_session_recap(
    event_tx: &mpsc::Sender<BrainEvent>,
    spec: &SyntheticStudySessionSpec,
    executor: Option<&VivaToolExecutor>,
    phases: &SessionPhaseTracker,
) {
    let Some(executor) = executor else {
        return;
    };
    let response_id = spec.response_id(0);
    let recap = match executor
        .execute(
            &response_id,
            ToolProposal::build_session_recap(&spec.study_set_id, &spec.voice_session_id),
        )
        .await
        .map_err(|error| tool_failure(BrainFailureClass::ToolExecutorFailure, &error.to_string()))
        .and_then(|result| recap_from_tool_result(&result.result))
    {
        Ok(recap) => recap,
        Err(error) => {
            emit_provider_failure(event_tx, error).await;
            return;
        }
    };
    let _ = event_tx
        .send(BrainEvent::RecapReady { response_id, recap })
        .await;
    if let Some(event) = phases.phase_event_if_legal(StudySessionPhase::Recap) {
        let _ = event_tx.send(event).await;
    }
}

async fn send_unless_cancelled(
    event_tx: &mpsc::Sender<BrainEvent>,
    event: BrainEvent,
    cancelled: &AtomicBool,
) -> bool {
    if cancelled.load(Ordering::SeqCst) {
        return false;
    }
    if event_tx.send(event).await.is_err() {
        return false;
    }
    tokio::task::yield_now().await;
    !cancelled.load(Ordering::SeqCst)
}

async fn emit_provider_failure(event_tx: &mpsc::Sender<BrainEvent>, error: BrainError) {
    let _ = event_tx
        .send(BrainEvent::Error(BrainProviderError::from_failure(
            error.failure().clone(),
        )))
        .await;
}

/// The rubric policy the corpus pins, asserted at compile time so a fixture that
/// silently changed policy could not grade a session under the old name.
const _: () = assert!(!VIVA_SEMANTIC_RUBRIC_POLICY_VERSION.is_empty());

#[cfg(test)]
mod fixture_evaluator_tests {
    use agent_domain::CriterionAssessmentKind;

    use super::*;

    #[test]
    fn every_named_rotation_case_exists_in_the_immutable_corpus() {
        for case_id in SYNTHETIC_FIXTURE_CASE_IDS {
            assert!(
                learning_core_turn_outcome(case_id).is_some(),
                "the corpus must publish `{case_id}`"
            );
        }
        assert_eq!(
            learning_core_rubric()
                .expect("corpus rubric parses")
                .policy_version,
            VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
        );
    }

    #[tokio::test]
    async fn fixture_evaluator_replays_corpus_verdicts_and_never_reads_the_answer() {
        let evaluator = synthetic_fixture_answer_evaluator();
        let rubric = learning_core_rubric().expect("corpus rubric parses");
        let question = StudyQuestion {
            question_id: "q-etc-electron-flow".to_owned(),
            concept_id: rubric.criteria[0].concept_id.clone(),
            prompt: "Trace the electrons.".to_owned(),
            expected_terms: Vec::new(),
            follow_up: "Say the next step.".to_owned(),
            source: agent_domain::StudySourceReference {
                source_id: rubric.criteria[0].source_id.clone(),
                document_id: "lec5".to_owned(),
                span: "slide:18".to_owned(),
                excerpt: "bound claim".to_owned(),
                confidence: agent_domain::SourceConfidence::High,
                retrieval_reason: "server-bound rubric source".to_owned(),
            },
            rubric: rubric.clone(),
        };
        let request = |answer: &str| EvaluationRequest {
            response_id: "response-1".to_owned(),
            question: question.clone(),
            answer_text: answer.to_owned(),
            transcript_confidence: Some(0.88),
        };

        let first = evaluator
            .evaluate(&request("a perfect answer"))
            .await
            .expect("fixture decision");
        let second = evaluator
            .evaluate(&request("a completely different answer"))
            .await
            .expect("fixture decision");
        assert_eq!(
            first, second,
            "the fixture evaluator must not read the answer text"
        );

        if let EvaluationDecision::Evaluated { assessments, .. } = first {
            let criterion_ids = assessments
                .iter()
                .map(|assessment| assessment.criterion_id.clone())
                .collect::<Vec<_>>();
            let rubric_ids = rubric
                .criteria
                .iter()
                .map(|criterion| criterion.criterion_id.clone())
                .collect::<Vec<_>>();
            assert_eq!(
                criterion_ids, rubric_ids,
                "criterion identity stays server-owned"
            );
            assert!(assessments
                .iter()
                .all(|assessment| assessment.confidence.is_finite()));
            assert!(assessments.iter().any(|assessment| matches!(
                assessment.assessment,
                CriterionAssessmentKind::Satisfied
                    | CriterionAssessmentKind::Contradicted
                    | CriterionAssessmentKind::NotDemonstrated
            )));
        }
    }
}

// ---------------------------------------------------------------------------
// `SyntheticBrain` trust and lifecycle guards.
//
// Task 1 replaced how this runtime obtains learner facts, which obsoleted the
// *assertions* of the pre-Task-1 suite but not the *invariants* those tests
// existed to pin. The five restored below are re-expressed against the
// authoritative-outcome flow: a browser-supplied source context is still never
// the trusted source, a browser-supplied concept list is still never an
// authorized concept event, the per-generation response identity is still the
// one persisted, dropping a session still aborts the turn before any store
// write, and one assembled long-form turn is still exactly one graded turn.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod synthetic_runtime_guards {
    use agent_domain::{
        ConceptStatus, RealtimeBrain, SessionId, SourceConfidence, SourceContext, StudyMode,
    };
    use tokio::time::timeout;

    use super::*;

    /// Values a hostile browser could put in `SessionConfig.source_context`.
    /// None of them is evidence, so none of them may reach a learner-visible
    /// event.
    const FORGED_DOCUMENT_ID: &str = "browser-forged-doc";
    const FORGED_SPAN: &str = "browser:999";
    const FORGED_EXCERPT: &str = "Browser forged excerpt";
    const FORGED_RETRIEVAL_REASON: &str = "browser supplied injection";
    /// A real concept of the seeded set that this session's rubric does *not*
    /// name, supplied by the client through `SessionConfig.active_concepts`.
    const FORGED_ACTIVE_CONCEPT: &str = "atp-synthase";

    const SPOKEN_ANSWER: &str = "NADH gives electrons to the electron transport chain.";

    /// The seeded development study set publishes concept ids that its own
    /// question's rubric does not name, so a graded turn needs the rubric's
    /// concept published before the executor can bind a prior status to it.
    fn learning_ready_store() -> Arc<data::InMemoryStudyStore> {
        let store = data::InMemoryStudyStore::seeded_fixture();
        let question = fixture_question();
        let mut concept_ids = vec![
            "oxidative-phosphorylation".to_owned(),
            "nadh".to_owned(),
            FORGED_ACTIVE_CONCEPT.to_owned(),
            "cellular-respiration".to_owned(),
        ];
        for criterion in &question.rubric.criteria {
            if !concept_ids.contains(&criterion.concept_id) {
                concept_ids.push(criterion.concept_id.clone());
            }
            store.upsert_concept(data::ConceptRecord {
                study_set_id: "biology-midterm".to_owned(),
                concept_id: criterion.concept_id.clone(),
                label: "Oxidative phosphorylation".to_owned(),
                status: ConceptStatus::Review,
                source_span_id: criterion.source_id.clone(),
            });
        }
        store.upsert_study_set(data::StudySetRecord {
            study_set_id: "biology-midterm".to_owned(),
            user_id: "user-1".to_owned(),
            title: "Biology Midterm".to_owned(),
            course: Some("Biology 201".to_owned()),
            ingestion_status: agent_domain::StudySetIngestionStatus::Ready,
            ingestion_error: None,
            concept_ids,
            question_ids: vec![question.question_id.clone()],
        });
        Arc::new(store)
    }

    fn session_config() -> SessionConfig {
        SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        }
    }

    fn forged_source_context() -> Vec<SourceContext> {
        vec![SourceContext {
            // The one honest-looking field: the forgery names a real server
            // source id so only the *content* fields distinguish it.
            source_id: "src-lecture-5-slide-18".to_owned(),
            document_id: FORGED_DOCUMENT_ID.to_owned(),
            span: FORGED_SPAN.to_owned(),
            excerpt: FORGED_EXCERPT.to_owned(),
            confidence: SourceConfidence::Low,
            retrieval_reason: FORGED_RETRIEVAL_REASON.to_owned(),
        }]
    }

    async fn next_event(session: &mut RealtimeSession) -> BrainEvent {
        timeout(Duration::from_secs(5), session.events.recv())
            .await
            .expect("event arrives")
            .expect("event stream stays open")
    }

    async fn wait_for_transcript_final(session: &mut RealtimeSession) {
        loop {
            if matches!(
                next_event(session).await,
                BrainEvent::TranscriptFinal { .. }
            ) {
                return;
            }
        }
    }

    /// Every event of one answer turn, ending at the turn's terminal event.
    async fn drain_turn(session: &mut RealtimeSession) -> Vec<BrainEvent> {
        let mut events = Vec::new();
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
            let terminal = matches!(
                event,
                BrainEvent::ResponseCompleted { .. } | BrainEvent::Error(_)
            );
            events.push(event);
            if terminal {
                break;
            }
        }
        events
    }

    fn emitted_concept_statuses(events: &[BrainEvent]) -> Vec<(String, ConceptStatus)> {
        events
            .iter()
            .filter_map(|event| match event {
                BrainEvent::ConceptStatus {
                    concept_id, status, ..
                } => Some((concept_id.clone(), status.clone())),
                _ => None,
            })
            .collect()
    }

    /// The single persisted outcome's own concept transitions — the only thing
    /// that may become a `ConceptStatus` event.
    fn persisted_transitions(store: &data::InMemoryStudyStore) -> Vec<(String, ConceptStatus)> {
        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.turn_outcomes.len(),
            1,
            "exactly one turn outcome is persisted"
        );
        match &snapshot.turn_outcomes[0].outcome.resolution {
            TurnResolution::Evaluated {
                concept_transitions,
                ..
            } => concept_transitions
                .iter()
                .map(|transition| (transition.concept_id.clone(), transition.to_status.clone()))
                .collect(),
            TurnResolution::Deferred { .. } => Vec::new(),
        }
    }

    /// A browser can put anything in `SessionConfig.source_context`. It is not
    /// evidence: the source a learner is shown is the server's own, and no
    /// forged field may reach any emitted event.
    #[tokio::test]
    async fn ignores_browser_source_context_for_trusted_source_output() {
        let store = learning_ready_store();
        let mut session = SyntheticBrain::with_study_store(store.clone())
            .open(SessionConfig {
                source_context: forged_source_context(),
                ..session_config()
            })
            .await
            .expect("synthetic runtime opens");

        let mut events = vec![
            next_event(&mut session).await,
            next_event(&mut session).await,
        ];
        assert!(matches!(
            events[0],
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Ready
            }
        ));
        match &events[1] {
            BrainEvent::QuestionStarted { question, .. } => {
                assert_eq!(question.source.document_id, "lec-5");
                assert_eq!(question.source.span, "slide:18");
                assert_eq!(
                    question.source.retrieval_reason,
                    "server fixture source for oxidative phosphorylation"
                );
            }
            other => panic!("expected question_started, got {other:?}"),
        }

        session
            .input
            .send(BrainInput::Text(SPOKEN_ANSWER.to_owned()))
            .await
            .expect("text input accepted");
        events.extend(drain_turn(&mut session).await);

        // The whole turn, not just the question: the retrieved source reference
        // and the evaluation carry a source too.
        assert!(
            events
                .iter()
                .any(|event| matches!(event, BrainEvent::SourceReference { .. })),
            "the turn retrieved a server source: {events:?}"
        );
        let serialized = serde_json::to_string(&events).expect("events serialize");
        for forged in [
            FORGED_DOCUMENT_ID,
            FORGED_SPAN,
            FORGED_EXCERPT,
            FORGED_RETRIEVAL_REASON,
        ] {
            assert!(
                !serialized.contains(forged),
                "a browser-supplied source field reached the learner: `{forged}` in {serialized}"
            );
        }
    }

    /// A browser-supplied `active_concepts` list is a hint about what the page is
    /// showing, never an authorization. Only the persisted outcome's own
    /// transitions become concept events.
    #[tokio::test]
    async fn uses_server_active_concepts_for_authorized_concept_events() {
        let store = learning_ready_store();
        let mut session = SyntheticBrain::with_study_store(store.clone())
            .open(SessionConfig {
                active_concepts: vec![FORGED_ACTIVE_CONCEPT.to_owned()],
                ..session_config()
            })
            .await
            .expect("synthetic runtime opens");
        let _ = next_event(&mut session).await;
        let _ = next_event(&mut session).await;
        session
            .input
            .send(BrainInput::Text(SPOKEN_ANSWER.to_owned()))
            .await
            .expect("text input accepted");
        let events = drain_turn(&mut session).await;

        assert!(
            events
                .iter()
                .all(|event| !matches!(event, BrainEvent::Error(_))),
            "the turn completed without a failure: {events:?}"
        );
        let expected = persisted_transitions(&store);
        assert!(
            !expected.is_empty(),
            "the persisted outcome names at least one concept: {events:?}"
        );
        assert_eq!(emitted_concept_statuses(&events), expected, "{events:?}");
        assert!(
            !expected
                .iter()
                .any(|(concept_id, _)| concept_id == FORGED_ACTIVE_CONCEPT),
            "the client-supplied concept must not be in the persisted outcome either"
        );
        let serialized = serde_json::to_string(&emitted_concept_statuses(&events))
            .expect("concept statuses serialize");
        assert!(
            !serialized.contains(FORGED_ACTIVE_CONCEPT),
            "a client-supplied concept became an authorized concept event: {serialized}"
        );
    }

    /// The client generation id is the browser's restore identity. It must reach
    /// both the response identity and the persisted attempt envelope, or a
    /// bfcache restore silently double-writes.
    #[tokio::test]
    async fn persists_client_generation_id_on_synthetic_answer_attempts() {
        let store = learning_ready_store();
        let mut session = SyntheticBrain::with_study_store(store.clone())
            .open(SessionConfig {
                client_generation_id: Some("bfcache_restore-3".to_owned()),
                ..session_config()
            })
            .await
            .expect("synthetic runtime opens");

        let response_id = "response-1-generation-bfcache_restore-3";
        let _ = next_event(&mut session).await;
        match next_event(&mut session).await {
            BrainEvent::QuestionStarted {
                response_id: question_response_id,
                ..
            } => assert_eq!(question_response_id, response_id),
            event => panic!("expected generated question response id, got {event:?}"),
        }
        session
            .input
            .send(BrainInput::TextWithMetadata {
                text: SPOKEN_ANSWER.to_owned(),
                client_generation_id: Some("bfcache_restore-3".to_owned()),
            })
            .await
            .expect("text input accepted");
        let events = drain_turn(&mut session).await;
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, BrainEvent::Error(_))),
            "the turn completed without a failure: {events:?}"
        );

        let snapshot = store.snapshot();
        assert_eq!(snapshot.answer_attempts.len(), 1);
        assert_eq!(snapshot.answer_attempts[0].response_id, response_id);
        assert_eq!(
            snapshot.answer_attempts[0].envelope.response_id,
            response_id
        );
        assert_eq!(
            snapshot.answer_attempts[0]
                .envelope
                .client_generation_id
                .as_deref(),
            Some("bfcache_restore-3"),
        );
        assert_eq!(snapshot.turn_outcomes.len(), 1);
        assert_eq!(snapshot.turn_outcomes[0].outcome.response_id, response_id);
    }

    /// Nothing a learner never saw is ever written.
    ///
    /// Two ways the browser can walk away mid-turn, and the store must be
    /// untouched after both. The second is the one that isolates
    /// [`ActiveResponse`]'s own `Drop`: the event receiver stays alive, so every
    /// `send` still succeeds and only the abort can stop the in-flight response
    /// before it reaches the executor.
    #[tokio::test]
    async fn dropping_session_aborts_active_synthetic_response_before_store_writes() {
        // The whole session goes away.
        let store = learning_ready_store();
        let mut session = SyntheticBrain::with_study_store(store.clone())
            .open(session_config())
            .await
            .expect("synthetic runtime opens");
        let _ = next_event(&mut session).await;
        let _ = next_event(&mut session).await;
        session
            .input
            .send(BrainInput::Text(SPOKEN_ANSWER.to_owned()))
            .await
            .expect("text input accepted");
        wait_for_transcript_final(&mut session).await;

        drop(session);
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert_untouched_by_the_abandoned_turn(&store);

        // Only the input side goes away, with the reader still attached.
        let store = learning_ready_store();
        let session = SyntheticBrain::with_study_store(store.clone())
            .open(session_config())
            .await
            .expect("synthetic runtime opens");
        let RealtimeSession {
            input,
            events: mut event_rx,
            task_guard,
        } = session;
        for _ in 0..2 {
            let _ = timeout(Duration::from_secs(5), event_rx.recv())
                .await
                .expect("event arrives");
        }
        input
            .send(BrainInput::Text(SPOKEN_ANSWER.to_owned()))
            .await
            .expect("text input accepted");
        loop {
            let event = timeout(Duration::from_secs(5), event_rx.recv())
                .await
                .expect("event arrives")
                .expect("event stream stays open");
            if matches!(event, BrainEvent::TranscriptFinal { .. }) {
                break;
            }
        }
        drop(input);

        // Past every remaining stage of the turn, with the reader still draining
        // so no send can fail and stand in for the abort.
        let mut trailing = Vec::new();
        while let Ok(Some(event)) = timeout(Duration::from_secs(3), event_rx.recv()).await {
            trailing.push(event);
        }
        drop(task_guard);
        assert!(
            trailing
                .iter()
                .all(|event| !matches!(event, BrainEvent::ResponseCompleted { .. })),
            "the abandoned turn must not run to completion: {trailing:?}"
        );
        assert_untouched_by_the_abandoned_turn(&store);
    }

    fn assert_untouched_by_the_abandoned_turn(store: &data::InMemoryStudyStore) {
        let snapshot = store.snapshot();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.answer_attempts.len(), 0);
        assert_eq!(snapshot.turn_outcomes.len(), 0);
        assert_eq!(snapshot.concept_statuses.len(), 0);
        assert_eq!(snapshot.review_items.len(), 0);
        assert_eq!(snapshot.review_schedule_decisions.len(), 0);
        assert_eq!(snapshot.recaps.len(), 0);
    }

    /// The WebSocket assembler admits one `BrainInput` per completed browser
    /// turn, so thousands of bounded chunks still produce exactly one graded
    /// turn.
    #[tokio::test]
    async fn one_assembled_forty_five_second_turn_produces_one_evaluated_turn() {
        let store = learning_ready_store();
        let mut session = SyntheticBrain::with_study_store(store.clone())
            .open(session_config())
            .await
            .expect("synthetic runtime opens");
        let _ = next_event(&mut session).await;
        let _ = next_event(&mut session).await;

        // 45 seconds of mono pcm_s16le at 24 kHz: 2,250 bounded 20 ms chunks.
        session
            .input
            .send(BrainInput::AudioWithMetadata {
                frame: agent_domain::AudioFrame::from_pcm16_bytes(vec![0_u8; 2_160_000]),
                client_generation_id: Some("generation-1".to_owned()),
            })
            .await
            .expect("audio input accepted");

        // Read past the first evaluation to the turn's terminal event, so a
        // second evaluation would be counted rather than hidden by an early
        // break.
        let mut events = drain_turn(&mut session).await;
        assert!(
            events
                .iter()
                .any(|event| matches!(event, BrainEvent::ResponseCompleted { .. })),
            "the assembled turn reached its terminal event: {events:?}"
        );

        // Close the input side and drain the remainder of the stream: any second
        // provider turn for the same assembled frame surfaces here.
        let RealtimeSession {
            input,
            events: mut event_rx,
            task_guard: _task_guard,
        } = session;
        drop(input);
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), event_rx.recv()).await {
            events.push(event);
        }

        let transcripts = events
            .iter()
            .filter_map(|event| match event {
                BrainEvent::TranscriptFinal { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(transcripts, vec!["received 2160000 PCM16 bytes".to_owned()]);
        let resolutions = events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    BrainEvent::AnswerEvaluated { .. } | BrainEvent::TurnDeferred { .. }
                )
            })
            .count();
        assert_eq!(resolutions, 1, "{events:?}");
        let snapshot = store.snapshot();
        assert_eq!(snapshot.answer_attempts.len(), 1);
        assert_eq!(snapshot.turn_outcomes.len(), 1);
    }

    /// The residual product-flow invariants of the pre-Task-1
    /// `emits_deterministic_product_study_flow_and_cancel_id`: its
    /// adapter-authored mastery assertions are obsolete, but the response-id
    /// allocation for a cancel with no active response, the usage report, the
    /// terminal correction phase, and the recap-on-`Stop` are all still live.
    #[tokio::test]
    async fn cancel_without_an_active_response_allocates_the_next_response_id_and_recaps_on_stop() {
        let store = learning_ready_store();
        let mut session = SyntheticBrain::with_study_store(store.clone())
            .open(session_config())
            .await
            .expect("synthetic runtime opens");
        let _ = next_event(&mut session).await;
        match next_event(&mut session).await {
            BrainEvent::QuestionStarted { response_id, .. } => {
                assert_eq!(response_id, "response-1");
            }
            other => panic!("expected question_started, got {other:?}"),
        }

        session
            .input
            .send(BrainInput::Text(SPOKEN_ANSWER.to_owned()))
            .await
            .expect("text input accepted");
        let events = drain_turn(&mut session).await;
        assert!(
            events.iter().any(|event| matches!(
                event,
                BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Correction
                }
            )),
            "the turn ends dwelling in correction: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, BrainEvent::Usage(_))),
            "the turn reports usage: {events:?}"
        );
        assert_eq!(
            events.last(),
            Some(&BrainEvent::ResponseCompleted {
                response_id: "response-1".to_owned()
            })
        );

        // The completed turn consumed response-1, so a cancel with nothing in
        // flight names the response the next turn would have used rather than
        // re-cancelling a finished one.
        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .expect("cancel accepted");
        assert_eq!(
            next_event(&mut session).await,
            BrainEvent::ResponseCancelledFor {
                response_id: "response-2".to_owned()
            }
        );

        // The recap is produced when the student ends the session, from the
        // persisted evidence rather than from adapter-authored copy.
        session
            .input
            .send(BrainInput::Stop)
            .await
            .expect("stop accepted");
        let mut saw_recap = false;
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
            if let BrainEvent::RecapReady { recap, .. } = event {
                assert_eq!(recap.voice_session_id, "voice-session-1");
                saw_recap = true;
                break;
            }
        }
        assert!(saw_recap);
        assert_eq!(store.snapshot().recaps.len(), 1);
    }
}
