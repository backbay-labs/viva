use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::{sync::mpsc, task::AbortHandle, time::sleep};

use agent_domain::{
    fixture_question, AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus,
    AnswerContentPolicy, AnswerEvaluation, BrainError, BrainEvent, BrainInput, BrainProviderError,
    BrainUsage, ConceptStatus, ManuscriptEmphasis, ManuscriptEntityKind, ManuscriptIntent,
    ManuscriptRegister, RealtimeBrain, RealtimeBrainCapabilities, RealtimeSession,
    RealtimeSessionTaskGuard, RecapSourceMoment, SessionConfig, StudyMemoryStore, StudyQuestion,
    StudySessionPhase, StudySessionRecap,
};

/// One step in the synthetic evaluation rotation. Deterministic, offline, no
/// keys — but VARIED, so the manuscript shows real branching (shaky vs strong vs
/// confident-wrong vs unverifiable) instead of one hardcoded mood.
struct SyntheticAnswerSpec {
    label: &'static str,
    status: ConceptStatus,
    transcript_confidence: f32,
    eval_confidence: f32,
    feedback: &'static str,
    concept_id: &'static str,
}

const ANSWER_SPECS: [SyntheticAnswerSpec; 4] = [
    SyntheticAnswerSpec {
        label: "partially correct",
        status: ConceptStatus::Shaky,
        transcript_confidence: 0.78,
        eval_confidence: 0.55,
        feedback: "You named ATP, but skipped the proton-gradient mechanism that drives ATP synthase.",
        concept_id: "nadh",
    },
    SyntheticAnswerSpec {
        label: "mostly correct",
        status: ConceptStatus::Strong,
        transcript_confidence: 0.92,
        eval_confidence: 0.88,
        feedback: "Strong mechanism. Now make the link from the proton gradient to ATP synthase explicit.",
        concept_id: "oxidative-phosphorylation",
    },
    SyntheticAnswerSpec {
        label: "wrong",
        status: ConceptStatus::Missed,
        transcript_confidence: 0.95,
        eval_confidence: 0.86,
        feedback: "Not quite — NADH donates electrons to the transport chain; it does not make ATP directly.",
        concept_id: "atp-synthase",
    },
    SyntheticAnswerSpec {
        label: "insufficient evidence",
        status: ConceptStatus::Missed,
        transcript_confidence: 0.6,
        eval_confidence: 0.4,
        feedback: "I can't confirm that from your notes — Lecture 5 doesn't support that claim.",
        concept_id: "cellular-respiration",
    },
];

#[derive(Clone, Default)]
pub struct SyntheticBrain {
    study_store: Option<Arc<dyn StudyMemoryStore>>,
}

impl SyntheticBrain {
    pub fn with_study_store(study_store: Arc<dyn StudyMemoryStore>) -> Self {
        Self {
            study_store: Some(study_store),
        }
    }

