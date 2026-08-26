pub mod constants;
pub mod llm;
mod projection;
mod runner;
mod session;
pub mod stt;
pub mod tts;

use std::{
    env, fmt,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_util::sync::CancellationToken;

use agent_domain::{
    tool_executor::VIVA_STUDY_MODE, AudioFrame, AuthorizedStudySession, BrainError, BrainEvent,
    BrainFailureClass, BrainFailureStage, BrainInput, BrainProviderFailure,
    BrainProviderFailureParts, BrainUsage, QuestionProgressionResult, RealtimeBrain,
    RealtimeBrainCapabilities, RealtimeSession, RealtimeSessionTaskGuard, SessionConfig,
    StudyMemoryStore, StudyQuestion, ToolProposal, TurnOutcome, VivaToolExecutor,
};

pub use llm::{
    gemini_request, parse_gemini_sse_line, viva_tool_declarations, GeminiConfig, GeminiStreamEvent,
    ThinkingLevel,
};
pub use stt::{
    audio_frame_bytes, parse_ink_event, parse_ink_numeric, InkConfig, InkEvent,
    INK_MAX_SILENCE_SECS_RANGE, INK_MIN_VOLUME_RANGE,
};
pub use tts::{parse_sonic_event, sonic_generation_request, SonicConfig, SonicEvent};

pub(crate) use projection::{
    answer_evaluation_from_outcome, emit_provider_failure, learning_event_projection,
    outcome_contract_failure, parse_persisted_turn_outcome, recap_from_tool_result,
    send_fake_unless_cancelled, SessionPhaseTracker,
};

use crate::synthetic::fixture_response_text;
use llm::{GeminiEventStream, GeminiStreamAttemptFailure};
use runner::CartesiaGeminiRunner;
use session::{
    answer_attempt_envelope, CartesiaGeminiTransports, LiveCartesiaGeminiTransports, RunnerInput,
    RunnerTranscript,
};
use tts::SpeechFrameSink;

pub(crate) const FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT: &str =
    "NADH donates electrons to the electron transport chain.";
pub(crate) const MAX_GEMINI_TOOL_LOOP_PASSES: u32 = 2;
pub(crate) const MAX_GEMINI_EXECUTED_TOOL_STAGES: u32 = 5;
pub(crate) const DETERMINISTIC_STUDY_TOOL_STAGES: u32 = 3;

// ---------------------------------------------------------------------------
// `ADAPTER-01` shared seam: typed failures, the Plan 06 phase machine, and the
// one projection from a persisted Plan 04 outcome to learner-visible events.
//
// Everything below is consumed by both the Cartesia/Gemini runner and the
// synthetic runtime, so neither can grow a second, divergent copy of the rule.
// ---------------------------------------------------------------------------

/// Every adapter failure is a classified failure; there is no untyped path.
pub(crate) fn brain_failure(parts: BrainProviderFailureParts) -> BrainError {
    BrainError::from_failure(BrainProviderFailure::new(parts))
}

/// Re-stamp a source-constructed failure with the elapsed stage latency.
///
/// The transport that observed the status classifies it, but only the caller
/// that started the stage knows how long it took. Fields are private, so the
/// latency is applied by rebuilding the failure from its own accessors; a
/// failure that already carries a latency is returned untouched.
pub(crate) fn failure_with_latency(error: BrainError, latency: Duration) -> BrainError {
    let failure = error.failure();
    if failure.latency_ms() != 0 {
        return error;
    }
    brain_failure(BrainProviderFailureParts {
        failure_class: failure.failure_class(),
        stage: failure.stage(),
        retry_eligible: failure.retry_eligible(),
        latency_ms: duration_ms(latency),
        provider: failure.provider().to_owned(),
        model: failure.model().to_owned(),
        metadata: failure.metadata().to_owned(),
    })
}

pub(crate) fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

// ---------------------------------------------------------------------------
// `ADAPTER-06`: the one bounded, allowlisted provider-diagnostic vocabulary.
//
// Every live Gemini HTTP, Cartesia Ink, and Cartesia Sonic diagnostic is
// described by the closed types below. There is no free-form diagnostic string
// in the chain: a provider body, close reason, error message, error code,
// request URL or query, prompt, transcript, answer, audio, or credential has no
// representation here, so none of them can reach `BrainProviderFailureParts`,
// failure metadata, an emitted event, or a fallback event. A known HTTP status
// survives only as its integer and a WebSocket close only as its integer close
// code.
// ---------------------------------------------------------------------------

/// The hard ceiling Plan 06 enforces on failure metadata. The builder below
/// stays inside it by construction and is pinned by a unit test.
pub(crate) const MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES: usize = 240;

/// The typed provider stage a diagnostic was observed at.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderStageLabel {
    Gemini,
    CartesiaInk,
    CartesiaSonic,
}

impl ProviderStageLabel {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::CartesiaInk => "cartesia_ink",
            Self::CartesiaSonic => "cartesia_sonic",
        }
    }

    /// The typed source: which vendor the stage belongs to.
    pub(crate) const fn provider(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::CartesiaInk | Self::CartesiaSonic => "cartesia",
        }
    }
}

/// The closed diagnostic vocabulary. There is deliberately no `Other(String)`
/// variant: an unrecognized provider diagnostic collapses into the stage's
/// `*_http_rejected`, `*_ws_closed`, or `*_provider_error` code.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderDiagnosticCode {
    GeminiHttpAuth,
    GeminiHttpRateLimited,
    GeminiHttpRejected,
    CartesiaInkHttpAuth,
    CartesiaInkHttpRateLimited,
    CartesiaInkHttpRejected,
    CartesiaInkWsClosed,
    CartesiaInkProviderError,
    CartesiaSonicHttpAuth,
    CartesiaSonicHttpRateLimited,
    CartesiaSonicHttpRejected,
    CartesiaSonicWsClosed,
    CartesiaSonicProviderError,
}

