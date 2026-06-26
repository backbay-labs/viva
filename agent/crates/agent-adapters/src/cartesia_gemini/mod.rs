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
    answer_attempt_envelope, CartesiaGeminiRunner, FakeCartesiaGeminiTransports,
    LiveCartesiaGeminiTransports, RunnerInput,
};

pub(crate) const FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT: &str =
    "NADH donates electrons to the electron transport chain.";

#[derive(Clone, Eq, PartialEq)]
pub struct CartesiaGeminiConfig {
    pub cartesia_api_key: String,
    pub gemini: GeminiConfig,
    pub ink: InkConfig,
    pub sonic: SonicConfig,
    pub live_runtime_enabled: bool,
    pub cartesia_zero_data_retention_enabled: bool,
    pub gemini_zero_data_retention_approved: bool,
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
            .field("live_runtime_enabled", &self.live_runtime_enabled)
            .field(
                "cartesia_zero_data_retention_enabled",
                &self.cartesia_zero_data_retention_enabled,
            )
            .field(
                "gemini_zero_data_retention_approved",
                &self.gemini_zero_data_retention_approved,
            )
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
            live_runtime_enabled: false,
            cartesia_zero_data_retention_enabled: false,
            gemini_zero_data_retention_approved: false,
            tools: viva_tool_declarations(),
        }
    }
}

impl CartesiaGeminiConfig {
    pub fn from_env() -> Self {
        Self::from_env_with(env_value)
    }

    fn from_env_with(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let env_value = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let mut config = Self {
            cartesia_api_key: env_value("CARTESIA_API_KEY").unwrap_or_default(),
            gemini: GeminiConfig {
                api_key: env_value("GEMINI_API_KEY").unwrap_or_default(),
                ..GeminiConfig::default()
            },
            ..Self::default()
        };
        config.live_runtime_enabled =
            env_value("VIVA_CARTESIA_GEMINI_LIVE_RUNTIME").as_deref() == Some("1");
        config.cartesia_zero_data_retention_enabled =
            env_value("CARTESIA_ZERO_DATA_RETENTION_ENABLED").as_deref() == Some("1");
        config.gemini_zero_data_retention_approved =
            env_value("GEMINI_ZERO_DATA_RETENTION_APPROVED").as_deref() == Some("1");
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
        if let Some(websocket_url) = env_value("CARTESIA_INK_WEBSOCKET_URL") {
            config.ink.websocket_url = websocket_url;
        }
        if let Some(model) = env_value("CARTESIA_INK_MODEL") {
            config.ink.model = model;
        }
        if let Some(language) = env_value("CARTESIA_INK_LANGUAGE") {
            config.ink.language = language;
        }
        if let Some(encoding) = env_value("CARTESIA_INK_ENCODING") {
            config.ink.encoding = encoding;
        }
        if let Some(sample_rate) = env_value("CARTESIA_INK_SAMPLE_RATE")
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|sample_rate| *sample_rate > 0)
        {
            config.ink.sample_rate = sample_rate;
        }
        if let Some(min_volume) = env_value("CARTESIA_INK_MIN_VOLUME") {
            config.ink.min_volume = min_volume;
        }
        if let Some(max_silence_duration_secs) = env_value("CARTESIA_INK_MAX_SILENCE_DURATION_SECS")
        {
            config.ink.max_silence_duration_secs = max_silence_duration_secs;
        }
        if let Some(cartesia_version) =
            env_value("CARTESIA_VERSION").or_else(|| env_value("CARTESIA_INK_VERSION"))
        {
            config.ink.cartesia_version = cartesia_version;
        }
        if let Some(websocket_url) = env_value("CARTESIA_SONIC_WEBSOCKET_URL") {
            config.sonic.websocket_url = websocket_url;
        }
        if let Some(model) = env_value("CARTESIA_SONIC_MODEL") {
            config.sonic.model_id = model;
        }
        if let Some(voice_id) =
            env_value("CARTESIA_VOICE_ID").or_else(|| env_value("CARTESIA_SONIC_VOICE_ID"))
        {
            config.sonic.voice_id = voice_id;
        }
        if let Some(language) = env_value("CARTESIA_SONIC_LANGUAGE") {
            config.sonic.language = language;
        }
        if let Some(sample_rate) = env_value("CARTESIA_SONIC_SAMPLE_RATE")
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|sample_rate| *sample_rate > 0)
        {
            config.sonic.sample_rate = sample_rate;
        }
        if let Some(max_buffer_delay_ms) = env_value("CARTESIA_SONIC_MAX_BUFFER_DELAY_MS")
            .and_then(|value| value.parse::<u32>().ok())
        {
            config.sonic.max_buffer_delay_ms = max_buffer_delay_ms;
        }
        if let Some(cartesia_version) =
            env_value("CARTESIA_VERSION").or_else(|| env_value("CARTESIA_SONIC_VERSION"))
        {
            config.sonic.cartesia_version = cartesia_version;
        }
        config
    }

    pub fn missing_live_keys(&self) -> bool {
        self.cartesia_api_key.trim().is_empty() || self.gemini.api_key.trim().is_empty()
    }

    pub fn selectable_live_keys(&self) -> bool {
        !self.missing_live_keys()
            && !is_placeholder_live_key(&self.cartesia_api_key)
            && !is_placeholder_live_key(&self.gemini.api_key)
    }

    pub fn provider_zero_data_retention_confirmed(&self) -> bool {
        self.cartesia_zero_data_retention_enabled && self.gemini_zero_data_retention_approved
    }

    pub fn live_runtime_selectable(&self) -> bool {
        self.live_runtime_enabled
            && self.selectable_live_keys()
            && self.provider_zero_data_retention_confirmed()
    }
}

