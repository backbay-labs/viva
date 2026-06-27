use std::{
    fmt,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{sync::mpsc, task::AbortHandle};

use agent_domain::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    AnswerEvaluation, AudioFrame, AuthorizedStudySession, BrainError, BrainEvent, BrainInput,
    BrainProviderFailure, BrainProviderFailureParts, BrainUsage, ConceptStatus, ManuscriptEmphasis,
    ManuscriptEntityKind, ManuscriptIntent, ManuscriptRegister, PortError, RealtimeSession,
    RealtimeSessionTaskGuard, SessionConfig, StudyMemoryStore, StudyQuestion, StudySessionPhase,
    StudySessionRecap, StudySourceReference, TerminalSessionReason, ToolExecutionError,
    ToolProposal, ToolResult, VivaToolExecutor,
};
use tokio::time::timeout;

use super::llm::{
    stream_gemini_http_with_attempt_events, GeminiConversation, GeminiStreamAttemptFailure,
};
use super::stt::transcribe_ink_websocket;
use super::tts::synthesize_sonic_websocket;
use super::{
    audio_frame_bytes, gemini_request, parse_gemini_sse_line, parse_ink_event, parse_sonic_event,
    select_next_question, send_fake_unless_cancelled, sonic_generation_request,
    CartesiaGeminiConfig, FakeRuntimeInterrupt, FakeRuntimeReport, GeminiConfig, GeminiStreamEvent,
    InkEvent, SonicEvent, FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT, MAX_GEMINI_EXECUTED_TOOL_STAGES,
    MAX_GEMINI_TOOL_LOOP_PASSES,
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
        let session_generation_id = session_config.client_generation_id.clone();
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
            let first_response_id = response_id_for_turn(1, session_generation_id.as_deref());
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
            let mut active_response: Option<ActiveRunnerResponse> = None;
            while let Some(input) = input_rx.recv().await {
                let runner_turn = match input {
                    BrainInput::Audio(frame) => Some((
                        RunnerInput::Audio {
                            frame,
                            client_generation_id: None,
                        },
                        Some(0.91_f32),
                    )),
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => Some((
                        RunnerInput::Audio {
                            frame,
                            client_generation_id,
                        },
                        Some(0.91_f32),
                    )),
                    BrainInput::Text(text) => Some((
                        RunnerInput::Text {
                            text,
                            client_generation_id: None,
                        },
                        Some(1.0_f32),
                    )),
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => Some((
                        RunnerInput::Text {
                            text,
                            client_generation_id,
                        },
                        Some(1.0_f32),
                    )),
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
                                let response_id =
                                    response_id_for_turn(turn, session_generation_id.as_deref());
                                turn += 1;
                                response_id
                            }
                        };
                        let _ = event_tx
                            .send(BrainEvent::ResponseCancelledFor { response_id })
                            .await;
                        continue;
                    }
                    BrainInput::Stop => {
                        let _ = cancel_active_runner_response(&mut active_response);
                        break;
                    }
                    BrainInput::ToolResult(_)
                    | BrainInput::SessionContextRefresh(_)
                    | BrainInput::ProactiveTurn { .. } => continue,
                    _ => continue,
                };
                let Some((runner_input, confidence)) = runner_turn else {
                    continue;
                };

                if let Some(response_id) = cancel_active_runner_response(&mut active_response) {
                    let _ = event_tx
                        .send(BrainEvent::ResponseCancelledFor { response_id })
                        .await;
                }
                let submission_sequence = turn as u32;
                let response_id = response_id_for_turn(
                    turn,
                    runner_input
                        .client_generation_id()
                        .or(session_generation_id.as_deref()),
                );
                turn += 1;
                active_response = Some(runner.spawn_turn(
                    RunnerTurnJob {
                        event_tx: event_tx.clone(),
                        executor: executor.clone(),
                        session: session.clone(),
                        question: question.clone(),
                        response_id: response_id.clone(),
                        submission_sequence,
                        input: runner_input,
                        confidence,
                        cancelled: Arc::new(AtomicBool::new(false)),
                        completed: Arc::new(AtomicBool::new(false)),
                    },
                    response_id,
                ));
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
                &RunnerInput::Audio {
                    frame: frame.clone(),
                    client_generation_id: None,
                },
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
        events.push(BrainEvent::SessionPhase {
            phase: StudySessionPhase::Feedback,
        });
        events.push(BrainEvent::SessionPhase {
            phase: StudySessionPhase::Correction,
        });
        events.push(BrainEvent::ResponseCompleted {
            response_id: response_id.clone(),
        });

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
            emit_fake_provider_error(&job.event_tx, BrainError::Protocol(error.to_string())).await;
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
                emit_fake_provider_error(&job.event_tx, error).await;
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
                for event in deferred_events {
                    if !matches!(event, BrainEvent::ProviderFallbackActivated { .. }) {
                        continue;
                    }
                    if !send_fake_unless_cancelled(&job.event_tx, event, &job.cancelled).await {
                        return;
                    }
                }
                emit_fake_provider_error(&job.event_tx, error).await;
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
                completed: &job.completed,
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
            emit_fake_provider_error(&job.event_tx, error).await;
        }
    }

    async fn transcript_for_input(
        &self,
        response_id: &str,
        input: &RunnerInput,
    ) -> Result<RunnerTranscript, BrainError> {
        match input {
            RunnerInput::Audio { frame, .. } => {
                self.transports
                    .transcribe_audio(&self.config, response_id, frame)
                    .await
            }
            RunnerInput::Text { text, .. } => Ok(RunnerTranscript {
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
        let mut executed_gemini_tool_stages = 0_u32;
        let mut active_gemini = self.config.gemini.clone();

        for pass_index in 0..MAX_GEMINI_TOOL_LOOP_PASSES {
            if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
                return Ok(response_prompt);
            }
            let mut active_config = self.config.clone();
            active_config.gemini = active_gemini.clone();
            let tools = if pass_index + 1 >= MAX_GEMINI_TOOL_LOOP_PASSES {
                &[] as &[Value]
            } else {
                &active_config.tools
            };
            let request = gemini_request(&active_config.gemini, conversation.snapshot(), tools);
            let gemini_started = Instant::now();
            let stream = match self.transports.stream_gemini(&active_config, request).await {
                Ok(stream) => stream,
                Err(failure) => {
                    for event in failure.events {
                        if let GeminiStreamEvent::FallbackActivated {
                            from_model,
                            to_model,
                            reason,
                            failure,
                        } = event
                        {
                            promote_active_gemini_fallback(&mut active_gemini, &to_model);
                            events.push(BrainEvent::ProviderFallbackActivated {
                                response_id: response_id.to_owned(),
                                provider: "gemini".to_owned(),
                                from_model,
                                to_model,
                                reason,
                                failure,
                            });
                        }
                    }
                    return Err(failure.error);
                }
            };
            let stream = fake_interrupt_gemini_stream(stream, interrupt);
            {
                let tool_call_names = gemini_function_call_names(&stream);
                if !tool_call_names.is_empty() {
                    if interrupt == FakeRuntimeInterrupt::CancelDuringGeminiToolCall {
                        return Ok(response_prompt);
                    }
                    if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
                        return Ok(response_prompt);
                    }
                    if pass_index + 1 >= MAX_GEMINI_TOOL_LOOP_PASSES {
                        return Err(gemini_tool_loop_budget_error(
                            tool_call_names[0],
                            &active_gemini.model_id,
                            gemini_started.elapsed(),
                        ));
                    }
                    reserve_gemini_tool_batch(
                        &mut executed_gemini_tool_stages,
                        &tool_call_names,
                        &active_gemini.model_id,
                        gemini_started.elapsed(),
                    )?;
                }
            }
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
                        if pass_index + 1 >= MAX_GEMINI_TOOL_LOOP_PASSES {
                            return Err(gemini_tool_loop_budget_error(
                                &name,
                                &self.config.gemini.model_id,
                                gemini_started.elapsed(),
                            ));
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
                        if proposal.name() == "emit_manuscript_intent" {
                            let accepted = if let Some(intent) =
                                parse_gemini_manuscript_intent(proposal.arguments())
                            {
                                if manuscript_intent_authorization_stage(
                                    self.authorize_gemini_manuscript_intent(session, &intent),
                                    self.config.tool_stage_timeout,
                                )
                                .await?
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
                                proposal,
                                result: json!({ "accepted": accepted }),
                            });
                            continue;
                        }
                        let result = execute_tool_stage(
                            executor,
                            response_id,
                            proposal,
                            self.config.tool_stage_timeout,
                            "tools",
                            "tool_executor_failure",
                            Some(&active_gemini.model_id),
                        )
                        .await?;
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
                    GeminiStreamEvent::FallbackActivated {
                        from_model,
                        to_model,
                        reason,
                        failure,
                    } => {
                        promote_active_gemini_fallback(&mut active_gemini, &to_model);
                        events.push(BrainEvent::ProviderFallbackActivated {
                            response_id: response_id.to_owned(),
                            provider: "gemini".to_owned(),
                            from_model,
                            to_model,
                            reason,
                            failure,
                        });
                    }
                    GeminiStreamEvent::Error(message) => {
                        return Err(provider_stage_error_from_brain_error(
                            BrainError::Protocol(message),
                            "gemini",
                            "gemini",
                            &active_gemini.model_id,
                            gemini_started.elapsed(),
                        ))
                    }
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
            completed,
            event_tx,
            executor,
            question,
            response_id,
            response_prompt,
            session,
            usage,
        } = job;
        let source = execute_tool_stage(
            executor,
            response_id,
            ToolProposal::retrieve_source_reference(
                &session.study_set_id,
                &session.voice_session_id,
                &question.source.source_id,
            ),
            self.config.tool_stage_timeout,
            "tools",
            "tool_executor_failure",
            None,
        )
        .await
        .and_then(|result| parse_result_field::<StudySourceReference>(&result.result, "source"))?;
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

        let status_result = execute_tool_stage(
            executor,
            response_id,
            ToolProposal::mark_concept_status(
                &session.study_set_id,
                &session.voice_session_id,
                &status_concept_id,
                "strong",
            ),
            self.config.tool_stage_timeout,
            "tools",
            "tool_executor_failure",
            None,
        )
        .await?;
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

        execute_tool_stage(
            executor,
            response_id,
            ToolProposal::schedule_review_item(
                &session.study_set_id,
                &session.voice_session_id,
                &review_concept_id,
                concept_status_tool_arg(&status),
            ),
            self.config.tool_stage_timeout,
            "tools",
            "tool_executor_failure",
            None,
        )
        .await?;

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
        completed.store(true, Ordering::SeqCst);
        if !send_fake_unless_cancelled(
            event_tx,
            BrainEvent::ResponseCompleted {
                response_id: response_id.to_owned(),
            },
            cancelled,
        )
        .await
        {
            return Ok(());
        }

        let recap = execute_tool_stage(
            executor,
            response_id,
            ToolProposal::build_session_recap(&session.study_set_id, &session.voice_session_id),
            self.config.recap_stage_timeout,
            "recap",
            "tool_executor_failure",
            None,
        )
        .await
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
    Audio {
        frame: AudioFrame,
        client_generation_id: Option<String>,
    },
    Text {
        text: String,
        client_generation_id: Option<String>,
    },
}

impl RunnerInput {
    fn client_generation_id(&self) -> Option<&str> {
        match self {
            Self::Audio {
                client_generation_id,
                ..
            }
            | Self::Text {
                client_generation_id,
                ..
            } => client_generation_id.as_deref(),
        }
    }
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
        RunnerInput::Audio { frame, .. } => (
            AnswerCaptureMode::Audio,
            Some(audio_frame_bytes(frame).len() as u64),
            None,
            "before_ink_stt",
        ),
        RunnerInput::Text { text, .. } => (
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
        client_generation_id: input.client_generation_id().map(ToOwned::to_owned),
        locale: None,
        capture_status: AnswerCaptureStatus::Accepted,
        content_policy: AnswerContentPolicy::None,
        answer_digest_hmac: None,
        transcript_status: None,
        transcript_confidence_bucket: None,
        pre_provider_state: pre_provider_state.to_owned(),
    }
}

fn response_id_for_turn(turn: usize, client_generation_id: Option<&str>) -> String {
    let base = format!("response-{turn}");
    let Some(generation_id) = client_generation_id else {
        return base;
    };
    let generation_id = sanitized_response_generation_id(generation_id);
    if generation_id.is_empty() {
        base
    } else {
        format!("{base}-generation-{generation_id}")
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

async fn execute_tool_stage(
    executor: &VivaToolExecutor,
    response_id: &str,
    proposal: ToolProposal,
    deadline: Duration,
    stage: &'static str,
    failure_class: &'static str,
    gemini_model: Option<&str>,
) -> Result<ToolResult, BrainError> {
    let tool_name = proposal.name().to_owned();
    let started = Instant::now();
    match timeout(deadline, executor.execute(response_id, proposal)).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(tool_execution_stage_error(
            &tool_name,
            failure_class,
            stage,
            started.elapsed(),
            &error,
            gemini_model,
        )),
        Err(_) => Err(tool_stage_error(
            &tool_name,
            "timeout",
            stage,
            TerminalSessionReason::ProviderTimeout,
            true,
            deadline,
            "deadline_elapsed",
        )),
    }
}

fn reserve_gemini_tool_stage(
    executed_gemini_tool_stages: &mut u32,
    tool_name: &str,
    model: &str,
    latency: Duration,
) -> Result<(), BrainError> {
    if *executed_gemini_tool_stages >= MAX_GEMINI_EXECUTED_TOOL_STAGES {
        return Err(gemini_tool_loop_budget_error(tool_name, model, latency));
    }
    *executed_gemini_tool_stages = executed_gemini_tool_stages.saturating_add(1);
    Ok(())
}

fn reserve_gemini_tool_batch(
    executed_gemini_tool_stages: &mut u32,
    tool_names: &[&str],
    model: &str,
    latency: Duration,
) -> Result<(), BrainError> {
    let mut staged = *executed_gemini_tool_stages;
    for tool_name in tool_names {
        reserve_gemini_tool_stage(&mut staged, tool_name, model, latency)?;
    }
    *executed_gemini_tool_stages = staged;
    Ok(())
}

fn gemini_function_call_names(stream: &[GeminiStreamEvent]) -> Vec<&str> {
    stream
        .iter()
        .filter_map(|event| match event {
            GeminiStreamEvent::FunctionCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect()
}

async fn manuscript_intent_authorization_stage<F>(
    authorization: F,
    deadline: Duration,
) -> Result<bool, BrainError>
where
    F: Future<Output = bool>,
{
    match timeout(deadline, authorization).await {
        Ok(accepted) => Ok(accepted),
        Err(_) => Err(tool_stage_error(
            "emit_manuscript_intent",
            "timeout",
            "tools",
            TerminalSessionReason::ProviderTimeout,
            true,
            deadline,
            "deadline_elapsed",
        )),
    }
}

fn tool_stage_error(
    tool_name: &str,
    failure_class: &'static str,
    stage: &'static str,
    terminal_reason: TerminalSessionReason,
    retry_eligible: bool,
    latency: Duration,
    error_kind: &'static str,
) -> BrainError {
    BrainError::StageFailure(Box::new(BrainProviderFailure::new(
        BrainProviderFailureParts {
            failure_class: failure_class.to_owned(),
            stage: stage.to_owned(),
            terminal_reason,
            retry_eligible,
            latency_ms: duration_ms(latency),
            provider: "server".to_owned(),
            model: "viva-tools".to_owned(),
            metadata: tool_stage_metadata(tool_name, error_kind),
        },
    )))
}

fn tool_execution_stage_error(
    tool_name: &str,
    failure_class: &'static str,
    stage: &'static str,
    latency: Duration,
    error: &ToolExecutionError,
    gemini_model: Option<&str>,
) -> BrainError {
    if let ToolExecutionError::Store(port_error) = error {
        if port_error_is_durability_degraded(port_error) {
            return tool_stage_error(
                tool_name,
                "durability_degraded",
                "store",
                TerminalSessionReason::DurabilityDegraded,
                true,
                latency,
                "durability_degraded",
            );
        }
    }
    if let (Some(model), true) = (gemini_model, gemini_controlled_tool_error(error)) {
        return gemini_tool_stage_error(
            tool_name,
            model,
            latency,
            tool_execution_error_kind(error),
        );
    }
    tool_stage_error(
        tool_name,
        failure_class,
        stage,
        TerminalSessionReason::ToolExecutorFailure,
        true,
        latency,
        tool_execution_error_kind(error),
    )
}

fn gemini_controlled_tool_error(error: &ToolExecutionError) -> bool {
    matches!(
        error,
        ToolExecutionError::InvalidArguments(_) | ToolExecutionError::Unavailable(_)
    )
}

fn port_error_is_durability_degraded(error: &PortError) -> bool {
    match error {
        PortError::Adapter { reason, .. } => {
            let normalized = reason.to_ascii_lowercase();
            normalized.contains("durable store")
                || normalized.contains("store unavailable")
                || normalized.contains("database unavailable")
                || normalized.contains("postgres unavailable")
                || normalized.contains("connection")
                || normalized.contains("pool")
                || normalized.contains("timed out")
                || normalized.contains("timeout")
        }
        PortError::Unavailable { .. } => false,
    }
}

fn gemini_tool_stage_error(
    tool_name: &str,
    model: &str,
    latency: Duration,
    error_kind: &'static str,
) -> BrainError {
    BrainError::StageFailure(Box::new(BrainProviderFailure::new(
        BrainProviderFailureParts {
            failure_class: "malformed_stream".to_owned(),
            stage: "gemini".to_owned(),
            terminal_reason: TerminalSessionReason::ProviderMalformedStream,
            retry_eligible: true,
            latency_ms: duration_ms(latency),
            provider: "gemini".to_owned(),
            model: model.to_owned(),
            metadata: tool_stage_metadata(tool_name, error_kind),
        },
    )))
}

fn gemini_tool_loop_budget_error(tool_name: &str, model: &str, latency: Duration) -> BrainError {
    gemini_tool_stage_error(tool_name, model, latency, "tool_loop_budget_exceeded")
}

#[cfg(test)]
fn gemini_stream_event_error(message: String, model: &str, latency: Duration) -> BrainError {
    provider_stage_error_from_brain_error(
        BrainError::Protocol(message),
        "gemini",
        "gemini",
        model,
        latency,
    )
}

fn promote_active_gemini_fallback(active_gemini: &mut GeminiConfig, to_model: &str) {
    let remaining_fallbacks = active_gemini
        .fallback_model_ids
        .iter()
        .position(|model_id| model_id == to_model)
        .map(|index| active_gemini.fallback_model_ids[index + 1..].to_vec())
        .unwrap_or_default();
    active_gemini.model_id = to_model.to_owned();
    active_gemini.fallback_model_ids = remaining_fallbacks;
}

fn provider_stage_error_from_brain_error(
    error: BrainError,
    stage: &'static str,
    provider: &'static str,
    model: &str,
    latency: Duration,
) -> BrainError {
    if matches!(error, BrainError::StageFailure(_)) {
        return error;
    }
    let (failure_class, terminal_reason, retry_eligible, metadata) =
        provider_failure_classification(&error);
    BrainError::StageFailure(Box::new(BrainProviderFailure::new(
        BrainProviderFailureParts {
            failure_class: failure_class.to_owned(),
            stage: stage.to_owned(),
            terminal_reason,
            retry_eligible,
            latency_ms: duration_ms(latency),
            provider: provider.to_owned(),
            model: model.to_owned(),
            metadata: metadata.to_owned(),
        },
    )))
}

fn provider_failure_classification(
    error: &BrainError,
) -> (&'static str, TerminalSessionReason, bool, &'static str) {
    match error {
        BrainError::MissingApiKey => (
            "provider_auth_failure",
            TerminalSessionReason::ProviderAuthFailed,
            false,
            "error_kind=missing_api_key",
        ),
        BrainError::Connection(message) | BrainError::Protocol(message) => {
            let normalized = message.to_ascii_lowercase();
            if normalized.contains("auth")
                || normalized.contains("api key")
                || normalized.contains("_api_key")
                || normalized.contains("unauthorized")
                || normalized.contains("forbidden")
                || normalized.contains("status 401")
                || normalized.contains("status: 401")
                || normalized.contains("status=401")
                || normalized.contains("status 403")
                || normalized.contains("status: 403")
                || normalized.contains("status=403")
                || normalized.contains("permission")
            {
                return (
                    "provider_auth_failure",
                    TerminalSessionReason::ProviderAuthFailed,
                    false,
                    "error_kind=provider_auth",
                );
            }
            if normalized.contains("rate")
                || normalized.contains("quota")
                || normalized.contains("budget")
                || normalized.contains("429")
            {
                return (
                    "quota_rate_failure",
                    TerminalSessionReason::ProviderRateLimited,
                    true,
                    "error_kind=provider_rate_limited",
                );
            }
            if normalized.contains("timeout") || normalized.contains("timed out") {
                return (
                    "timeout",
                    TerminalSessionReason::ProviderTimeout,
                    true,
                    "error_kind=deadline_elapsed",
                );
            }
            if normalized.contains("cancel") || normalized.contains("abort") {
                return (
                    "cancellation",
                    TerminalSessionReason::ProviderCancelled,
                    true,
                    "error_kind=provider_cancelled",
                );
            }
            if matches!(error, BrainError::Protocol(_))
                || normalized.contains("protocol")
                || normalized.contains("invalid")
                || normalized.contains("malformed")
                || normalized.contains("parse")
                || normalized.contains("schema")
            {
                return (
                    "malformed_stream",
                    TerminalSessionReason::ProviderMalformedStream,
                    true,
                    "error_kind=malformed_stream",
                );
            }
            (
                "network_disconnect",
                TerminalSessionReason::ProviderNetworkDisconnect,
                true,
                "error_kind=network_disconnect",
            )
        }
        BrainError::StageFailure(_) => (
            "stage_failure",
            TerminalSessionReason::ProviderMalformedStream,
            true,
            "error_kind=stage_failure",
        ),
    }
}

fn tool_execution_error_kind(error: &ToolExecutionError) -> &'static str {
    match error {
        ToolExecutionError::InvalidArguments(_) => "invalid_arguments",
        ToolExecutionError::Unavailable(_) => "unavailable",
        ToolExecutionError::Store(_) => "store",
    }
}

fn tool_stage_metadata(tool_name: &str, error_kind: &'static str) -> String {
    format!(
        "tool={} error_kind={error_kind}",
        sanitized_tool_metadata_name(tool_name)
    )
}

fn sanitized_tool_metadata_name(tool_name: &str) -> &'static str {
    match tool_name {
        "select_next_question" => "select_next_question",
        "evaluate_spoken_answer" => "evaluate_spoken_answer",
        "retrieve_source_reference" => "retrieve_source_reference",
        "mark_concept_status" => "mark_concept_status",
        "emit_manuscript_intent" => "emit_manuscript_intent",
        "build_session_recap" => "build_session_recap",
        "challenge_correction" => "challenge_correction",
        "schedule_review_item" => "schedule_review_item",
        _ => "unrecognized_tool",
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod fallback_tests {
    use super::*;
    use agent_domain::{SessionId, StudyMode};

    #[test]
    fn provider_classifier_maps_http_auth_statuses_to_auth_failure() {
        for message in [
            "Gemini stream request failed with status 401",
            "Gemini stream request failed with status 403",
            "Gemini stream request failed with status: 401",
            "Gemini stream request failed with status=403",
        ] {
            let (failure_class, terminal_reason, retry_eligible, metadata) =
                provider_failure_classification(&BrainError::Protocol(message.to_owned()));

            assert_eq!(failure_class, "provider_auth_failure");
            assert_eq!(terminal_reason, TerminalSessionReason::ProviderAuthFailed);
            assert!(!retry_eligible);
            assert_eq!(metadata, "error_kind=provider_auth");
        }
    }

    #[test]
    fn invalid_tool_arguments_classify_as_malformed_provider_stream() {
        let error = tool_execution_stage_error(
            "unknown_tool",
            "tool_executor_failure",
            "tools",
            Duration::from_millis(42),
            &ToolExecutionError::InvalidArguments("unknown tool".to_owned()),
            Some("gemini-test-model"),
        );
        let BrainError::StageFailure(failure) = error else {
            panic!("invalid tool arguments should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.stage, "gemini");
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-test-model");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ProviderMalformedStream
        );
        assert!(failure.retry_eligible);
        assert_eq!(failure.latency_ms, 42);
        assert!(failure.metadata.contains("tool=unrecognized_tool"));
        assert!(failure.metadata.contains("error_kind=invalid_arguments"));
    }

    #[test]
    fn unavailable_gemini_tool_targets_classify_as_malformed_provider_stream() {
        let error = tool_execution_stage_error(
            "retrieve_source_reference",
            "tool_executor_failure",
            "tools",
            Duration::from_millis(17),
            &ToolExecutionError::Unavailable("source is unavailable".to_owned()),
            Some("gemini-test-model"),
        );
        let BrainError::StageFailure(failure) = error else {
            panic!("unavailable Gemini tool targets should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.stage, "gemini");
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-test-model");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ProviderMalformedStream
        );
        assert!(failure.retry_eligible);
        assert_eq!(failure.latency_ms, 17);
        assert_eq!(
            failure.metadata,
            "tool=retrieve_source_reference error_kind=unavailable"
        );
    }

    #[test]
    fn durable_tool_store_errors_classify_as_durability_degraded() {
        let error = tool_execution_stage_error(
            "mark_concept_status",
            "tool_executor_failure",
            "tools",
            Duration::from_millis(29),
            &ToolExecutionError::Store(PortError::adapter(
                "postgres",
                "durable store write failed",
            )),
            Some("gemini-test-model"),
        );
        let BrainError::StageFailure(failure) = error else {
            panic!("durable tool store errors should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "durability_degraded");
        assert_eq!(failure.stage, "store");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::DurabilityDegraded
        );
        assert!(failure.retry_eligible);
        assert_eq!(failure.latency_ms, 29);
        assert_eq!(failure.provider, "server");
        assert_eq!(failure.model, "viva-tools");
        assert_eq!(
            failure.metadata,
            "tool=mark_concept_status error_kind=durability_degraded"
        );
    }

    #[test]
    fn provider_controlled_tool_names_are_redacted_from_stage_metadata() {
        let error = gemini_tool_stage_error(
            "retrieve_source_reference raw answer text and source excerpt",
            "gemini-test-model",
            Duration::from_millis(12),
            "invalid_arguments",
        );
        let BrainError::StageFailure(failure) = error else {
            panic!("malformed provider tool names should produce a stage failure");
        };

        assert_eq!(
            failure.metadata,
            "tool=unrecognized_tool error_kind=invalid_arguments"
        );
        assert!(!failure.metadata.contains("raw answer text"));
        assert!(!failure.metadata.contains("source excerpt"));
    }

    #[test]
    fn manuscript_intent_counts_against_gemini_tool_budget() {
        let mut executed = MAX_GEMINI_EXECUTED_TOOL_STAGES;

        let error = reserve_gemini_tool_stage(
            &mut executed,
            "emit_manuscript_intent",
            "gemini-test-model",
            Duration::from_millis(9),
        )
        .unwrap_err();
        let BrainError::StageFailure(failure) = error else {
            panic!("tool loop budget should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.stage, "gemini");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ProviderMalformedStream
        );
        assert_eq!(
            failure.metadata,
            "tool=emit_manuscript_intent error_kind=tool_loop_budget_exceeded"
        );
    }

    #[tokio::test]
    async fn gemini_tool_batches_preflight_budget_before_side_effects() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let question = store
            .active_question("user-1", "biology-midterm")
            .await
            .unwrap()
            .expect("seeded active question");
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig::default(),
            transports: OverBudgetGeminiToolBatchTransports,
            store: Some(store.clone()),
        };
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let error = runner
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: "NADH donates electrons to the electron transport chain.",
                cancelled: None,
                emit_text_delta: true,
                events: &mut events,
                executor: &executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: "response-over-budget",
                session: &session,
                usage: &mut usage,
            })
            .await
            .unwrap_err();
        let BrainError::StageFailure(failure) = error else {
            panic!("over-budget Gemini tool batch should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.stage, "gemini");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ProviderMalformedStream
        );
        assert_eq!(
            failure.metadata,
            "tool=evaluate_spoken_answer error_kind=tool_loop_budget_exceeded"
        );
        assert!(events
            .iter()
            .all(|event| !matches!(event, BrainEvent::AnswerEvaluated { .. })));
        assert_eq!(usage.source_grounded_correction_count, 0);
        assert!(store.snapshot().answer_attempts.is_empty());
    }

    #[tokio::test]
    async fn manuscript_intent_authorization_uses_stage_deadline() {
        let error = manuscript_intent_authorization_stage(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                true
            },
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        let BrainError::StageFailure(failure) = error else {
            panic!("manuscript intent timeout should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "timeout");
        assert_eq!(failure.stage, "tools");
        assert_eq!(failure.provider, "server");
        assert_eq!(failure.model, "viva-tools");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ProviderTimeout
        );
        assert!(failure.retry_eligible);
        assert_eq!(failure.latency_ms, 1);
        assert_eq!(
            failure.metadata,
            "tool=emit_manuscript_intent error_kind=deadline_elapsed"
        );
    }

    #[test]
    fn server_tool_invalid_arguments_remain_tool_executor_failures() {
        let error = tool_execution_stage_error(
            "mark_concept_status",
            "tool_executor_failure",
            "tools",
            Duration::from_millis(11),
            &ToolExecutionError::InvalidArguments("bad server proposal".to_owned()),
            None,
        );
        let BrainError::StageFailure(failure) = error else {
            panic!("server tool argument errors should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "tool_executor_failure");
        assert_eq!(failure.stage, "tools");
        assert_eq!(failure.provider, "server");
        assert_eq!(failure.model, "viva-tools");
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ToolExecutorFailure
        );
        assert!(failure.retry_eligible);
        assert_eq!(failure.latency_ms, 11);
        assert!(failure.metadata.contains("tool=mark_concept_status"));
        assert!(failure.metadata.contains("error_kind=invalid_arguments"));
    }

    #[test]
    fn gemini_sse_error_events_preserve_elapsed_latency() {
        let error = gemini_stream_event_error(
            "Gemini stream provider error".to_owned(),
            "gemini-test-model",
            Duration::from_millis(73),
        );
        let BrainError::StageFailure(failure) = error else {
            panic!("Gemini SSE error event should produce a stage failure");
        };

        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.stage, "gemini");
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-test-model");
        assert_eq!(failure.latency_ms, 73);
        assert_eq!(
            failure.terminal_reason,
            TerminalSessionReason::ProviderMalformedStream
        );
    }

    #[derive(Clone, Copy)]
    struct OverBudgetGeminiToolBatchTransports;

    #[async_trait]
    impl CartesiaGeminiTransports for OverBudgetGeminiToolBatchTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
        ) -> Result<RunnerTranscript, BrainError> {
            unreachable!("test calls Gemini tool loop directly")
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
            Ok((0..=MAX_GEMINI_EXECUTED_TOOL_STAGES)
                .map(|index| {
                    let args = json!({
                        "study_set_id": "biology-midterm",
                        "voice_session_id": "voice-session-1",
                        "question_id": "q-oxidative-phosphorylation-nadh",
                        "answer_text": "NADH donates electrons to the electron transport chain.",
                    });
                    GeminiStreamEvent::FunctionCall {
                        id: format!("call-eval-{index}"),
                        name: "evaluate_spoken_answer".to_owned(),
                        args: args.clone(),
                        part: json!({
                            "functionCall": {
                                "id": format!("call-eval-{index}"),
                                "name": "evaluate_spoken_answer",
                                "args": args,
                            }
                        }),
                    }
                })
                .collect())
        }

        async fn synthesize_sonic(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _transcript: &str,
            _interrupt: FakeRuntimeInterrupt,
        ) -> Result<Vec<AudioFrame>, BrainError> {
            unreachable!("test calls Gemini tool loop directly")
        }
    }
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
        FakeRuntimeInterrupt::GeminiToolCallOnFinalPass
            if stream
                .iter()
                .all(|event| !matches!(event, GeminiStreamEvent::FunctionCall { .. })) =>
        {
            let args = json!({
                "type": "entity_intent",
                "entity_id": "nadh",
                "entity_kind": "concept",
                "register": "correcting",
                "emphasis": "marked",
            });
            vec![GeminiStreamEvent::FunctionCall {
                id: "call-manuscript-final-pass".to_owned(),
                name: "emit_manuscript_intent".to_owned(),
                args: args.clone(),
                part: json!({
                    "functionCall": {
                        "id": "call-manuscript-final-pass",
                        "name": "emit_manuscript_intent",
                        "args": args,
                    }
                }),
            }]
        }
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
    completed: &'a AtomicBool,
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
    ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure>;

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
    ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
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
            if request.get("tools").is_some() {
                return Err(GeminiStreamAttemptFailure {
                    events: Vec::new(),
                    error: BrainError::Protocol(
                        "fake Gemini final request advertised Viva tools".to_owned(),
                    ),
                });
            }
            Ok(parse_gemini_sse_line(
                r#"data: {"candidates":[{"content":{"parts":[{"text":"Good. Now connect the proton gradient to ATP synthase."}]}}],"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":2}}"#,
            ))
        } else {
            if request.get("tools").is_none() {
                return Err(GeminiStreamAttemptFailure {
                    events: Vec::new(),
                    error: BrainError::Protocol(
                        "fake Gemini request omitted Viva tools".to_owned(),
                    ),
                });
            }
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
        let started = Instant::now();
        let transcript = transcribe_ink_websocket(&config.ink, &config.cartesia_api_key, frame)
            .await
            .map_err(|error| {
                provider_stage_error_from_brain_error(
                    error,
                    "ink_stt",
                    "cartesia",
                    &config.ink.model,
                    started.elapsed(),
                )
            })?;
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
    ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
        let started = Instant::now();
        stream_gemini_http_with_attempt_events(&config.gemini, request)
            .await
            .map_err(|failure| GeminiStreamAttemptFailure {
                events: failure.events,
                error: provider_stage_error_from_brain_error(
                    failure.error,
                    "gemini",
                    "gemini",
                    &config.gemini.model_id,
                    started.elapsed(),
                ),
            })
    }

    async fn synthesize_sonic(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        transcript: &str,
        _interrupt: FakeRuntimeInterrupt,
    ) -> Result<Vec<AudioFrame>, BrainError> {
        let started = Instant::now();
        synthesize_sonic_websocket(
            &config.sonic,
            &config.cartesia_api_key,
            response_id,
            transcript,
        )
        .await
        .map_err(|error| {
            provider_stage_error_from_brain_error(
                error,
                "sonic_tts",
                "cartesia",
                &config.sonic.model_id,
                started.elapsed(),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use agent_domain::{SessionId, StudyMode};

    #[tokio::test]
    async fn gemini_tool_loop_keeps_fallback_model_for_tool_continuations() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let transports = FallbackContinuationCaptureTransports::default();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: transports.clone(),
            store: Some(store),
        };
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let response_prompt = runner
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: "omitted",
                cancelled: None,
                emit_text_delta: false,
                events: &mut events,
                executor: &executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: "response-1",
                session: &session,
                usage: &mut usage,
            })
            .await
            .unwrap();

        assert_eq!(response_prompt, "fallback continuation");
        assert!(events.iter().any(|event| matches!(
            event,
            BrainEvent::ProviderFallbackActivated {
                from_model,
                to_model,
                ..
            } if from_model == "gemini-3.5-pro" && to_model == "gemini-3.5-flash"
        )));
        assert_eq!(
            transports
                .models
                .lock()
                .expect("models lock poisoned")
                .as_slice(),
            ["gemini-3.5-pro", "gemini-3.5-flash"]
        );
    }

    #[tokio::test]
    async fn gemini_tool_loop_preserves_unused_fallbacks_after_model_switch() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let transports = FallbackContinuationCaptureTransports::default();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec![
                        "gemini-3.5-flash".to_owned(),
                        "gemini-3.5-lite".to_owned(),
                    ],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: transports.clone(),
            store: Some(store),
        };
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        runner
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: "omitted",
                cancelled: None,
                emit_text_delta: false,
                events: &mut events,
                executor: &executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: "response-1",
                session: &session,
                usage: &mut usage,
            })
            .await
            .unwrap();

        assert_eq!(
            transports
                .models
                .lock()
                .expect("models lock poisoned")
                .as_slice(),
            ["gemini-3.5-pro", "gemini-3.5-flash"]
        );
        assert_eq!(
            transports
                .fallback_lists
                .lock()
                .expect("fallback lists lock poisoned")
                .as_slice(),
            [
                vec!["gemini-3.5-flash".to_owned(), "gemini-3.5-lite".to_owned()],
                vec!["gemini-3.5-lite".to_owned()]
            ]
        );
    }

    #[tokio::test]
    async fn gemini_tool_loop_budget_error_uses_active_fallback_model() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: FallbackToolLoopBudgetTransports::default(),
            store: Some(store),
        };
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let error = runner
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: "omitted",
                cancelled: None,
                emit_text_delta: false,
                events: &mut events,
                executor: &executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: "response-1",
                session: &session,
                usage: &mut usage,
            })
            .await
            .unwrap_err();

        let BrainError::StageFailure(failure) = error else {
            panic!("tool loop budget should produce a Gemini stage failure");
        };
        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-35-flash");
        assert!(failure
            .metadata
            .contains("error_kind=tool_loop_budget_exceeded"));
        assert!(events.iter().any(|event| matches!(
            event,
            BrainEvent::ProviderFallbackActivated {
                from_model,
                to_model,
                ..
            } if from_model == "gemini-3.5-pro" && to_model == "gemini-3.5-flash"
        )));
    }

    #[tokio::test]
    async fn gemini_stream_error_events_use_elapsed_request_latency() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: GeminiStreamErrorTransports {
                delay: Duration::from_millis(5),
            },
            store: Some(store),
        };
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let error = runner
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: "omitted",
                cancelled: None,
                emit_text_delta: false,
                events: &mut events,
                executor: &executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: "response-1",
                session: &session,
                usage: &mut usage,
            })
            .await
            .unwrap_err();

        let BrainError::StageFailure(failure) = error else {
            panic!("Gemini stream errors should produce stage failures");
        };
        assert_eq!(failure.failure_class, "malformed_stream");
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-35-pro");
        assert!(failure.latency_ms > 0);
    }

    #[tokio::test]
    async fn gemini_tool_loop_emits_fallback_activation_before_returning_failure() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: FallbackFailureTransports,
            store: Some(store),
        };
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let error = runner
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: "omitted",
                cancelled: None,
                emit_text_delta: false,
                events: &mut events,
                executor: &executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: "response-1",
                session: &session,
                usage: &mut usage,
            })
            .await
            .unwrap_err();

        assert!(events.iter().any(|event| matches!(
            event,
            BrainEvent::ProviderFallbackActivated {
                from_model,
                to_model,
                reason,
                ..
            } if from_model == "gemini-3.5-pro"
                && to_model == "gemini-3.5-flash"
                && reason == "primary_429"
        )));
        let BrainError::StageFailure(failure) = error else {
            panic!("expected carried fallback stage failure");
        };
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-35-flash");
    }

    #[tokio::test]
    async fn emit_turn_drains_fallback_activation_before_provider_failure() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: FallbackFailureTransports,
            store: Some(store),
        };
        let (event_tx, mut event_rx) = mpsc::channel(16);

        runner
            .emit_turn(RunnerTurnJob {
                event_tx,
                executor,
                session,
                question,
                response_id: "response-1".to_owned(),
                submission_sequence: 1,
                input: RunnerInput::Text {
                    text: "omitted".to_owned(),
                    client_generation_id: None,
                },
                confidence: Some(1.0),
                cancelled: Arc::new(AtomicBool::new(false)),
                completed: Arc::new(AtomicBool::new(false)),
            })
            .await;

        let mut events = Vec::new();
        while let Ok(Some(event)) = timeout(Duration::from_millis(50), event_rx.recv()).await {
            events.push(event);
        }

        let fallback_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    BrainEvent::ProviderFallbackActivated {
                        from_model,
                        to_model,
                        reason,
                        ..
                    } if from_model == "gemini-3.5-pro"
                        && to_model == "gemini-3.5-flash"
                        && reason == "primary_429"
                )
            })
            .expect("fallback activation should be emitted before provider failure");
        let error_index = events
            .iter()
            .position(|event| matches!(event, BrainEvent::Error(_)))
            .expect("fallback failure should emit provider error");
        assert!(
            fallback_index < error_index,
            "fallback activation must precede terminal provider error"
        );
    }

    #[tokio::test]
    async fn emit_turn_does_not_flush_tool_events_when_continuation_fails() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let executor = VivaToolExecutor::new(store.clone(), session.clone());
        let question = select_next_question(&executor, &session).await.unwrap();
        let runner = CartesiaGeminiRunner {
            config: CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports: FallbackContinuationFailureAfterToolTransports::default(),
            store: Some(store),
        };
        let (event_tx, mut event_rx) = mpsc::channel(16);

        runner
            .emit_turn(RunnerTurnJob {
                event_tx,
                executor,
                session,
                question,
                response_id: "response-1".to_owned(),
                submission_sequence: 1,
                input: RunnerInput::Text {
                    text: "omitted".to_owned(),
                    client_generation_id: None,
                },
                confidence: Some(1.0),
                cancelled: Arc::new(AtomicBool::new(false)),
                completed: Arc::new(AtomicBool::new(false)),
            })
            .await;

        let mut events = Vec::new();
        while let Ok(Some(event)) = timeout(Duration::from_millis(50), event_rx.recv()).await {
            events.push(event);
        }

        assert!(events.iter().any(|event| matches!(
            event,
            BrainEvent::ProviderFallbackActivated {
                from_model,
                to_model,
                reason,
                ..
            } if from_model == "gemini-3.5-pro"
                && to_model == "gemini-3.5-flash"
                && reason == "primary_429"
        )));
        assert!(
            events
                .iter()
                .any(|event| matches!(event, BrainEvent::Error(_))),
            "continuation failure should emit provider error"
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, BrainEvent::AnswerEvaluated { .. })),
            "tool-derived browser events must remain deferred when continuation fails"
        );
    }

    #[derive(Clone, Default)]
    struct FallbackContinuationCaptureTransports {
        models: Arc<Mutex<Vec<String>>>,
        fallback_lists: Arc<Mutex<Vec<Vec<String>>>>,
    }

    #[derive(Clone)]
    struct FallbackFailureTransports;

    #[derive(Clone, Default)]
    struct FallbackToolLoopBudgetTransports {
        calls: Arc<Mutex<u32>>,
    }

    #[derive(Clone, Default)]
    struct FallbackContinuationFailureAfterToolTransports {
        calls: Arc<Mutex<u32>>,
    }

    #[derive(Clone)]
    struct GeminiStreamErrorTransports {
        delay: Duration,
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackContinuationCaptureTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(1.0),
            })
        }

        async fn stream_gemini(
            &self,
            config: &CartesiaGeminiConfig,
            request: Value,
        ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
            let mut models = self.models.lock().expect("models lock poisoned");
            models.push(config.gemini.model_id.clone());
            let call_index = models.len();
            drop(models);
            self.fallback_lists
                .lock()
                .expect("fallback lists lock poisoned")
                .push(config.gemini.fallback_model_ids.clone());

            if call_index == 1 {
                let args = json!({
                    "study_set_id": "biology-midterm",
                    "voice_session_id": "voice-session-1",
                    "question_id": "q-oxidative-phosphorylation-nadh",
                    "answer_text": "omitted",
                });
                Ok(vec![
                    GeminiStreamEvent::FallbackActivated {
                        from_model: "gemini-3.5-pro".to_owned(),
                        to_model: "gemini-3.5-flash".to_owned(),
                        reason: "primary_429".to_owned(),
                        failure: None,
                    },
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
                ])
            } else {
                assert!(request["contents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|content| {
                        content["parts"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|part| part.get("functionResponse").is_some())
                    }));
                Ok(vec![GeminiStreamEvent::ModelPart {
                    text: Some("fallback continuation".to_owned()),
                    part: json!({ "text": "fallback continuation" }),
                }])
            }
        }

        async fn synthesize_sonic(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _transcript: &str,
            _interrupt: FakeRuntimeInterrupt,
        ) -> Result<Vec<AudioFrame>, BrainError> {
            Ok(Vec::new())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackFailureTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(1.0),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
            Err(GeminiStreamAttemptFailure {
                events: vec![GeminiStreamEvent::FallbackActivated {
                    from_model: "gemini-3.5-pro".to_owned(),
                    to_model: "gemini-3.5-flash".to_owned(),
                    reason: "primary_429".to_owned(),
                    failure: None,
                }],
                error: BrainError::StageFailure(Box::new(BrainProviderFailure::new(
                    BrainProviderFailureParts {
                        failure_class: "timeout".to_owned(),
                        stage: "gemini".to_owned(),
                        terminal_reason: TerminalSessionReason::ProviderTimeout,
                        retry_eligible: true,
                        latency_ms: 1,
                        provider: "gemini".to_owned(),
                        model: "gemini-3.5-flash".to_owned(),
                        metadata: "error_kind=deadline_elapsed".to_owned(),
                    },
                ))),
            })
        }

        async fn synthesize_sonic(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _transcript: &str,
            _interrupt: FakeRuntimeInterrupt,
        ) -> Result<Vec<AudioFrame>, BrainError> {
            Ok(Vec::new())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackContinuationFailureAfterToolTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(1.0),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
            let mut calls = self.calls.lock().expect("calls lock poisoned");
            *calls += 1;
            let call_index = *calls;
            drop(calls);

            if call_index == 1 {
                let args = json!({
                    "study_set_id": "biology-midterm",
                    "voice_session_id": "voice-session-1",
                    "question_id": "q-oxidative-phosphorylation-nadh",
                    "answer_text": "omitted",
                });
                return Ok(vec![
                    GeminiStreamEvent::FallbackActivated {
                        from_model: "gemini-3.5-pro".to_owned(),
                        to_model: "gemini-3.5-flash".to_owned(),
                        reason: "primary_429".to_owned(),
                        failure: None,
                    },
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
                ]);
            }

            Err(GeminiStreamAttemptFailure {
                events: Vec::new(),
                error: BrainError::StageFailure(Box::new(BrainProviderFailure::new(
                    BrainProviderFailureParts {
                        failure_class: "timeout".to_owned(),
                        stage: "gemini".to_owned(),
                        terminal_reason: TerminalSessionReason::ProviderTimeout,
                        retry_eligible: true,
                        latency_ms: 1,
                        provider: "gemini".to_owned(),
                        model: "gemini-3.5-flash".to_owned(),
                        metadata: "error_kind=deadline_elapsed".to_owned(),
                    },
                ))),
            })
        }

        async fn synthesize_sonic(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _transcript: &str,
            _interrupt: FakeRuntimeInterrupt,
        ) -> Result<Vec<AudioFrame>, BrainError> {
            Ok(Vec::new())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackToolLoopBudgetTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(1.0),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
            let mut calls = self.calls.lock().expect("calls lock poisoned");
            *calls += 1;
            let call_index = *calls;
            drop(calls);

            let tool_call = GeminiStreamEvent::FunctionCall {
                id: format!("call-intent-{call_index}"),
                name: "emit_manuscript_intent".to_owned(),
                args: json!({}),
                part: json!({
                    "functionCall": {
                        "id": format!("call-intent-{call_index}"),
                        "name": "emit_manuscript_intent",
                        "args": {},
                    }
                }),
            };
            if call_index == 1 {
                Ok(vec![
                    GeminiStreamEvent::FallbackActivated {
                        from_model: "gemini-3.5-pro".to_owned(),
                        to_model: "gemini-3.5-flash".to_owned(),
                        reason: "primary_429".to_owned(),
                        failure: None,
                    },
                    tool_call,
                ])
            } else {
                Ok(vec![tool_call])
            }
        }

        async fn synthesize_sonic(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _transcript: &str,
            _interrupt: FakeRuntimeInterrupt,
        ) -> Result<Vec<AudioFrame>, BrainError> {
            Ok(Vec::new())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for GeminiStreamErrorTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(1.0),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure> {
            tokio::time::sleep(self.delay).await;
            Ok(vec![GeminiStreamEvent::Error(
                "Gemini stream provider error".to_owned(),
            )])
        }

        async fn synthesize_sonic(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _transcript: &str,
            _interrupt: FakeRuntimeInterrupt,
        ) -> Result<Vec<AudioFrame>, BrainError> {
            Ok(Vec::new())
        }
    }
}