impl ProviderDiagnosticCode {
    /// Only the closed-vocabulary test enumerates the set; production code
    /// always names the one code it observed.
    #[cfg(test)]
    pub(crate) const ALL: [Self; 13] = [
        Self::GeminiHttpAuth,
        Self::GeminiHttpRateLimited,
        Self::GeminiHttpRejected,
        Self::CartesiaInkHttpAuth,
        Self::CartesiaInkHttpRateLimited,
        Self::CartesiaInkHttpRejected,
        Self::CartesiaInkWsClosed,
        Self::CartesiaInkProviderError,
        Self::CartesiaSonicHttpAuth,
        Self::CartesiaSonicHttpRateLimited,
        Self::CartesiaSonicHttpRejected,
        Self::CartesiaSonicWsClosed,
        Self::CartesiaSonicProviderError,
    ];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::GeminiHttpAuth => "gemini_http_auth",
            Self::GeminiHttpRateLimited => "gemini_http_rate_limited",
            Self::GeminiHttpRejected => "gemini_http_rejected",
            Self::CartesiaInkHttpAuth => "cartesia_ink_http_auth",
            Self::CartesiaInkHttpRateLimited => "cartesia_ink_http_rate_limited",
            Self::CartesiaInkHttpRejected => "cartesia_ink_http_rejected",
            Self::CartesiaInkWsClosed => "cartesia_ink_ws_closed",
            Self::CartesiaInkProviderError => "cartesia_ink_provider_error",
            Self::CartesiaSonicHttpAuth => "cartesia_sonic_http_auth",
            Self::CartesiaSonicHttpRateLimited => "cartesia_sonic_http_rate_limited",
            Self::CartesiaSonicHttpRejected => "cartesia_sonic_http_rejected",
            Self::CartesiaSonicWsClosed => "cartesia_sonic_ws_closed",
            Self::CartesiaSonicProviderError => "cartesia_sonic_provider_error",
        }
    }

    pub(crate) const fn stage(self) -> ProviderStageLabel {
        match self {
            Self::GeminiHttpAuth | Self::GeminiHttpRateLimited | Self::GeminiHttpRejected => {
                ProviderStageLabel::Gemini
            }
            Self::CartesiaInkHttpAuth
            | Self::CartesiaInkHttpRateLimited
            | Self::CartesiaInkHttpRejected
            | Self::CartesiaInkWsClosed
            | Self::CartesiaInkProviderError => ProviderStageLabel::CartesiaInk,
            Self::CartesiaSonicHttpAuth
            | Self::CartesiaSonicHttpRateLimited
            | Self::CartesiaSonicHttpRejected
            | Self::CartesiaSonicWsClosed
            | Self::CartesiaSonicProviderError => ProviderStageLabel::CartesiaSonic,
        }
    }
}

/// The only numeric provider facts allowed to survive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderStatusCode {
    Http(u16),
    WebSocketClose(u16),
}

/// One bounded provider diagnostic: typed stage, one closed code, an optional
/// numeric status or close code, and retry eligibility. Nothing else is
/// representable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProviderDiagnostic {
    pub(crate) stage: ProviderStageLabel,
    pub(crate) code: ProviderDiagnosticCode,
    pub(crate) status: Option<ProviderStatusCode>,
    pub(crate) retry_eligible: bool,
}

impl ProviderDiagnostic {
    pub(crate) const fn new(code: ProviderDiagnosticCode, retry_eligible: bool) -> Self {
        Self {
            stage: code.stage(),
            code,
            status: None,
            retry_eligible,
        }
    }

    pub(crate) const fn with_http_status(mut self, status: u16) -> Self {
        self.status = Some(ProviderStatusCode::Http(status));
        self
    }

    pub(crate) const fn with_close_code(mut self, close_code: Option<u16>) -> Self {
        self.status = match close_code {
            Some(close_code) => Some(ProviderStatusCode::WebSocketClose(close_code)),
            None => None,
        };
        self
    }

    pub(crate) const fn provider(&self) -> &'static str {
        self.stage.provider()
    }
}

/// The one metadata builder `llm.rs`, `stt.rs`, and `tts.rs` share.
///
/// Its inputs are only the typed stage, the closed diagnostic code, an optional
/// numeric HTTP status or WebSocket close code, and retry eligibility. Keys are
/// canonical ASCII and the ordering is deterministic, so observability can group
/// by any of them without parsing prose.
pub(crate) fn provider_diagnostic_metadata(diagnostic: &ProviderDiagnostic) -> String {
    debug_assert_eq!(diagnostic.stage, diagnostic.code.stage());
    let mut metadata = format!(
        "stage={} error_kind={}",
        diagnostic.stage.as_str(),
        diagnostic.code.as_str()
    );
    match diagnostic.status {
        Some(ProviderStatusCode::Http(status)) => {
            metadata.push_str(" http_status=");
            metadata.push_str(&status.to_string());
        }
        Some(ProviderStatusCode::WebSocketClose(close_code)) => {
            metadata.push_str(" ws_close_code=");
            metadata.push_str(&close_code.to_string());
        }
        None => {}
    }
    metadata.push_str(" retry_eligible=");
    metadata.push_str(if diagnostic.retry_eligible {
        "true"
    } else {
        "false"
    });
    metadata
}

/// Build a classified failure straight from a bounded diagnostic.
pub(crate) fn provider_diagnostic_failure(
    diagnostic: ProviderDiagnostic,
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    model: &str,
    latency: Duration,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible: diagnostic.retry_eligible,
        latency_ms: duration_ms(latency),
        provider: diagnostic.provider().to_owned(),
        model: model.to_owned(),
        metadata: provider_diagnostic_metadata(&diagnostic),
    })
}

/// How a rejected Cartesia WebSocket upgrade classifies.
///
/// The HTTP status is the only classifier: the refusal body, the request URL,
/// and the query never take part. Auth is never retried as a network blip.
pub(crate) fn cartesia_handshake_classification(
    stage: ProviderStageLabel,
    status: u16,
) -> (ProviderDiagnostic, BrainFailureClass, BrainFailureStage) {
    let ink = matches!(stage, ProviderStageLabel::CartesiaInk);
    let (code, failure_class, failure_stage, retry_eligible) = match status {
        401 | 403 => (
            if ink {
                ProviderDiagnosticCode::CartesiaInkHttpAuth
            } else {
                ProviderDiagnosticCode::CartesiaSonicHttpAuth
            },
            BrainFailureClass::ProviderAuthFailure,
            BrainFailureStage::ProviderAuth,
            false,
        ),
        429 => (
            if ink {
                ProviderDiagnosticCode::CartesiaInkHttpRateLimited
            } else {
                ProviderDiagnosticCode::CartesiaSonicHttpRateLimited
            },
            BrainFailureClass::QuotaRateFailure,
            BrainFailureStage::Provider,
            true,
        ),
        500..=599 => (
            if ink {
                ProviderDiagnosticCode::CartesiaInkHttpRejected
            } else {
                ProviderDiagnosticCode::CartesiaSonicHttpRejected
            },
            BrainFailureClass::NetworkDisconnect,
            BrainFailureStage::Transport,
            true,
        ),
        _ => (
            if ink {
                ProviderDiagnosticCode::CartesiaInkHttpRejected
            } else {
                ProviderDiagnosticCode::CartesiaSonicHttpRejected
            },
            BrainFailureClass::MalformedStream,
            BrainFailureStage::Provider,
            true,
        ),
    };
    (
        ProviderDiagnostic::new(code, retry_eligible).with_http_status(status),
        failure_class,
        failure_stage,
    )
}

