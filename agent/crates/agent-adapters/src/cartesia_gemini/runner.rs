use std::{
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{sync::mpsc, task::AbortHandle};

use agent_domain::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    AnswerEvaluation, AudioFrame, AuthorizedStudySession, BrainError, BrainEvent, BrainInput,
    BrainUsage, ConceptStatus, ManuscriptEmphasis, ManuscriptEntityKind, ManuscriptIntent,
    ManuscriptRegister, RealtimeSession, RealtimeSessionTaskGuard, SessionConfig, StudyMemoryStore,
    StudyQuestion, StudySessionPhase, StudySessionRecap, StudySourceReference, ToolProposal,
    ToolResult, VivaToolExecutor,
};

use super::llm::{stream_gemini_http, GeminiConversation};
use super::stt::transcribe_ink_websocket;
use super::tts::synthesize_sonic_websocket;
use super::{
    audio_frame_bytes, gemini_request, parse_gemini_sse_line, parse_ink_event, parse_sonic_event,
    select_next_question, send_fake_unless_cancelled, sonic_generation_request,
    CartesiaGeminiConfig, FakeRuntimeInterrupt, FakeRuntimeReport, GeminiStreamEvent, InkEvent,
    SonicEvent, FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT,
};
use super::{emit_fake_provider_error, parse_result_field};

#[derive(Clone)]
pub(crate) struct CartesiaGeminiRunner<T> {
    config: CartesiaGeminiConfig,
    transports: T,
    store: Option<Arc<dyn StudyMemoryStore>>,
}

impl<T> fmt::Debug for CartesiaGeminiRunner<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CartesiaGeminiRunner")
            .field("config", &self.config)
            .field("has_store", &self.store.is_some())
            .finish_non_exhaustive()
    }
}

impl CartesiaGeminiRunner<FakeCartesiaGeminiTransports> {
    pub(crate) fn fake(store: Arc<dyn StudyMemoryStore>, config: CartesiaGeminiConfig) -> Self {
        Self {
            config,
            transports: FakeCartesiaGeminiTransports,
            store: Some(store),
        }
    }
}

impl CartesiaGeminiRunner<LiveCartesiaGeminiTransports> {
    pub(crate) fn live(store: Arc<dyn StudyMemoryStore>, config: CartesiaGeminiConfig) -> Self {
        let transports = LiveCartesiaGeminiTransports::new(config.live_runtime_enabled);
        Self {
            config,
            transports,
            store: Some(store),
        }
    }
}

