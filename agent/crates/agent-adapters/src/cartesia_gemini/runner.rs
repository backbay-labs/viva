use std::{
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use agent_domain::{
    AnswerEvaluator, AudioFrame, AuthorizedStudySession, BrainError, BrainEvent, BrainFailureClass,
    BrainFailureStage, BrainInput, BrainProviderFailureParts, BrainUsage, ManuscriptIntent,
    RealtimeSession, RealtimeSessionTaskGuard, SessionConfig, StudyMemoryStore, StudyQuestion,
    StudySessionPhase, StudySourceReference, ToolExecutionError, ToolProposal, ToolResult,
    TurnOutcome, TurnResolution, VivaToolExecutor,
};
use tokio::time::timeout;

use crate::synthetic::synthetic_fixture_answer_evaluator;

use futures_util::StreamExt;

/// Seams the in-file tests script directly. Production orchestration reaches
/// the providers only through [`CartesiaGeminiTransports`].
#[cfg(test)]
use super::llm::GeminiStreamAttemptFailure;
use super::llm::{
    parse_gemini_manuscript_intent, GeminiAnswerEvaluator, GeminiConversation, GeminiEventStream,
};
use super::session::{
    answer_attempt_envelope, cancel_active_runner_response, manuscript_intent_stage,
    response_id_for_turn, ActiveRunnerResponse, CartesiaGeminiTransports,
    LiveCartesiaGeminiTransports, RunnerInput, RunnerTranscript, RunnerTurnJob,
};
use super::tts::SpeechFrameSink;
#[cfg(test)]
use super::{fake_transport_failure, fixture_gemini_stream};

use super::{
    answer_evaluation_from_outcome, brain_failure, duration_ms, emit_provider_failure,
    failure_with_latency, fake_interrupt_gemini_stream, gemini_request, learning_event_projection,
    parse_persisted_turn_outcome, recap_from_tool_result, select_session_question,
    send_fake_unless_cancelled, CartesiaGeminiConfig, FakeCartesiaGeminiTransports,
    FakeRuntimeInterrupt, FakeRuntimeReport, GeminiConfig, GeminiStreamEvent, SessionPhaseTracker,
    MAX_GEMINI_EXECUTED_TOOL_STAGES, MAX_GEMINI_TOOL_LOOP_PASSES,
};

/// Which evaluator a runtime injected.
///
/// `A-13.3`: the fixture evaluator is reachable only through the named
/// fake/synthetic builders, and this records which one a composed runner
/// actually holds so the boundary is observable rather than assumed. No value
/// here is read from the environment and there is no default.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EvaluatorProvenance {
    LiveGemini,
    SyntheticFixture,
}

/// What one Gemini tool loop produced.
///
/// The response text is provider output and stays provider output. The outcome
/// is the persisted Plan 04 `TurnOutcome` the executor returned, and it is the
/// only thing downstream code may turn into a learner fact.
#[derive(Debug)]
pub(crate) struct GeminiTurnResult {
    /// Only the final-pass, post-outcome text — the words actually spoken.
    response_text: String,
    turn_outcome: Option<TurnOutcome>,
    /// Whether a speech context was opened for this response.
    speech_opened: bool,
}

#[derive(Clone)]
pub(crate) struct CartesiaGeminiRunner<T> {
    config: CartesiaGeminiConfig,
    transports: T,
    store: Option<Arc<dyn StudyMemoryStore>>,
    evaluator: Arc<dyn AnswerEvaluator>,
    evaluator_provenance: EvaluatorProvenance,
}

impl<T> fmt::Debug for CartesiaGeminiRunner<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CartesiaGeminiRunner")
            .field("config", &self.config)
            .field("has_store", &self.store.is_some())
            .field("evaluator", &self.evaluator_provenance())
            .finish_non_exhaustive()
    }
}

impl<T> CartesiaGeminiRunner<T> {
    /// Which evaluator this composed runtime holds. Recorded on the type rather
    /// than inferred, so a live composition cannot silently become synthetic.
    pub(crate) fn evaluator_provenance(&self) -> EvaluatorProvenance {
        self.evaluator_provenance
    }
}

impl CartesiaGeminiRunner<FakeCartesiaGeminiTransports> {
    pub(crate) fn fake(store: Arc<dyn StudyMemoryStore>, config: CartesiaGeminiConfig) -> Self {
        Self {
            config,
            transports: FakeCartesiaGeminiTransports::new(),
            store: Some(store),
            evaluator: synthetic_fixture_answer_evaluator(),
            evaluator_provenance: EvaluatorProvenance::SyntheticFixture,
        }
    }

    /// How many times this fixture runtime asked Sonic to speak.
    pub(crate) fn sonic_call_count(&self) -> u32 {
        self.transports.sonic_call_count()
    }

    /// How many times this fixture runtime entered a provider stage at all.
    pub(crate) fn provider_call_count(&self) -> u32 {
        self.transports.provider_call_count()
    }
}

impl CartesiaGeminiRunner<LiveCartesiaGeminiTransports> {
    pub(crate) fn live(store: Arc<dyn StudyMemoryStore>, config: CartesiaGeminiConfig) -> Self {
        let transports = LiveCartesiaGeminiTransports::new(config.live_runtime_enabled);
        // The live composition always names the provider-backed evaluator. A
        // missing credential or a closed runtime gate makes the runtime
        // unselectable; it never makes it quietly synthetic. The evaluator
        // shares the transports' one HTTP connection pool.
        let evaluator = Arc::new(GeminiAnswerEvaluator::live(
            &config.gemini,
            transports.gemini_client(),
        ));
        Self {
            config,
            transports,
            store: Some(store),
            evaluator,
            evaluator_provenance: EvaluatorProvenance::LiveGemini,
        }
    }
}

