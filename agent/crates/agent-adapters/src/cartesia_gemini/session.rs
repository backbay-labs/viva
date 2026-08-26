//! Session ownership for the Cartesia/Gemini adapter.
//!
//! `ADAPTER-11`: this module owns what one opened Viva realtime session owns —
//! turn acceptance and per-turn correlation, the active response and its
//! cooperative cancellation signal, the stage deadlines a turn runs under, the
//! provider transports seam, and the single bounded cleanup path invoked by
//! Stop, by a fatal error, or by the session being dropped. It decodes no
//! provider frame of its own: Gemini SSE stays in [`super::llm`], Ink in
//! [`super::stt`], and Sonic in [`super::tts`].

use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use serde_json::Value;
use tokio::{sync::mpsc, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;

use agent_domain::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy, AudioFrame,
    AuthorizedStudySession, BrainError, BrainEvent, BrainFailureClass, BrainFailureStage,
    BrainProviderFailureParts, StudyQuestion, VivaToolExecutor,
};

use super::llm::{
    stream_gemini_http_with_attempt_events, GeminiEventStream, GeminiStreamAttemptFailure,
    ReqwestGeminiSseClient,
};
use super::runner::tool_stage_error;
use super::stt::{audio_frame_bytes, transcribe_ink_websocket};
use super::tts::{SonicSessionVoice, SpeechFrameSink};
use super::{
    brain_failure, failure_with_latency, CartesiaGeminiConfig, FakeRuntimeInterrupt,
    SessionPhaseTracker,
};

/// How long a replaced or stopped turn may take to write its provider
/// cancel/close controls before the task is force-aborted.
///
/// `ADAPTER-03`: cancellation is cooperative for exactly this long. The bound
/// exists because a provider that never answers must not hold a session open,
/// and an abort before it must not skip the controls Cartesia documents.
pub(crate) const PROVIDER_CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);

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
    pub(crate) fn client_generation_id(&self) -> Option<&str> {
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
    pub(crate) response_id: String,
    pub(crate) submission_sequence: u32,
    pub(crate) input: RunnerInput,
    pub(crate) phases: SessionPhaseTracker,
    /// Whether this turn owns the `QuestionStarted` emission for its response.
    /// The open handshake already announced the first response; every later
    /// accepted turn announces its own.
    pub(crate) announce_question: bool,
    /// Whether this turn opened a speech context, so a cancellation can tell
    /// the provider about it even if the turn never reached its finalizer.
    pub(crate) speech_opened: Arc<AtomicBool>,
    /// The one cooperative cancellation signal for this turn: the provider
    /// stages select on it and the event projection suppresses through it.
    pub(crate) cancelled: CancellationToken,
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

pub(crate) fn response_id_for_turn(turn: usize, client_generation_id: Option<&str>) -> String {
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

pub(crate) fn sanitized_response_generation_id(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '-',
        })
        .take(96)
        .collect()
}

pub(crate) async fn manuscript_intent_stage<F>(
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
            BrainFailureClass::Timeout,
            BrainFailureStage::Tools,
            true,
            deadline,
            "deadline_elapsed",
        )),
    }
}

pub(crate) struct ActiveRunnerResponse {
    pub(crate) response_id: String,
    pub(crate) cancelled: CancellationToken,
    pub(crate) completed: Arc<AtomicBool>,
    pub(crate) handle: JoinHandle<()>,
}

impl ActiveRunnerResponse {
    /// Signal the turn, then give it a bounded window to write the provider's
    /// cancel/close controls before forcing it down.
    pub(crate) async fn cancel_with_bounded_cleanup(&mut self, cleanup: Duration) {
        self.cancelled.cancel();
        if timeout(cleanup, &mut self.handle).await.is_err() {
            self.handle.abort();
        }
    }
}

impl Drop for ActiveRunnerResponse {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            self.cancelled.cancel();
            self.handle.abort();
        }
    }
}

/// Cancel the active response cooperatively and wait out the cleanup bound.
///
/// A response that already completed is simply forgotten: there is nothing to
/// cancel and no replacement to name.
pub(crate) async fn cancel_active_runner_response(
    active_response: &mut Option<ActiveRunnerResponse>,
) -> Option<String> {
    let mut active = active_response.take()?;
    if active.completed.load(Ordering::SeqCst) {
        return None;
    }
    active
        .cancel_with_bounded_cleanup(PROVIDER_CLEANUP_TIMEOUT)
        .await;
    Some(active.response_id.clone())
}