/// The numeric HTTP status of a refused WebSocket upgrade, if the failure was a
/// refusal rather than a transport fault. Nothing else is read off the error.
pub(crate) fn websocket_handshake_status(
    error: &tokio_tungstenite::tungstenite::Error,
) -> Option<u16> {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => Some(response.status().as_u16()),
        _ => None,
    }
}

/// The numeric close code of a provider close frame. The reason is discarded
/// before it can reach a caller.
pub(crate) fn websocket_close_code(frame: Option<&CloseFrame>) -> Option<u16> {
    frame.map(|frame| frame.code.into())
}

/// This session's authorized question for one response, from the D-02B cursor.
///
/// The selection is idempotent per response, so a turn always asks for its own
/// question rather than reusing a cached one the cursor may already have moved
/// past. An exhausted session carries no question and is never filled in with a
/// fixture one.
pub(crate) async fn select_session_question(
    executor: &VivaToolExecutor,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
) -> Result<StudyQuestion, BrainError> {
    let result = executor
        .execute(
            response_id,
            ToolProposal::select_next_question(study_set_id, voice_session_id, VIVA_STUDY_MODE),
        )
        .await
        .map_err(|_| outcome_contract_failure("select_next_question_failed"))?;
    let progression: QuestionProgressionResult =
        serde_json::from_value(result.result["progression"].clone())
            .map_err(|_| outcome_contract_failure("question_progression_malformed"))?;
    match progression {
        QuestionProgressionResult::Selected { question, .. }
        | QuestionProgressionResult::Retry { question, .. } => Ok(question),
        QuestionProgressionResult::Exhausted { .. } => {
            Err(outcome_contract_failure("question_progression_exhausted"))
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct CartesiaGeminiConfig {
    pub cartesia_api_key: String,
    pub gemini: GeminiConfig,
    pub ink: InkConfig,
    pub sonic: SonicConfig,
    pub tool_stage_timeout: Duration,
    pub recap_stage_timeout: Duration,
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
            .field("tool_stage_timeout", &self.tool_stage_timeout)
            .field("recap_stage_timeout", &self.recap_stage_timeout)
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
            tool_stage_timeout: Duration::from_secs(2),
            recap_stage_timeout: Duration::from_secs(2),
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
        if let Some(fallback_models) =
            env_value("GEMINI_FALLBACK_MODELS").or_else(|| env_value("GEMINI_FALLBACK_MODEL"))
        {
            config.gemini.fallback_model_ids =
                parse_gemini_fallback_models(&fallback_models, &config.gemini.model_id);
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
        // `ADAPTER-07`: an operator-supplied numeric is parsed into a finite
        // bounded value or refused outright; a malformed one keeps the
        // documented safe default instead of becoming free-form query syntax.
        if let Some(min_volume) = env_value("CARTESIA_INK_MIN_VOLUME")
            .as_deref()
            .and_then(|value| parse_ink_numeric(value, &INK_MIN_VOLUME_RANGE))
        {
            config.ink.min_volume = min_volume;
        }
        if let Some(max_silence_duration_secs) = env_value("CARTESIA_INK_MAX_SILENCE_DURATION_SECS")
            .as_deref()
            .and_then(|value| parse_ink_numeric(value, &INK_MAX_SILENCE_SECS_RANGE))
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

    pub fn total_live_stage_deadline(&self) -> Duration {
        [
            self.ink.stage_timeout,
            self.gemini
                .stage_timeout
                .saturating_mul(MAX_GEMINI_TOOL_LOOP_PASSES),
            self.tool_stage_timeout.saturating_mul(
                MAX_GEMINI_EXECUTED_TOOL_STAGES.saturating_add(DETERMINISTIC_STUDY_TOOL_STAGES),
            ),
            self.sonic.stage_timeout,
            self.recap_stage_timeout,
        ]
        .into_iter()
        .fold(Duration::ZERO, |total, duration| {
            total.saturating_add(duration)
        })
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
        // A credential problem is a provider-auth failure at the auth stage and
        // is never retried as a transport blip; a gate that was never opened is
        // an operator configuration fact, not a provider one.
        if self.config.missing_live_keys() {
            return Err(live_open_refusal(
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::ProviderAuth,
                "error_kind=missing_api_key",
            ));
        }
        if !self.config.selectable_live_keys() {
            return Err(live_open_refusal(
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::ProviderAuth,
                "error_kind=placeholder_credentials",
            ));
        }
        if !self.config.provider_zero_data_retention_confirmed() {
            return Err(live_open_refusal(
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::Startup,
                "error_kind=zero_data_retention_unconfirmed",
            ));
        }

        self.runner.open(_config).await
    }
}

fn live_open_refusal(
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    metadata: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible: false,
        latency_ms: 0,
        provider: "cartesia_gemini".to_owned(),
        model: "cartesia_gemini".to_owned(),
        metadata: metadata.to_owned(),
    })
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
    GeminiToolCallOnFinalPass,
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

    /// How many times this runtime asked the speech provider to speak.
    ///
    /// A turn that must stay silent — a deferral, a refused empty model output —
    /// is only proven silent by this counter: an absent `AudioDelta` is also
    /// consistent with a synthesis that ran and had its frames dropped.
    pub fn sonic_call_count(&self) -> u32 {
        self.runner.sonic_call_count()
    }

    /// How many times this runtime entered any provider stage at all.
    ///
    /// A failure the server owns — a refused durable write, an illegal phase —
    /// must be proven to happen *before* provider I/O, and an absent transcript
    /// or audio event cannot prove that on its own.
    pub fn provider_call_count(&self) -> u32 {
        self.runner.provider_call_count()
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
            .map_err(|_| outcome_contract_failure("unauthorized_session"))?;
        let store = self
            .runner
            .store()
            .ok_or_else(|| outcome_contract_failure("missing_study_store"))?;
        let evaluator = self.runner.evaluator();
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
                let executor =
                    VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
                let question = match select_session_question(
                    &executor,
                    &session.study_set_id,
                    &session.voice_session_id,
                    &response_id,
                )
                .await
                {
                    Ok(question) => question,
                    Err(error) => {
                        emit_provider_failure(&event_tx, error).await;
                        break;
                    }
                };
                if executor
                    .record_answer_attempt_envelope(answer_attempt_envelope(
                        &session,
                        &question,
                        &response_id,
                        1,
                        &runner_input,
                    ))
                    .await
                    .is_err()
                {
                    emit_provider_failure(
                        &event_tx,
                        outcome_contract_failure("answer_attempt_envelope_failed"),
                    )
                    .await;
                    break;
                }
                let final_transcript = match runner_input {
                    RunnerInput::Audio { .. } => FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT.to_owned(),
                    RunnerInput::Text { text, .. } => text,
                };
                let _ = event_tx.send(BrainEvent::InputSpeechStarted).await;
                // The fixture Ink transport reports no confidence, so the v5 fake
                // fixture carries an explicit `null` rather than a default.
                let _ = event_tx
                    .send(BrainEvent::TranscriptFinal {
                        response_id: response_id.clone(),
                        text: final_transcript.clone(),
                        confidence: None,
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

fn parse_gemini_fallback_models(value: &str, primary_model: &str) -> Vec<String> {
    let primary = primary_model.trim();
    let mut models = Vec::new();
    for model in value
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        if model == primary || models.iter().any(|existing| existing == model) {
            continue;
        }
        models.push(model.to_owned());
    }
    models
}

// ---------------------------------------------------------------------------
// Task 6 (`ADAPTER-06`): Cartesia Ink and Sonic diagnostics.
//
// A rejected WebSocket upgrade, a provider `error` message, and a close frame
// are all provider-authored. Only the numeric status or close code and one
// allowlisted diagnostic code may survive; the body, reason, and provider code
// are discarded whole.
// ---------------------------------------------------------------------------
fn fake_interrupt_gemini_stream(
    stream: GeminiEventStream,
    interrupt: FakeRuntimeInterrupt,
) -> GeminiEventStream {
    match interrupt {
        FakeRuntimeInterrupt::NoGeminiManuscriptIntent => Box::pin(stream.filter(|event| {
            let keep = !matches!(
                event,
                Ok(GeminiStreamEvent::FunctionCall { name, .. })
                    if name == "emit_manuscript_intent"
            );
            async move { keep }
        })),
        FakeRuntimeInterrupt::MalformedGeminiManuscriptIntent => Box::pin(stream.map(|event| {
            event.map(|event| match event {
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
        })),
        FakeRuntimeInterrupt::UnauthorizedGeminiManuscriptIntent => Box::pin(stream.map(|event| {
            event.map(|event| match event {
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
        })),
        // A tool call the model was not offered, appended once the pass turns
        // out to have proposed none of its own.
        FakeRuntimeInterrupt::GeminiToolCallOnFinalPass => Box::pin(futures_util::stream::unfold(
            (Some(stream), false, false),
            |(stream, saw_call, appended)| async move {
                let mut stream = stream?;
                if let Some(item) = stream.next().await {
                    let saw_call =
                        saw_call || matches!(&item, Ok(GeminiStreamEvent::FunctionCall { .. }));
                    return Some((item, (Some(stream), saw_call, appended)));
                }
                if saw_call || appended {
                    return None;
                }
                let args = json!({
                    "type": "entity_intent",
                    "entity_id": "nadh",
                    "entity_kind": "concept",
                    "register": "correcting",
                    "emphasis": "marked",
                });
                Some((
                    Ok(GeminiStreamEvent::FunctionCall {
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
                    }),
                    (Some(stream), saw_call, true),
                ))
            },
        )),
        _ => stream,
    }
}

/// The fixture transports, plus the one observation a test cannot make from the
/// event stream: whether the speech provider was *asked* to speak at all.
///
/// A turn that must not speak is not proven by the absence of `AudioDelta` —
/// synthesis could have run and its frames been dropped. The counter below makes
/// "zero Sonic calls" directly observable.
#[derive(Clone, Debug, Default)]
pub(crate) struct FakeCartesiaGeminiTransports {
    spoken_contexts: Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
    /// Every entry into a provider stage, so "no provider call" is observable
    /// rather than inferred from an absent event.
    provider_calls: Arc<std::sync::atomic::AtomicU32>,
}

impl FakeCartesiaGeminiTransports {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn sonic_call_count(&self) -> u32 {
        self.spoken_contexts
            .lock()
            .expect("spoken context lock poisoned")
            .len() as u32
    }

    pub(crate) fn provider_call_count(&self) -> u32 {
        self.provider_calls.load(Ordering::SeqCst)
    }

    fn record_provider_call(&self) {
        self.provider_calls.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl CartesiaGeminiTransports for FakeCartesiaGeminiTransports {
    async fn transcribe_audio(
        &self,
        _config: &CartesiaGeminiConfig,
        _response_id: &str,
        frame: &AudioFrame,
        _cancel: &CancellationToken,
    ) -> Result<RunnerTranscript, BrainError> {
        self.record_provider_call();
        let pcm_len = audio_frame_bytes(frame).len();
        let Some(InkEvent::TurnEnd { text, confidence }) = parse_ink_event(
            r#"{"type":"transcript","is_final":true,"text":"NADH donates electrons to the electron transport chain."}"#,
        ) else {
            return Err(fake_transport_failure("ink_transcript_unparsed"));
        };
        Ok(RunnerTranscript {
            interim_text: format!("received {pcm_len} PCM16 bytes"),
            // The fixture Ink event carries no confidence field, so the v5 fake
            // fixture reports an explicit absence rather than a default. The
            // value is read back out of the parsed event, not hardcoded.
            final_text: text,
            confidence,
        })
    }

    async fn stream_gemini(
        &self,
        _config: &CartesiaGeminiConfig,
        request: Value,
    ) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
        self.record_provider_call();
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
                    error: fake_transport_failure("final_request_advertised_tools"),
                });
            }
            // The fixture runtime speaks the persisted outcome's own feedback,
            // read back out of the tool response it was just handed. There is no
            // shared fallback sentence and no topic copy of its own.
            let mut events = Vec::new();
            if let Some(text) = fake_final_response_text(&request) {
                events.push(GeminiStreamEvent::ModelPart {
                    part: json!({ "text": text }),
                    text: Some(text),
                });
            }
            events.push(GeminiStreamEvent::Usage {
                input_tokens: 0,
                output_tokens: 2,
            });
            Ok(fixture_gemini_stream(events))
        } else {
            if request.get("tools").is_none() {
                return Err(GeminiStreamAttemptFailure {
                    events: Vec::new(),
                    error: fake_transport_failure("request_omitted_tools"),
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
            Ok(fixture_gemini_stream(vec![
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
            ]))
        }
    }

    async fn extend_speech(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        text: &str,
        interrupt: FakeRuntimeInterrupt,
        _cancel: &CancellationToken,
    ) -> Result<(), BrainError> {
        // Recorded on entry, before any outcome: an asked-for synthesis that
        // then failed is still a context the provider saw.
        self.record_provider_call();
        self.spoken_contexts
            .lock()
            .expect("spoken context lock poisoned")
            .insert(response_id.to_owned());
        let _request = sonic_generation_request(&config.sonic, response_id, text, true);
        if interrupt == FakeRuntimeInterrupt::WriterFailureBeforeSonicAudio {
            return Err(fake_transport_failure("writer_failed_before_audio"));
        }
        Ok(())
    }

    async fn finish_speech(
        &self,
        config: &CartesiaGeminiConfig,
        response_id: &str,
        _interrupt: FakeRuntimeInterrupt,
        _cancel: &CancellationToken,
        sink: &mut dyn SpeechFrameSink,
    ) -> Result<(), BrainError> {
        self.record_provider_call();
        let _finalizer = sonic_generation_request(&config.sonic, response_id, "", false);
        let sonic = json!({
            "type": "chunk",
            "context_id": response_id,
            "data": "AQIDBA==",
        });
        let Some(SonicEvent::Audio { pcm16_base64, .. }) = parse_sonic_event(&sonic.to_string())
        else {
            return Err(fake_transport_failure("sonic_audio_unparsed"));
        };
        let frame = AudioFrame::from_base64(pcm16_base64)
            .map_err(|_| fake_transport_failure("sonic_audio_invalid_base64"))?;
        sink.frame(frame).await;
        Ok(())
    }
}

/// A scripted provider response, delivered through the same incremental stream
/// shape the live transport produces.
fn fixture_gemini_stream(events: Vec<GeminiStreamEvent>) -> GeminiEventStream {
    Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
}

/// Fixture-runtime transport faults. The wording stays inside the fake
/// transports; a live failure never reaches this function.
fn fake_transport_failure(error_kind: &'static str) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::MalformedStream,
        stage: BrainFailureStage::Provider,
        retry_eligible: false,
        latency_ms: 0,
        provider: "fake_cartesia_gemini".to_owned(),
        model: "fake_cartesia_gemini".to_owned(),
        metadata: format!("stage=fake_transport error_kind={error_kind}"),
    })
}

/// Read the persisted outcome back out of the tool response the fixture runtime
/// is replaying, and speak that outcome's own copy.
fn fake_final_response_text(request: &Value) -> Option<String> {
    let outcome = request["contents"]
        .as_array()?
        .iter()
        .flat_map(|content| content["parts"].as_array().into_iter().flatten())
        .filter_map(|part| part.get("functionResponse"))
        .filter(|response| {
            response.get("name").and_then(Value::as_str) == Some("evaluate_spoken_answer")
        })
        .find_map(|response| {
            serde_json::from_value::<TurnOutcome>(
                response["response"]["result"]["turn_outcome"].clone(),
            )
            .ok()
        })?;
    fixture_response_text(&outcome)
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

#[cfg(test)]
mod cartesia_diagnostics_tests {
    use std::net::SocketAddr;
    use std::time::Duration;

    use agent_domain::{AudioFrame, BrainFailureClass, BrainFailureStage, BrainProviderFailure};
    use futures_util::SinkExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_util::sync::CancellationToken;

    use super::stt::{transcribe_ink_websocket, InkConfig};
    use super::tts::{SonicConfig, SonicSessionVoice, SpeechFrameSink};
    use super::*;

    const CARTESIA_BODY_MARKER: &str = "marker-cartesia-raw-body-c41";
    const CARTESIA_PROMPT_MARKER: &str = "marker-cartesia-prompt-c42";
    const CARTESIA_AUDIO_MARKER: &str = "marker-cartesia-audio-c43";
    const CARTESIA_TOKEN_MARKER: &str = "marker-cartesia-token-c44";
    const CARTESIA_URL_MARKER: &str = "marker-cartesia-url-c45";
    const CARTESIA_QUERY_MARKER: &str = "marker-cartesia-query-c46";
    const CARTESIA_TRANSCRIPT_MARKER: &str = "marker-cartesia-transcript-c47";
    const CARTESIA_PROVIDER_CODE_MARKER: &str = "marker-cartesia-provider-code-c48";

    fn cartesia_leak_markers() -> [&'static str; 8] {
        [
            CARTESIA_BODY_MARKER,
            CARTESIA_PROMPT_MARKER,
            CARTESIA_AUDIO_MARKER,
            CARTESIA_TOKEN_MARKER,
            CARTESIA_URL_MARKER,
            CARTESIA_QUERY_MARKER,
            CARTESIA_TRANSCRIPT_MARKER,
            CARTESIA_PROVIDER_CODE_MARKER,
        ]
    }

    fn assert_no_cartesia_marker(rendered: &str) {
        for marker in cartesia_leak_markers() {
            assert!(
                !rendered.contains(marker),
                "provider marker {marker} survived into: {rendered}"
            );
        }
    }

    fn rendered(failure: &BrainProviderFailure) -> String {
        format!(
            "{failure} {failure:?} {}",
            serde_json::to_string(failure).expect("a typed failure serializes")
        )
    }

    /// A 123-byte close reason — the protocol maximum — packed with markers.
    fn hostile_close_reason() -> String {
        let mut reason = format!(
            "{CARTESIA_TRANSCRIPT_MARKER} {CARTESIA_PROMPT_MARKER} {CARTESIA_AUDIO_MARKER} {CARTESIA_TOKEN_MARKER} {CARTESIA_URL_MARKER} {CARTESIA_QUERY_MARKER}"
        );
        reason.truncate(123);
        reason
    }

    fn hostile_upgrade_body() -> String {
        format!(
            "{CARTESIA_BODY_MARKER} {CARTESIA_PROMPT_MARKER} {CARTESIA_AUDIO_MARKER} {CARTESIA_TOKEN_MARKER} {CARTESIA_URL_MARKER} {CARTESIA_QUERY_MARKER} {CARTESIA_TRANSCRIPT_MARKER} "
        )
        .repeat(2_048)
    }

    /// A server that refuses every WebSocket upgrade with one HTTP status and a
    /// hostile oversized body.
    async fn spawn_upgrade_rejecting_server(status: u16) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local Cartesia upgrade-rejecting server");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let body = hostile_upgrade_body();
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut byte = [0_u8; 1];
                while stream.read_exact(&mut byte).await.is_ok() {
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status} Refused\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            }
        });
        addr
    }

    /// What a connected Cartesia socket does after the upgrade succeeds.
    #[derive(Clone, Copy)]
    enum ConnectedFault {
        /// Emit a provider `error` frame carrying an unknown provider code.
        ProviderError,
        /// Close with a standard code and a 123-byte hostile reason.
        CloseFrame,
    }

    /// A server that completes the WebSocket upgrade and then faults.
    async fn spawn_faulting_ws_server(fault: ConnectedFault, error_json: String) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local Cartesia faulting server");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let error_json = error_json.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    match fault {
                        ConnectedFault::ProviderError => {
                            let _ = socket.send(Message::Text(error_json.into())).await;
                        }
                        ConnectedFault::CloseFrame => {
                            let _ = socket
                                .send(Message::Close(Some(CloseFrame {
                                    code: CloseCode::Error,
                                    reason: hostile_close_reason().into(),
                                })))
                                .await;
                        }
                    }
                    let _ = socket.flush().await;
                    // Keep the connection alive long enough for the client to
                    // observe the frame it was sent.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                });
            }
        });
        addr
    }

    fn ink_config_for(addr: SocketAddr) -> InkConfig {
        InkConfig {
            websocket_url: format!("ws://{addr}/stt/turns/websocket"),
            stage_timeout: Duration::from_secs(3),
            ..InkConfig::default()
        }
    }

    fn sonic_config_for(addr: SocketAddr) -> SonicConfig {
        SonicConfig {
            websocket_url: format!("ws://{addr}/tts/websocket"),
            stage_timeout: Duration::from_secs(3),
            ..SonicConfig::default()
        }
    }

    #[derive(Default)]
    struct DiscardedFrames;

    #[async_trait]
    impl SpeechFrameSink for DiscardedFrames {
        async fn frame(&mut self, _frame: AudioFrame) -> bool {
            true
        }
    }

    async fn ink_failure_against(addr: SocketAddr) -> BrainError {
        transcribe_ink_websocket(
            &ink_config_for(addr),
            "sk_car_diagnostics_secret",
            &AudioFrame::from_pcm16_bytes(vec![7, 6, 5, 4]),
            &CancellationToken::new(),
        )
        .await
        .expect_err("the scripted Cartesia Ink fault is terminal")
    }

    async fn sonic_failure_against(addr: SocketAddr) -> BrainError {
        let config = sonic_config_for(addr);
        let voice = SonicSessionVoice::websocket();
        let cancel = CancellationToken::new();
        let mut sink = DiscardedFrames;
        let outcome = async {
            voice
                .extend(
                    &config,
                    "sk_car_diagnostics_secret",
                    "response-1",
                    "a scripted response",
                )
                .await?;
            voice
                .finish(&config, "response-1", &cancel, &mut sink)
                .await
        }
        .await;
        voice.close().await;
        outcome.expect_err("the scripted Cartesia Sonic fault is terminal")
    }

    /// The builder's whole output space, pinned.
    ///
    /// Every closed code is unique, belongs to exactly one stage, and every
    /// combination of code, numeric status, and retry eligibility serializes to
    /// canonical ASCII keys within Plan 06's 240-byte metadata bound.
    #[test]
    fn provider_diagnostic_metadata_is_closed_ascii_and_bounded() {
        let mut seen = std::collections::BTreeSet::new();
        for code in ProviderDiagnosticCode::ALL {
            assert!(
                seen.insert(code.as_str()),
                "{} is declared twice",
                code.as_str()
            );
            assert!(code.as_str().starts_with(code.stage().as_str()));
            for status in [
                None,
                Some(ProviderStatusCode::Http(u16::MAX)),
                Some(ProviderStatusCode::WebSocketClose(u16::MAX)),
            ] {
                for retry_eligible in [true, false] {
                    let metadata = provider_diagnostic_metadata(&ProviderDiagnostic {
                        stage: code.stage(),
                        code,
                        status,
                        retry_eligible,
                    });
                    assert!(
                        metadata.len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES,
                        "{metadata}"
                    );
                    assert!(
                        metadata
                            .chars()
                            .all(|character| character.is_ascii_alphanumeric()
                                || matches!(character, ' ' | '_' | '=')),
                        "{metadata}"
                    );
                    assert!(metadata.contains(&format!("stage={}", code.stage().as_str())));
                    assert!(metadata.contains(&format!("error_kind={}", code.as_str())));
                    assert!(metadata.contains(&format!("retry_eligible={retry_eligible}")));
                }
            }
        }
        assert_eq!(seen.len(), ProviderDiagnosticCode::ALL.len());
    }

    #[tokio::test]
    async fn cartesia_auth_header_failures_are_nonretryable_and_stage_specific() {
        // A credential `HeaderValue` rejects is refused before any connection is
        // attempted: the endpoints below point at a port nothing listens on, so
        // a connect attempt would classify as a network disconnect instead.
        let unusable_key = format!("{CARTESIA_TOKEN_MARKER}\u{7f}\u{1}");
        let ink = InkConfig {
            websocket_url: "ws://127.0.0.1:1/stt/turns/websocket".to_owned(),
            stage_timeout: Duration::from_millis(250),
            ..InkConfig::default()
        };
        let error = ink
            .websocket_request(&unusable_key)
            .expect_err("an unusable Cartesia credential cannot be sent");
        let failure = error.failure();
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::ProviderAuthFailure
        );
        assert_eq!(failure.stage(), BrainFailureStage::ProviderAuth);
        assert!(!failure.retry_eligible(), "{failure:?}");
        assert_eq!(failure.provider(), "cartesia");
        assert!(
            failure.metadata().contains("stage=cartesia_ink"),
            "the Ink stage must be distinguishable: {failure:?}"
        );
        assert_no_cartesia_marker(&rendered(failure));

        // The whole Ink turn refuses at the same classification, so nothing
        // downgrades it into a retryable connect failure.
        let error = transcribe_ink_websocket(
            &ink,
            &unusable_key,
            &AudioFrame::from_pcm16_bytes(vec![1, 2]),
            &CancellationToken::new(),
        )
        .await
        .expect_err("an unusable Cartesia credential cannot open a turn");
        let failure = error.failure();
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::ProviderAuthFailure
        );
        assert_ne!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert!(!failure.retry_eligible(), "{failure:?}");
        assert_no_cartesia_marker(&rendered(failure));

        let sonic = SonicConfig {
            websocket_url: "ws://127.0.0.1:1/tts/websocket".to_owned(),
            stage_timeout: Duration::from_millis(250),
            ..SonicConfig::default()
        };
        let error = sonic
            .websocket_request(&unusable_key)
            .expect_err("an unusable Cartesia credential cannot be sent");
        let failure = error.failure();
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::ProviderAuthFailure
        );
        assert_eq!(failure.stage(), BrainFailureStage::ProviderAuth);
        assert!(!failure.retry_eligible(), "{failure:?}");
        assert_eq!(failure.provider(), "cartesia");
        assert!(
            failure.metadata().contains("stage=cartesia_sonic"),
            "the Sonic stage must be distinguishable: {failure:?}"
        );
        assert_no_cartesia_marker(&rendered(failure));
    }

    #[tokio::test]
    async fn cartesia_ink_and_sonic_handshake_http_diagnostics_are_bounded_and_redacted() {
        for (status, expected_class, retry_eligible, ink_code, sonic_code) in [
            (
                401_u16,
                BrainFailureClass::ProviderAuthFailure,
                false,
                "cartesia_ink_http_auth",
                "cartesia_sonic_http_auth",
            ),
            (
                403,
                BrainFailureClass::ProviderAuthFailure,
                false,
                "cartesia_ink_http_auth",
                "cartesia_sonic_http_auth",
            ),
            (
                429,
                BrainFailureClass::QuotaRateFailure,
                true,
                "cartesia_ink_http_rate_limited",
                "cartesia_sonic_http_rate_limited",
            ),
            (
                500,
                BrainFailureClass::NetworkDisconnect,
                true,
                "cartesia_ink_http_rejected",
                "cartesia_sonic_http_rejected",
            ),
        ] {
            let addr = spawn_upgrade_rejecting_server(status).await;
            for (error, stage_label, expected_code) in [
                (ink_failure_against(addr).await, "cartesia_ink", ink_code),
                (
                    sonic_failure_against(addr).await,
                    "cartesia_sonic",
                    sonic_code,
                ),
            ] {
                let failure = error.failure();
                assert_eq!(
                    failure.failure_class(),
                    expected_class,
                    "{stage_label} status {status}: {failure:?}"
                );
                assert_eq!(failure.provider(), "cartesia");
                assert_eq!(
                    failure.retry_eligible(),
                    retry_eligible,
                    "{stage_label} status {status}: {failure:?}"
                );
                assert!(
                    failure.metadata().contains(&format!("stage={stage_label}")),
                    "{stage_label} status {status}: {failure:?}"
                );
                assert!(
                    failure
                        .metadata()
                        .contains(&format!("http_status={status}")),
                    "{stage_label} status {status} must survive as its integer: {failure:?}"
                );
                assert!(
                    failure
                        .metadata()
                        .contains(&format!("error_kind={expected_code}")),
                    "{stage_label} status {status} must carry {expected_code}: {failure:?}"
                );
                assert!(
                    failure.metadata().len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES,
                    "{stage_label} status {status}: {failure:?}"
                );
                assert_no_cartesia_marker(&rendered(failure));
            }
        }
    }

    #[tokio::test]
    async fn cartesia_ink_and_sonic_websocket_diagnostics_are_bounded_and_redacted() {
        // A standard close code with a 123-byte hostile reason.
        let addr = spawn_faulting_ws_server(ConnectedFault::CloseFrame, String::new()).await;
        for (error, stage_label, expected_code) in [
            (
                ink_failure_against(addr).await,
                "cartesia_ink",
                "cartesia_ink_ws_closed",
            ),
            (
                sonic_failure_against(addr).await,
                "cartesia_sonic",
                "cartesia_sonic_ws_closed",
            ),
        ] {
            let failure = error.failure();
            assert_eq!(failure.provider(), "cartesia");
            assert!(
                failure.metadata().contains(&format!("stage={stage_label}")),
                "{stage_label}: {failure:?}"
            );
            assert!(
                failure.metadata().contains("ws_close_code=1011"),
                "{stage_label} must keep only the numeric close code: {failure:?}"
            );
            assert!(
                failure
                    .metadata()
                    .contains(&format!("error_kind={expected_code}")),
                "{stage_label} must carry {expected_code}: {failure:?}"
            );
            assert!(
                failure.metadata().len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES,
                "{stage_label}: {failure:?}"
            );
            assert_no_cartesia_marker(&rendered(failure));
        }

        // An unknown provider error code collapses to the stage's provider-error
        // code; neither the message nor the raw code survives.
        let ink_error_json = format!(
            r#"{{"type":"error","code":"{CARTESIA_PROVIDER_CODE_MARKER}","message":"{CARTESIA_BODY_MARKER} {CARTESIA_TRANSCRIPT_MARKER} {CARTESIA_PROMPT_MARKER} {CARTESIA_AUDIO_MARKER} {CARTESIA_TOKEN_MARKER} {CARTESIA_URL_MARKER} {CARTESIA_QUERY_MARKER}"}}"#
        );
        let addr = spawn_faulting_ws_server(ConnectedFault::ProviderError, ink_error_json).await;
        let error = ink_failure_against(addr).await;
        let failure = error.failure();
        assert!(
            failure.metadata().contains("stage=cartesia_ink"),
            "{failure:?}"
        );
        assert!(
            failure
                .metadata()
                .contains("error_kind=cartesia_ink_provider_error"),
            "an unknown Ink provider code must collapse to the stage code: {failure:?}"
        );
        assert!(
            failure.metadata().len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES,
            "{failure:?}"
        );
        assert_no_cartesia_marker(&rendered(failure));

        let sonic_error_json = format!(
            r#"{{"type":"error","context_id":"response-1","code":"{CARTESIA_PROVIDER_CODE_MARKER}","message":"{CARTESIA_BODY_MARKER} {CARTESIA_TRANSCRIPT_MARKER} {CARTESIA_PROMPT_MARKER} {CARTESIA_AUDIO_MARKER} {CARTESIA_TOKEN_MARKER} {CARTESIA_URL_MARKER} {CARTESIA_QUERY_MARKER}"}}"#
        );
        let addr = spawn_faulting_ws_server(ConnectedFault::ProviderError, sonic_error_json).await;
        let error = sonic_failure_against(addr).await;
        let failure = error.failure();
        assert!(
            failure.metadata().contains("stage=cartesia_sonic"),
            "{failure:?}"
        );
        assert!(
            failure
                .metadata()
                .contains("error_kind=cartesia_sonic_provider_error"),
            "an unknown Sonic provider code must collapse to the stage code: {failure:?}"
        );
        assert!(
            failure.metadata().len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES,
            "{failure:?}"
        );
        assert_no_cartesia_marker(&rendered(failure));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_domain::viva_max_submitted_answer_resolution;

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
        assert!((config.ink.min_volume - 0.2).abs() < f32::EPSILON);
        assert!((config.ink.max_silence_duration_secs - 1.1).abs() < f32::EPSILON);
        assert_eq!(config.ink.cartesia_version, "2026-03-01");
    }

    // -----------------------------------------------------------------
    // Task 7 (`ADAPTER-07`): the two operator-supplied Ink numerics are parsed
    // into finite bounded values, and a malformed one keeps the documented safe
    // default rather than becoming free-form query syntax.
    // -----------------------------------------------------------------

    #[test]
    fn ink_numeric_environment_values_fail_closed_when_malformed() {
        let with_numerics = |min_volume: &str, max_silence: &str| {
            let min_volume = min_volume.to_owned();
            let max_silence = max_silence.to_owned();
            CartesiaGeminiConfig::from_env_with(move |name| match name {
                "CARTESIA_INK_MIN_VOLUME" => Some(min_volume.clone()),
                "CARTESIA_INK_MAX_SILENCE_DURATION_SECS" => Some(max_silence.clone()),
                _ => None,
            })
            .ink
        };

        let defaults = InkConfig::default();
        for hostile in [
            "NaN", "nan", "inf", "-inf", "-0.1", "0.7&x=1", "", " ", "abc", "0x1",
        ] {
            let ink = with_numerics(hostile, hostile);
            assert_eq!(
                ink.min_volume, defaults.min_volume,
                "min_volume must fail closed for {hostile:?}"
            );
            assert_eq!(
                ink.max_silence_duration_secs, defaults.max_silence_duration_secs,
                "max_silence_duration_secs must fail closed for {hostile:?}"
            );
            let endpoint = ink.websocket_endpoint();
            assert!(
                hostile.trim().is_empty() || !endpoint.contains(hostile.trim()),
                "{endpoint}"
            );
            assert!(!endpoint.contains("x=1"), "{endpoint}");
        }

        // A volume threshold is a fraction, so anything above 1 is refused even
        // though it is a perfectly good number of seconds for the other field.
        assert_eq!(
            with_numerics("1.1", "0.7").min_volume,
            defaults.min_volume,
            "min_volume must fail closed for a value above 1"
        );

        // Accepted boundary values are preserved exactly.
        let ink = with_numerics("0", "0.25");
        assert!((ink.min_volume - 0.0).abs() < f32::EPSILON);
        assert!((ink.max_silence_duration_secs - 0.25).abs() < f32::EPSILON);
        let ink = with_numerics("1", "60");
        assert!((ink.min_volume - 1.0).abs() < f32::EPSILON);
        assert!((ink.max_silence_duration_secs - 60.0).abs() < f32::EPSILON);
        let ink = with_numerics(" 0.2 ", " 1.1 ");
        assert!((ink.min_volume - 0.2).abs() < f32::EPSILON);
        assert!((ink.max_silence_duration_secs - 1.1).abs() < f32::EPSILON);

        // A silence window of zero is not a window; an out-of-range one is not a
        // configuration this adapter will send.
        for rejected in ["0", "-1", "60.1", "1e9"] {
            assert_eq!(
                with_numerics("0.05", rejected).max_silence_duration_secs,
                defaults.max_silence_duration_secs,
                "max_silence_duration_secs must fail closed for {rejected:?}"
            );
        }
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
    fn defaults_allow_declared_live_tool_sequence_under_outer_turn_cap() {
        let config = CartesiaGeminiConfig::default();

        assert_eq!(MAX_GEMINI_EXECUTED_TOOL_STAGES, 5);
        assert_eq!(config.tool_stage_timeout, Duration::from_secs(2));
        assert_eq!(config.recap_stage_timeout, Duration::from_secs(2));
        assert!(
            config
                .total_live_stage_deadline()
                .saturating_add(Duration::from_secs(1))
                <= viva_max_submitted_answer_resolution()
        );
    }

    #[test]
    fn from_env_applies_deduped_gemini_fallback_models() {
        let config = CartesiaGeminiConfig::from_env_with(|name| match name {
            "GEMINI_MODEL" => Some(" gemini-3.5-pro ".to_owned()),
            "GEMINI_FALLBACK_MODELS" => {
                Some(" gemini-3.5-flash , gemini-3.0-flash ,, gemini-3.5-flash ".to_owned())
            }
            _ => None,
        });

        assert_eq!(
            config.gemini.fallback_model_ids,
            vec!["gemini-3.5-flash", "gemini-3.0-flash"]
        );
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
}