impl<T> CartesiaGeminiRunner<T>
where
    T: CartesiaGeminiTransports,
{
    /// Test-only composition with scripted transports and an explicit evaluator.
    #[cfg(test)]
    pub(crate) fn scripted(
        config: CartesiaGeminiConfig,
        transports: T,
        store: Arc<dyn StudyMemoryStore>,
        evaluator: Arc<dyn AnswerEvaluator>,
        evaluator_provenance: EvaluatorProvenance,
    ) -> Self {
        Self {
            config,
            transports,
            store: Some(store),
            evaluator,
            evaluator_provenance,
        }
    }

    pub(crate) fn store(&self) -> Option<Arc<dyn StudyMemoryStore>> {
        self.store.clone()
    }

    pub(crate) fn evaluator(&self) -> Arc<dyn AnswerEvaluator> {
        Arc::clone(&self.evaluator)
    }

    fn executor(&self, session: &AuthorizedStudySession) -> Result<VivaToolExecutor, BrainError> {
        let store = self.store.clone().ok_or_else(|| {
            runner_failure(
                BrainFailureClass::ToolExecutorFailure,
                BrainFailureStage::Session,
                "error_kind=missing_study_store",
            )
        })?;
        Ok(VivaToolExecutor::new(
            store,
            session.clone(),
            Arc::clone(&self.evaluator),
        ))
    }

    pub(crate) async fn open(
        &self,
        session_config: SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        self.transports.authorize_open().await?;
        let session_generation_id = session_config.client_generation_id.clone();
        let session = AuthorizedStudySession::from_config(&session_config).map_err(|_| {
            runner_failure(
                BrainFailureClass::ToolExecutorFailure,
                BrainFailureStage::Session,
                "error_kind=unauthorized_session",
            )
        })?;
        let store = self.store.clone().ok_or_else(|| {
            runner_failure(
                BrainFailureClass::ToolExecutorFailure,
                BrainFailureStage::Session,
                "error_kind=missing_study_store",
            )
        })?;
        let _ = store
            .record_voice_session(&session_config)
            .await
            .map_err(|_| {
                runner_failure(
                    BrainFailureClass::DurabilityDegraded,
                    BrainFailureStage::Store,
                    "error_kind=voice_session_write_failed",
                )
            })?;

        let executor = self.executor(&session)?;
        let first_response_id = response_id_for_turn(1, session_generation_id.as_deref());
        // The first question comes from this session's own D-02B cursor, keyed by
        // the response it will be asked under, so the selection a turn later
        // replays rather than advancing past it.
        let question = select_session_question(
            &executor,
            &session.study_set_id,
            &session.voice_session_id,
            &first_response_id,
        )
        .await?;
        let phases = SessionPhaseTracker::ready();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(32);
        let (event_tx, events) = mpsc::channel::<BrainEvent>(32);
        // This session's own provider connections, minted once the session is
        // authorized and durably recorded.
        let runner = CartesiaGeminiRunner {
            config: self.config.clone(),
            transports: self.transports.open_session(),
            store: self.store.clone(),
            evaluator: Arc::clone(&self.evaluator),
            evaluator_provenance: self.evaluator_provenance,
        };
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: first_response_id.clone(),
                    question,
                })
                .await;

            let mut turn = 1_usize;
            // The response whose question has already been announced. The open
            // handshake announces the first one; every later accepted turn
            // announces its own before it records or emits anything else.
            let mut started_response_id = Some(first_response_id);
            let mut active_response: Option<ActiveRunnerResponse> = None;
            while let Some(input) = input_rx.recv().await {
                let runner_input = match input {
                    BrainInput::Audio(frame) => Some(RunnerInput::Audio {
                        frame,
                        client_generation_id: None,
                    }),
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => Some(RunnerInput::Audio {
                        frame,
                        client_generation_id,
                    }),
                    BrainInput::Text(text) => Some(RunnerInput::Text {
                        text,
                        client_generation_id: None,
                    }),
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => Some(RunnerInput::Text {
                        text,
                        client_generation_id,
                    }),
                    BrainInput::CancelResponse => {
                        let response_id = match cancel_active_runner_response(&mut active_response)
                            .await
                        {
                            Some(response_id) => response_id,
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
                        let _ = cancel_active_runner_response(&mut active_response).await;
                        runner
                            .emit_session_recap(
                                &event_tx,
                                &executor,
                                &session,
                                session_generation_id.as_deref(),
                                &phases,
                            )
                            .await;
                        break;
                    }
                    BrainInput::ToolResult(_)
                    | BrainInput::SessionContextRefresh(_)
                    | BrainInput::ProactiveTurn { .. } => continue,
                    _ => continue,
                };
                let Some(runner_input) = runner_input else {
                    continue;
                };

                if let Some(response_id) = cancel_active_runner_response(&mut active_response).await
                {
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
                // Every accepted turn is correlated to its own question. The
                // first one was announced by the open handshake; a replacement
                // or follow-on turn announces its own before anything else it
                // records or emits, so a client's staleness guard can key on it.
                let announce_question =
                    started_response_id.as_deref() != Some(response_id.as_str());
                started_response_id = Some(response_id.clone());
                active_response = Some(runner.spawn_turn(
                    RunnerTurnJob {
                        event_tx: event_tx.clone(),
                        executor: executor.clone(),
                        session: session.clone(),
                        response_id: response_id.clone(),
                        submission_sequence,
                        input: runner_input,
                        phases: phases.clone(),
                        announce_question,
                        speech_opened: Arc::new(AtomicBool::new(false)),
                        cancelled: CancellationToken::new(),
                        completed: Arc::new(AtomicBool::new(false)),
                    },
                    response_id,
                ));
            }
            // One bounded teardown for the session's provider connections,
            // whether the learner stopped or the session was dropped.
            runner.transports.close_session().await;
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }

    /// The fake runtime's one-shot audio replay.
    ///
    /// It runs the same authority path as a live turn: the question comes from
    /// the session cursor, the outcome comes from the Plan 04 executor, and the
    /// spoken text comes from that outcome rather than from a shared fallback.
    pub(crate) async fn replay_audio_turn(
        &self,
        session_config: SessionConfig,
        frame: AudioFrame,
        interrupt: FakeRuntimeInterrupt,
    ) -> Result<FakeRuntimeReport, BrainError> {
        let session = AuthorizedStudySession::from_config(&session_config).map_err(|_| {
            runner_failure(
                BrainFailureClass::ToolExecutorFailure,
                BrainFailureStage::Session,
                "error_kind=unauthorized_session",
            )
        })?;
        let executor = self.executor(&session)?;
        let response_id = "fake-cartesia-gemini-response-1".to_owned();
        let input = RunnerInput::Audio {
            frame: frame.clone(),
            client_generation_id: None,
        };
        let question = select_session_question(
            &executor,
            &session.study_set_id,
            &session.voice_session_id,
            &response_id,
        )
        .await?;
        executor
            .record_answer_attempt_envelope(answer_attempt_envelope(
                &session,
                &question,
                &response_id,
                1,
                &input,
            ))
            .await
            .map_err(|_| {
                runner_failure(
                    BrainFailureClass::DurabilityDegraded,
                    BrainFailureStage::Store,
                    "error_kind=answer_attempt_envelope_failed",
                )
            })?;
        // The one-shot fixture replay has no session loop to cancel it.
        let cancel = CancellationToken::new();
        let transcript = self
            .transports
            .transcribe_audio(&self.config, &response_id, &frame, &cancel)
            .await?;
        let phases = SessionPhaseTracker::ready();
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
        events.push(phases.begin_turn()?);
        events.push(phases.phase_event(StudySessionPhase::Thinking)?);

        let mut usage = BrainUsage::default();
        let speech_opened = AtomicBool::new(false);
        let turn = self
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
                speech_opened: &speech_opened,
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
        let outcome = turn.turn_outcome.ok_or_else(missing_turn_outcome_failure)?;
        let source = self
            .retrieve_outcome_source(&executor, &session, &question, &outcome, &response_id)
            .await?;
        let evaluation =
            answer_evaluation_from_outcome(&outcome, &transcript.final_text, &source, &question)?;
        events.extend(learning_event_projection(
            &outcome,
            &response_id,
            &source,
            evaluation,
        ));
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
        if matches!(outcome.resolution, TurnResolution::Evaluated { .. }) {
            require_spoken_response_text(&turn.response_text, &self.config.gemini.model_id)?;
            let mut sink = ReplayFrameSink {
                events: &mut events,
                response_id: &response_id,
            };
            self.transports
                .finish_speech(&self.config, &response_id, interrupt, &cancel, &mut sink)
                .await?;
        }
        events.push(phases.phase_event(StudySessionPhase::Feedback)?);
        events.push(phases.phase_event(StudySessionPhase::Correction)?);
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
        let handle = tokio::spawn(async move {
            runner.emit_turn(job).await;
        });
        ActiveRunnerResponse {
            response_id,
            cancelled,
            completed,
            handle,
        }
    }

    async fn emit_turn(&self, job: RunnerTurnJob) {
        let mut deferred_events = Vec::new();
        let outcome = self.run_turn(&job, &mut deferred_events).await;
        // A turn replaced while its speech context was open must still tell the
        // provider, even if it never reached its own finalizer.
        if job.cancelled.is_cancelled() && job.speech_opened.load(Ordering::SeqCst) {
            self.transports
                .cancel_speech(&self.config, &job.response_id)
                .await;
        }
        if let Err(error) = outcome {
            // A learner's own barge-in or stop is not an incident: a turn that
            // ended because it was cancelled reports no provider error.
            if job.cancelled.is_cancelled() {
                return;
            }
            // A fallback activation is a fact about the attempt that already
            // happened, so it survives the turn's failure.
            for event in deferred_events {
                if !matches!(event, BrainEvent::ProviderFallbackActivated { .. }) {
                    continue;
                }
                if !send_fake_unless_cancelled(&job.event_tx, event, &job.cancelled).await {
                    return;
                }
            }
            emit_provider_failure(&job.event_tx, error).await;
        }
    }

    /// One accepted turn, split into a transport half and a learning half so
    /// source, audio, and phase work cannot recreate an adapter-side learning
    /// authority under a new name.
    async fn run_turn(
        &self,
        job: &RunnerTurnJob,
        deferred_events: &mut Vec<BrainEvent>,
    ) -> Result<(), BrainError> {
        let question = select_session_question(
            &job.executor,
            &job.session.study_set_id,
            &job.session.voice_session_id,
            &job.response_id,
        )
        .await?;
        if job.announce_question
            && !send_fake_unless_cancelled(
                &job.event_tx,
                BrainEvent::QuestionStarted {
                    response_id: job.response_id.clone(),
                    question: question.clone(),
                },
                &job.cancelled,
            )
            .await
        {
            return Ok(());
        }
        job.executor
            .record_answer_attempt_envelope(answer_attempt_envelope(
                &job.session,
                &question,
                &job.response_id,
                job.submission_sequence,
                &job.input,
            ))
            .await
            .map_err(|error| {
                tool_execution_stage_error(
                    "record_answer_attempt_envelope",
                    BrainFailureClass::ToolExecutorFailure,
                    BrainFailureStage::Store,
                    Duration::ZERO,
                    &error,
                    None,
                )
            })?;

        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::InputSpeechStarted,
            &job.cancelled,
        )
        .await
        {
            return Ok(());
        }
        if !send_fake_unless_cancelled(&job.event_tx, job.phases.begin_turn()?, &job.cancelled)
            .await
        {
            return Ok(());
        }
        let transcript = self
            .transcript_for_input(&job.response_id, &job.input, &job.cancelled)
            .await?;
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
            return Ok(());
        }
        // The confidence is the provider's parsed value or nothing. Typed input
        // carries `None` because it is not a speech-recognition score.
        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::TranscriptFinal {
                response_id: job.response_id.clone(),
                text: transcript.final_text.clone(),
                confidence: transcript.confidence,
            },
            &job.cancelled,
        )
        .await
        {
            return Ok(());
        }
        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::InputSpeechStopped,
            &job.cancelled,
        )
        .await
        {
            return Ok(());
        }
        if !send_fake_unless_cancelled(
            &job.event_tx,
            job.phases.phase_event(StudySessionPhase::Thinking)?,
            &job.cancelled,
        )
        .await
        {
            return Ok(());
        }

        let mut usage = BrainUsage::default();
        let turn = self
            .run_gemini_tool_loop(GeminiToolLoopJob {
                answer_text: &transcript.final_text,
                cancelled: Some(&job.cancelled),
                emit_text_delta: false,
                events: deferred_events,
                executor: &job.executor,
                interrupt: FakeRuntimeInterrupt::None,
                question: &question,
                response_id: &job.response_id,
                session: &job.session,
                speech_opened: &job.speech_opened,
                usage: &mut usage,
            })
            .await?;
        for event in std::mem::take(deferred_events) {
            if !send_fake_unless_cancelled(&job.event_tx, event, &job.cancelled).await {
                return Ok(());
            }
        }

        self.emit_learning_stage(job, &question, &transcript.final_text, turn, usage)
            .await
    }

    /// Everything a learner is told about their own answer, and nothing else.
    ///
    /// Every value here is copied out of the persisted outcome. There is no
    /// branch that writes mastery, schedules a review, or authors recap copy.
    async fn emit_learning_stage(
        &self,
        job: &RunnerTurnJob,
        question: &StudyQuestion,
        answer_text: &str,
        turn: GeminiTurnResult,
        usage: BrainUsage,
    ) -> Result<(), BrainError> {
        let speech_opened = turn.speech_opened;
        let outcome = turn.turn_outcome.ok_or_else(missing_turn_outcome_failure)?;
        let evaluated = matches!(outcome.resolution, TurnResolution::Evaluated { .. });
        // A live turn that produced no text has nothing honest to say. There is
        // no shared fallback sentence to fall back to any more.
        let response_text = if evaluated {
            Some(require_spoken_response_text(
                &turn.response_text,
                &self.config.gemini.model_id,
            )?)
        } else {
            None
        };

        let source = self
            .retrieve_outcome_source(
                &job.executor,
                &job.session,
                question,
                &outcome,
                &job.response_id,
            )
            .await?;
        let evaluation = answer_evaluation_from_outcome(&outcome, answer_text, &source, question)?;
        for event in learning_event_projection(&outcome, &job.response_id, &source, evaluation) {
            if !send_fake_unless_cancelled(&job.event_tx, event, &job.cancelled).await {
                return Ok(());
            }
        }

        if usage != BrainUsage::default()
            && !send_fake_unless_cancelled(&job.event_tx, BrainEvent::Usage(usage), &job.cancelled)
                .await
        {
            return Ok(());
        }

        // A deferral is a recovery signal, not a response to speak. The final
        // text already reached the provider as it arrived; all that remains is
        // to close the context and forward each frame as it is decoded.
        if response_text.is_some() && speech_opened {
            let mut sink = RunnerFrameSink {
                event_tx: &job.event_tx,
                response_id: &job.response_id,
                cancelled: &job.cancelled,
                stopped: false,
            };
            self.transports
                .finish_speech(
                    &self.config,
                    &job.response_id,
                    FakeRuntimeInterrupt::None,
                    &job.cancelled,
                    &mut sink,
                )
                .await?;
            if sink.stopped {
                return Ok(());
            }
        }

        for phase in [StudySessionPhase::Feedback, StudySessionPhase::Correction] {
            if !send_fake_unless_cancelled(
                &job.event_tx,
                job.phases.phase_event(phase)?,
                &job.cancelled,
            )
            .await
            {
                return Ok(());
            }
        }
        if !send_fake_unless_cancelled(
            &job.event_tx,
            BrainEvent::ResponseCompleted {
                response_id: job.response_id.to_owned(),
            },
            &job.cancelled,
        )
        .await
        {
            return Ok(());
        }

        // A turn publishes no recap. A recap is a fold over everything the
        // session has persisted, so it is built once, when the learner stops,
        // by `emit_session_recap`. Building one per graded turn published a
        // count that could not see the turns that had not happened yet, so a
        // session whose last turn deferred told the learner "Deferred turns: 0".
        job.completed.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// The session's single recap, folded over every outcome it persisted.
    ///
    /// It is built when the learner stops so its deferral bucket, graded
    /// concepts, and source moments cover the whole session, and it is bound to
    /// a session-scope response identity — not to a turn — so a superseded turn
    /// cannot carry the session's recap down with it. Every value in it is the
    /// Plan 04 executor's; the adapter authors nothing.
    async fn emit_session_recap(
        &self,
        event_tx: &mpsc::Sender<BrainEvent>,
        executor: &VivaToolExecutor,
        session: &AuthorizedStudySession,
        session_generation_id: Option<&str>,
        phases: &SessionPhaseTracker,
    ) {
        let response_id = response_id_for_turn(0, session_generation_id);
        let recap = match execute_tool_stage(
            executor,
            &response_id,
            ToolProposal::build_session_recap(&session.study_set_id, &session.voice_session_id),
            self.config.recap_stage_timeout,
            BrainFailureStage::Recap,
            BrainFailureClass::ToolExecutorFailure,
            None,
        )
        .await
        .and_then(|result| recap_from_tool_result(&result.result))
        {
            Ok(recap) => recap,
            Err(error) => {
                // A recap the store could not build is a typed failure, not a
                // phase transition: the learner is not told to look at a recap
                // that does not exist.
                emit_provider_failure(event_tx, error).await;
                return;
            }
        };
        if event_tx
            .send(BrainEvent::RecapReady { response_id, recap })
            .await
            .is_err()
        {
            return;
        }
        if let Some(event) = phases.phase_event_if_legal(StudySessionPhase::Recap) {
            let _ = event_tx.send(event).await;
        }
    }

    /// The source a persisted outcome cites, re-retrieved through the executor's
    /// deterministic retrieval rather than taken from the model or the question.
    async fn retrieve_outcome_source(
        &self,
        executor: &VivaToolExecutor,
        session: &AuthorizedStudySession,
        question: &StudyQuestion,
        outcome: &TurnOutcome,
        response_id: &str,
    ) -> Result<StudySourceReference, BrainError> {
        let source_id = outcome
            .source_ids
            .first()
            .map_or(question.source.source_id.as_str(), String::as_str);
        execute_tool_stage(
            executor,
            response_id,
            ToolProposal::retrieve_source_reference(
                &session.study_set_id,
                &session.voice_session_id,
                source_id,
            ),
            self.config.tool_stage_timeout,
            BrainFailureStage::Tools,
            BrainFailureClass::ToolExecutorFailure,
            None,
        )
        .await
        .and_then(|result| {
            serde_json::from_value(result.result["source"].clone()).map_err(|_| {
                runner_failure(
                    BrainFailureClass::ToolExecutorFailure,
                    BrainFailureStage::Tools,
                    "error_kind=source_payload_malformed",
                )
            })
        })
    }

    async fn transcript_for_input(
        &self,
        response_id: &str,
        input: &RunnerInput,
        cancel: &CancellationToken,
    ) -> Result<RunnerTranscript, BrainError> {
        match input {
            RunnerInput::Audio { frame, .. } => {
                self.transports
                    .transcribe_audio(&self.config, response_id, frame, cancel)
                    .await
            }
            RunnerInput::Text { text, .. } => Ok(RunnerTranscript {
                interim_text: text.clone(),
                final_text: text.clone(),
                // Typed input carries no speech-recognition confidence, so none
                // is reported.
                confidence: None,
            }),
        }
    }

    async fn run_gemini_tool_loop(
        &self,
        job: GeminiToolLoopJob<'_>,
    ) -> Result<GeminiTurnResult, BrainError> {
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
            speech_opened: speech_opened_flag,
            usage,
        } = job;
        let mut conversation = GeminiConversation::default();
        conversation.push_user_text(answer_text);
        let mut response_prompt = String::new();
        let mut turn_outcome: Option<TurnOutcome> = None;
        let mut speech_opened = false;
        let mut executed_gemini_tool_stages = 0_u32;
        let mut active_gemini = self.config.gemini.clone();
        // A one-shot replay has no session loop to cancel it, so it selects on a
        // token that is never triggered rather than on nothing at all.
        let idle_cancellation = CancellationToken::new();
        let cancel = cancelled.unwrap_or(&idle_cancellation);

        for pass_index in 0..MAX_GEMINI_TOOL_LOOP_PASSES {
            let final_pass = pass_index + 1 >= MAX_GEMINI_TOOL_LOOP_PASSES;
            if cancelled.is_some_and(CancellationToken::is_cancelled) {
                return Ok(GeminiTurnResult {
                    response_text: response_prompt,
                    turn_outcome,
                    speech_opened,
                });
            }
            let mut active_config = self.config.clone();
            active_config.gemini = active_gemini.clone();
            let tools = if final_pass {
                &[] as &[Value]
            } else {
                &active_config.tools
            };
            let request = gemini_request(&active_config.gemini, conversation.snapshot(), tools);
            let gemini_started = Instant::now();
            // The Gemini stage is cooperative too: a barge-in does not wait for
            // the model to finish answering the turn it replaced.
            let attempt = match cancelled {
                Some(cancelled) => tokio::select! {
                    biased;
                    () = cancelled.cancelled() => None,
                    attempt = self.transports.stream_gemini(&active_config, request) => Some(attempt),
                },
                None => Some(self.transports.stream_gemini(&active_config, request).await),
            };
            let Some(attempt) = attempt else {
                return Ok(GeminiTurnResult {
                    response_text: response_prompt,
                    turn_outcome,
                    speech_opened,
                });
            };
            let stream: GeminiEventStream = match attempt {
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
            let mut stream = fake_interrupt_gemini_stream(stream, interrupt);
            let mut saw_tool_call = false;
            while let Some(item) = stream.next().await {
                let event =
                    item.map_err(|error| failure_with_latency(error, gemini_started.elapsed()))?;
                match event {
                    GeminiStreamEvent::FunctionCall { id, name, args, .. } => {
                        saw_tool_call = true;
                        if interrupt == FakeRuntimeInterrupt::CancelDuringGeminiToolCall {
                            return Ok(GeminiTurnResult {
                                response_text: response_prompt,
                                turn_outcome,
                                speech_opened,
                            });
                        }
                        if cancelled.is_some_and(CancellationToken::is_cancelled) {
                            return Ok(GeminiTurnResult {
                                response_text: response_prompt,
                                turn_outcome,
                                speech_opened,
                            });
                        }
                        if final_pass {
                            return Err(gemini_tool_loop_budget_error(
                                &name,
                                &active_gemini.model_id,
                                gemini_started.elapsed(),
                            ));
                        }
                        // Incremental processing makes the budget live: stages
                        // are reserved as the calls arrive, not preflighted from
                        // a buffered batch.
                        reserve_gemini_tool_stage(
                            &mut executed_gemini_tool_stages,
                            &name,
                            &active_gemini.model_id,
                            gemini_started.elapsed(),
                        )?;
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
                                if manuscript_intent_stage(
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
                            BrainFailureStage::Tools,
                            BrainFailureClass::ToolExecutorFailure,
                            Some(&active_gemini.model_id),
                        )
                        .await?;
                        if result.proposal.name() == "evaluate_spoken_answer" {
                            // The executor persisted the outcome; the adapter
                            // only checks the receipt and carries the outcome.
                            turn_outcome =
                                Some(parse_persisted_turn_outcome(&result.result, response_id)?);
                            usage.source_grounded_correction_count =
                                usage.source_grounded_correction_count.saturating_add(1);
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
                        // Only the final, post-outcome pass is an answer to the
                        // learner. First-pass text is the model planning its
                        // tool call, and a turn with no evaluated outcome has
                        // nothing to say: neither reaches the speech provider.
                        if final_pass && evaluated_turn_outcome(turn_outcome.as_ref()) {
                            response_prompt.push_str(&text);
                            if !text.trim().is_empty() {
                                self.transports
                                    .extend_speech(
                                        &self.config,
                                        response_id,
                                        &text,
                                        interrupt,
                                        cancel,
                                    )
                                    .await?;
                                speech_opened = true;
                                speech_opened_flag.store(true, Ordering::SeqCst);
                            }
                        }
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
                    GeminiStreamEvent::Error(_) => {
                        return Err(gemini_tool_stage_error(
                            "gemini_stream",
                            &active_gemini.model_id,
                            gemini_started.elapsed(),
                            "provider_stream_error",
                        ))
                    }
                    GeminiStreamEvent::ModelPart { text: None, .. } => {}
                }
            }
            if !saw_tool_call {
                break;
            }
        }

        Ok(GeminiTurnResult {
            response_text: response_prompt,
            turn_outcome,
            speech_opened,
        })
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
}

/// The runner's speech sink: every decoded frame becomes one `AudioDelta`, at
/// once, unless the turn it belongs to was cancelled.
struct RunnerFrameSink<'a> {
    event_tx: &'a mpsc::Sender<BrainEvent>,
    response_id: &'a str,
    cancelled: &'a CancellationToken,
    stopped: bool,
}

#[async_trait]
impl SpeechFrameSink for RunnerFrameSink<'_> {
    async fn frame(&mut self, frame: AudioFrame) -> bool {
        let delivered = send_fake_unless_cancelled(
            self.event_tx,
            BrainEvent::AudioDelta {
                response_id: self.response_id.to_owned(),
                frame,
            },
            self.cancelled,
        )
        .await;
        if !delivered {
            self.stopped = true;
        }
        delivered
    }
}

/// The fixture replay's speech sink: frames land in the reported event list.
struct ReplayFrameSink<'a> {
    events: &'a mut Vec<BrainEvent>,
    response_id: &'a str,
}