impl<T> CartesiaGeminiRunner<T>
where
    T: CartesiaGeminiTransports,
{
    pub(crate) fn store(&self) -> Option<Arc<dyn StudyMemoryStore>> {
        self.store.clone()
    }

    pub(crate) async fn open(
        &self,
        session_config: SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let store = self.store.clone().ok_or_else(|| {
            BrainError::Protocol(
                "Cartesia/Gemini runner opened without a study-memory store".to_owned(),
            )
        })?;
        self.transports.authorize_open().await?;
        let session = AuthorizedStudySession::from_config(&session_config)
            .map_err(|error| BrainError::Protocol(error.to_string()))?;
        store
            .record_voice_session(&session_config)
            .await
            .map_err(|error| BrainError::Connection(error.to_string()))?;

        let executor = VivaToolExecutor::new(store, session.clone());
        let question = select_next_question(&executor, &session).await?;
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(32);
        let (event_tx, events) = mpsc::channel::<BrainEvent>(32);
        let runner = self.clone();
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: question.clone(),
                })
                .await;

            let mut turn = 1_usize;
            let mut active_response: Option<ActiveRunnerResponse> = None;
            while let Some(input) = input_rx.recv().await {
                match input {
                    BrainInput::Audio(frame) => {
                        if let Some(response_id) =
                            cancel_active_runner_response(&mut active_response)
                        {
                            let _ = event_tx
                                .send(BrainEvent::ResponseCancelledFor { response_id })
                                .await;
                        }
                        let submission_sequence = turn as u32;
                        let response_id = format!("response-{turn}");
                        turn += 1;
                        active_response = Some(runner.spawn_turn(
                            RunnerTurnJob {
                                event_tx: event_tx.clone(),
                                executor: executor.clone(),
                                session: session.clone(),
                                question: question.clone(),
                                response_id: response_id.clone(),
                                submission_sequence,
                                input: RunnerInput::Audio(frame),
                                confidence: Some(0.91),
                                cancelled: Arc::new(AtomicBool::new(false)),
                                completed: Arc::new(AtomicBool::new(false)),
                            },
                            response_id,
                        ));
                    }
                    BrainInput::Text(text) => {
                        if let Some(response_id) =
                            cancel_active_runner_response(&mut active_response)
                        {
                            let _ = event_tx
                                .send(BrainEvent::ResponseCancelledFor { response_id })
                                .await;
                        }
                        let submission_sequence = turn as u32;
                        let response_id = format!("response-{turn}");
                        turn += 1;
                        active_response = Some(runner.spawn_turn(
                            RunnerTurnJob {
                                event_tx: event_tx.clone(),
                                executor: executor.clone(),
                                session: session.clone(),
                                question: question.clone(),
                                response_id: response_id.clone(),
                                submission_sequence,
                                input: RunnerInput::Text(text),
                                confidence: Some(1.0),
                                cancelled: Arc::new(AtomicBool::new(false)),
                                completed: Arc::new(AtomicBool::new(false)),
                            },
                            response_id,
                        ));
                    }
                    BrainInput::CancelResponse => {
                        let response_id = match active_response
                            .take()
                            .filter(|active| !active.completed.load(Ordering::SeqCst))
                        {
                            Some(active) => {
                                active.cancelled.store(true, Ordering::SeqCst);
                                active.abort_handle.abort();
                                active.response_id.clone()
                            }
                            None => {
                                let response_id = format!("response-{turn}");
                                turn += 1;
                                response_id
                            }
                        };
                        let _ = event_tx
                            .send(BrainEvent::ResponseCancelledFor { response_id })
                            .await;
                    }
                    BrainInput::Stop => {
                        let _ = cancel_active_runner_response(&mut active_response);
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

    pub(crate) async fn replay_audio_turn(
        &self,
        session_config: SessionConfig,
        frame: AudioFrame,
        interrupt: FakeRuntimeInterrupt,
    ) -> Result<FakeRuntimeReport, BrainError> {
        let session = AuthorizedStudySession::from_config(&session_config)
            .map_err(|error| BrainError::Protocol(error.to_string()))?;
        let store = self.store.clone().ok_or_else(|| {
            BrainError::Protocol(
                "fake Cartesia/Gemini runner missing study-memory store".to_owned(),
            )
        })?;
        let executor = VivaToolExecutor::new(store, session.clone());
        let question = select_next_question(&executor, &session).await?;
        let response_id = "fake-cartesia-gemini-response-1".to_owned();
        executor
            .record_answer_attempt_envelope(answer_attempt_envelope(
                &session,
                &question,
                &response_id,
                1,
                &RunnerInput::Audio(frame.clone()),
            ))
            .await
            .map_err(|error| BrainError::Protocol(error.to_string()))?;
        let transcript = self
            .transports
            .transcribe_audio(&self.config, &response_id, &frame)
            .await?;
        let mut events = vec![BrainEvent::InputSpeechStarted];
        if !transcript.interim_text.trim().is_empty()
            && transcript.interim_text != transcript.final_text
        {
            events.push(BrainEvent::TranscriptDelta {
                response_id: response_id.clone(),
                text: transcript.interim_text.clone(),
            });
        }
        events.push(BrainEvent::TranscriptFinal {
            response_id: response_id.clone(),
            text: transcript.final_text.clone(),
            confidence: transcript.confidence,
        });

        let mut usage = BrainUsage::default();
        let prompt = self
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: &transcript.final_text,
                cancelled: None,
                emit_text_delta: true,
                events: &mut events,
                executor: &executor,
                interrupt,
                question: &question,
                response_id: &response_id,
                session: &session,
                usage: &mut usage,
            })
            .await?;
        if interrupt == FakeRuntimeInterrupt::CancelDuringGeminiToolCall {
            events.push(BrainEvent::ResponseCancelledFor {
                response_id: response_id.clone(),
            });
            return Ok(FakeRuntimeReport {
                events,
                stopped_stage: Some("gemini_tool_call_pre_commit"),
            });
        }
        if usage != BrainUsage::default() {
            events.push(BrainEvent::Usage(usage));
        }

        if interrupt == FakeRuntimeInterrupt::BargeInDuringSonicAudio {
            events.push(BrainEvent::ResponseCancelledFor {
                response_id: response_id.clone(),
            });
            return Ok(FakeRuntimeReport {
                events,
                stopped_stage: Some("sonic_audio"),
            });
        }
        let frames = self
            .transports
            .synthesize_sonic(&self.config, &response_id, &prompt, interrupt)
            .await?;
        for frame in frames {
            events.push(BrainEvent::AudioDelta {
                response_id: response_id.clone(),
                frame,
            });
        }

        Ok(FakeRuntimeReport {
            events,
            stopped_stage: None,
        })
    }

    fn spawn_turn(&self, job: RunnerTurnJob, response_id: String) -> ActiveRunnerResponse {
        let cancelled = job.cancelled.clone();
        let completed = job.completed.clone();
        let runner = self.clone();
        let abort_handle = tokio::spawn(async move {
            runner.emit_turn(job).await;
        })
        .abort_handle();
        ActiveRunnerResponse {
            response_id,
            cancelled,
            completed,
            abort_handle,
        }
    }

    async fn emit_turn(&self, job: RunnerTurnJob) {
        if let Err(error) = job
            .executor
            .record_answer_attempt_envelope(answer_attempt_envelope(
                &job.session,
                &job.question,
                &job.response_id,
                job.submission_sequence,
                &job.input,
            ))
            .await
        {
            emit_fake_provider_error(&job.event_tx, error.to_string()).await;
            return;
        }
        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::InputSpeechStarted,
            &job.cancelled,
        )
        .await
        {
            return;
        }
        let transcript = match self
            .transcript_for_input(&job.response_id, &job.input)
            .await
        {
            Ok(transcript) => transcript,
            Err(error) => {
                emit_fake_provider_error(&job.event_tx, error.to_string()).await;
                return;
            }
        };
        if !transcript.interim_text.trim().is_empty()
            && transcript.interim_text != transcript.final_text
            && !send_fake_unless_cancelled(
                &job.event_tx,
                BrainEvent::TranscriptDelta {
                    response_id: job.response_id.clone(),
                    text: transcript.interim_text.clone(),
                },
                &job.cancelled,
            )
            .await
        {
            return;
        }
        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::TranscriptFinal {
                response_id: job.response_id.clone(),
                text: transcript.final_text.clone(),
                confidence: job.confidence.or(transcript.confidence),
            },
            &job.cancelled,
        )
        .await
        {
            return;
        }
        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::InputSpeechStopped,
            &job.cancelled,
        )
        .await
        {
            return;
        }

        let mut usage = BrainUsage::default();
        let mut deferred_events = Vec::new();
        let response_prompt = match self
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: &transcript.final_text,
                cancelled: Some(&job.cancelled),
                emit_text_delta: false,
                events: &mut deferred_events,
                executor: &job.executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &job.question,
                response_id: &job.response_id,
                session: &job.session,
                usage: &mut usage,
            })
            .await
        {
            Ok(response_prompt) => response_prompt,
            Err(error) => {
                emit_fake_provider_error(&job.event_tx, error.to_string()).await;
                return;
            }
        };
        for event in deferred_events {
            if !send_fake_unless_cancelled(&job.event_tx, event, &job.cancelled).await {
                return;
            }
        }

        if let Err(error) = self
            .emit_deterministic_study_tool_events(StudyToolEventJob {
                cancelled: &job.cancelled,
                event_tx: &job.event_tx,
                executor: &job.executor,
                question: &job.question,
                response_id: &job.response_id,
                response_prompt: &response_prompt,
                session: &job.session,
                usage,
            })
            .await
        {
            emit_fake_provider_error(&job.event_tx, error.to_string()).await;
            return;
        }
        job.completed.store(true, Ordering::SeqCst);
    }

    async fn transcript_for_input(
        &self,
        response_id: &str,
        input: &RunnerInput,
    ) -> Result<RunnerTranscript, BrainError> {
        match input {
            RunnerInput::Audio(frame) => {
                self.transports
                    .transcribe_audio(&self.config, response_id, frame)
                    .await
            }
            RunnerInput::Text(text) => Ok(RunnerTranscript {
                interim_text: text.clone(),
                final_text: text.clone(),
                confidence: Some(1.0),
            }),
        }
    }

    async fn run_gemini_tool_loop(&self, job: GeminiToolLoopJob<'_>) -> Result<String, BrainError> {
        let GeminiToolLoopJob {
            answer_text,
            cancelled,
            emit_text_delta,
            events,
            executor,
            interrupt,
            question,
            response_id,
            session,
            usage,
        } = job;
        let mut conversation = GeminiConversation::default();
        conversation.push_user_text(answer_text);
        let mut response_prompt = String::new();

        for _ in 0..4 {
            if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
                return Ok(response_prompt);
            }
            let request = gemini_request(
                &self.config.gemini,
                conversation.snapshot(),
                &self.config.tools,
            );
            let stream = fake_interrupt_gemini_stream(
                self.transports.stream_gemini(&self.config, request).await?,
                interrupt,
            );
            let mut saw_tool_call = false;
            for event in stream {
                match event {
                    GeminiStreamEvent::FunctionCall { id, name, args, .. } => {
                        saw_tool_call = true;
                        if interrupt == FakeRuntimeInterrupt::CancelDuringGeminiToolCall {
                            return Ok(response_prompt);
                        }
                        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
                            return Ok(response_prompt);
                        }
                        if name == "emit_manuscript_intent" {
                            let accepted =
                                if let Some(intent) = parse_gemini_manuscript_intent(&args) {
                                    if self
                                        .authorize_gemini_manuscript_intent(session, &intent)
                                        .await
                                    {
                                        events.push(BrainEvent::ManuscriptIntent {
                                            response_id: response_id.to_owned(),
                                            intent,
                                        });
                                        true
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                };
                            conversation.push_function_response(&ToolResult {
                                proposal: ToolProposal::new(name, args).with_call_id(id),
                                result: json!({ "accepted": accepted }),
                            });
                            continue;
                        }
                        let proposal = if name == "evaluate_spoken_answer" {
                            ToolProposal::evaluate_spoken_answer(
                                &session.study_set_id,
                                &session.voice_session_id,
                                &question.question_id,
                                answer_text,
                            )
                            .with_call_id(id)
                        } else {
                            ToolProposal::new(name, args).with_call_id(id)
                        };
                        let result = executor
                            .execute(response_id, proposal)
                            .await
                            .map_err(|error| BrainError::Protocol(error.to_string()))?;
                        if result.proposal.name() == "evaluate_spoken_answer" {
                            let evaluation = parse_result_field::<AnswerEvaluation>(
                                &result.result,
                                "evaluation",
                            )?;
                            usage.source_grounded_correction_count =
                                usage.source_grounded_correction_count.saturating_add(1);
                            events.push(BrainEvent::AnswerEvaluated {
                                response_id: response_id.to_owned(),
                                evaluation,
                            });
                        }
                        conversation.push_function_response(&result);
                    }
                    GeminiStreamEvent::ModelPart {
                        text: Some(text), ..
                    } => {
                        if emit_text_delta {
                            events.push(BrainEvent::ResponseTranscriptDelta {
                                response_id: response_id.to_owned(),
                                text: text.clone(),
                            });
                        }
                        response_prompt.push_str(&text);
                        conversation.push_model_text(text);
                    }
                    GeminiStreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                    } => usage.add(&BrainUsage {
                        text_input_tokens: input_tokens,
                        text_output_tokens: output_tokens,
                        ..BrainUsage::default()
                    }),
                    GeminiStreamEvent::Error(message) => return Err(BrainError::Protocol(message)),
                    GeminiStreamEvent::ModelPart { text: None, .. } => {}
                }
            }
            if !saw_tool_call {
                break;
            }
        }

        if response_prompt.trim().is_empty() {
            Ok("Good. Now connect the proton gradient to ATP synthase.".to_owned())
        } else {
            Ok(response_prompt)
        }
    }

    async fn authorize_gemini_manuscript_intent(
        &self,
        session: &AuthorizedStudySession,
        intent: &ManuscriptIntent,
    ) -> bool {
        let Some(store) = self.store.as_ref() else {
            return false;
        };
        store
            .authorize_manuscript_intent(
                &session.user_id,
                &session.study_set_id,
                &session.voice_session_id,
                intent,
            )
            .await
            .is_ok()
    }

    async fn emit_deterministic_study_tool_events(
        &self,
        job: StudyToolEventJob<'_>,
    ) -> Result<(), BrainError> {
        let StudyToolEventJob {
            cancelled,
            event_tx,
            executor,
            question,
            response_id,
            response_prompt,
            session,
            usage,
        } = job;
        let source = executor
            .execute(
                response_id,
                ToolProposal::retrieve_source_reference(
                    &session.study_set_id,
                    &session.voice_session_id,
                    &question.source.source_id,
                ),
            )
            .await
            .map_err(|error| BrainError::Protocol(error.to_string()))
            .and_then(|result| {
                parse_result_field::<StudySourceReference>(&result.result, "source")
            })?;
        if !send_fake_unless_cancelled(
            event_tx,
            BrainEvent::SourceReference {
                response_id: response_id.to_owned(),
                source,
            },
            cancelled,
        )
        .await
        {
            return Ok(());
        }

        let status_concept_id = session
            .active_concepts
            .first()
            .cloned()
            .unwrap_or_else(|| "oxidative-phosphorylation".to_owned());
        let review_concept_id = session.active_concepts.get(1).cloned().unwrap_or_else(|| {
            if status_concept_id == "oxidative-phosphorylation" {
                "atp-synthase".to_owned()
            } else {
                status_concept_id.clone()
            }
        });

        let status_result = executor
            .execute(
                response_id,
                ToolProposal::mark_concept_status(
                    &session.study_set_id,
                    &session.voice_session_id,
                    &status_concept_id,
                    "strong",
                ),
            )
            .await
            .map_err(|error| BrainError::Protocol(error.to_string()))?;
        let concept_id = parse_result_field::<String>(&status_result.result, "concept_id")?;
        let status = parse_result_field::<ConceptStatus>(&status_result.result, "status")?;
        if !send_fake_unless_cancelled(
            event_tx,
            BrainEvent::ConceptStatus {
                response_id: response_id.to_owned(),
                concept_id,
                status: status.clone(),
            },
            cancelled,
        )
        .await
        {
            return Ok(());
        }

        executor
            .execute(
                response_id,
                ToolProposal::schedule_review_item(
                    &session.study_set_id,
                    &session.voice_session_id,
                    &review_concept_id,
                    concept_status_tool_arg(&status),
                ),
            )
            .await
            .map_err(|error| BrainError::Protocol(error.to_string()))?;

        if usage != BrainUsage::default()
            && !send_fake_unless_cancelled(event_tx, BrainEvent::Usage(usage), cancelled).await
        {
            return Ok(());
        }

        let frames = self
            .transports
            .synthesize_sonic(
                &self.config,
                response_id,
                response_prompt,
                FakeRuntimeInterrupt::None,
            )
            .await?;
        for frame in frames {
            if !send_fake_unless_cancelled(
                event_tx,
                BrainEvent::AudioDelta {
                    response_id: response_id.to_owned(),
                    frame,
                },
                cancelled,
            )
            .await
            {
                return Ok(());
            }
        }

        for phase in [StudySessionPhase::Feedback, StudySessionPhase::Correction] {
            if !send_fake_unless_cancelled(event_tx, BrainEvent::SessionPhase { phase }, cancelled)
                .await
            {
                return Ok(());
            }
        }

        let recap = executor
            .execute(
                response_id,
                ToolProposal::build_session_recap(&session.study_set_id, &session.voice_session_id),
            )
            .await
            .map_err(|error| BrainError::Protocol(error.to_string()))
            .and_then(|result| parse_result_field::<StudySessionRecap>(&result.result, "recap"))?;
        if !send_fake_unless_cancelled(
            event_tx,
            BrainEvent::RecapReady {
                response_id: response_id.to_owned(),
                recap,
            },
            cancelled,
        )
        .await
        {
            return Ok(());
        }
        let _ = send_fake_unless_cancelled(
            event_tx,
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Recap,
            },
            cancelled,
        )
        .await;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(crate) enum RunnerInput {
    Audio(AudioFrame),
    Text(String),
}