    async fn question_for_spec(
        &self,
        spec: &SyntheticStudySessionSpec,
    ) -> Result<StudyQuestion, BrainError> {
        let mut question = fixture_question();
        let Some(study_store) = &self.study_store else {
            return Ok(question);
        };
        if let Some(active_question) = study_store
            .active_question(&spec.user_id, &spec.study_set_id)
            .await
            .map_err(|error| BrainError::Connection(error.to_string()))?
        {
            return Ok(active_question);
        }
        let source = study_store
            .source_reference(
                &spec.user_id,
                &spec.study_set_id,
                &question.source.source_id,
            )
            .await
            .map_err(|error| BrainError::Connection(error.to_string()))?
            .ok_or_else(|| {
                BrainError::Connection(format!(
                    "missing deterministic source {} for study set {}",
                    question.source.source_id, spec.study_set_id
                ))
            })?;
        question.source = source;
        Ok(question)
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
        let question = self.question_for_spec(&spec).await?;
        let study_store = self.study_store.clone();
        if let Some(store) = &study_store {
            store
                .record_voice_session(&config)
                .await
                .map_err(|error| BrainError::Connection(error.to_string()))?;
        }
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: spec.response_id(1),
                    question: question.clone(),
                })
                .await;

            let mut turn = 1_usize;
            let mut active_response: Option<ActiveResponse> = None;
            while let Some(input) = input_rx.recv().await {
                match input {
                    BrainInput::Audio(frame) => {
                        cancel_active_response(&mut active_response);
                        let response_id = spec.response_id(turn);
                        let answer_turn = turn;
                        turn += 1;
                        active_response = Some(spawn_study_answer_sequence(
                            event_tx.clone(),
                            spec.clone(),
                            question.clone(),
                            &response_id,
                            SyntheticAnswerInput::audio(frame, None),
                            answer_turn,
                            study_store.clone(),
                        ));
                    }
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => {
                        cancel_active_response(&mut active_response);
                        let response_id =
                            spec.response_id_for_generation(turn, client_generation_id.as_deref());
                        let answer_turn = turn;
                        turn += 1;
                        active_response = Some(spawn_study_answer_sequence(
                            event_tx.clone(),
                            spec.clone(),
                            question.clone(),
                            &response_id,
                            SyntheticAnswerInput::audio(frame, client_generation_id),
                            answer_turn,
                            study_store.clone(),
                        ));
                    }
                    BrainInput::Text(text) => {
                        cancel_active_response(&mut active_response);
                        let response_id = spec.response_id(turn);
                        let answer_turn = turn;
                        turn += 1;
                        active_response = Some(spawn_study_answer_sequence(
                            event_tx.clone(),
                            spec.clone(),
                            question.clone(),
                            &response_id,
                            SyntheticAnswerInput::text(text, None),
                            answer_turn,
                            study_store.clone(),
                        ));
                    }
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => {
                        cancel_active_response(&mut active_response);
                        let response_id =
                            spec.response_id_for_generation(turn, client_generation_id.as_deref());
                        let answer_turn = turn;
                        turn += 1;
                        active_response = Some(spawn_study_answer_sequence(
                            event_tx.clone(),
                            spec.clone(),
                            question.clone(),
                            &response_id,
                            SyntheticAnswerInput::text(text, client_generation_id),
                            answer_turn,
                            study_store.clone(),
                        ));
                    }
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
                    }
                    BrainInput::Stop => {
                        cancel_active_response(&mut active_response);
                        emit_session_recap(&event_tx, &spec, &question, study_store.as_ref()).await;
                        break;
                    }
                    BrainInput::ToolResult(_)
                    | BrainInput::SessionContextRefresh(_)
                    | BrainInput::ProactiveTurn { .. } => {}
                    _ => {}
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

#[derive(Clone, Debug)]
struct SyntheticStudySessionSpec {
    client_generation_id: Option<String>,
    user_id: String,
    voice_session_id: String,
    study_set_id: String,
    active_concepts: Vec<String>,
}

impl SyntheticStudySessionSpec {
    fn from_config(config: &SessionConfig) -> Result<Self, BrainError> {
        let user_id = required(config.user_id.as_deref(), "user_id")?;
        let voice_session_id = required(config.session_id.as_deref(), "session_id")?;
        let study_set_id = required(config.study_set_id.as_deref(), "study_set_id")?;
        Ok(Self {
            client_generation_id: config.client_generation_id.clone(),
            user_id: user_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            active_concepts: config.active_concepts.clone(),
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

    fn concept_id_for_turn<'a>(&'a self, turn: usize, fixture_concept_id: &'a str) -> &'a str {
        if self.active_concepts.is_empty() {
            return fixture_concept_id;
        }
        if self
            .active_concepts
            .iter()
            .any(|concept_id| concept_id == fixture_concept_id)
        {
            return fixture_concept_id;
        }
        self.active_concepts[turn.saturating_sub(1) % self.active_concepts.len()].as_str()
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
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BrainError::Protocol(format!("{label} is required")))?;
    Ok(value)
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

fn spawn_study_answer_sequence(
    event_tx: mpsc::Sender<BrainEvent>,
    spec: SyntheticStudySessionSpec,
    question: StudyQuestion,
    response_id: &str,
    answer_input: SyntheticAnswerInput,
    turn: usize,
    study_store: Option<Arc<dyn StudyMemoryStore>>,
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
                study_store,
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
    study_store: Option<Arc<dyn StudyMemoryStore>>,
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
    let answer_spec = &ANSWER_SPECS[(job.turn - 1) % ANSWER_SPECS.len()];

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
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::SessionPhase {
            phase: StudySessionPhase::Listening,
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
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
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::TranscriptFinal {
            response_id: job.response_id.clone(),
            text: job.answer_input.text.clone(),
            confidence: Some(answer_spec.transcript_confidence),
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    sleep(Duration::from_millis(260)).await;
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::SessionPhase {
            phase: StudySessionPhase::Thinking,
        },
        &job.cancelled,
    )
    .await
    {
        return;
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
    let source = job.question.source.clone();
    let evaluation = AnswerEvaluation {
        question_id: job.question.question_id.clone(),
        answer_text: job.answer_input.text.clone(),
        label: answer_spec.label.to_owned(),
        concise_feedback: answer_spec.feedback.to_owned(),
        retry_prompt: job.question.follow_up.clone(),
        source: source.clone(),
        concept_status: answer_spec.status.clone(),
        confidence_score: answer_spec.eval_confidence,
    };
    if job.cancelled.load(Ordering::SeqCst) {
        return;
    }
    if let Some(store) = &job.study_store {
        if job.answer_input.client_generation_id.is_some() {
            if let Err(error) = store
                .record_answer_attempt_envelope(
                    &job.spec.user_id,
                    &job.spec.study_set_id,
                    &job.spec.voice_session_id,
                    synthetic_answer_attempt_envelope(&job),
                )
                .await
            {
                emit_store_error(event_tx, error.to_string()).await;
                return;
            }
        }
        if let Err(error) = store
            .record_answer_evaluation(
                &job.spec.user_id,
                &job.spec.study_set_id,
                &job.spec.voice_session_id,
                &job.response_id,
                evaluation.clone(),
            )
            .await
        {
            emit_store_error(event_tx, error.to_string()).await;
            return;
        }
    }
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::AnswerEvaluated {
            response_id: job.response_id.clone(),
            evaluation,
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::SourceReference {
            response_id: job.response_id.clone(),
            source: source.clone(),
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::ManuscriptIntent {
            response_id: job.response_id.clone(),
            intent: ManuscriptIntent::Marginalia {
                marginalia_id: "source-folio".to_owned(),
                anchor_entity_id: source.source_id.clone(),
                register: ManuscriptRegister::Sourcing,
                emphasis: ManuscriptEmphasis::Measured,
            },
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    if job.cancelled.load(Ordering::SeqCst) {
        return;
    }
    let concept_id = job
        .spec
        .concept_id_for_turn(job.turn, answer_spec.concept_id);
    if let Some(store) = &job.study_store {
        if let Err(error) = store
            .record_concept_status(
                &job.spec.user_id,
                &job.spec.study_set_id,
                &job.spec.voice_session_id,
                &job.response_id,
                concept_id,
                answer_spec.status.clone(),
            )
            .await
        {
            emit_store_error(event_tx, error.to_string()).await;
            return;
        }
    }
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::ConceptStatus {
            response_id: job.response_id.clone(),
            concept_id: concept_id.to_owned(),
            status: answer_spec.status.clone(),
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::ManuscriptIntent {
            response_id: job.response_id.clone(),
            intent: ManuscriptIntent::Entity {
                entity_id: concept_id.to_owned(),
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
    if job.cancelled.load(Ordering::SeqCst) {
        return;
    }
    if let Some(store) = &job.study_store {
        // Best-effort scheduling — never block the loop on a store rejection.
        let _ = store
            .schedule_review_item(
                &job.spec.user_id,
                &job.spec.study_set_id,
                &job.spec.voice_session_id,
                concept_id,
                storage_due_at_for_status(&answer_spec.status),
            )
            .await;
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
    if !send_unless_cancelled(
        event_tx,
        BrainEvent::SessionPhase {
            phase: StudySessionPhase::Feedback,
        },
        &job.cancelled,
    )
    .await
    {
        return;
    }
    // Terminal state for the attempt: the page dwells in correction. There is no
    // auto-recap — recap is emitted on Stop. The student answers again or ends.
    let _ = send_unless_cancelled(
        event_tx,
        BrainEvent::SessionPhase {
            phase: StudySessionPhase::Correction,
        },
        &job.cancelled,
    )
    .await;
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
    question: &StudyQuestion,
    study_store: Option<&Arc<dyn StudyMemoryStore>>,
) {
    let response_id = spec.response_id(0);
    let recap = study_session_recap(spec, question.source.clone());
    if let Some(store) = study_store {
        if let Err(error) = store
            .record_recap(
                &spec.user_id,
                &spec.study_set_id,
                &spec.voice_session_id,
                &response_id,
                recap.clone(),
            )
            .await
        {
            emit_store_error(event_tx, error.to_string()).await;
            return;
        }
    }
    let _ = event_tx
        .send(BrainEvent::RecapReady { response_id, recap })
        .await;
    let _ = event_tx
        .send(BrainEvent::SessionPhase {
            phase: StudySessionPhase::Recap,
        })
        .await;
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

async fn emit_store_error(event_tx: &mpsc::Sender<BrainEvent>, message: String) {
    let _ = event_tx
        .send(BrainEvent::Error(BrainProviderError {
            source: "synthetic-memory".to_owned(),
            message,
            failure: None,
        }))
        .await;
}

fn storage_due_at_for_status(status: &ConceptStatus) -> &'static str {
    match status {
        ConceptStatus::Missed => "2026-06-18T09:00:00Z",
        ConceptStatus::Shaky => "2026-06-19T09:00:00Z",
        ConceptStatus::Review => "2026-06-20T09:00:00Z",
        ConceptStatus::Strong => "2026-06-24T09:00:00Z",
    }
}

fn study_session_recap(
    spec: &SyntheticStudySessionSpec,
    source: agent_domain::StudySourceReference,
) -> StudySessionRecap {
    StudySessionRecap {
        voice_session_id: spec.voice_session_id.clone(),
        headline: "Oxidative phosphorylation is getting stronger.".to_owned(),
        summary: format!(
            "You named NADH as the electron donor in {study_set}. Next, make the proton-gradient-to-ATP-synthase link explicit.",
            study_set = spec.study_set_id
        ),
        strong_concepts: vec!["NADH".to_owned(), "electron transport chain".to_owned()],
        shaky_concepts: vec!["proton gradient".to_owned()],
        missed_concepts: vec![],
        review_later: vec!["ATP synthase".to_owned()],
        next_action: "Schedule a short review of ATP synthase tomorrow.".to_owned(),
        source_moments: vec![RecapSourceMoment {
            text: "NADH donates high-energy electrons to the electron transport chain.".to_owned(),
            source,
            status: ConceptStatus::Strong,
        }],
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use agent_domain::{RealtimeBrain, SessionId, SourceConfidence, SourceContext, StudyMode};
    use tokio::time::timeout;

    use super::*;

    async fn next_event(session: &mut RealtimeSession) -> BrainEvent {
        timeout(Duration::from_secs(1), session.events.recv())
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

    #[tokio::test]
    async fn emits_deterministic_product_study_flow_and_cancel_id() {
        let brain = SyntheticBrain::default();
        let mut session = brain
            .open(SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .unwrap();

        assert!(matches!(
            next_event(&mut session).await,
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Ready
            }
        ));
        match next_event(&mut session).await {
            BrainEvent::QuestionStarted {
                response_id,
                question,
            } => {
                assert_eq!(response_id, "response-1");
                assert_eq!(question.source.source_id, "src-lecture-5-slide-18");
            }
            other => panic!("expected question_started, got {other:?}"),
        }

        session
            .input
            .send(BrainInput::Text(
                "NADH gives electrons to the electron transport chain.".to_owned(),
            ))
            .await
            .unwrap();

        let mut saw_evaluation = false;
        let mut saw_source = false;
        let mut saw_manuscript_intent = false;
        let mut saw_usage = false;
        loop {
            match next_event(&mut session).await {
                BrainEvent::AnswerEvaluated {
                    response_id,
                    evaluation,
                } => {
                    assert_eq!(response_id, "response-1");
                    assert_eq!(evaluation.source.document_id, "lec-5");
                    saw_evaluation = true;
                }
                BrainEvent::SourceReference {
                    response_id,
                    source,
                } => {
                    assert_eq!(response_id, "response-1");
                    assert_eq!(source.span, "slide:18");
                    saw_source = true;
                }
                BrainEvent::ManuscriptIntent { response_id, .. } => {
                    assert_eq!(response_id, "response-1");
                    saw_manuscript_intent = true;
                }
                BrainEvent::Usage(usage) => {
                    assert_eq!(usage.text_input_tokens, 20);
                    assert_eq!(usage.text_output_tokens, 10);
                    saw_usage = true;
                }
                // The per-answer sequence now ends at Correction; recap is on Stop.
                BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Correction,
                } => break,
                _ => {}
            }
        }
        assert!(saw_evaluation);
        assert!(saw_source);
        assert!(saw_manuscript_intent);
        assert!(saw_usage);
        assert_eq!(
            next_event(&mut session).await,
            BrainEvent::ResponseCompleted {
                response_id: "response-1".to_owned()
            }
        );

        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .unwrap();
        assert_eq!(
            next_event(&mut session).await,
            BrainEvent::ResponseCancelledFor {
                response_id: "response-2".to_owned()
            }
        );

        // Recap is produced when the student ends the session.
        session.input.send(BrainInput::Stop).await.unwrap();
        let mut saw_recap = false;
        for _ in 0..4 {
            if let BrainEvent::RecapReady { recap, .. } = next_event(&mut session).await {
                assert_eq!(recap.voice_session_id, "voice-session-1");
                saw_recap = true;
                break;
            }
        }
        assert!(saw_recap);
    }

    #[tokio::test]
    async fn ignores_browser_source_context_for_trusted_source_output() {
        let brain = SyntheticBrain::default();
        let mut session = brain
            .open(SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                source_context: vec![SourceContext {
                    source_id: "src-lecture-5-slide-18".to_owned(),
                    document_id: "browser-forged-doc".to_owned(),
                    span: "browser:999".to_owned(),
                    excerpt: "Browser forged excerpt".to_owned(),
                    confidence: SourceConfidence::Low,
                    retrieval_reason: "browser supplied injection".to_owned(),
                }],
                ..SessionConfig::default()
            })
            .await
            .unwrap();

        let _ = next_event(&mut session).await;
        match next_event(&mut session).await {
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
    }

    #[tokio::test]
    async fn uses_server_active_concepts_for_authorized_concept_events() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = SyntheticBrain::with_study_store(store.clone());
        let mut session = brain
            .open(SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                active_concepts: vec!["atp-synthase".to_owned()],
                ..SessionConfig::default()
            })
            .await
            .unwrap();

        let _ = next_event(&mut session).await;
        let _ = next_event(&mut session).await;
        session
            .input
            .send(BrainInput::Text(
                "NADH gives electrons to the electron transport chain.".to_owned(),
            ))
            .await
            .unwrap();

        let mut saw_concept_status = false;
        loop {
            match next_event(&mut session).await {
                BrainEvent::ConceptStatus {
                    response_id,
                    concept_id,
                    status,
                } => {
                    assert_eq!(response_id, "response-1");
                    assert_eq!(concept_id, "atp-synthase");
                    assert_eq!(status, ConceptStatus::Shaky);
                    saw_concept_status = true;
                }
                BrainEvent::Error(error) => panic!("store rejected synthetic concept: {error:?}"),
                BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Correction,
                } => break,
                _ => {}
            }
        }
        assert!(saw_concept_status);

        let snapshot = store.snapshot();
        assert_eq!(snapshot.concept_statuses.len(), 1);
        assert_eq!(snapshot.concept_statuses[0].concept_id, "atp-synthase");
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.review_items[0].concept_id, "atp-synthase");
    }

    #[tokio::test]
    async fn persists_client_generation_id_on_synthetic_answer_attempts() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = SyntheticBrain::with_study_store(store.clone());
        let mut config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        config.client_generation_id = Some("bfcache_restore-3".to_owned());
        let mut session = brain.open(config).await.unwrap();

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
                text: "NADH gives electrons to the electron transport chain.".to_owned(),
                client_generation_id: Some("bfcache_restore-3".to_owned()),
            })
            .await
            .unwrap();

        loop {
            match next_event(&mut session).await {
                BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Correction,
                } => break,
                BrainEvent::Error(error) => panic!("store rejected synthetic answer: {error:?}"),
                _ => {}
            }
        }

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
    }

    #[tokio::test]
    async fn dropping_session_aborts_active_synthetic_response_before_store_writes() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = SyntheticBrain::with_study_store(store.clone());
        let mut session = brain
            .open(SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .unwrap();

        let _ = next_event(&mut session).await;
        let _ = next_event(&mut session).await;
        session
            .input
            .send(BrainInput::Text(
                "NADH gives electrons to the electron transport chain.".to_owned(),
            ))
            .await
            .unwrap();
        wait_for_transcript_final(&mut session).await;

        drop(session);
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.answer_attempts.len(), 0);
        assert_eq!(snapshot.concept_statuses.len(), 0);
        assert_eq!(snapshot.review_items.len(), 0);
        assert_eq!(snapshot.recaps.len(), 0);
    }

    /// The WebSocket assembler admits one `BrainInput` per completed browser turn,
    /// so thousands of bounded chunks still produce exactly one evaluated turn.
    #[tokio::test]
    async fn one_assembled_forty_five_second_turn_produces_one_evaluated_turn() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = SyntheticBrain::with_study_store(store.clone());
        let mut session = brain
            .open(SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .unwrap();
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
            .unwrap();

        // Read past the first evaluation to the turn's terminal event, so a
        // second evaluation would be counted rather than hidden by an early
        // break.
        let mut transcripts = Vec::new();
        let mut evaluations = 0_u32;
        let mut completed = false;
        for _ in 0..64 {
            match timeout(Duration::from_secs(5), session.events.recv()).await {
                Ok(Some(BrainEvent::TranscriptFinal { text, .. })) => transcripts.push(text),
                Ok(Some(BrainEvent::AnswerEvaluated { .. })) => evaluations += 1,
                Ok(Some(BrainEvent::ResponseCompleted { .. })) => {
                    completed = true;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => panic!("the assembled turn never reached its terminal event"),
            }
        }
        assert!(completed, "the assembled turn completed exactly once");

        // Close the input side and drain the remainder of the stream: any
        // second provider turn for the same assembled frame surfaces here.
        let RealtimeSession {
            input,
            mut events,
            task_guard: _task_guard,
        } = session;
        drop(input);
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), events.recv()).await {
            match event {
                BrainEvent::TranscriptFinal { text, .. } => transcripts.push(text),
                BrainEvent::AnswerEvaluated { .. } => evaluations += 1,
                _ => {}
            }
        }

        assert_eq!(transcripts, vec!["received 2160000 PCM16 bytes".to_owned()]);
        assert_eq!(evaluations, 1);
        assert_eq!(store.snapshot().answer_attempts.len(), 1);
    }
}