pub(crate) struct RunnerTranscript {
    pub(crate) interim_text: String,
    pub(crate) final_text: String,
    pub(crate) confidence: Option<f32>,
}

#[async_trait]
pub(crate) trait CartesiaGeminiTransports: Clone + Send + Sync + 'static {
    async fn authorize_open(&self) -> Result<(), BrainError> {
        Ok(())
    }

    /// Provider state for one opened Viva realtime session.
    ///
    /// `ADAPTER-04`: the returned instance owns this session's sockets,
    /// response contexts, and unread frames. Only process-wide connection pools
    /// are shared with other sessions; nothing is keyed by learner id.
    fn open_session(&self) -> Self {
        self.clone()
    }

    /// The single teardown path, invoked by Stop or session drop.
    async fn close_session(&self) {}

    async fn transcribe_audio(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        frame: &AudioFrame,
        cancel: &CancellationToken,
    ) -> Result<RunnerTranscript, BrainError>;

    async fn stream_gemini(
        &self,
        config: &CartesiaGeminiConfig,
        request: Value,
    ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure>;

    /// Feed more final-pass text into this response's speech context.
    async fn extend_speech(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        text: &str,
        interrupt: FakeRuntimeInterrupt,
        cancel: &CancellationToken,
    ) -> Result<(), BrainError>;

    /// Abandon this response's speech context: the turn was replaced or stopped
    /// before it could finish speaking.
    async fn cancel_speech(&self, config: &CartesiaGeminiConfig, response_id: &str) {
        let _ = (config, response_id);
    }

    /// Close the context and stream its audio out, frame by frame.
    async fn finish_speech(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        interrupt: FakeRuntimeInterrupt,
        cancel: &CancellationToken,
        sink: &mut dyn SpeechFrameSink,
    ) -> Result<(), BrainError>;
}

/// The live provider transports.
///
/// `ADAPTER-04`: one `reqwest::Client` — the HTTP connection pool — is shared by
/// every Gemini call in the process, while the Cartesia speech connection is
/// per opened session. Cloning shares both through `Arc`; only
/// [`open_session`](CartesiaGeminiTransports::open_session) mints a new speech
/// connection.
#[derive(Clone, Debug)]
pub(crate) struct LiveCartesiaGeminiTransports {
    live_runtime_enabled: bool,
    gemini: Arc<ReqwestGeminiSseClient>,
    voice: Arc<SonicSessionVoice>,
}

impl LiveCartesiaGeminiTransports {
    pub(crate) fn new(live_runtime_enabled: bool) -> Self {
        Self {
            live_runtime_enabled,
            gemini: Arc::new(ReqwestGeminiSseClient::shared()),
            voice: Arc::new(SonicSessionVoice::websocket()),
        }
    }

    /// The shared HTTP pool, so the evaluator and the tool loop reuse one.
    pub(crate) fn gemini_client(&self) -> Arc<ReqwestGeminiSseClient> {
        Arc::clone(&self.gemini)
    }
}

#[async_trait]
impl CartesiaGeminiTransports for LiveCartesiaGeminiTransports {
    fn open_session(&self) -> Self {
        Self {
            live_runtime_enabled: self.live_runtime_enabled,
            // The HTTP pool is process-wide; the speech connection is not.
            gemini: Arc::clone(&self.gemini),
            voice: Arc::new(SonicSessionVoice::websocket()),
        }
    }

    async fn close_session(&self) {
        self.voice.close().await;
    }

    async fn authorize_open(&self) -> Result<(), BrainError> {
        if self.live_runtime_enabled {
            return Ok(());
        }
        // The runner is wired but the live transports are gated, so no network
        // connection is attempted. That is an operator configuration fact and it
        // is never retried as a provider blip.
        Err(brain_failure(BrainProviderFailureParts {
            failure_class: BrainFailureClass::ProviderAuthFailure,
            stage: BrainFailureStage::Startup,
            retry_eligible: false,
            latency_ms: 0,
            provider: "cartesia_gemini".to_owned(),
            model: "cartesia_gemini".to_owned(),
            metadata: "error_kind=live_runtime_gated".to_owned(),
        }))
    }