pub(crate) struct RunnerTurnJob {
    pub(crate) event_tx: mpsc::Sender<BrainEvent>,
    pub(crate) executor: VivaToolExecutor,
    pub(crate) session: AuthorizedStudySession,
    pub(crate) question: StudyQuestion,
    pub(crate) response_id: String,
    pub(crate) submission_sequence: u32,
    pub(crate) input: RunnerInput,
    pub(crate) confidence: Option<f32>,
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) completed: Arc<AtomicBool>,
}

pub(crate) fn answer_attempt_envelope(
    session: &AuthorizedStudySession,
    question: &StudyQuestion,
    response_id: &str,
    submission_sequence: u32,
    input: &RunnerInput,
) -> AnswerAttemptEnvelope {
    let (capture_mode, byte_count, char_count, pre_provider_state) = match input {
        RunnerInput::Audio(frame) => (
            AnswerCaptureMode::Audio,
            Some(audio_frame_bytes(frame).len() as u64),
            None,
            "before_ink_stt",
        ),
        RunnerInput::Text(text) => (
            AnswerCaptureMode::Typed,
            Some(text.len() as u64),
            Some(text.chars().count() as u64),
            "before_text_evaluation",
        ),
    };
    AnswerAttemptEnvelope {
        response_id: response_id.to_owned(),
        question_id: question.question_id.clone(),
        submission_sequence,
        idempotency_key: format!(
            "{}:{}:{submission_sequence}:{response_id}",
            session.voice_session_id, question.question_id
        ),
        capture_mode,
        byte_count,
        char_count,
        duration_ms: None,
        client_generation_id: None,
        locale: None,
        capture_status: AnswerCaptureStatus::Accepted,
        content_policy: AnswerContentPolicy::None,
        answer_digest_hmac: None,
        transcript_status: None,
        transcript_confidence_bucket: None,
        pre_provider_state: pre_provider_state.to_owned(),
    }
}