#[async_trait]
impl SpeechFrameSink for ReplayFrameSink<'_> {
    async fn frame(&mut self, frame: AudioFrame) -> bool {
        self.events.push(BrainEvent::AudioDelta {
            response_id: self.response_id.to_owned(),
            frame,
        });
        true
    }
}

/// Live model output with no text is a typed provider failure. It is never
/// replaced with a stock sentence about a topic this session may not even be
/// studying.
fn require_spoken_response_text<'a>(
    response_text: &'a str,
    model: &str,
) -> Result<&'a str, BrainError> {
    if response_text.trim().is_empty() {
        return Err(gemini_tool_stage_error(
            "gemini_stream",
            model,
            Duration::ZERO,
            "empty_model_output",
        ));
    }
    Ok(response_text)
}

/// A turn whose provider never called the evaluation tool produced no learner
/// fact at all, so there is nothing to emit and nothing to invent.
fn missing_turn_outcome_failure() -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::MalformedStream,
        stage: BrainFailureStage::Gemini,
        retry_eligible: true,
        latency_ms: 0,
        provider: "gemini".to_owned(),
        model: "gemini".to_owned(),
        metadata: "error_kind=missing_turn_outcome".to_owned(),
    })
}

fn runner_failure(
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    metadata: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible: true,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "viva-tools".to_owned(),
        metadata: metadata.to_owned(),
    })
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
    speech_opened: &'a AtomicBool,
    cancelled: Option<&'a CancellationToken>,
}

async fn execute_tool_stage(
    executor: &VivaToolExecutor,
    response_id: &str,
    proposal: ToolProposal,
    deadline: Duration,
    stage: BrainFailureStage,
    failure_class: BrainFailureClass,
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
            BrainFailureClass::Timeout,
            stage,
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

/// Only an evaluated outcome authorizes speech.
fn evaluated_turn_outcome(outcome: Option<&TurnOutcome>) -> bool {
    outcome.is_some_and(|outcome| matches!(outcome.resolution, TurnResolution::Evaluated { .. }))
}

/// A server-side stage failure. The class is chosen where the failure is
/// observed and the metadata carries only an allowlisted tool name plus a closed
/// `error_kind` token.
pub(crate) fn tool_stage_error(
    tool_name: &str,
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    retry_eligible: bool,
    latency: Duration,
    error_kind: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible,
        latency_ms: duration_ms(latency),
        provider: "server".to_owned(),
        model: "viva-tools".to_owned(),
        metadata: tool_stage_metadata(tool_name, error_kind),
    })
}