#[derive(Clone, Debug)]
pub struct CartesiaGeminiBrain {
    config: CartesiaGeminiConfig,
    runner: CartesiaGeminiRunner<LiveCartesiaGeminiTransports>,
}

impl CartesiaGeminiBrain {
    pub fn new(config: CartesiaGeminiConfig, store: Arc<dyn StudyMemoryStore>) -> Self {
        Self {
            runner: CartesiaGeminiRunner::live(store, config.clone()),
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
        let selectable = self.config.live_runtime_selectable();
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: !self.config.missing_live_keys(),
            selectable,
            live_runtime: selectable,
        }
    }

    async fn open(&self, _config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        if self.config.missing_live_keys() {
            return Err(BrainError::MissingApiKey);
        }
        if !self.config.selectable_live_keys() {
            return Err(BrainError::Protocol(
                "live Cartesia/Gemini keys must be real provider credentials; placeholder release-check keys cannot open live transports"
                    .to_owned(),
            ));
        }
        if !self.config.provider_zero_data_retention_confirmed() {
            return Err(BrainError::Protocol(
                "live Cartesia/Gemini requires provider zero-data-retention confirmation; set CARTESIA_ZERO_DATA_RETENTION_ENABLED=1 and GEMINI_ZERO_DATA_RETENTION_APPROVED=1 only after provider-side configuration is complete"
                    .to_owned(),
            ));
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
    MalformedGeminiManuscriptIntent,
    UnauthorizedGeminiManuscriptIntent,
    NoGeminiManuscriptIntent,
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
                let runner_input = match input {
                    BrainInput::Audio(frame) => RunnerInput::Audio {
                        frame,
                        client_generation_id: None,
                    },
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => RunnerInput::Audio {
                        frame,
                        client_generation_id,
                    },
                    BrainInput::Text(text) => RunnerInput::Text {
                        text,
                        client_generation_id: None,
                    },
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => RunnerInput::Text {
                        text,
                        client_generation_id,
                    },
                    BrainInput::Stop => break,
                    _ => continue,
                };
                let response_id = "fake-cartesia-gemini-session-response-1".to_owned();
                let executor = VivaToolExecutor::new(store.clone(), session.clone());
                let question = match select_next_question(&executor, &session).await {
                    Ok(question) => question,
                    Err(error) => {
                        emit_fake_provider_error(&event_tx, error.to_string()).await;
                        break;
                    }
                };
                if let Err(error) = executor
                    .record_answer_attempt_envelope(answer_attempt_envelope(
                        &session,
                        &question,
                        &response_id,
                        1,
                        &runner_input,
                    ))
                    .await
                {
                    emit_fake_provider_error(&event_tx, error.to_string()).await;
                    break;
                }
                let final_transcript = match runner_input {
                    RunnerInput::Audio { .. } => FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT.to_owned(),
                    RunnerInput::Text { text, .. } => text,
                };
                let _ = event_tx.send(BrainEvent::InputSpeechStarted).await;
                let _ = event_tx
                    .send(BrainEvent::TranscriptFinal {
                        response_id: response_id.clone(),
                        text: final_transcript.clone(),
                        confidence: Some(0.9),
                    })
                    .await;

                match scenario {
                    FakeSessionScenario::CancelDuringGeminiToolCall => {
                        let args = json!({
                            "study_set_id": session.study_set_id.clone(),
                            "voice_session_id": session.voice_session_id.clone(),
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": final_transcript.clone(),
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
                        let args = json!({
                            "study_set_id": session.study_set_id.clone(),
                            "voice_session_id": session.voice_session_id.clone(),
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": final_transcript.clone(),
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
                                BrainInput::Audio(_)
                                | BrainInput::AudioWithMetadata { .. }
                                | BrainInput::Text(_)
                                | BrainInput::TextWithMetadata { .. } => {
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

async fn emit_fake_provider_error(event_tx: &mpsc::Sender<BrainEvent>, message: String) {
    let (source, message) = fake_provider_error_source_and_message(&message);
    let _ = event_tx
        .send(BrainEvent::Error(BrainProviderError { source, message }))
        .await;
}

fn fake_provider_error_source_and_message(message: &str) -> (String, String) {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("adapter error")
        && fake_provider_store_error_is_durability_degraded(&normalized)
    {
        return (
            "fake-provider-store".to_owned(),
            "store adapter error".to_owned(),
        );
    }
    if normalized.contains("unavailable for")
        && fake_provider_store_error_is_durability_degraded(&normalized)
    {
        return (
            "fake-provider-store".to_owned(),
            "store unavailable".to_owned(),
        );
    }
    (
        "agent-service".to_owned(),
        "fake provider turn failed".to_owned(),
    )
}

fn fake_provider_store_error_is_durability_degraded(normalized: &str) -> bool {
    normalized.contains("store unavailable")
        || normalized.contains("database unavailable")
        || normalized.contains("durable store")
        || ((normalized.contains("postgres")
            || normalized.contains("database")
            || normalized.contains("store"))
            && (normalized.contains("connection")
                || normalized.contains("pool")
                || normalized.contains("timed out")
                || normalized.contains("timeout")))
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn is_placeholder_live_key(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("viva-release-check-") || normalized.contains("placeholder")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_env_applies_ink_transport_overrides() {
        let config = CartesiaGeminiConfig::from_env_with(|name| match name {
            "CARTESIA_API_KEY" => Some(" cartesia-key ".to_owned()),
            "GEMINI_API_KEY" => Some(" gemini-key ".to_owned()),
            "CARTESIA_INK_WEBSOCKET_URL" => {
                Some(" wss://example.test/stt/turns/websocket ".to_owned())
            }
            "CARTESIA_INK_MODEL" => Some(" ink-custom ".to_owned()),
            "CARTESIA_INK_LANGUAGE" => Some(" en ".to_owned()),
            "CARTESIA_INK_ENCODING" => Some(" pcm_f32le ".to_owned()),
            "CARTESIA_INK_SAMPLE_RATE" => Some(" 16000 ".to_owned()),
            "CARTESIA_INK_MIN_VOLUME" => Some(" 0.2 ".to_owned()),
            "CARTESIA_INK_MAX_SILENCE_DURATION_SECS" => Some(" 1.1 ".to_owned()),
            "CARTESIA_VERSION" => Some(" 2026-03-01 ".to_owned()),
            _ => None,
        });

        assert_eq!(config.cartesia_api_key, "cartesia-key");
        assert_eq!(config.gemini.api_key, "gemini-key");
        assert_eq!(
            config.ink.websocket_url,
            "wss://example.test/stt/turns/websocket"
        );
        assert_eq!(config.ink.model, "ink-custom");
        assert_eq!(config.ink.language, "en");
        assert_eq!(config.ink.encoding, "pcm_f32le");
        assert_eq!(config.ink.sample_rate, 16_000);
        assert_eq!(config.ink.min_volume, "0.2");
        assert_eq!(config.ink.max_silence_duration_secs, "1.1");
        assert_eq!(config.ink.cartesia_version, "2026-03-01");
    }

    #[test]
    fn from_env_applies_sonic_transport_overrides() {
        let config = CartesiaGeminiConfig::from_env_with(|name| match name {
            "CARTESIA_SONIC_WEBSOCKET_URL" => Some(" wss://example.test/tts/websocket ".to_owned()),
            "CARTESIA_SONIC_MODEL" => Some(" sonic-custom ".to_owned()),
            "CARTESIA_SONIC_VOICE_ID" => Some(" voice-custom ".to_owned()),
            "CARTESIA_SONIC_LANGUAGE" => Some(" es ".to_owned()),
            "CARTESIA_SONIC_SAMPLE_RATE" => Some(" 16000 ".to_owned()),
            "CARTESIA_SONIC_MAX_BUFFER_DELAY_MS" => Some(" 40 ".to_owned()),
            "CARTESIA_SONIC_VERSION" => Some(" 2026-03-01 ".to_owned()),
            _ => None,
        });

        assert_eq!(
            config.sonic.websocket_url,
            "wss://example.test/tts/websocket"
        );
        assert_eq!(config.sonic.model_id, "sonic-custom");
        assert_eq!(config.sonic.voice_id, "voice-custom");
        assert_eq!(config.sonic.language, "es");
        assert_eq!(config.sonic.sample_rate, 16_000);
        assert_eq!(config.sonic.max_buffer_delay_ms, 40);
        assert_eq!(config.sonic.cartesia_version, "2026-03-01");
    }

    #[test]
    fn from_env_parses_live_runtime_gate_conservatively() {
        let enabled = CartesiaGeminiConfig::from_env_with(|name| match name {
            "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME" => Some(" 1 ".to_owned()),
            "CARTESIA_ZERO_DATA_RETENTION_ENABLED" => Some(" 1 ".to_owned()),
            "GEMINI_ZERO_DATA_RETENTION_APPROVED" => Some(" 1 ".to_owned()),
            _ => None,
        });
        let disabled = CartesiaGeminiConfig::from_env_with(|name| match name {
            "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME" => Some(" true ".to_owned()),
            "CARTESIA_ZERO_DATA_RETENTION_ENABLED" => Some(" true ".to_owned()),
            "GEMINI_ZERO_DATA_RETENTION_APPROVED" => Some(" true ".to_owned()),
            _ => None,
        });
        let alias = CartesiaGeminiConfig::from_env_with(|name| match name {
            "VIVA_AGENT_CARTESIA_GEMINI_LIVE_RUNTIME" => Some(" 1 ".to_owned()),
            _ => None,
        });

        assert!(enabled.live_runtime_enabled);
        assert!(enabled.provider_zero_data_retention_confirmed());
        assert!(!disabled.live_runtime_enabled);
        assert!(!disabled.provider_zero_data_retention_confirmed());
        assert!(!alias.live_runtime_enabled);
        assert!(!alias.provider_zero_data_retention_confirmed());
    }

    #[test]
    fn fake_provider_store_errors_keep_only_sanitized_store_markers() {
        let (source, message) = fake_provider_error_source_and_message(
            "postgres adapter error: durable store write failed",
        );
        assert_eq!(source, "fake-provider-store");
        assert_eq!(message, "store adapter error");

        let (source, message) =
            fake_provider_error_source_and_message("postgres unavailable for durable store");
        assert_eq!(source, "fake-provider-store");
        assert_eq!(message, "store unavailable");

        let (source, message) =
            fake_provider_error_source_and_message("provider-specific raw turn failure");
        assert_eq!(source, "agent-service");
        assert_eq!(message, "fake provider turn failed");
    }

    #[test]
    fn fake_provider_store_errors_do_not_promote_semantic_store_failures() {
        let (source, message) = fake_provider_error_source_and_message(
            "postgres adapter error: answer attempt envelope cannot be changed",
        );
        assert_eq!(source, "agent-service");
        assert_eq!(message, "fake provider turn failed");

        let (source, message) =
            fake_provider_error_source_and_message("memory unavailable for missing-study-set");
        assert_eq!(source, "agent-service");
        assert_eq!(message, "fake provider turn failed");

        let (source, message) = fake_provider_error_source_and_message(
            "postgres unavailable for concept-1: concept is not available for this study set",
        );
        assert_eq!(source, "agent-service");
        assert_eq!(message, "fake provider turn failed");
    }
}