struct GeminiToolLoopJob<'a> {
    executor: &'a VivaToolExecutor,
    session: &'a AuthorizedStudySession,
    question: &'a StudyQuestion,
    response_id: &'a str,
    answer_text: &'a str,
    interrupt: FakeRuntimeInterrupt,
    events: &'a mut Vec<BrainEvent>,
    usage: &'a mut BrainUsage,
    emit_text_delta: bool,
    cancelled: Option<&'a AtomicBool>,
}

fn fake_interrupt_gemini_stream(
    stream: Vec<GeminiStreamEvent>,
    interrupt: FakeRuntimeInterrupt,
) -> Vec<GeminiStreamEvent> {
    match interrupt {
        FakeRuntimeInterrupt::NoGeminiManuscriptIntent => stream
            .into_iter()
            .filter(|event| {
                !matches!(
                    event,
                    GeminiStreamEvent::FunctionCall { name, .. }
                        if name == "emit_manuscript_intent"
                )
            })
            .collect(),
        FakeRuntimeInterrupt::MalformedGeminiManuscriptIntent => stream
            .into_iter()
            .map(|event| match event {
                GeminiStreamEvent::FunctionCall { id, name, .. }
                    if name == "emit_manuscript_intent" =>
                {
                    let args = json!({
                        "type": "entity_intent",
                        "entity_id": "<script>raw-markup</script>",
                        "entity_kind": "concept",
                        "register": "correcting",
                        "emphasis": "marked",
                    });
                    GeminiStreamEvent::FunctionCall {
                        id,
                        name,
                        args: args.clone(),
                        part: json!({
                            "functionCall": {
                                "id": "call-manuscript-invalid",
                                "name": "emit_manuscript_intent",
                                "args": args,
                            }
                        }),
                    }
                }
                event => event,
            })
            .collect(),
        FakeRuntimeInterrupt::UnauthorizedGeminiManuscriptIntent => stream
            .into_iter()
            .map(|event| match event {
                GeminiStreamEvent::FunctionCall { id, name, .. }
                    if name == "emit_manuscript_intent" =>
                {
                    let args = json!({
                        "type": "entity_intent",
                        "entity_id": "unknown-concept",
                        "entity_kind": "concept",
                        "register": "correcting",
                        "emphasis": "marked",
                    });
                    GeminiStreamEvent::FunctionCall {
                        id,
                        name,
                        args: args.clone(),
                        part: json!({
                            "functionCall": {
                                "id": "call-manuscript-unauthorized",
                                "name": "emit_manuscript_intent",
                                "args": args,
                            }
                        }),
                    }
                }
                event => event,
            })
            .collect(),
        _ => stream,
    }
}