/// Classify one executor failure from its typed variant.
///
/// `PortErrorKind` is the store-side half of the boundary: a durability kind is
/// a durability-degraded failure at the store stage, and nothing here reads a
/// message to decide.
fn tool_execution_stage_error(
    tool_name: &str,
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    latency: Duration,
    error: &ToolExecutionError,
    gemini_model: Option<&str>,
) -> BrainError {
    if let ToolExecutionError::Store(port_error) = error {
        if port_error.is_durability() {
            return tool_stage_error(
                tool_name,
                BrainFailureClass::DurabilityDegraded,
                BrainFailureStage::Store,
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

fn gemini_tool_stage_error(
    tool_name: &str,
    model: &str,
    latency: Duration,
    error_kind: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::MalformedStream,
        stage: BrainFailureStage::Gemini,
        retry_eligible: true,
        latency_ms: duration_ms(latency),
        provider: "gemini".to_owned(),
        model: model.to_owned(),
        metadata: tool_stage_metadata(tool_name, error_kind),
    })
}

fn gemini_tool_loop_budget_error(tool_name: &str, model: &str, latency: Duration) -> BrainError {
    gemini_tool_stage_error(tool_name, model, latency, "tool_loop_budget_exceeded")
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

fn tool_execution_error_kind(error: &ToolExecutionError) -> &'static str {
    match error {
        ToolExecutionError::InvalidArguments(_) => "invalid_arguments",
        ToolExecutionError::Unavailable(_) => "unavailable",
        ToolExecutionError::Store(_) => "store",
        ToolExecutionError::ReviewSchedule(_) => "review_schedule",
        ToolExecutionError::RecapEvidence(_) => "recap_evidence",
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
        "emit_manuscript_intent" => "emit_manuscript_intent",
        "build_session_recap" => "build_session_recap",
        "challenge_correction" => "challenge_correction",
        "record_answer_attempt_envelope" => "record_answer_attempt_envelope",
        "gemini_stream" => "gemini_stream",
        _ => "unrecognized_tool",
    }
}

#[cfg(test)]
mod fallback_tests {
    use super::*;
    use agent_domain::{SessionId, StudyMode, TerminalSessionReason};

    use super::tests::learning_ready_seeded_store;

    #[test]
    fn invalid_tool_arguments_classify_as_malformed_provider_stream() {
        let error = tool_execution_stage_error(
            "unknown_tool",
            BrainFailureClass::ToolExecutorFailure,
            BrainFailureStage::Tools,
            Duration::from_millis(42),
            &ToolExecutionError::InvalidArguments("unknown tool".to_owned()),
            Some("gemini-test-model"),
        );
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-test-model");
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderMalformedStream
        );
        assert!(failure.retry_eligible());
        assert_eq!(failure.latency_ms(), 42);
        assert!(failure.metadata().contains("tool=unrecognized_tool"));
        assert!(failure.metadata().contains("error_kind=invalid_arguments"));
    }

    #[test]
    fn unavailable_gemini_tool_targets_classify_as_malformed_provider_stream() {
        let error = tool_execution_stage_error(
            "retrieve_source_reference",
            BrainFailureClass::ToolExecutorFailure,
            BrainFailureStage::Tools,
            Duration::from_millis(17),
            &ToolExecutionError::Unavailable("source is unavailable".to_owned()),
            Some("gemini-test-model"),
        );
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-test-model");
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderMalformedStream
        );
        assert!(failure.retry_eligible());
        assert_eq!(failure.latency_ms(), 17);
        assert_eq!(
            failure.metadata(),
            "tool=retrieve_source_reference error_kind=unavailable"
        );
    }

    #[test]
    fn durable_tool_store_errors_classify_as_durability_degraded() {
        let error = tool_execution_stage_error(
            "build_session_recap",
            BrainFailureClass::ToolExecutorFailure,
            BrainFailureStage::Tools,
            Duration::from_millis(29),
            &ToolExecutionError::Store(agent_domain::PortError::durability(
                "postgres",
                "voice-session-1",
                "durable store write failed",
            )),
            Some("gemini-test-model"),
        );
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::DurabilityDegraded
        );
        assert_eq!(failure.stage(), BrainFailureStage::Store);
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::DurabilityDegraded
        );
        assert!(failure.retry_eligible());
        assert_eq!(failure.latency_ms(), 29);
        assert_eq!(failure.provider(), "server");
        assert_eq!(failure.model(), "viva-tools");
        assert_eq!(
            failure.metadata(),
            "tool=build_session_recap error_kind=durability_degraded"
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
        let failure = error.failure();

        assert_eq!(
            failure.metadata(),
            "tool=unrecognized_tool error_kind=invalid_arguments"
        );
        assert!(!failure.metadata().contains("raw answer text"));
        assert!(!failure.metadata().contains("source excerpt"));
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
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderMalformedStream
        );
        assert_eq!(
            failure.metadata(),
            "tool=emit_manuscript_intent error_kind=tool_loop_budget_exceeded"
        );
    }

    /// Task 5 (`ADAPTER-05`) replaced the pre-buffer batch scan with a live,
    /// per-call reservation: a streamed response has no batch to preflight.
    /// The budget therefore stops the call that exceeds it — every earlier call
    /// in the same response is a stage the model was entitled to.
    #[tokio::test]
    async fn gemini_tool_stages_are_reserved_as_calls_arrive_and_stop_at_the_budget() {
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-over-budget",
        )
        .await
        .expect("the session cursor selects a question");
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            OverBudgetGeminiToolBatchTransports,
            store.clone(),
            evaluator,
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let speech_opened = AtomicBool::new(false);
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
                speech_opened: &speech_opened,
                usage: &mut usage,
            })
            .await
            .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderMalformedStream
        );
        assert_eq!(
            failure.metadata(),
            "tool=evaluate_spoken_answer error_kind=tool_loop_budget_exceeded"
        );
        assert!(events
            .iter()
            .all(|event| !matches!(event, BrainEvent::AnswerEvaluated { .. })));
        // Exactly the budget was spent, and the call that would have exceeded it
        // never executed: the loop stops at the boundary rather than after it.
        assert_eq!(
            usage.source_grounded_correction_count,
            u64::from(MAX_GEMINI_EXECUTED_TOOL_STAGES),
            "the budget is spent, and no further stage runs"
        );
        assert!(store.snapshot().answer_attempts.is_empty());
    }

    #[test]
    fn server_tool_invalid_arguments_remain_tool_executor_failures() {
        let error = tool_execution_stage_error(
            "build_session_recap",
            BrainFailureClass::ToolExecutorFailure,
            BrainFailureStage::Tools,
            Duration::from_millis(11),
            &ToolExecutionError::InvalidArguments("bad server proposal".to_owned()),
            None,
        );
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::ToolExecutorFailure
        );
        assert_eq!(failure.stage(), BrainFailureStage::Tools);
        assert_eq!(failure.provider(), "server");
        assert_eq!(failure.model(), "viva-tools");
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ToolExecutorFailure
        );
        assert!(failure.retry_eligible());
        assert_eq!(failure.latency_ms(), 11);
        assert!(failure.metadata().contains("tool=build_session_recap"));
        assert!(failure.metadata().contains("error_kind=invalid_arguments"));
    }

    #[test]
    fn gemini_sse_error_events_preserve_elapsed_latency() {
        let error = gemini_tool_stage_error(
            "gemini_stream",
            "gemini-test-model",
            Duration::from_millis(73),
            "provider_stream_error",
        );
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-test-model");
        assert_eq!(failure.latency_ms(), 73);
        assert_eq!(
            failure.terminal_reason(),
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
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            unreachable!("test calls Gemini tool loop directly")
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            Ok(fixture_gemini_stream(
                (0..=MAX_GEMINI_EXECUTED_TOOL_STAGES)
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
                .collect(),
            ))
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            unreachable!("test calls Gemini tool loop directly")
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            unreachable!("test calls Gemini tool loop directly")
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

    use agent_domain::{SessionId, StudyMode};

    /// The seeded development set publishes concept ids its own question's rubric
    /// does not name, so a graded turn needs the rubric's concepts published
    /// before the executor can bind a prior status to them.
    pub(crate) fn learning_ready_seeded_store() -> Arc<data::InMemoryStudyStore> {
        let store = data::InMemoryStudyStore::seeded_fixture();
        let question = agent_domain::fixture_question();
        let mut concept_ids = vec![
            "oxidative-phosphorylation".to_owned(),
            "nadh".to_owned(),
            "atp-synthase".to_owned(),
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
                status: agent_domain::ConceptStatus::Review,
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

    #[tokio::test]
    async fn gemini_tool_loop_keeps_fallback_model_for_tool_continuations() {
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-1",
        )
        .await
        .unwrap();
        let transports = FallbackContinuationCaptureTransports::default();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let speech_opened = AtomicBool::new(false);
        let turn = runner
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
                speech_opened: &speech_opened,
                usage: &mut usage,
            })
            .await
            .unwrap();

        assert_eq!(turn.response_text, "fallback continuation");
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
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-1",
        )
        .await
        .unwrap();
        let transports = FallbackContinuationCaptureTransports::default();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
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
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let speech_opened = AtomicBool::new(false);
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
                speech_opened: &speech_opened,
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
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-1",
        )
        .await
        .unwrap();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            FallbackToolLoopBudgetTransports,
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let speech_opened = AtomicBool::new(false);
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
                speech_opened: &speech_opened,
                usage: &mut usage,
            })
            .await
            .unwrap_err();

        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
        assert!(failure
            .metadata()
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
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-1",
        )
        .await
        .unwrap();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            GeminiStreamErrorTransports {
                delay: Duration::from_millis(5),
            },
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let speech_opened = AtomicBool::new(false);
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
                speech_opened: &speech_opened,
                usage: &mut usage,
            })
            .await
            .unwrap_err();

        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-pro");
        assert!(failure.latency_ms() > 0);
    }

    #[tokio::test]
    async fn gemini_tool_loop_emits_fallback_activation_before_returning_failure() {
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-1",
        )
        .await
        .unwrap();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            FallbackFailureTransports,
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();

        let speech_opened = AtomicBool::new(false);
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
                speech_opened: &speech_opened,
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
        let failure = error.failure();
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
    }

    #[tokio::test]
    async fn emit_turn_drains_fallback_activation_before_provider_failure() {
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            FallbackFailureTransports,
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let (event_tx, mut event_rx) = mpsc::channel(16);

        runner
            .emit_turn(RunnerTurnJob {
                event_tx,
                executor,
                session,
                response_id: "response-1".to_owned(),
                submission_sequence: 1,
                input: RunnerInput::Text {
                    text: "omitted".to_owned(),
                    client_generation_id: None,
                },
                phases: SessionPhaseTracker::ready(),
                announce_question: false,
                speech_opened: Arc::new(AtomicBool::new(false)),
                cancelled: CancellationToken::new(),
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
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            FallbackContinuationFailureAfterToolTransports::default(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let (event_tx, mut event_rx) = mpsc::channel(16);

        runner
            .emit_turn(RunnerTurnJob {
                event_tx,
                executor,
                session,
                response_id: "response-1".to_owned(),
                submission_sequence: 1,
                input: RunnerInput::Text {
                    text: "omitted".to_owned(),
                    client_generation_id: None,
                },
                phases: SessionPhaseTracker::ready(),
                announce_question: false,
                speech_opened: Arc::new(AtomicBool::new(false)),
                cancelled: CancellationToken::new(),
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
    struct FallbackToolLoopBudgetTransports;

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
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            config: &CartesiaGeminiConfig,
            request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
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
                Ok(fixture_gemini_stream(vec![
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
                ]))
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
                Ok(fixture_gemini_stream(vec![GeminiStreamEvent::ModelPart {
                    text: Some("fallback continuation".to_owned()),
                    part: json!({ "text": "fallback continuation" }),
                }]))
            }
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackFailureTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            Err(GeminiStreamAttemptFailure {
                events: vec![GeminiStreamEvent::FallbackActivated {
                    from_model: "gemini-3.5-pro".to_owned(),
                    to_model: "gemini-3.5-flash".to_owned(),
                    reason: "primary_429".to_owned(),
                    failure: None,
                }],
                error: brain_failure(BrainProviderFailureParts {
                    failure_class: BrainFailureClass::Timeout,
                    stage: BrainFailureStage::Gemini,
                    retry_eligible: true,
                    latency_ms: 1,
                    provider: "gemini".to_owned(),
                    model: "gemini-3.5-flash".to_owned(),
                    metadata: "error_kind=deadline_elapsed".to_owned(),
                }),
            })
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackContinuationFailureAfterToolTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
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
                return Ok(fixture_gemini_stream(vec![
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
                ]));
            }

            Err(GeminiStreamAttemptFailure {
                events: Vec::new(),
                error: brain_failure(BrainProviderFailureParts {
                    failure_class: BrainFailureClass::Timeout,
                    stage: BrainFailureStage::Gemini,
                    retry_eligible: true,
                    latency_ms: 1,
                    provider: "gemini".to_owned(),
                    model: "gemini-3.5-flash".to_owned(),
                    metadata: "error_kind=deadline_elapsed".to_owned(),
                }),
            })
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for FallbackToolLoopBudgetTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            let mut stream = vec![GeminiStreamEvent::FallbackActivated {
                from_model: "gemini-3.5-pro".to_owned(),
                to_model: "gemini-3.5-flash".to_owned(),
                reason: "primary_429".to_owned(),
                failure: None,
            }];
            stream.extend((0..=MAX_GEMINI_EXECUTED_TOOL_STAGES).map(|index| {
                GeminiStreamEvent::FunctionCall {
                    id: format!("call-intent-{index}"),
                    name: "emit_manuscript_intent".to_owned(),
                    args: json!({}),
                    part: json!({
                        "functionCall": {
                            "id": format!("call-intent-{index}"),
                            "name": "emit_manuscript_intent",
                            "args": {},
                        }
                    }),
                }
            }));
            Ok(fixture_gemini_stream(stream))
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for GeminiStreamErrorTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            tokio::time::sleep(self.delay).await;
            Ok(fixture_gemini_stream(vec![GeminiStreamEvent::Error(
                "Gemini stream provider error".to_owned(),
            )]))
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct AssembledTurnCardinalityTransports {
        transcribed_bytes: Arc<Mutex<Vec<usize>>>,
        gemini_calls: Arc<Mutex<u32>>,
    }

    #[async_trait]
    impl CartesiaGeminiTransports for AssembledTurnCardinalityTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            self.transcribed_bytes
                .lock()
                .expect("transcribed bytes lock poisoned")
                .push(frame.pcm16_bytes().len());
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "one assembled browser turn".to_owned(),
                confidence: Some(0.9),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            *self
                .gemini_calls
                .lock()
                .expect("gemini calls lock poisoned") += 1;
            Ok(fixture_gemini_stream(vec![GeminiStreamEvent::ModelPart {
                text: Some("one provider turn".to_owned()),
                part: json!({ "text": "one provider turn" }),
            }]))
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    /// The assembler hands the runner one `AudioFrame` per completed browser turn,
    /// no matter how many bounded chunks the browser streamed to build it.
    #[tokio::test]
    async fn completed_forty_five_second_turn_transcribes_once_for_one_provider_turn() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let transports = AssembledTurnCardinalityTransports::default();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner.open(session_config).await.expect("runner opens");

        // 45 seconds of mono pcm_s16le at 24 kHz, assembled from 2,250 bounded chunks.
        let assembled = AudioFrame::from_pcm16_bytes(vec![0_u8; 2_160_000]);
        session
            .input
            .send(BrainInput::AudioWithMetadata {
                frame: assembled,
                client_generation_id: Some("generation-1".to_owned()),
            })
            .await
            .expect("sends one assembled turn");

        let mut transcripts = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(250), session.events.recv()).await {
                Ok(Some(BrainEvent::TranscriptFinal { text, .. })) => transcripts.push(text),
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break,
            }
        }

        assert_eq!(transcripts, vec!["one assembled browser turn".to_owned()]);
        assert_eq!(
            transports
                .transcribed_bytes
                .lock()
                .expect("transcribed bytes lock poisoned")
                .as_slice(),
            [2_160_000]
        );
        assert_eq!(
            *transports
                .gemini_calls
                .lock()
                .expect("gemini calls lock poisoned"),
            1
        );
    }

    // -----------------------------------------------------------------
    // Task 5 (`ADAPTER-05`): only the final, post-outcome response is spoken.
    //
    // A first-pass part is the model planning its tool call, not an answer to
    // the learner; a turn whose evaluation was deferred has nothing to say at
    // all. Neither may reach the speech provider.
    // -----------------------------------------------------------------

    /// A latch a test can open once. Awaiting it is cancel-safe, so a `select!`
    /// arm may drop the wait without losing the release.
    struct Latch {
        permits: tokio::sync::Semaphore,
    }

    impl Latch {
        fn closed() -> Self {
            Self {
                permits: tokio::sync::Semaphore::new(0),
            }
        }

        fn open(&self) {
            self.permits.add_permits(1);
        }

        async fn wait(&self) {
            let _permit = self.permits.acquire().await.expect("the latch is alive");
        }
    }

    // -----------------------------------------------------------------
    // Task 5 (`ADAPTER-05`): the final answer reaches the learner's ears while
    // the providers are still producing it.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn sonic_emits_first_audio_delta_before_done() {
        let store = two_question_seeded_store();
        let script = Arc::new(StreamingSpeechScript::new());
        // Only the speech provider's `done` is held back here: the model itself
        // finishes normally.
        script.release_gemini_eof();
        let transports = StreamingSpeechTransports::new(Arc::clone(&script));
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports,
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner
            .open(scripted_session_config("voice-session-1"))
            .await
            .unwrap();
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();

        // The provider delivers one chunk, then holds `done` back.
        let mut events = Vec::new();
        let first_audio = loop {
            let event = timeout(Duration::from_secs(10), session.events.recv())
                .await
                .expect("the first audio frame arrives before the provider is done")
                .expect("the session stays open");
            if let BrainEvent::AudioDelta { response_id, frame } = &event {
                break (response_id.clone(), frame.pcm16_bytes().to_vec());
            }
            if let BrainEvent::Error(error) = &event {
                panic!("unexpected provider failure: {error:?}");
            }
            events.push(event);
        };

        assert_eq!(first_audio.0, "response-1");
        assert_eq!(first_audio.1, vec![1_u8, 2]);
        assert!(
            !script.done_released(),
            "the first AudioDelta must precede the provider's `done`"
        );

        script.release_done();
        drain_until_response_completed(&mut session).await;
    }

    #[tokio::test]
    async fn final_gemini_text_continuations_feed_sonic_before_gemini_eof() {
        let store = two_question_seeded_store();
        let script = Arc::new(StreamingSpeechScript::new());
        let transports = StreamingSpeechTransports::new(Arc::clone(&script));
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports,
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner
            .open(scripted_session_config("voice-session-1"))
            .await
            .unwrap();
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();

        // Both final-pass parts must reach Sonic while the Gemini body is still
        // open. The latch is only released once they have.
        let mut events = Vec::new();
        loop {
            tokio::select! {
                biased;
                () = script.both_continuations_written() => break,
                event = session.events.recv() => events.push(event.expect("the session stays open")),
            }
        }
        assert!(
            !script.gemini_eof_released(),
            "Sonic must receive the continuations before the Gemini body ends"
        );

        let written = script.sonic_writes();
        let continuations = written
            .iter()
            .filter(|value| value["continue"] == serde_json::Value::Bool(true))
            .map(|value| value["transcript"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            continuations,
            vec![
                FINAL_RESPONSE_PART_ONE.to_owned(),
                FINAL_RESPONSE_PART_TWO.to_owned()
            ],
            "{written:?}"
        );
        assert!(
            written
                .iter()
                .all(|value| value["continue"] != serde_json::Value::Bool(false)),
            "the finalizer may not be written before the model has finished: {written:?}"
        );

        script.release_gemini_eof();
        script.release_done();
        drain_until_response_completed(&mut session).await;

        let written = script.sonic_writes();
        let finalizers = written
            .iter()
            .filter(|value| value["continue"] == serde_json::Value::Bool(false))
            .collect::<Vec<_>>();
        assert_eq!(
            finalizers.len(),
            1,
            "exactly one explicit finalizer closes the context: {written:?}"
        );
        assert_eq!(finalizers[0]["context_id"], "response-1");
        let finalizer_index = written
            .iter()
            .position(|value| value["continue"] == serde_json::Value::Bool(false))
            .expect("the finalizer was written");
        assert_eq!(
            finalizer_index,
            written.len() - 1,
            "the finalizer is the last thing written to the context: {written:?}"
        );
    }

    const FINAL_RESPONSE_PART_ONE: &str = "That holds up. ";
    const FINAL_RESPONSE_PART_TWO: &str = "Here is the next question.";

    /// One scripted provider pair: a Gemini body whose EOF the test holds back,
    /// and a Sonic connection whose `done` the test holds back.
    struct StreamingSpeechScript {
        sonic_writes: std::sync::Mutex<Vec<Value>>,
        continuations: AtomicU32,
        continuations_written: Latch,
        gemini_eof: Latch,
        gemini_eof_released: AtomicBool,
        done: Latch,
        done_released: AtomicBool,
    }

    impl StreamingSpeechScript {
        fn new() -> Self {
            Self {
                sonic_writes: std::sync::Mutex::new(Vec::new()),
                continuations: AtomicU32::new(0),
                continuations_written: Latch::closed(),
                gemini_eof: Latch::closed(),
                gemini_eof_released: AtomicBool::new(false),
                done: Latch::closed(),
                done_released: AtomicBool::new(false),
            }
        }

        fn sonic_writes(&self) -> Vec<Value> {
            self.sonic_writes
                .lock()
                .expect("sonic write lock poisoned")
                .clone()
        }

        async fn both_continuations_written(&self) {
            self.continuations_written.wait().await;
        }

        fn release_gemini_eof(&self) {
            self.gemini_eof_released.store(true, Ordering::SeqCst);
            self.gemini_eof.open();
        }

        fn gemini_eof_released(&self) -> bool {
            self.gemini_eof_released.load(Ordering::SeqCst)
        }

        fn release_done(&self) {
            self.done_released.store(true, Ordering::SeqCst);
            self.done.open();
        }

        fn done_released(&self) -> bool {
            self.done_released.load(Ordering::SeqCst)
        }

        fn record_sonic_write(&self, value: &Value) {
            self.sonic_writes
                .lock()
                .expect("sonic write lock poisoned")
                .push(value.clone());
            if value.get("continue").and_then(Value::as_bool) == Some(true)
                && self.continuations.fetch_add(1, Ordering::SeqCst) + 1 == 2
            {
                self.continuations_written.open();
            }
        }
    }

    #[derive(Clone)]
    struct StreamingSpeechTransports {
        script: Arc<StreamingSpeechScript>,
        voice: Arc<super::super::tts::SonicSessionVoice>,
    }

    impl StreamingSpeechTransports {
        fn new(script: Arc<StreamingSpeechScript>) -> Self {
            let voice = Arc::new(super::super::tts::SonicSessionVoice::new(Arc::new(
                StreamingSonicConnector {
                    script: Arc::clone(&script),
                },
            )));
            Self { script, voice }
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for StreamingSpeechTransports {
        fn open_session(&self) -> Self {
            Self {
                script: Arc::clone(&self.script),
                voice: Arc::new(super::super::tts::SonicSessionVoice::new(Arc::new(
                    StreamingSonicConnector {
                        script: Arc::clone(&self.script),
                    },
                ))),
            }
        }

        async fn close_session(&self) {
            self.voice.close().await;
        }

        async fn cancel_speech(&self, _config: &CartesiaGeminiConfig, response_id: &str) {
            self.voice.cancel_context(response_id).await;
        }

        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "a spoken answer".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            request: Value,
        ) -> Result<super::super::llm::GeminiEventStream, GeminiStreamAttemptFailure> {
            let final_pass = request["contents"]
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
            if !final_pass {
                let args = json!({
                    "study_set_id": "biology-midterm",
                    "voice_session_id": "voice-session-1",
                    "question_id": "q-oxidative-phosphorylation-nadh",
                    "answer_text": "a spoken answer",
                });
                return Ok(Box::pin(futures_util::stream::iter(vec![Ok(
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
                )])));
            }
            // The final pass hands over two text parts and then holds the body
            // open until the test says otherwise.
            let script = Arc::clone(&self.script);
            let parts = std::collections::VecDeque::from([
                FINAL_RESPONSE_PART_ONE,
                FINAL_RESPONSE_PART_TWO,
            ]);
            Ok(Box::pin(futures_util::stream::unfold(
                (parts, script, false),
                |(mut parts, script, done)| async move {
                    if done {
                        return None;
                    }
                    if let Some(text) = parts.pop_front() {
                        return Some((
                            Ok(GeminiStreamEvent::ModelPart {
                                part: json!({ "text": text }),
                                text: Some(text.to_owned()),
                            }),
                            (parts, script, false),
                        ));
                    }
                    script.gemini_eof.wait().await;
                    None
                },
            )))
        }

        async fn extend_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            self.voice
                .extend(&config.sonic, "sk_car_stream_secret", response_id, text)
                .await
        }

        async fn finish_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            cancel: &CancellationToken,
            sink: &mut dyn super::super::tts::SpeechFrameSink,
        ) -> Result<(), BrainError> {
            self.voice
                .finish(&config.sonic, response_id, cancel, sink)
                .await
        }
    }

    struct StreamingSonicConnector {
        script: Arc<StreamingSpeechScript>,
    }

    #[async_trait]
    impl super::super::tts::SonicConnector for StreamingSonicConnector {
        type Socket = StreamingSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, BrainError> {
            Ok(StreamingSonicSocket {
                script: Arc::clone(&self.script),
                pending: std::collections::VecDeque::new(),
                finalized_context: None,
                done_sent: false,
                open: true,
            })
        }
    }

    struct StreamingSonicSocket {
        script: Arc<StreamingSpeechScript>,
        pending: std::collections::VecDeque<String>,
        finalized_context: Option<String>,
        done_sent: bool,
        open: bool,
    }

    #[async_trait]
    impl super::super::tts::SonicSocket for StreamingSonicSocket {
        async fn send_json(&mut self, value: Value) -> Result<(), BrainError> {
            self.script.record_sonic_write(&value);
            if value.get("cancel").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if value.get("continue").and_then(Value::as_bool) == Some(false) {
                let context_id = value["context_id"]
                    .as_str()
                    .expect("every generation names its context")
                    .to_owned();
                // The provider starts speaking as soon as the context closes.
                self.pending.push_back(format!(
                    r#"{{"type":"chunk","context_id":"{context_id}","data":"AQI="}}"#
                ));
                self.finalized_context = Some(context_id);
            }
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, BrainError> {
            if let Some(text) = self.pending.pop_front() {
                return Ok(Some(text));
            }
            if let Some(context_id) = self.finalized_context.clone() {
                if !self.done_sent {
                    // `done` is held back so the first frame must already have
                    // reached the learner.
                    self.script.done.wait().await;
                    self.done_sent = true;
                    return Ok(Some(format!(
                        r#"{{"type":"done","context_id":"{context_id}"}}"#
                    )));
                }
            }
            self.open = false;
            Ok(None)
        }

        fn is_open(&self) -> bool {
            self.open
        }

        async fn close(&mut self) -> Result<(), BrainError> {
            self.open = false;
            Ok(())
        }
    }

    const FIRST_PASS_PLANNING_TEXT: &str = "planning: I should evaluate this answer first.";
    const FINAL_RESPONSE_TEXT: &str = "That holds up. Here is the next question.";

    #[tokio::test]
    async fn first_pass_or_unevaluated_text_is_never_spoken() {
        let store = two_question_seeded_store();
        let transports = SpeechRecordingTransports::default();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            Arc::clone(&store) as Arc<dyn StudyMemoryStore>,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner
            .open(scripted_session_config("voice-session-1"))
            .await
            .unwrap();
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();
        drain_until_response_completed(&mut session).await;

        let spoken = transports.spoken();
        assert_eq!(
            spoken.len(),
            1,
            "exactly one response context is opened for an evaluated turn: {spoken:?}"
        );
        assert_eq!(spoken[0].0, "response-1");
        assert!(
            spoken[0].1.contains(FINAL_RESPONSE_TEXT),
            "the final response must be spoken: {spoken:?}"
        );
        assert!(
            !spoken[0].1.contains(FIRST_PASS_PLANNING_TEXT),
            "first-pass tool-planning text must never reach the speech provider: {spoken:?}"
        );

        // A turn whose evaluation was deferred opens no speech context at all.
        let deferring = SpeechRecordingTransports::default();
        let deferred_runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            deferring.clone(),
            store,
            Arc::new(DeferringEvaluator) as Arc<dyn AnswerEvaluator>,
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut deferred_session = deferred_runner
            .open(scripted_session_config("voice-session-2"))
            .await
            .unwrap();
        deferred_session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                5_u8, 6, 7, 8,
            ])))
            .await
            .unwrap();
        let mut deferred_events = Vec::new();
        loop {
            let event = timeout(Duration::from_secs(10), deferred_session.events.recv())
                .await
                .expect("the deferred turn completes")
                .expect("the session stays open");
            let completed = matches!(&event, BrainEvent::ResponseCompleted { .. });
            deferred_events.push(event);
            if completed {
                break;
            }
        }
        assert!(
            deferred_events
                .iter()
                .any(|event| matches!(event, BrainEvent::TurnDeferred { .. })),
            "the control only means something if the turn really deferred: {deferred_events:?}"
        );
        assert!(
            deferring.spoken().is_empty(),
            "a deferred turn opens no speech context: {:?}",
            deferring.spoken()
        );
    }

    /// Always defers, so the executor persists a deferred outcome.
    struct DeferringEvaluator;

    #[async_trait]
    impl AnswerEvaluator for DeferringEvaluator {
        async fn evaluate(
            &self,
            _request: &agent_domain::EvaluationRequest,
        ) -> Result<agent_domain::EvaluationDecision, agent_domain::EvaluationError> {
            Ok(agent_domain::EvaluationDecision::Deferred {
                reason: agent_domain::EvaluationDeferralReason::InsufficientSemanticEvidence,
                can_retry_same_question: true,
            })
        }
    }

    /// Fixture Ink, a two-pass Gemini script that speaks on both passes, and a
    /// speech transport that records every context it was asked to open.
    #[derive(Clone, Default)]
    struct SpeechRecordingTransports {
        spoken: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    impl SpeechRecordingTransports {
        fn spoken(&self) -> Vec<(String, String)> {
            self.spoken.lock().expect("spoken lock poisoned").clone()
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for SpeechRecordingTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "a spoken answer".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            let final_pass = request["contents"]
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
            if final_pass {
                return Ok(fixture_gemini_stream(vec![GeminiStreamEvent::ModelPart {
                    part: json!({ "text": FINAL_RESPONSE_TEXT }),
                    text: Some(FINAL_RESPONSE_TEXT.to_owned()),
                }]));
            }
            let args = json!({
                "study_set_id": "biology-midterm",
                "voice_session_id": "voice-session-1",
                "question_id": "q-oxidative-phosphorylation-nadh",
                "answer_text": "a spoken answer",
            });
            Ok(fixture_gemini_stream(vec![
                // The model narrates its plan next to the tool call. That text
                // is not an answer to the learner.
                GeminiStreamEvent::ModelPart {
                    part: json!({ "text": FIRST_PASS_PLANNING_TEXT }),
                    text: Some(FIRST_PASS_PLANNING_TEXT.to_owned()),
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
            ]))
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            response_id: &str,
            text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            let mut spoken = self.spoken.lock().expect("spoken lock poisoned");
            match spoken.iter_mut().find(|(id, _)| id == response_id) {
                Some((_, spoken_text)) => spoken_text.push_str(text),
                None => spoken.push((response_id.to_owned(), text.to_owned())),
            }
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            let _ = response_id;
            sink.frame(AudioFrame::from_pcm16_bytes(vec![1, 2])).await;
            Ok(())
        }
    }

    // -----------------------------------------------------------------
    // Task 4 (`ADAPTER-04`): one HTTP connection pool, one session-scoped Sonic
    // connection, and connection state that belongs to a learner session rather
    // than to a process-global pool or to a single turn.
    //
    // Every assertion below is a causal counter — accepted TCP connections,
    // provider dials, provider closes, per-socket writes — never a timing
    // threshold.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn sonic_two_turns_use_one_socket_and_distinct_contexts() {
        let store = two_question_seeded_store();
        let transports = SessionScopedSonicTransports::new(SonicSocketLifetime::Healthy);
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner
            .open(scripted_session_config("voice-session-1"))
            .await
            .unwrap();

        for bytes in [vec![1_u8, 2, 3, 4], vec![5_u8, 6, 7, 8]] {
            session
                .input
                .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(bytes)))
                .await
                .unwrap();
            drain_until_response_completed(&mut session).await;
        }

        assert_eq!(
            transports.connects(),
            1,
            "one session-duration Sonic connection serves both response contexts"
        );
        let contexts = transports.generation_contexts();
        assert_eq!(
            contexts,
            vec!["response-1".to_owned(), "response-2".to_owned()]
        );
        assert_eq!(
            transports.closes(),
            0,
            "the session connection is not closed between turns"
        );

        session.input.send(BrainInput::Stop).await.unwrap();
        drain_until_session_end(&mut session).await;
        assert_eq!(
            transports.closes(),
            1,
            "session stop closes the provider connection exactly once"
        );
    }

    #[tokio::test]
    async fn provider_connections_are_session_scoped_and_closed_on_stop() {
        let store = two_question_seeded_store();
        let transports = SessionScopedSonicTransports::new(SonicSocketLifetime::Healthy);
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );

        let mut first = runner
            .open(scripted_session_config_for(
                "voice-session-1",
                Some("session-a"),
            ))
            .await
            .unwrap();
        first
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();
        drain_until_response_completed(&mut first).await;

        // A second learner session gets its own provider session state: its own
        // socket, its own contexts, and none of the first session's frames.
        let mut second = runner
            .open(scripted_session_config_for(
                "voice-session-2",
                Some("session-b"),
            ))
            .await
            .unwrap();
        second
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                5_u8, 6, 7, 8,
            ])))
            .await
            .unwrap();
        drain_until_response_completed(&mut second).await;

        assert_eq!(
            transports.connects(),
            2,
            "provider connection state is per learner session, never shared"
        );
        let by_context = transports.sockets_by_context();
        assert_eq!(
            by_context.len(),
            2,
            "the two sessions name distinct response contexts: {by_context:?}"
        );
        assert!(
            by_context.values().all(|sockets| sockets.len() == 1),
            "a response context belongs to exactly one session socket: {by_context:?}"
        );
        assert_eq!(
            by_context
                .values()
                .flatten()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            2,
            "neither session may be served from the other's connection: {by_context:?}"
        );

        first.input.send(BrainInput::Stop).await.unwrap();
        drain_until_session_end(&mut first).await;
        assert_eq!(transports.closes(), 1);
        second.input.send(BrainInput::Stop).await.unwrap();
        drain_until_session_end(&mut second).await;
        assert_eq!(
            transports.closes(),
            2,
            "each session closes its own connection exactly once"
        );
    }

    #[tokio::test]
    async fn dead_provider_socket_is_not_returned_to_the_next_turn() {
        let store = two_question_seeded_store();
        // The provider closes the first connection as soon as response-1 ends.
        let transports = SessionScopedSonicTransports::new(SonicSocketLifetime::ClosesAndReportsIt);
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner
            .open(scripted_session_config("voice-session-1"))
            .await
            .unwrap();

        for bytes in [vec![1_u8, 2, 3, 4], vec![5_u8, 6, 7, 8]] {
            session
                .input
                .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(bytes)))
                .await
                .unwrap();
            drain_until_response_completed(&mut session).await;
        }

        assert_eq!(
            transports.connects(),
            2,
            "a dead connection is replaced, not reused"
        );
        let by_context = transports.sockets_by_context();
        assert_eq!(by_context["response-1"], vec![0_u32]);
        assert_eq!(
            by_context["response-2"],
            vec![1_u32],
            "the replacement turn must never write to the closed socket"
        );
    }

    /// Task 4 (`ADAPTER-04`) health control: connection reuse must not turn a
    /// routine provider hang-up into a dead learner turn.
    ///
    /// Cartesia closes idle STT/TTS sockets at documented limits, and a
    /// peer-initiated close that happens between turns is invisible to a socket
    /// that is not reading: `is_open()` sampled at the end of the previous
    /// context still says true, and only the next write discovers it. The first
    /// write of a new context into a connection held from an earlier one is
    /// therefore retried once on a fresh dial. Nothing of the new context has
    /// reached the provider yet, so the replacement speaks it in full.
    #[tokio::test]
    async fn a_session_socket_closed_while_idle_is_redialled_for_the_next_turn() {
        let store = two_question_seeded_store();
        // The provider hangs up between the turns without the socket noticing.
        let transports =
            SessionScopedSonicTransports::new(SonicSocketLifetime::ClosesSilentlyWhileIdle);
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner
            .open(scripted_session_config("voice-session-1"))
            .await
            .unwrap();

        let mut spoken_frames = 0_usize;
        for bytes in [vec![1_u8, 2, 3, 4], vec![5_u8, 6, 7, 8]] {
            session
                .input
                .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(bytes)))
                .await
                .unwrap();
            // Panics on `BrainEvent::Error`: a turn that dies because the idle
            // socket went away is exactly the regression this pins.
            spoken_frames += drain_until_response_completed(&mut session)
                .await
                .iter()
                .filter(|event| matches!(event, BrainEvent::AudioDelta { .. }))
                .count();
        }

        assert_eq!(
            spoken_frames, 2,
            "both turns must still reach the learner as speech"
        );
        assert_eq!(
            transports.connects(),
            2,
            "the silently closed connection is replaced by a fresh dial"
        );
        let by_context = transports.sockets_by_context();
        assert_eq!(by_context["response-1"], vec![0_u32]);
        assert_eq!(
            by_context["response-2"],
            vec![0_u32, 1_u32],
            "the refused first write is retried whole on the replacement connection"
        );
        let replacement_writes = transports
            .writes_on_socket(1)
            .into_iter()
            .map(|value| value["context_id"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert!(
            !replacement_writes.is_empty()
                && replacement_writes
                    .iter()
                    .all(|context_id| context_id == "response-2"),
            "the replacement connection carries only the new context: {replacement_writes:?}"
        );
    }

    fn scripted_session_config(voice_session_id: &str) -> SessionConfig {
        scripted_session_config_for(voice_session_id, None)
    }

    fn scripted_session_config_for(
        voice_session_id: &str,
        client_generation_id: Option<&str>,
    ) -> SessionConfig {
        SessionConfig {
            session_id: Some(SessionId::new(voice_session_id)),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            client_generation_id: client_generation_id.map(ToOwned::to_owned),
            ..SessionConfig::default()
        }
    }

    async fn drain_until_response_completed(session: &mut RealtimeSession) -> Vec<BrainEvent> {
        let mut events = Vec::new();
        loop {
            let event = timeout(Duration::from_secs(10), session.events.recv())
                .await
                .expect("the turn completes")
                .expect("the session stays open");
            if let BrainEvent::Error(error) = &event {
                panic!("unexpected provider failure: {error:?}");
            }
            // A turn ends at its own completion. The session recap is published
            // once, on Stop, so it is not this turn's terminator.
            let finished = matches!(event, BrainEvent::ResponseCompleted { .. });
            events.push(event);
            if finished {
                return events;
            }
        }
    }

    async fn drain_until_session_end(session: &mut RealtimeSession) {
        while let Ok(Some(_)) = timeout(Duration::from_millis(200), session.events.recv()).await {}
    }

    /// Fixture Ink/Gemini with a counting, scriptable Sonic connection.
    #[derive(Clone)]
    struct SessionScopedSonicTransports {
        inner: FakeCartesiaGeminiTransports,
        connector: Arc<CountingSonicConnector>,
        voice: Arc<super::super::tts::SonicSessionVoice>,
    }

    impl SessionScopedSonicTransports {
        fn new(lifetime: SonicSocketLifetime) -> Self {
            let connector = Arc::new(CountingSonicConnector::new(lifetime));
            Self {
                inner: FakeCartesiaGeminiTransports::new(),
                voice: Arc::new(super::super::tts::SonicSessionVoice::new(Arc::clone(
                    &connector,
                ))),
                connector,
            }
        }

        fn connects(&self) -> u32 {
            self.connector.record().connects
        }

        fn closes(&self) -> u32 {
            self.connector.record().closes
        }

        /// Every generation context written, in order, deduplicated.
        fn generation_contexts(&self) -> Vec<String> {
            let mut contexts = Vec::new();
            for (_, value) in self.connector.record().sent {
                if value.get("cancel").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let Some(context_id) = value["context_id"].as_str() else {
                    continue;
                };
                if contexts.last().map(String::as_str) != Some(context_id) {
                    contexts.push(context_id.to_owned());
                }
            }
            contexts
        }

        /// Which socket index each response context was written on.
        fn sockets_by_context(&self) -> std::collections::BTreeMap<String, Vec<u32>> {
            let mut by_context: std::collections::BTreeMap<String, Vec<u32>> =
                std::collections::BTreeMap::new();
            for (index, value) in self.connector.record().sent {
                let Some(context_id) = value["context_id"].as_str() else {
                    continue;
                };
                let sockets = by_context.entry(context_id.to_owned()).or_default();
                if !sockets.contains(&index) {
                    sockets.push(index);
                }
            }
            by_context
        }

        /// Everything written to one socket, in order.
        fn writes_on_socket(&self, index: u32) -> Vec<Value> {
            self.connector
                .record()
                .sent
                .into_iter()
                .filter_map(|(socket, value)| (socket == index).then_some(value))
                .collect()
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for SessionScopedSonicTransports {
        fn open_session(&self) -> Self {
            Self {
                inner: self.inner.clone(),
                voice: Arc::new(super::super::tts::SonicSessionVoice::new(Arc::clone(
                    &self.connector,
                ))),
                connector: Arc::clone(&self.connector),
            }
        }

        async fn close_session(&self) {
            self.voice.close().await;
        }

        async fn cancel_speech(&self, _config: &CartesiaGeminiConfig, response_id: &str) {
            self.voice.cancel_context(response_id).await;
        }

        async fn transcribe_audio(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            frame: &AudioFrame,
            cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            self.inner
                .transcribe_audio(config, response_id, frame, cancel)
                .await
        }

        async fn stream_gemini(
            &self,
            config: &CartesiaGeminiConfig,
            request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            self.inner.stream_gemini(config, request).await
        }

        async fn extend_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            self.voice
                .extend(&config.sonic, "sk_car_session_secret", response_id, text)
                .await
        }

        async fn finish_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            cancel: &CancellationToken,
            sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            self.voice
                .finish(&config.sonic, response_id, cancel, sink)
                .await
        }
    }

    #[derive(Clone, Default)]
    struct CountingSonicRecord {
        connects: u32,
        closes: u32,
        sent: Vec<(u32, Value)>,
    }

    /// How the provider treats the session connection once a response context
    /// has ended.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum SonicSocketLifetime {
        /// The connection serves the whole session.
        Healthy,
        /// The provider hangs up at the end of the first context and the socket
        /// observes it, so `is_open()` reports the close.
        ClosesAndReportsIt,
        /// The provider hangs up while the connection sits idle between turns.
        /// Nothing is reading, so the socket learns nothing: `is_open()` still
        /// says true and only the next write fails.
        ClosesSilentlyWhileIdle,
    }

    struct CountingSonicConnector {
        record: Arc<std::sync::Mutex<CountingSonicRecord>>,
        lifetime: SonicSocketLifetime,
    }

    impl CountingSonicConnector {
        fn new(lifetime: SonicSocketLifetime) -> Self {
            Self {
                record: Arc::new(std::sync::Mutex::new(CountingSonicRecord::default())),
                lifetime,
            }
        }

        fn record(&self) -> CountingSonicRecord {
            self.record.lock().expect("record lock poisoned").clone()
        }
    }

    #[async_trait]
    impl super::super::tts::SonicConnector for CountingSonicConnector {
        type Socket = CountingSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, BrainError> {
            let index = {
                let mut record = self.record.lock().expect("record lock poisoned");
                let index = record.connects;
                record.connects += 1;
                index
            };
            Ok(CountingSonicSocket {
                index,
                record: Arc::clone(&self.record),
                pending: std::collections::VecDeque::new(),
                reports_open: true,
                writable: true,
                lifetime: self.lifetime,
                contexts_finished: 0,
            })
        }
    }

    /// Answers every finalized generation with one chunk plus `done` for that
    /// context, so a multiplexed connection can serve many response contexts.
    struct CountingSonicSocket {
        index: u32,
        record: Arc<std::sync::Mutex<CountingSonicRecord>>,
        pending: std::collections::VecDeque<String>,
        /// What `is_open()` tells the adapter.
        reports_open: bool,
        /// Whether a write still reaches the provider. These come apart exactly
        /// when the peer hangs up on a connection nobody is reading.
        writable: bool,
        lifetime: SonicSocketLifetime,
        contexts_finished: u32,
    }

    #[async_trait]
    impl super::super::tts::SonicSocket for CountingSonicSocket {
        async fn send_json(&mut self, value: Value) -> Result<(), BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent
                .push((self.index, value.clone()));
            if !self.writable {
                return Err(brain_failure(BrainProviderFailureParts {
                    failure_class: BrainFailureClass::NetworkDisconnect,
                    stage: BrainFailureStage::Transport,
                    retry_eligible: true,
                    latency_ms: 0,
                    provider: "cartesia".to_owned(),
                    model: "cartesia-sonic".to_owned(),
                    metadata: "stage=cartesia_sonic error_kind=send_failed".to_owned(),
                }));
            }
            if value.get("cancel").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if value.get("continue").and_then(Value::as_bool) == Some(false) {
                let context_id = value["context_id"]
                    .as_str()
                    .expect("every generation names its context")
                    .to_owned();
                self.pending.push_back(format!(
                    r#"{{"type":"chunk","context_id":"{context_id}","data":"AQI="}}"#
                ));
                self.pending
                    .push_back(format!(r#"{{"type":"done","context_id":"{context_id}"}}"#));
            }
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, BrainError> {
            let next = self.pending.pop_front();
            if next
                .as_deref()
                .is_some_and(|text| text.contains(r#""type":"done""#))
            {
                self.contexts_finished += 1;
                if self.contexts_finished == 1 {
                    match self.lifetime {
                        SonicSocketLifetime::Healthy => {}
                        // The provider hangs up as soon as the response ends and
                        // the socket sees it.
                        SonicSocketLifetime::ClosesAndReportsIt => {
                            self.reports_open = false;
                            self.writable = false;
                        }
                        // The provider hangs up while the connection is idle.
                        // Nothing observes it, so the socket keeps claiming to
                        // be open and only the next write finds out.
                        SonicSocketLifetime::ClosesSilentlyWhileIdle => self.writable = false,
                    }
                }
            }
            Ok(next)
        }

        fn is_open(&self) -> bool {
            self.reports_open
        }

        async fn close(&mut self) -> Result<(), BrainError> {
            self.reports_open = false;
            self.writable = false;
            self.record.lock().expect("record lock poisoned").closes += 1;
            Ok(())
        }
    }

    // -----------------------------------------------------------------
    // Task 3 (`ADAPTER-03`): a cancelled speech context never becomes audio,
    // even when the provider finishes generating it anyway.
    //
    // Cartesia documents that a cancel may not stop a request already in
    // flight, so correctness comes from writing the cancel, suppressing the
    // cancelled context, and closing on terminal cleanup — never from treating
    // the cancel write as an acknowledgement.
    // -----------------------------------------------------------------

    /// The seeded set plus a second active question, so a session that already
    /// graded one turn can legitimately be asked another.
    fn two_question_seeded_store() -> Arc<data::InMemoryStudyStore> {
        let store = learning_ready_seeded_store();
        let question = agent_domain::fixture_question();
        let mut follow_up = question.clone();
        follow_up.question_id = "q-oxidative-phosphorylation-atp".to_owned();
        follow_up.prompt = "Explain what the proton gradient powers.".to_owned();
        store.upsert_question(data::StudyQuestionRecord {
            study_set_id: "biology-midterm".to_owned(),
            question: follow_up.clone(),
            active: true,
        });
        let mut concept_ids = vec![
            "oxidative-phosphorylation".to_owned(),
            "nadh".to_owned(),
            "atp-synthase".to_owned(),
            "cellular-respiration".to_owned(),
        ];
        for criterion in &question.rubric.criteria {
            if !concept_ids.contains(&criterion.concept_id) {
                concept_ids.push(criterion.concept_id.clone());
            }
        }
        store.upsert_study_set(data::StudySetRecord {
            study_set_id: "biology-midterm".to_owned(),
            user_id: "user-1".to_owned(),
            title: "Biology Midterm".to_owned(),
            course: Some("Biology 201".to_owned()),
            ingestion_status: agent_domain::StudySetIngestionStatus::Ready,
            ingestion_error: None,
            concept_ids,
            question_ids: vec![question.question_id.clone(), follow_up.question_id.clone()],
        });
        store
    }

    #[tokio::test]
    async fn cancelled_sonic_context_never_emits_audio_even_when_provider_finishes_it() {
        let store = two_question_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let (transports, mut speaking) = ProviderFinishesCancelledContextTransports::new();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig::default(),
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner.open(session_config).await.unwrap();

        let mut events = Vec::new();
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();

        // Barrier, not a sleep: the barge-in lands once response-1 genuinely
        // opened its speech context on the provider.
        loop {
            tokio::select! {
                biased;
                _ = &mut speaking => break,
                event = session.events.recv() => events.push(event.expect("the session stays open")),
            }
        }
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                5_u8, 6, 7, 8,
            ])))
            .await
            .unwrap();

        loop {
            let event = timeout(Duration::from_secs(5), session.events.recv())
                .await
                .expect("the replacement turn completes")
                .expect("the session stays open");
            let completed = matches!(&event, BrainEvent::ResponseCompleted { response_id }
                if response_id == "response-2");
            events.push(event);
            if completed {
                break;
            }
        }

        let audio = events
            .iter()
            .filter_map(|event| match event {
                BrainEvent::AudioDelta { response_id, frame } => {
                    Some((response_id.clone(), frame.pcm16_bytes().to_vec()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            audio,
            vec![("response-2".to_owned(), vec![3_u8, 4])],
            "only the replacement context may be heard: {events:?}"
        );

        let record = transports.record();
        let written = record
            .iter()
            .map(|value| {
                (
                    value["context_id"]
                        .as_str()
                        .expect("every Sonic control names its context")
                        .to_owned(),
                    value
                        .get("cancel")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
            })
            .collect::<Vec<_>>();
        let cancel_index = written
            .iter()
            .position(|(context_id, cancel)| *cancel && context_id == "response-1")
            .unwrap_or_else(|| panic!("the replaced context must be cancelled: {written:?}"));
        assert!(written[..cancel_index]
            .iter()
            .all(|(context_id, _)| context_id == "response-1"));
        assert!(written[cancel_index + 1..]
            .iter()
            .all(|(context_id, cancel)| context_id == "response-2" && !cancel));
        assert!(!written[cancel_index + 1..].is_empty());
    }

    /// Fixture Ink/Gemini with a scripted Sonic connection whose replaced
    /// context keeps generating after it is cancelled.
    #[derive(Clone)]
    struct ProviderFinishesCancelledContextTransports {
        inner: FakeCartesiaGeminiTransports,
        script: Arc<ScriptedSonicScript>,
        voice: Arc<super::super::tts::SonicSessionVoice>,
    }

    impl ProviderFinishesCancelledContextTransports {
        /// The receiver fires once the replaced context is genuinely open on the
        /// provider, so the barge-in lands on a real speech context.
        fn new() -> (Self, tokio::sync::oneshot::Receiver<()>) {
            let (speaking, speaking_rx) = tokio::sync::oneshot::channel();
            let script = Arc::new(ScriptedSonicScript {
                connects: AtomicU32::new(0),
                sent_json: std::sync::Mutex::new(Vec::new()),
                released: AtomicBool::new(false),
                release: tokio::sync::Notify::new(),
                speaking: std::sync::Mutex::new(Some(speaking)),
            });
            (
                Self {
                    inner: FakeCartesiaGeminiTransports::new(),
                    voice: Arc::new(super::super::tts::SonicSessionVoice::new(Arc::new(
                        ScriptedSonicConnector {
                            script: Arc::clone(&script),
                        },
                    ))),
                    script,
                },
                speaking_rx,
            )
        }

        fn record(&self) -> Vec<Value> {
            self.script
                .sent_json
                .lock()
                .expect("record lock poisoned")
                .clone()
        }
    }

    struct ScriptedSonicScript {
        connects: AtomicU32,
        sent_json: std::sync::Mutex<Vec<Value>>,
        released: AtomicBool,
        release: tokio::sync::Notify,
        speaking: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }

    #[async_trait]
    impl CartesiaGeminiTransports for ProviderFinishesCancelledContextTransports {
        fn open_session(&self) -> Self {
            Self {
                inner: self.inner.clone(),
                voice: Arc::new(super::super::tts::SonicSessionVoice::new(Arc::new(
                    ScriptedSonicConnector {
                        script: Arc::clone(&self.script),
                    },
                ))),
                script: Arc::clone(&self.script),
            }
        }

        async fn close_session(&self) {
            self.voice.close().await;
        }

        async fn cancel_speech(&self, _config: &CartesiaGeminiConfig, response_id: &str) {
            self.voice.cancel_context(response_id).await;
        }

        async fn transcribe_audio(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            frame: &AudioFrame,
            cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            self.inner
                .transcribe_audio(config, response_id, frame, cancel)
                .await
        }

        async fn stream_gemini(
            &self,
            config: &CartesiaGeminiConfig,
            request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            self.inner.stream_gemini(config, request).await
        }

        async fn extend_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            self.voice
                .extend(&config.sonic, "sk_car_scripted_secret", response_id, text)
                .await
        }

        async fn finish_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            cancel: &CancellationToken,
            sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            self.voice
                .finish(&config.sonic, response_id, cancel, sink)
                .await
        }
    }

    struct ScriptedSonicConnector {
        script: Arc<ScriptedSonicScript>,
    }

    #[async_trait]
    impl super::super::tts::SonicConnector for ScriptedSonicConnector {
        type Socket = ScriptedSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, BrainError> {
            let index = self.script.connects.fetch_add(1, Ordering::SeqCst);
            // The replaced context's frames are already generated and waiting;
            // the provider releases them once the cancel arrives, exactly as
            // Cartesia documents for a request that is already generating.
            let incoming = if index == 0 {
                std::collections::VecDeque::from([
                    r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#.to_owned(),
                    r#"{"type":"done","context_id":"response-1"}"#.to_owned(),
                ])
            } else {
                std::collections::VecDeque::new()
            };
            Ok(ScriptedSonicSocket {
                script: Arc::clone(&self.script),
                incoming,
                gated: index == 0,
            })
        }
    }

    /// One multiplexed session connection, as Cartesia documents it: the
    /// replaced context finishes on the same socket the replacement context is
    /// then generated on.
    struct ScriptedSonicSocket {
        script: Arc<ScriptedSonicScript>,
        incoming: std::collections::VecDeque<String>,
        gated: bool,
    }

    #[async_trait]
    impl super::super::tts::SonicSocket for ScriptedSonicSocket {
        async fn send_json(&mut self, value: Value) -> Result<(), BrainError> {
            let cancelled = value.get("cancel").and_then(Value::as_bool) == Some(true);
            let finalized = value.get("continue").and_then(Value::as_bool) == Some(false);
            let context_id = value["context_id"]
                .as_str()
                .expect("every Sonic control names its context")
                .to_owned();
            self.script
                .sent_json
                .lock()
                .expect("record lock poisoned")
                .push(value);
            if finalized {
                let data = if context_id == "response-1" {
                    "AQI="
                } else {
                    "AwQ="
                };
                self.incoming.push_back(format!(
                    r#"{{"type":"chunk","context_id":"{context_id}","data":"{data}"}}"#
                ));
                self.incoming
                    .push_back(format!(r#"{{"type":"done","context_id":"{context_id}"}}"#));
            }
            if cancelled {
                self.script.released.store(true, Ordering::SeqCst);
                self.script.release.notify_waiters();
            } else if self.gated {
                if let Some(speaking) = self
                    .script
                    .speaking
                    .lock()
                    .expect("speaking lock poisoned")
                    .take()
                {
                    let _ = speaking.send(());
                }
            }
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, BrainError> {
            while self.gated && !self.script.released.load(Ordering::SeqCst) {
                self.script.release.notified().await;
            }
            Ok(self.incoming.pop_front())
        }

        async fn close(&mut self) -> Result<(), BrainError> {
            Ok(())
        }
    }
}

/// `A-13.3` construction boundary: the fixture evaluator is reachable only
/// through the named fake/synthetic builders, never by default and never through
/// the environment.
#[cfg(test)]
mod evaluator_boundary_tests {
    use agent_domain::{EvaluationError, EvaluationRequest};

    use super::*;

    /// A request no evaluator can answer from the network: the default config
    /// carries no credential, so the provider-backed evaluator refuses before
    /// it opens a connection while the fixture evaluator answers from the
    /// corpus. The two are therefore distinguishable by behaviour, offline.
    fn credential_less_evaluation_request() -> EvaluationRequest {
        EvaluationRequest {
            response_id: "response-1".to_owned(),
            question: agent_domain::fixture_question(),
            answer_text: "the learner answer".to_owned(),
            transcript_confidence: None,
        }
    }

    #[tokio::test]
    async fn live_runtime_evaluator_is_provider_backed_in_behaviour_not_only_in_label() {
        let store: Arc<dyn StudyMemoryStore> = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let live = CartesiaGeminiRunner::live(Arc::clone(&store), CartesiaGeminiConfig::default());
        let fake = CartesiaGeminiRunner::fake(Arc::clone(&store), CartesiaGeminiConfig::default());
        let request = credential_less_evaluation_request();

        // The live composition holds a provider evaluator: with no credential it
        // reports the provider unavailable rather than producing a verdict.
        assert_eq!(
            live.evaluator().evaluate(&request).await,
            Err(EvaluationError::Unavailable)
        );
        // The fixture composition answers from the immutable corpus without any
        // provider at all — so a live runtime that had silently become
        // synthetic would return a decision here.
        assert!(fake.evaluator().evaluate(&request).await.is_ok());
    }

    #[test]
    fn live_runtime_injects_provider_evaluator_not_synthetic() {
        let store: Arc<dyn StudyMemoryStore> = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let live = CartesiaGeminiRunner::live(Arc::clone(&store), CartesiaGeminiConfig::default());
        let fake = CartesiaGeminiRunner::fake(Arc::clone(&store), CartesiaGeminiConfig::default());

        assert_eq!(live.evaluator_provenance(), EvaluatorProvenance::LiveGemini);
        assert_eq!(
            fake.evaluator_provenance(),
            EvaluatorProvenance::SyntheticFixture
        );

        // No live construction path falls back to the fixture evaluator when
        // credentials or the runtime gate are absent: such a runtime is not
        // selectable, but it is never silently synthetic.
        let ungated = CartesiaGeminiRunner::live(
            Arc::clone(&store),
            CartesiaGeminiConfig {
                live_runtime_enabled: false,
                cartesia_api_key: String::new(),
                ..CartesiaGeminiConfig::default()
            },
        );
        assert_eq!(
            ungated.evaluator_provenance(),
            EvaluatorProvenance::LiveGemini
        );
        assert!(!ungated.config.live_runtime_selectable());
    }
}

// ---------------------------------------------------------------------------
// Task 6 (`ADAPTER-06`): a live failure is a live failure. The fixture wording
// belongs to `FakeCartesiaGeminiTransports` alone and no generic runner path can
// reach it.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod live_failure_tests {
    use super::tests::learning_ready_seeded_store;
    use super::*;

    use agent_domain::{SessionId, StudyMode};

    use super::super::{InkConfig, SonicConfig};

    pub(crate) fn live_session_config(voice_session_id: &str) -> SessionConfig {
        SessionConfig {
            session_id: Some(SessionId::new(voice_session_id)),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        }
    }

    /// A live composition pointed at ports nothing listens on: the transports
    /// are the real ones, so every failure they produce is a live failure.
    fn unreachable_live_config() -> CartesiaGeminiConfig {
        CartesiaGeminiConfig {
            cartesia_api_key: "viva-not-a-real-key-label-probe".to_owned(),
            gemini: GeminiConfig {
                api_key: "gemini-live-label-probe".to_owned(),
                base_url: "http://127.0.0.1:1/v1beta/models".to_owned(),
                stage_timeout: Duration::from_millis(400),
                ..GeminiConfig::default()
            },
            ink: InkConfig {
                websocket_url: "ws://127.0.0.1:1/stt/turns/websocket".to_owned(),
                stage_timeout: Duration::from_millis(400),
                ..InkConfig::default()
            },
            sonic: SonicConfig {
                websocket_url: "ws://127.0.0.1:1/tts/websocket".to_owned(),
                stage_timeout: Duration::from_millis(400),
                ..SonicConfig::default()
            },
            live_runtime_enabled: true,
            ..CartesiaGeminiConfig::default()
        }
    }

    #[tokio::test]
    async fn live_failures_never_emit_fake_provider_labels() {
        let store = learning_ready_seeded_store();
        let session_config = live_session_config("voice-live-label-probe");
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let runner = CartesiaGeminiRunner::live(store, unreachable_live_config());
        let mut session = runner.open(session_config).await.unwrap();

        let mut observed = Vec::new();
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();
        let error = loop {
            let event = timeout(Duration::from_secs(5), session.events.recv())
                .await
                .expect("the live turn reports its failure")
                .expect("the live session stays open until it fails");
            if let BrainEvent::Error(error) = &event {
                break error.clone();
            }
            observed.push(event);
        };

        let failure = error
            .failure
            .clone()
            .expect("a live provider failure is typed");
        assert_eq!(
            failure.provider(),
            "cartesia",
            "a live Ink failure names the live provider: {failure:?}"
        );
        let rendered = format!(
            "{} {} {failure:?} {}",
            error.source,
            error.message,
            serde_json::to_string(&failure).unwrap()
        );
        assert!(
            !rendered.to_ascii_lowercase().contains("fake"),
            "a live failure must not carry fixture wording: {rendered}"
        );
        let observed_json = serde_json::to_string(&observed).unwrap();
        assert!(
            !observed_json.to_ascii_lowercase().contains("fake"),
            "no live event may carry fixture wording: {observed_json}"
        );

        // Non-vacuity: the fixture wording does exist, and it belongs to the
        // fixture transports alone.
        let fixture = fake_transport_failure("writer_failed_before_audio");
        assert_eq!(fixture.failure().provider(), "fake_cartesia_gemini");
    }
}

// ---------------------------------------------------------------------------
// Task 7 (`ADAPTER-07`): transcript confidence is the provider's parsed value or
// an explicit absence. Nothing in the adapter invents one.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod transcript_confidence_tests {
    use super::live_failure_tests::live_session_config;
    use super::tests::learning_ready_seeded_store;
    use super::*;

    use std::collections::VecDeque;

    use super::super::stt::{transcribe_ink_turn, InkSocket};

    struct ScriptedInkSocket {
        incoming: VecDeque<String>,
    }

    #[async_trait]
    impl InkSocket for ScriptedInkSocket {
        async fn send_binary(&mut self, _bytes: bytes::Bytes) -> Result<(), BrainError> {
            Ok(())
        }

        async fn send_text(&mut self, _text: &'static str) -> Result<(), BrainError> {
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, BrainError> {
            Ok(self.incoming.pop_front())
        }

        async fn close(&mut self) -> Result<(), BrainError> {
            Ok(())
        }
    }

    /// The two ends of the provider's own documented range, named rather than
    /// written as literals: the Task 1 Step 5 scan forbids the removed
    /// runner-level confidence defaults anywhere under `src`, and a boundary
    /// assertion must not resemble one.
    const PROVIDER_MIN_CONFIDENCE: f32 = 0.0;
    const PROVIDER_MAX_CONFIDENCE: f32 = 1.0;

    async fn ink_confidence_for(turn_end: &str) -> Option<f32> {
        let mut socket = ScriptedInkSocket {
            incoming: VecDeque::from([turn_end.to_owned()]),
        };
        transcribe_ink_turn(
            &mut socket,
            &AudioFrame::from_pcm16_bytes(vec![1, 2]),
            &CancellationToken::new(),
        )
        .await
        .expect("the scripted Ink turn completes")
        .confidence
    }

    #[tokio::test]
    async fn transcript_confidence_is_provider_value_or_explicit_unknown() {
        // The v5 fixture runtime states an explicit absence, never a constant.
        let store = learning_ready_seeded_store();
        let session_config = live_session_config("voice-confidence-probe");
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let runner = CartesiaGeminiRunner::fake(store, CartesiaGeminiConfig::default());
        let mut session = runner.open(session_config).await.unwrap();
        session
            .input
            .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
                1_u8, 2, 3, 4,
            ])))
            .await
            .unwrap();
        let confidence = loop {
            let event = timeout(Duration::from_secs(5), session.events.recv())
                .await
                .expect("the fixture turn produces a final transcript")
                .expect("the fixture session stays open");
            if let BrainEvent::TranscriptFinal { confidence, .. } = event {
                break confidence;
            }
        };
        assert_eq!(
            confidence, None,
            "the v5 fixture reports an explicit unknown confidence"
        );

        // A live Ink turn whose provider supplies no confidence stays unknown.
        assert_eq!(
            ink_confidence_for(r#"{"type":"turn.end","transcript":"NADH donates electrons"}"#)
                .await,
            None
        );

        // A provider-supplied finite value in [0, 1] is preserved exactly.
        assert_eq!(
            ink_confidence_for(
                r#"{"type":"turn.end","transcript":"NADH donates electrons","confidence":0.42}"#
            )
            .await,
            Some(0.42)
        );
        assert_eq!(
            ink_confidence_for(
                r#"{"type":"turn.end","transcript":"NADH donates electrons","confidence":0}"#
            )
            .await,
            Some(PROVIDER_MIN_CONFIDENCE)
        );
        assert_eq!(
            ink_confidence_for(
                r#"{"type":"turn.end","transcript":"NADH donates electrons","confidence":1}"#
            )
            .await,
            Some(PROVIDER_MAX_CONFIDENCE)
        );

        // Out-of-range, non-finite, and non-numeric provider values fail closed
        // to unknown rather than being clamped into a plausible-looking score.
        for hostile in [
            r#"{"type":"turn.end","transcript":"NADH","confidence":"NaN"}"#,
            r#"{"type":"turn.end","transcript":"NADH","confidence":-0.1}"#,
            r#"{"type":"turn.end","transcript":"NADH","confidence":1.1}"#,
            r#"{"type":"turn.end","transcript":"NADH","confidence":"0.5"}"#,
            r#"{"type":"turn.end","transcript":"NADH","confidence":null}"#,
        ] {
            assert_eq!(
                ink_confidence_for(hostile).await,
                None,
                "a hostile confidence must fail closed: {hostile}"
            );
        }

        // Typed input is not a speech-recognition score, so it carries nothing.
        let store = learning_ready_seeded_store();
        let session_config = live_session_config("voice-typed-confidence-probe");
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let runner = CartesiaGeminiRunner::fake(store, CartesiaGeminiConfig::default());
        let mut session = runner.open(session_config).await.unwrap();
        session
            .input
            .send(BrainInput::Text("NADH donates electrons".to_owned()))
            .await
            .unwrap();
        let confidence = loop {
            let event = timeout(Duration::from_secs(5), session.events.recv())
                .await
                .expect("the typed turn produces a final transcript")
                .expect("the fixture session stays open");
            if let BrainEvent::TranscriptFinal { confidence, .. } = event {
                break confidence;
            }
        };
        assert_eq!(confidence, None);
    }
}

// ---------------------------------------------------------------------------
// Task 8 (`ADAPTER-08`): a forbidden final-pass tool call is attributed to the
// model that actually ran, not to the configured primary.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod promoted_model_tests {
    use super::live_failure_tests::live_session_config;
    use super::tests::learning_ready_seeded_store;
    use super::*;

    use std::sync::Mutex;

    #[derive(Clone, Default)]
    struct PromotedFinalPassToolCallTransports {
        calls: Arc<Mutex<u32>>,
    }

    #[async_trait]
    impl CartesiaGeminiTransports for PromotedFinalPassToolCallTransports {
        async fn transcribe_audio(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _frame: &AudioFrame,
            _cancel: &CancellationToken,
        ) -> Result<RunnerTranscript, BrainError> {
            Ok(RunnerTranscript {
                interim_text: String::new(),
                final_text: "omitted".to_owned(),
                confidence: Some(0.42),
            })
        }

        async fn stream_gemini(
            &self,
            _config: &CartesiaGeminiConfig,
            _request: Value,
        ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
            let mut calls = self.calls.lock().expect("call lock poisoned");
            *calls += 1;
            let pass = *calls;
            drop(calls);
            if pass == 1 {
                let args = json!({
                    "study_set_id": "biology-midterm",
                    "voice_session_id": "voice-session-1",
                    "question_id": "q-oxidative-phosphorylation-nadh",
                    "answer_text": "omitted",
                });
                return Ok(fixture_gemini_stream(vec![
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
                ]));
            }
            // The final pass may not call a tool at all.
            Ok(fixture_gemini_stream(vec![
                GeminiStreamEvent::FunctionCall {
                    id: "call-late-1".to_owned(),
                    name: "retrieve_source_reference".to_owned(),
                    args: json!({ "source_id": "src-1" }),
                    part: json!({
                        "functionCall": {
                            "id": "call-late-1",
                            "name": "retrieve_source_reference",
                            "args": { "source_id": "src-1" },
                        }
                    }),
                },
            ]))
        }

        async fn extend_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _text: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            Ok(())
        }

        async fn finish_speech(
            &self,
            _config: &CartesiaGeminiConfig,
            _response_id: &str,
            _interrupt: FakeRuntimeInterrupt,
            _cancel: &CancellationToken,
            _sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn streamed_final_pass_tool_call_reports_the_promoted_active_model() {
        let store = learning_ready_seeded_store();
        let session_config = live_session_config("voice-session-1");
        let _ = store.record_voice_session(&session_config).await.unwrap();
        let session = AuthorizedStudySession::from_config(&session_config).unwrap();
        let evaluator = synthetic_fixture_answer_evaluator();
        let executor =
            VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
        let question = select_session_question(
            &executor,
            "biology-midterm",
            "voice-session-1",
            "response-1",
        )
        .await
        .unwrap();
        let transports = PromotedFinalPassToolCallTransports::default();
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    model_id: "gemini-3.5-pro".to_owned(),
                    fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                    ..GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            transports.clone(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut events = Vec::new();
        let mut usage = BrainUsage::default();
        let speech_opened = AtomicBool::new(false);

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
                speech_opened: &speech_opened,
                usage: &mut usage,
            })
            .await
            .expect_err("a final-pass tool call is refused");

        assert_eq!(
            *transports.calls.lock().expect("call lock poisoned"),
            2,
            "the refusal happens on the streamed final pass"
        );
        let failure = error.failure();
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(
            failure.model(),
            "gemini-35-flash",
            "the failure names the promoted model, not the configured primary: {failure:?}"
        );
        assert!(
            failure
                .metadata()
                .contains("error_kind=tool_loop_budget_exceeded"),
            "{failure:?}"
        );
        assert!(
            failure
                .metadata()
                .contains("tool=retrieve_source_reference"),
            "{failure:?}"
        );
    }
}