    async fn transcribe_audio(
        &self,
        config: &CartesiaGeminiConfig,
        _response_id: &str,
        frame: &AudioFrame,
        cancel: &CancellationToken,
    ) -> Result<RunnerTranscript, BrainError> {
        let started = Instant::now();
        let transcript =
            transcribe_ink_websocket(&config.ink, &config.cartesia_api_key, frame, cancel)
                .await
                .map_err(|error| failure_with_latency(error, started.elapsed()))?;
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
    ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
        let started = Instant::now();
        stream_gemini_http_with_attempt_events(self.gemini.as_ref(), &config.gemini, request)
            .await
            .map_err(|failure| GeminiStreamAttemptFailure {
                events: failure.events,
                error: failure_with_latency(failure.error, started.elapsed()),
            })
    }

    async fn extend_speech(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        text: &str,
        _interrupt: FakeRuntimeInterrupt,
        _cancel: &CancellationToken,
    ) -> Result<(), BrainError> {
        let started = Instant::now();
        self.voice
            .extend(&config.sonic, &config.cartesia_api_key, response_id, text)
            .await
            .map_err(|error| failure_with_latency(error, started.elapsed()))
    }

    async fn cancel_speech(&self, _config: &CartesiaGeminiConfig, response_id: &str) {
        self.voice.cancel_context(response_id).await;
    }