struct StudyToolEventJob<'a> {
    event_tx: &'a mpsc::Sender<BrainEvent>,
    executor: &'a VivaToolExecutor,
    session: &'a AuthorizedStudySession,
    question: &'a StudyQuestion,
    response_id: &'a str,
    cancelled: &'a AtomicBool,
    usage: BrainUsage,
    response_prompt: &'a str,
}

struct ActiveRunnerResponse {
    response_id: String,
    cancelled: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
    abort_handle: AbortHandle,
}

impl Drop for ActiveRunnerResponse {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            self.cancelled.store(true, Ordering::SeqCst);
            self.abort_handle.abort();
        }
    }
}

fn cancel_active_runner_response(
    active_response: &mut Option<ActiveRunnerResponse>,
) -> Option<String> {
    if let Some(active) = active_response.take() {
        if !active.completed.load(Ordering::SeqCst) {
            active.cancelled.store(true, Ordering::SeqCst);
            active.abort_handle.abort();
            return Some(active.response_id.clone());
        }
    }
    None
}

pub(crate) struct RunnerTranscript {
    interim_text: String,
    final_text: String,
    confidence: Option<f32>,
}

#[async_trait]
pub(crate) trait CartesiaGeminiTransports: Clone + Send + Sync + 'static {
    async fn authorize_open(&self) -> Result<(), BrainError> {
        Ok(())
    }

    async fn transcribe_audio(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        frame: &AudioFrame,
    ) -> Result<RunnerTranscript, BrainError>;

    async fn stream_gemini(
        &self,
        config: &CartesiaGeminiConfig,
        request: Value,
    ) -> Result<Vec<GeminiStreamEvent>, BrainError>;

    async fn synthesize_sonic(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        transcript: &str,
        interrupt: FakeRuntimeInterrupt,
    ) -> Result<Vec<AudioFrame>, BrainError>;
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct FakeCartesiaGeminiTransports;

