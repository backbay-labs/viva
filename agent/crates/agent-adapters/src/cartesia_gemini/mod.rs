pub mod constants;
pub mod llm;
mod runner;
pub mod stt;
pub mod tts;

use std::{
    env, fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::json;
use serde_json::Value;
use tokio::sync::mpsc;

use agent_domain::{
    AudioFrame, AuthorizedStudySession, BrainError, BrainEvent, BrainInput, BrainProviderError,
    BrainUsage, RealtimeBrain, RealtimeBrainCapabilities, RealtimeSession,
    RealtimeSessionTaskGuard, SessionConfig, StudyMemoryStore, StudyQuestion, ToolProposal,
    VivaToolExecutor,
};

pub use llm::{
    gemini_request, parse_gemini_sse_line, viva_tool_declarations, GeminiConfig, GeminiStreamEvent,
    ThinkingLevel,
};
pub use stt::{audio_frame_bytes, parse_ink_event, InkConfig, InkEvent};
pub use tts::{parse_sonic_event, sonic_generation_request, SonicConfig, SonicEvent};

use runner::{
    CartesiaGeminiRunner, FakeCartesiaGeminiTransports, GatedNoNetworkCartesiaGeminiTransports,
};

#[derive(Clone, Eq, PartialEq)]
pub struct CartesiaGeminiConfig {
    pub cartesia_api_key: String,
    pub gemini: GeminiConfig,
    pub ink: InkConfig,
    pub sonic: SonicConfig,
    pub tools: Vec<serde_json::Value>,
}

impl fmt::Debug for CartesiaGeminiConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CartesiaGeminiConfig")
            .field("cartesia_api_key", &"<redacted>")
            .field("gemini", &self.gemini)
            .field("ink", &self.ink)
            .field("sonic", &self.sonic)
            .field("tool_count", &self.tools.len())
            .finish()
    }
}

impl Default for CartesiaGeminiConfig {
    fn default() -> Self {
        Self {
            cartesia_api_key: String::new(),
            gemini: GeminiConfig::default(),
            ink: InkConfig::default(),
            sonic: SonicConfig::default(),
            tools: viva_tool_declarations(),
        }
    }
}

impl CartesiaGeminiConfig {
    pub fn from_env() -> Self {
        let mut config = Self {
            cartesia_api_key: env_value("CARTESIA_API_KEY").unwrap_or_default(),
            gemini: GeminiConfig {
                api_key: env_value("GEMINI_API_KEY").unwrap_or_default(),
                ..GeminiConfig::default()
            },
            ..Self::default()
        };
        if let Some(model) =
            env_value("GEMINI_MODEL").or_else(|| env_value("GEMINI_REALTIME_MODEL"))
        {
            config.gemini.model_id = model;
        }
        if let Some(base_url) = env_value("GEMINI_BASE_URL") {
            config.gemini.base_url = base_url;
        }
        if let Some(thinking_level) = env_value("GEMINI_THINKING_LEVEL") {
            config.gemini.thinking_level = ThinkingLevel::parse(thinking_level);
        }
        if let Some(model) = env_value("CARTESIA_INK_MODEL") {
            config.ink.model = model;
        }
        if let Some(model) = env_value("CARTESIA_SONIC_MODEL") {
            config.sonic.model_id = model;
        }
        if let Some(voice_id) =
            env_value("CARTESIA_VOICE_ID").or_else(|| env_value("CARTESIA_SONIC_VOICE_ID"))
        {
            config.sonic.voice_id = voice_id;
        }
        config
    }

    pub fn missing_live_keys(&self) -> bool {
        self.cartesia_api_key.trim().is_empty() || self.gemini.api_key.trim().is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct CartesiaGeminiBrain {
    config: CartesiaGeminiConfig,
    runner: CartesiaGeminiRunner<GatedNoNetworkCartesiaGeminiTransports>,
}

impl CartesiaGeminiBrain {
    pub fn new(config: CartesiaGeminiConfig) -> Self {
        Self {
            runner: CartesiaGeminiRunner::gated_live(config.clone()),
            config,
        }
    }

    pub fn config(&self) -> &CartesiaGeminiConfig {
        &self.config
    }
}

#[async_trait]
impl RealtimeBrain for CartesiaGeminiBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: !self.config.missing_live_keys(),
            selectable: false,
            live_runtime: false,
        }
    }

    async fn open(&self, _config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        if self.config.missing_live_keys() {
            return Err(BrainError::MissingApiKey);
        }

        self.runner.open(_config).await
    }
}