    async fn finish_speech(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        _interrupt: FakeRuntimeInterrupt,
        cancel: &CancellationToken,
        sink: &mut dyn SpeechFrameSink,
    ) -> Result<(), BrainError> {
        let started = Instant::now();
        self.voice
            .finish(&config.sonic, response_id, cancel, sink)
            .await
            .map_err(|error| failure_with_latency(error, started.elapsed()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use agent_domain::{BrainInput, SessionConfig, SessionId, StudyMode, TerminalSessionReason};

    use crate::cartesia_gemini::runner::tests::learning_ready_seeded_store;
    use crate::cartesia_gemini::runner::{CartesiaGeminiRunner, EvaluatorProvenance};
    use crate::cartesia_gemini::FakeCartesiaGeminiTransports;
    use crate::synthetic::synthetic_fixture_answer_evaluator;

    #[tokio::test]
    async fn manuscript_intent_authorization_uses_stage_deadline() {
        let error = manuscript_intent_stage(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                true
            },
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(failure.stage(), BrainFailureStage::Tools);
        assert_eq!(failure.provider(), "server");
        assert_eq!(failure.model(), "viva-tools");
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderTimeout
        );
        assert!(failure.retry_eligible());
        assert_eq!(failure.latency_ms(), 1);
        assert_eq!(
            failure.metadata(),
            "tool=emit_manuscript_intent error_kind=deadline_elapsed"
        );
    }

    #[tokio::test]
    async fn gemini_two_pass_tool_loop_reuses_one_http_connection_pool() {
        let server = GeminiKeepAliveServer::start().await;
        let store = learning_ready_seeded_store();
        let session_config = SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        };
        let runner = CartesiaGeminiRunner::scripted(
            CartesiaGeminiConfig {
                gemini: super::super::GeminiConfig {
                    api_key: "gemini-test-key".to_owned(),
                    base_url: server.base_url.clone(),
                    ..super::super::GeminiConfig::default()
                },
                ..CartesiaGeminiConfig::default()
            },
            PooledGeminiTransports::new(),
            store,
            synthetic_fixture_answer_evaluator(),
            EvaluatorProvenance::SyntheticFixture,
        );
        let mut session = runner.open(session_config).await.unwrap();

        session
            .input
            .send(BrainInput::Text("one pooled turn".to_owned()))
            .await
            .unwrap();
        let mut events = Vec::new();
        loop {
            let event = timeout(Duration::from_secs(10), session.events.recv())
                .await
                .expect("the pooled turn completes")
                .expect("the session stays open");
            let completed = matches!(&event, BrainEvent::ResponseCompleted { .. });
            let failed = matches!(&event, BrainEvent::Error(_));
            events.push(event);
            if completed || failed {
                break;
            }
        }
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, BrainEvent::Error(_))),
            "the pooled turn must succeed: {events:?}"
        );

        assert_eq!(
            server.requests(),
            2,
            "the tool loop makes both Gemini passes"
        );
        assert_eq!(
            server.accepted_connections(),
            1,
            "both passes must share one HTTP connection pool"
        );
    }

    /// A local keep-alive HTTP/1.1 server that counts accepted TCP connections
    /// and serves the two `streamGenerateContent` passes of one tool loop.
    struct GeminiKeepAliveServer {
        base_url: String,
        record: Arc<std::sync::Mutex<(u32, u32)>>,
    }

    impl GeminiKeepAliveServer {
        async fn start() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("a loopback port is available");
            let port = listener.local_addr().expect("bound address").port();
            let record = Arc::new(std::sync::Mutex::new((0_u32, 0_u32)));
            let served = Arc::clone(&record);
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    served.lock().expect("server lock poisoned").0 += 1;
                    let served = Arc::clone(&served);
                    tokio::spawn(async move {
                        serve_gemini_connection(stream, served).await;
                    });
                }
            });
            Self {
                base_url: format!("http://127.0.0.1:{port}"),
                record,
            }
        }

        fn accepted_connections(&self) -> u32 {
            self.record.lock().expect("server lock poisoned").0
        }

        fn requests(&self) -> u32 {
            self.record.lock().expect("server lock poisoned").1
        }
    }

    async fn serve_gemini_connection(
        mut stream: tokio::net::TcpStream,
        record: Arc<std::sync::Mutex<(u32, u32)>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut buffer = Vec::new();
        let mut scratch = [0_u8; 4096];
        loop {
            // Read one complete request: headers, then exactly Content-Length bytes.
            let head_end = loop {
                if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
                match stream.read(&mut scratch).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => buffer.extend_from_slice(&scratch[..read]),
                }
            };
            let head = String::from_utf8_lossy(&buffer[..head_end]).to_ascii_lowercase();
            let content_length = head
                .split("\r\n")
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or_default();
            while buffer.len() < head_end + content_length {
                match stream.read(&mut scratch).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => buffer.extend_from_slice(&scratch[..read]),
                }
            }
            let request_body =
                String::from_utf8_lossy(&buffer[head_end..head_end + content_length]).to_string();
            buffer.drain(..head_end + content_length);

            let pass = {
                let mut record = record.lock().expect("server lock poisoned");
                record.1 += 1;
                record.1
            };
            // The first pass proposes the evaluation tool; the second speaks.
            let body = if pass == 1 && !request_body.contains("functionResponse") {
                concat!(
                    r#"data: {"candidates":[{"content":{"parts":[{"functionCall":"#,
                    r#"{"id":"call-eval-1","name":"evaluate_spoken_answer","args":{}}}]}}],"#,
                    r#""usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":3}}"#,
                    "\n\n"
                )
                .to_owned()
            } else {
                concat!(
                    r#"data: {"candidates":[{"content":{"parts":[{"text":"#,
                    r#""Thanks - here is the next question."}]}}],"#,
                    r#""usageMetadata":{"promptTokenCount":13,"candidatesTokenCount":5}}"#,
                    "\n\n"
                )
                .to_owned()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            if stream.write_all(response.as_bytes()).await.is_err() {
                return;
            }
        }
    }

    /// Fixture Ink/Sonic with a live, pooled Gemini client.
    #[derive(Clone)]
    struct PooledGeminiTransports {
        inner: FakeCartesiaGeminiTransports,
        live: LiveCartesiaGeminiTransports,
    }

    impl PooledGeminiTransports {
        fn new() -> Self {
            Self {
                inner: FakeCartesiaGeminiTransports::new(),
                live: LiveCartesiaGeminiTransports::new(true),
            }
        }
    }

    #[async_trait]
    impl CartesiaGeminiTransports for PooledGeminiTransports {
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
            self.live.stream_gemini(config, request).await
        }

        async fn extend_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            text: &str,
            interrupt: FakeRuntimeInterrupt,
            cancel: &CancellationToken,
        ) -> Result<(), BrainError> {
            self.inner
                .extend_speech(config, response_id, text, interrupt, cancel)
                .await
        }

        async fn finish_speech(
            &self,
            config: &CartesiaGeminiConfig,
            response_id: &str,
            interrupt: FakeRuntimeInterrupt,
            cancel: &CancellationToken,
            sink: &mut dyn SpeechFrameSink,
        ) -> Result<(), BrainError> {
            self.inner
                .finish_speech(config, response_id, interrupt, cancel, sink)
                .await
        }
    }
}