#[async_trait]
impl CartesiaGeminiTransports for FakeCartesiaGeminiTransports {
    async fn transcribe_audio(
        &self,
        _config: &CartesiaGeminiConfig,
        _response_id: &str,
        frame: &AudioFrame,
    ) -> Result<RunnerTranscript, BrainError> {
        let pcm_len = audio_frame_bytes(frame).len();
        let Some(InkEvent::TurnEnd { text }) = parse_ink_event(
            r#"{"type":"transcript","is_final":true,"text":"NADH donates electrons to the electron transport chain."}"#,
        ) else {
            return Err(BrainError::Protocol(
                "fake Ink transcript did not parse".to_owned(),
            ));
        };
        Ok(RunnerTranscript {
            interim_text: format!("received {pcm_len} PCM16 bytes"),
            final_text: text,
            confidence: Some(0.91),
        })
    }

    async fn stream_gemini(
        &self,
        _config: &CartesiaGeminiConfig,
        request: Value,
    ) -> Result<Vec<GeminiStreamEvent>, BrainError> {
        if request.get("tools").is_none() {
            return Err(BrainError::Protocol(
                "fake Gemini request omitted Viva tools".to_owned(),
            ));
        }
        let has_function_response =
            request["contents"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|content| {
                    content["parts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|part| part.get("functionResponse").is_some())
                });
        if has_function_response {
            Ok(parse_gemini_sse_line(
                r#"data: {"candidates":[{"content":{"parts":[{"text":"Good. Now connect the proton gradient to ATP synthase."}]}}],"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":2}}"#,
            ))
        } else {
            let answer_text = first_user_text(&request)
                .unwrap_or_else(|| FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT.to_owned());
            let args = json!({
                "study_set_id": "biology-midterm",
                "voice_session_id": "voice-session-1",
                "question_id": "q-oxidative-phosphorylation-nadh",
                "answer_text": answer_text,
            });
            let manuscript_args = json!({
                "type": "entity_intent",
                "entity_id": "nadh",
                "entity_kind": "concept",
                "register": "correcting",
                "emphasis": "marked",
            });
            Ok(vec![
                GeminiStreamEvent::FunctionCall {
                    id: "call-eval-1".to_owned(),
                    name: "evaluate_spoken_answer".to_owned(),
                    args: args.clone(),
                    part: json!({
                        "functionCall": {
                            "id": "call-eval-1",
                            "name": "evaluate_spoken_answer",
                            "args": args,
                        }
                    }),
                },
                GeminiStreamEvent::FunctionCall {
                    id: "call-manuscript-1".to_owned(),
                    name: "emit_manuscript_intent".to_owned(),
                    args: manuscript_args.clone(),
                    part: json!({
                        "functionCall": {
                            "id": "call-manuscript-1",
                            "name": "emit_manuscript_intent",
                            "args": manuscript_args,
                        }
                    }),
                },
                GeminiStreamEvent::Usage {
                    input_tokens: 20,
                    output_tokens: 8,
                },
            ])
        }
    }

    async fn synthesize_sonic(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        transcript: &str,
        interrupt: FakeRuntimeInterrupt,
    ) -> Result<Vec<AudioFrame>, BrainError> {
        let _request = sonic_generation_request(&config.sonic, response_id, transcript, false);
        if interrupt == FakeRuntimeInterrupt::WriterFailureBeforeSonicAudio {
            return Err(BrainError::Connection(
                "fake browser writer failed before Sonic audio".to_owned(),
            ));
        }
        let sonic = json!({
            "type": "chunk",
            "context_id": response_id,
            "data": "AQIDBA==",
        });
        let Some(SonicEvent::Audio { pcm16_base64, .. }) = parse_sonic_event(&sonic.to_string())
        else {
            return Err(BrainError::Protocol(
                "fake Sonic audio did not parse".to_owned(),
            ));
        };
        AudioFrame::from_base64(pcm16_base64)
            .map(|frame| vec![frame])
            .map_err(BrainError::Protocol)
    }
}

fn first_user_text(request: &Value) -> Option<String> {
    request["contents"]
        .as_array()?
        .iter()
        .find(|content| content.get("role").and_then(Value::as_str) == Some("user"))?
        .get("parts")?
        .as_array()?
        .iter()
        .find_map(|part| part.get("text").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn concept_status_tool_arg(status: &ConceptStatus) -> &'static str {
    match status {
        ConceptStatus::Strong => "strong",
        ConceptStatus::Shaky => "shaky",
        ConceptStatus::Missed => "missed",
        ConceptStatus::Review => "review",
    }
}

fn parse_gemini_manuscript_intent(args: &Value) -> Option<ManuscriptIntent> {
    let intent = args.as_object()?;
    let intent_type = intent.get("type")?.as_str()?;
    let register = parse_manuscript_register(intent.get("register")?)?;
    let emphasis = parse_manuscript_emphasis(intent.get("emphasis")?)?;
    match intent_type {
        "scene_intent" => {
            require_only_manuscript_keys(intent, &["type", "register", "emphasis"])?;
            Some(ManuscriptIntent::Scene { register, emphasis })
        }
        "entity_intent" => {
            require_only_manuscript_keys(
                intent,
                &["type", "entity_id", "entity_kind", "register", "emphasis"],
            )?;
            Some(ManuscriptIntent::Entity {
                entity_id: parse_manuscript_id(intent.get("entity_id")?)?,
                entity_kind: parse_manuscript_entity_kind(intent.get("entity_kind")?)?,
                register,
                emphasis,
            })
        }
        "marginalia_intent" => {
            require_only_manuscript_keys(
                intent,
                &[
                    "type",
                    "marginalia_id",
                    "anchor_entity_id",
                    "register",
                    "emphasis",
                ],
            )?;
            Some(ManuscriptIntent::Marginalia {
                marginalia_id: parse_manuscript_id(intent.get("marginalia_id")?)?,
                anchor_entity_id: parse_manuscript_id(intent.get("anchor_entity_id")?)?,
                register,
                emphasis,
            })
        }
        _ => None,
    }
}

fn require_only_manuscript_keys(
    intent: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Option<()> {
    intent
        .keys()
        .all(|key| allowed.iter().any(|allowed| key == allowed))
        .then_some(())
}

fn parse_manuscript_register(value: &Value) -> Option<ManuscriptRegister> {
    match value.as_str()? {
        "examining" => Some(ManuscriptRegister::Examining),
        "reflecting" => Some(ManuscriptRegister::Reflecting),
        "correcting" => Some(ManuscriptRegister::Correcting),
        "sourcing" => Some(ManuscriptRegister::Sourcing),
        "recapping" => Some(ManuscriptRegister::Recapping),
        _ => None,
    }
}

fn parse_manuscript_emphasis(value: &Value) -> Option<ManuscriptEmphasis> {
    match value.as_str()? {
        "quiet" => Some(ManuscriptEmphasis::Quiet),
        "measured" => Some(ManuscriptEmphasis::Measured),
        "marked" => Some(ManuscriptEmphasis::Marked),
        _ => None,
    }
}

fn parse_manuscript_entity_kind(value: &Value) -> Option<ManuscriptEntityKind> {
    match value.as_str()? {
        "concept" => Some(ManuscriptEntityKind::Concept),
        "source" => Some(ManuscriptEntityKind::Source),
        _ => None,
    }
}

fn parse_manuscript_id(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    is_valid_manuscript_id(text).then(|| text.to_owned())
}

fn is_valid_manuscript_id(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    text.len() <= 96
        && first.is_ascii_alphanumeric()
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct LiveCartesiaGeminiTransports {
    live_runtime_enabled: bool,
}

impl LiveCartesiaGeminiTransports {
    pub(crate) fn new(live_runtime_enabled: bool) -> Self {
        Self {
            live_runtime_enabled,
        }
    }
}

#[async_trait]
impl CartesiaGeminiTransports for LiveCartesiaGeminiTransports {
    async fn authorize_open(&self) -> Result<(), BrainError> {
        if self.live_runtime_enabled {
            return Ok(());
        }
        Err(BrainError::Protocol(
            "shared Cartesia/Gemini runner is wired but live transports remain gated; no network connection was attempted"
                .to_owned(),
        ))
    }

    async fn transcribe_audio(
        &self,
        config: &CartesiaGeminiConfig,
        _response_id: &str,
        frame: &AudioFrame,
    ) -> Result<RunnerTranscript, BrainError> {
        let transcript =
            transcribe_ink_websocket(&config.ink, &config.cartesia_api_key, frame).await?;
        Ok(RunnerTranscript {
            interim_text: transcript.interim_text,
            final_text: transcript.final_text,
            confidence: transcript.confidence,
        })
    }

    async fn stream_gemini(
        &self,
        config: &CartesiaGeminiConfig,
        request: Value,
    ) -> Result<Vec<GeminiStreamEvent>, BrainError> {
        stream_gemini_http(&config.gemini, request).await
    }

    async fn synthesize_sonic(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        transcript: &str,
        _interrupt: FakeRuntimeInterrupt,
    ) -> Result<Vec<AudioFrame>, BrainError> {
        synthesize_sonic_websocket(
            &config.sonic,
            &config.cartesia_api_key,
            response_id,
            transcript,
        )
        .await
    }
}