#[derive(Clone)]
pub struct FakeCartesiaGeminiRuntime {
    runner: CartesiaGeminiRunner<FakeCartesiaGeminiTransports>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeRuntimeInterrupt {
    None,
    CancelDuringGeminiToolCall,
    BargeInDuringSonicAudio,
    WriterFailureBeforeSonicAudio,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeSessionScenario {
    CancelDuringGeminiToolCall,
    BargeInDuringSonicAudio,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FakeRuntimeReport {
    pub events: Vec<BrainEvent>,
    pub stopped_stage: Option<&'static str>,
}

impl FakeCartesiaGeminiRuntime {
    pub fn new(store: Arc<dyn StudyMemoryStore>) -> Self {
        Self {
            runner: CartesiaGeminiRunner::fake(store, CartesiaGeminiConfig::default()),
        }
    }

    pub async fn replay_audio_turn(
        &self,
        session_config: SessionConfig,
        frame: AudioFrame,
    ) -> Result<Vec<BrainEvent>, BrainError> {
        Ok(self
            .replay_audio_turn_with_interrupt(session_config, frame, FakeRuntimeInterrupt::None)
            .await?
            .events)
    }

    pub async fn replay_audio_turn_with_interrupt(
        &self,
        session_config: SessionConfig,
        frame: AudioFrame,
        interrupt: FakeRuntimeInterrupt,
    ) -> Result<FakeRuntimeReport, BrainError> {
        self.runner
            .replay_audio_turn(session_config, frame, interrupt)
            .await
    }

    pub fn open_scripted_session(
        &self,
        session_config: SessionConfig,
        scenario: FakeSessionScenario,
    ) -> Result<RealtimeSession, BrainError> {
        let session = AuthorizedStudySession::from_config(&session_config)
            .map_err(|error| BrainError::Protocol(error.to_string()))?;
        let store = self.runner.store().ok_or_else(|| {
            BrainError::Protocol("fake Cartesia/Gemini runner missing study store".to_owned())
        })?;
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(32);
        let (event_tx, events) = mpsc::channel::<BrainEvent>(32);
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                let audio_len = match input {
                    BrainInput::Audio(frame) => frame.pcm16_bytes().len(),
                    BrainInput::Text(text) => text.len(),
                    BrainInput::Stop => break,
                    _ => continue,
                };
                let response_id = "fake-cartesia-gemini-session-response-1".to_owned();
                let _ = event_tx.send(BrainEvent::InputSpeechStarted).await;
                let _ = event_tx
                    .send(BrainEvent::TranscriptFinal {
                        response_id: response_id.clone(),
                        text: format!("received {audio_len} bytes"),
                        confidence: Some(0.9),
                    })
                    .await;

                match scenario {
                    FakeSessionScenario::CancelDuringGeminiToolCall => {
                        let executor = VivaToolExecutor::new(store.clone(), session.clone());
                        let args = json!({
                            "study_set_id": session.study_set_id.clone(),
                            "voice_session_id": session.voice_session_id.clone(),
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": "NADH donates electrons to the electron transport chain.",
                        });
                        let tool_response_id = response_id.clone();
                        let mut tool_task = tokio::spawn(async move {
                            executor
                                .execute(
                                    &tool_response_id,
                                    ToolProposal::new("evaluate_spoken_answer", args)
                                        .with_call_id("call-eval-1"),
                                )
                                .await
                        });
                        loop {
                            tokio::select! {
                                input = input_rx.recv() => {
                                    match input {
                                        Some(BrainInput::CancelResponse) => {
                                            tool_task.abort();
                                            let _ = event_tx
                                                .send(BrainEvent::ResponseCancelledFor {
                                                    response_id: response_id.clone(),
                                                })
                                                .await;
                                            break;
                                        }
                                        Some(BrainInput::Stop) | None => {
                                            tool_task.abort();
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                                _ = &mut tool_task => {
                                    break;
                                }
                            }
                        }
                    }
                    FakeSessionScenario::BargeInDuringSonicAudio => {
                        let executor = VivaToolExecutor::new(store.clone(), session.clone());
                        let args = json!({
                            "study_set_id": session.study_set_id.clone(),
                            "voice_session_id": session.voice_session_id.clone(),
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": "NADH donates electrons to the electron transport chain.",
                        });
                        if executor
                            .execute(
                                &response_id,
                                ToolProposal::new("evaluate_spoken_answer", args)
                                    .with_call_id("call-eval-1"),
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                        let _ = event_tx
                            .send(BrainEvent::Usage(BrainUsage {
                                text_input_tokens: 20,
                                text_output_tokens: 10,
                                source_grounded_correction_count: 1,
                                ..BrainUsage::default()
                            }))
                            .await;
                        while let Some(input) = input_rx.recv().await {
                            match input {
                                BrainInput::Audio(_) | BrainInput::Text(_) => {
                                    let _ = event_tx
                                        .send(BrainEvent::ResponseCancelledFor {
                                            response_id: response_id.clone(),
                                        })
                                        .await;
                                    break;
                                }
                                BrainInput::CancelResponse => {
                                    let _ = event_tx
                                        .send(BrainEvent::ResponseCancelledFor {
                                            response_id: response_id.clone(),
                                        })
                                        .await;
                                    break;
                                }
                                BrainInput::Stop => break,
                                _ => {}
                            }
                        }
                    }
                }
                break;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

#[async_trait]
impl RealtimeBrain for FakeCartesiaGeminiRuntime {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "fake_cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, session_config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        self.runner.open(session_config).await
    }
}

async fn select_next_question(
    executor: &VivaToolExecutor,
    session: &AuthorizedStudySession,
) -> Result<StudyQuestion, BrainError> {
    let result = executor
        .execute(
            "response-0",
            ToolProposal::select_next_question(
                &session.study_set_id,
                &session.voice_session_id,
                session.mode.as_str(),
            ),
        )
        .await
        .map_err(|error| BrainError::Protocol(error.to_string()))?;
    parse_result_field(&result.result, "question")
}

async fn send_fake_unless_cancelled(
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

fn parse_result_field<T>(value: &Value, field: &str) -> Result<T, BrainError>
where
    T: DeserializeOwned,
{
    let Some(field_value) = value.get(field) else {
        return Err(BrainError::Protocol(format!(
            "fake tool result missing `{field}`"
        )));
    };
    serde_json::from_value(field_value.clone())
        .map_err(|error| BrainError::Protocol(error.to_string()))
}

async fn emit_fake_provider_error(event_tx: &mpsc::Sender<BrainEvent>, _message: String) {
    let _ = event_tx
        .send(BrainEvent::Error(BrainProviderError {
            source: "agent-service".to_owned(),
            message: "fake provider turn failed".to_owned(),
        }))
        .await;
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
