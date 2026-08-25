use async_trait::async_trait;
use futures_util::{stream::BoxStream, StreamExt};
use serde::{de, Deserialize, Deserializer, Serialize};
use std::fmt;
use tokio::{sync::mpsc, task::AbortHandle};

use crate::{
    ids::SessionId,
    learning_outcome::EvaluationDeferralReason,
    learning_recap::StudySessionRecap,
    tools::{ToolPlan, ToolProposal, ToolResult},
    AnswerEvaluation, AudioFrame, StudyQuestion, StudySessionPhase, StudySourceReference,
    TerminalSessionReason,
};

pub type BrainEventStream = BoxStream<'static, BrainEvent>;

/// The single engine this product runs (recorded decision `D-03B`).
///
/// There is one oral-exam engine, so there is one mode. `Teach`, `Mock`, and
/// `Cram` were vocabulary for engines that were never built: a client could name
/// them, but nothing behind this type could execute them. Keeping the variants
/// would let a forged or stale wire value parse into a mode the server cannot
/// honour, so the vocabulary is exactly what the engine can do. `quiz` is the
/// internal identifier reported on the wire; the learner-facing label lives in
/// the web app.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudyMode {
    #[default]
    Quiz,
}

impl StudyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Quiz => "quiz",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConceptStatus {
    Strong,
    Shaky,
    Missed,
    #[default]
    Review,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceConfidence {
    High,
    #[default]
    Medium,
    Low,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceContext {
    pub source_id: String,
    pub document_id: String,
    pub span: String,
    pub excerpt: String,
    pub confidence: SourceConfidence,
    pub retrieval_reason: String,
}

/// Admission input for one study session.
///
/// The client-declared session goal is gone (recorded decision `D-03B`): it was
/// free text no policy read, so it could only ever be an unvalidated string
/// carried into storage and logs. Session scope comes from the bound
/// `study_set_id` and `active_concepts` instead.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionConfig {
    pub session_id: Option<SessionId>,
    pub user_id: Option<String>,
    pub study_set_id: Option<String>,
    pub mode: Option<StudyMode>,
    pub source_context: Vec<SourceContext>,
    pub active_concepts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_generation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManuscriptRegister {
    Examining,
    Reflecting,
    Correcting,
    Sourcing,
    Recapping,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManuscriptEmphasis {
    Quiet,
    Measured,
    Marked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManuscriptEntityKind {
    Concept,
    Source,
    MarginalNote,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ManuscriptIntent {
    #[serde(rename = "scene_intent")]
    Scene {
        register: ManuscriptRegister,
        emphasis: ManuscriptEmphasis,
    },
    #[serde(rename = "entity_intent")]
    Entity {
        entity_id: String,
        entity_kind: ManuscriptEntityKind,
        register: ManuscriptRegister,
        emphasis: ManuscriptEmphasis,
    },
    #[serde(rename = "marginalia_intent")]
    Marginalia {
        marginalia_id: String,
        anchor_entity_id: String,
        register: ManuscriptRegister,
        emphasis: ManuscriptEmphasis,
    },
}

#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum BrainInput {
    Audio(AudioFrame),
    AudioWithMetadata {
        frame: AudioFrame,
        client_generation_id: Option<String>,
    },
    Text(String),
    TextWithMetadata {
        text: String,
        client_generation_id: Option<String>,
    },
    ToolResult(ToolResult),
    SessionContextRefresh(serde_json::Value),
    ProactiveTurn {
        prompt: String,
    },
    CancelResponse,
    Stop,
}

pub struct RealtimeSession {
    pub input: mpsc::Sender<BrainInput>,
    pub events: mpsc::Receiver<BrainEvent>,
    pub task_guard: Option<RealtimeSessionTaskGuard>,
}

pub struct RealtimeSessionTaskGuard {
    handles: Vec<AbortHandle>,
}

impl RealtimeSessionTaskGuard {
    pub fn new(handles: Vec<AbortHandle>) -> Self {
        Self { handles }
    }
}

impl Drop for RealtimeSessionTaskGuard {
    fn drop(&mut self) {
        for handle in &self.handles {
            handle.abort();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum BrainEvent {
    SessionPhase {
        phase: StudySessionPhase,
    },
    TerminalSessionPhase {
        phase: StudySessionPhase,
        terminal_reason: TerminalSessionReason,
    },
    QuestionStarted {
        response_id: String,
        question: StudyQuestion,
    },
    TranscriptDelta {
        response_id: String,
        text: String,
    },
    AnswerEvaluated {
        response_id: String,
        evaluation: AnswerEvaluation,
    },
    /// A turn whose evaluation was deferred. This is a typed non-mastery fact: it
    /// carries no provider prose, feedback, confidence, concept status, schedule, or
    /// mastery. Plans 04/07 derive `AnswerEvaluated`/`ConceptStatus` only from a
    /// persisted `TurnOutcome`; there is deliberately no second evaluated event.
    TurnDeferred {
        response_id: String,
        question_id: String,
        reason: EvaluationDeferralReason,
        can_retry_same_question: bool,
    },
    SourceReference {
        response_id: String,
        source: StudySourceReference,
    },
    ConceptStatus {
        response_id: String,
        concept_id: String,
        status: ConceptStatus,
    },
    ManuscriptIntent {
        response_id: String,
        intent: ManuscriptIntent,
    },
    RecapReady {
        response_id: String,
        recap: StudySessionRecap,
    },
    AudioDelta {
        response_id: String,
        frame: AudioFrame,
    },
    ResponseStarted {
        response_id: String,
    },
    ResponseCompleted {
        response_id: String,
    },
    ResponseAudio {
        response_id: String,
        frame: AudioFrame,
    },
    Transcript(String),
    ResponseToolProposal {
        response_id: String,
        proposal: ToolProposal,
    },
    Usage(BrainUsage),
    ProviderFallbackActivated {
        response_id: String,
        provider: String,
        from_model: String,
        to_model: String,
        reason: String,
        failure: Option<BrainProviderFailure>,
    },
    Error(BrainProviderError),
    SpeechIntent(SpeechIntent),
    InputSpeechStarted,
    InputSpeechStopped,
    ResponseCancelled,
    ResponseCancelledFor {
        response_id: String,
    },
    ResponseTranscriptDelta {
        response_id: String,
        text: String,
    },
    ResponseTextStarted {
        response_id: String,
    },
    TranscriptFinal {
        response_id: String,
        text: String,
        confidence: Option<f32>,
    },
}

impl BrainEvent {
    pub fn response_id(&self) -> Option<&str> {
        match self {
            Self::QuestionStarted { response_id, .. }
            | Self::TranscriptDelta { response_id, .. }
            | Self::AnswerEvaluated { response_id, .. }
            | Self::TurnDeferred { response_id, .. }
            | Self::SourceReference { response_id, .. }
            | Self::ConceptStatus { response_id, .. }
            | Self::ManuscriptIntent { response_id, .. }
            | Self::RecapReady { response_id, .. }
            | Self::AudioDelta { response_id, .. }
            | Self::ResponseStarted { response_id }
            | Self::ResponseCompleted { response_id }
            | Self::ResponseAudio { response_id, .. }
            | Self::ResponseToolProposal { response_id, .. }
            | Self::ResponseTranscriptDelta { response_id, .. }
            | Self::ResponseTextStarted { response_id }
            | Self::ResponseCancelledFor { response_id }
            | Self::TranscriptFinal { response_id, .. }
            | Self::ProviderFallbackActivated { response_id, .. } => Some(response_id),
            Self::Transcript(_)
            | Self::SessionPhase { .. }
            | Self::TerminalSessionPhase { .. }
            | Self::Usage(_)
            | Self::Error(_)
            | Self::SpeechIntent(_)
            | Self::InputSpeechStarted
            | Self::InputSpeechStopped
            | Self::ResponseCancelled => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BrainProviderError {
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<BrainProviderFailure>,
}

impl BrainProviderError {
    /// The only constructor. There is deliberately no unclassified `new`: a
    /// provider error that reaches a terminal path must carry the typed failure
    /// that classified it, and `source`/`message` stay diagnostics.
    pub fn from_failure(failure: BrainProviderFailure) -> Self {
        Self {
            source: failure.provider().to_owned(),
            message: failure.to_string(),
            failure: Some(failure),
        }
    }

    pub fn failure(&self) -> Option<&BrainProviderFailure> {
        self.failure.as_ref()
    }

    /// A missing typed failure is an invariant breach, not an invitation to
    /// classify from `source`/`message`. Plan 08 converts this typed error into
    /// an explicit `BrainFailureClass::Rollback` failure at stage `Websocket`.
    pub fn require_failure(
        &self,
    ) -> Result<&BrainProviderFailure, BrainProviderErrorClassificationError> {
        self.failure()
            .ok_or(BrainProviderErrorClassificationError::MissingTypedFailure)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum BrainProviderErrorClassificationError {
    #[error("provider error is missing a typed failure")]
    MissingTypedFailure,
}

/// The single failure-vocabulary declaration, mirroring the
/// `define_terminal_session_reasons!` pattern Plan 04 owns in `study.rs`: one
/// variant list generates the enum, its serde token, [`ALL`](BrainFailureClass::ALL),
/// `as_str`, and `Display`, so no adapter, service, or store can keep a second
/// string table that drifts from this one.
macro_rules! define_failure_vocabulary {
    (
        $(#[$enum_meta:meta])*
        $name:ident { $( $variant:ident => $wire:literal ),+ $(,)? }
    ) => {
        $(#[$enum_meta])*
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl $name {
            /// Every declared variant, in declaration order.
            pub const ALL: [Self; define_failure_vocabulary!(@count $($variant),+)] =
                [$(Self::$variant),+];

            /// The canonical wire token. The serde name is generated from this
            /// same literal, so the two can never disagree.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
    (@count $($variant:ident),+) => {
        <[()]>::len(&[$(define_failure_vocabulary!(@one $variant)),+])
    };
    (@one $variant:ident) => { () };
}

define_failure_vocabulary! {
    /// Why a session or turn failed. This is classification data, never prose:
    /// exactly one class selects exactly one [`TerminalSessionReason`], so no
    /// consumer may parse a provider message to pick a terminal reason, retry
    /// policy, durability path, HTTP status, or alert class.
    ///
    /// Protocol-only observability labels (`pending_evaluation`,
    /// `pre_loop_unavailable`, `session_bootstrap_unavailable`,
    /// `session_auth_failure`) are deliberately absent: they are non-terminal or
    /// pre-session protocol signals that Plan 08 keeps outside typed
    /// [`BrainError`] classification.
    BrainFailureClass {
        DeployDrain => "deploy_drain",
        SessionCap => "session_cap",
        TurnCap => "turn_cap",
        LocalRateLimit => "local_rate_limit",
        CostBudget => "cost_budget",
        ProviderAuthFailure => "provider_auth_failure",
        QuotaRateFailure => "quota_rate_failure",
        Timeout => "timeout",
        MalformedStream => "malformed_stream",
        NetworkDisconnect => "network_disconnect",
        SlowClient => "slow_client",
        Cancellation => "cancellation",
        PartialStageSuccess => "partial_stage_success",
        DurabilityDegraded => "durability_degraded",
        ToolExecutorFailure => "tool_executor_failure",
        Rollback => "rollback",
    }
}

const _: () = assert!(BrainFailureClass::ALL.len() == 16);

define_failure_vocabulary! {
    /// Where the failure was observed. The stage is diagnostic context; it never
    /// selects a terminal reason on its own.
    BrainFailureStage {
        Session => "session",
        Store => "store",
        Tools => "tools",
        Recap => "recap",
        Gemini => "gemini",
        Provider => "provider",
        ProviderAuth => "provider_auth",
        Websocket => "websocket",
        Transport => "transport",
        PreLoop => "pre_loop",
        Startup => "startup",
        SessionAuth => "session_auth",
        Deployment => "deployment",
        Rollback => "rollback",
    }
}

const _: () = assert!(BrainFailureStage::ALL.len() == 14);

impl BrainFailureClass {
    /// The one class-to-terminal mapping, exhaustive over all 16
    /// [`TerminalSessionReason`] variants.
    pub const fn terminal_reason(self) -> TerminalSessionReason {
        match self {
            Self::DeployDrain => TerminalSessionReason::Drained,
            Self::SessionCap => TerminalSessionReason::SessionCap,
            Self::TurnCap => TerminalSessionReason::TurnCap,
            Self::LocalRateLimit => TerminalSessionReason::RateLimit,
            Self::CostBudget => TerminalSessionReason::CostBudget,
            Self::ProviderAuthFailure => TerminalSessionReason::ProviderAuthFailed,
            Self::QuotaRateFailure => TerminalSessionReason::ProviderRateLimited,
            Self::Timeout => TerminalSessionReason::ProviderTimeout,
            Self::MalformedStream => TerminalSessionReason::ProviderMalformedStream,
            Self::NetworkDisconnect => TerminalSessionReason::ProviderNetworkDisconnect,
            Self::SlowClient => TerminalSessionReason::SlowClient,
            Self::Cancellation => TerminalSessionReason::ProviderCancelled,
            Self::PartialStageSuccess => TerminalSessionReason::PartialStageSuccess,
            Self::DurabilityDegraded => TerminalSessionReason::DurabilityDegraded,
            Self::ToolExecutorFailure => TerminalSessionReason::ToolExecutorFailure,
            Self::Rollback => TerminalSessionReason::Rollback,
        }
    }
}

/// The construction input for [`BrainProviderFailure`]. It carries no
/// `terminal_reason`: the class is the single authority for that. `retry_eligible`
/// stays explicit because retryability can differ by status or attempt within one
/// class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrainProviderFailureParts {
    pub failure_class: BrainFailureClass,
    pub stage: BrainFailureStage,
    pub retry_eligible: bool,
    pub latency_ms: u64,
    pub provider: String,
    pub model: String,
    pub metadata: String,
}

/// A classified runtime failure. Every field is private and every path in —
/// construction and deserialization alike — runs through [`BrainProviderFailure::new`],
/// so a raw provider string, a smuggled secret, or a hand-picked terminal reason
/// cannot enter the domain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BrainProviderFailure {
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    terminal_reason: TerminalSessionReason,
    retry_eligible: bool,
    latency_ms: u64,
    provider: String,
    model: String,
    metadata: String,
}

impl BrainProviderFailure {
    pub fn new(parts: BrainProviderFailureParts) -> Self {
        Self {
            failure_class: parts.failure_class,
            stage: parts.stage,
            terminal_reason: parts.failure_class.terminal_reason(),
            retry_eligible: parts.retry_eligible,
            latency_ms: parts.latency_ms,
            provider: sanitize_stage_token(parts.provider),
            model: sanitize_stage_token(parts.model),
            metadata: sanitize_stage_metadata(parts.metadata),
        }
    }

    pub fn failure_class(&self) -> BrainFailureClass {
        self.failure_class
    }

    pub fn stage(&self) -> BrainFailureStage {
        self.stage
    }

    pub fn terminal_reason(&self) -> TerminalSessionReason {
        self.terminal_reason
    }

    pub fn retry_eligible(&self) -> bool {
        self.retry_eligible
    }

    pub fn latency_ms(&self) -> u64 {
        self.latency_ms
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn metadata(&self) -> &str {
        &self.metadata
    }
}

/// The wire shape of a failure. It exists so that deserialization can validate
/// the incoming `terminal_reason` against the class before handing the remaining
/// values to the sanitizing constructor; a derived `Deserialize` would bypass
/// both checks.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrainProviderFailureWire {
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    terminal_reason: TerminalSessionReason,
    retry_eligible: bool,
    latency_ms: u64,
    provider: String,
    model: String,
    metadata: String,
}

impl<'de> Deserialize<'de> for BrainProviderFailure {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrainProviderFailureWire::deserialize(deserializer)?;
        let implied = wire.failure_class.terminal_reason();
        if wire.terminal_reason != implied {
            return Err(de::Error::custom(format!(
                "failure_class {} implies terminal reason {}, not {}",
                wire.failure_class.as_str(),
                implied.as_str(),
                wire.terminal_reason.as_str(),
            )));
        }

        Ok(Self::new(BrainProviderFailureParts {
            failure_class: wire.failure_class,
            stage: wire.stage,
            retry_eligible: wire.retry_eligible,
            latency_ms: wire.latency_ms,
            provider: wire.provider,
            model: wire.model,
            metadata: wire.metadata,
        }))
    }
}

impl fmt::Display for BrainProviderFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} stage failure: {}",
            self.stage, self.failure_class
        )
    }
}

fn sanitize_stage_token(value: String) -> String {
    let sanitized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(96)
        .collect::<String>();
    if sanitized.is_empty() {
        "unknown".to_owned()
    } else {
        sanitized
    }
}

fn sanitize_stage_metadata(value: String) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    ' ' | '-' | '_' | ':' | '.' | '/' | '=' | ',' | ';' | '(' | ')'
                )
        })
        .take(240)
        .collect()
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct BrainUsage {
    pub audio_input_tokens: u64,
    pub cached_audio_input_tokens: u64,
    pub audio_output_tokens: u64,
    pub text_input_tokens: u64,
    pub cached_text_input_tokens: u64,
    pub text_output_tokens: u64,
    pub source_grounded_correction_count: u64,
}

impl BrainUsage {
    pub fn add(&mut self, usage: &BrainUsage) {
        self.audio_input_tokens = self
            .audio_input_tokens
            .saturating_add(usage.audio_input_tokens);
        self.cached_audio_input_tokens = self
            .cached_audio_input_tokens
            .saturating_add(usage.cached_audio_input_tokens);
        self.audio_output_tokens = self
            .audio_output_tokens
            .saturating_add(usage.audio_output_tokens);
        self.text_input_tokens = self
            .text_input_tokens
            .saturating_add(usage.text_input_tokens);
        self.cached_text_input_tokens = self
            .cached_text_input_tokens
            .saturating_add(usage.cached_text_input_tokens);
        self.text_output_tokens = self
            .text_output_tokens
            .saturating_add(usage.text_output_tokens);
        self.source_grounded_correction_count = self
            .source_grounded_correction_count
            .saturating_add(usage.source_grounded_correction_count);
    }
}

/// Every brain failure is a classified failure. The former stringly variants
/// (`MissingApiKey`, `Connection`, `Protocol`, `StageFailure`) are gone: a
/// missing API key is a `ProviderAuthFailure` at stage `ProviderAuth`, a dropped
/// connection is a `NetworkDisconnect` at stage `Transport`, and a protocol
/// defect is a `MalformedStream` — each with the terminal reason its class
/// implies, chosen at the boundary that observed the status rather than parsed
/// out of a message downstream.
#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("{0}")]
    Failure(Box<BrainProviderFailure>),
}

impl BrainError {
    pub fn from_failure(failure: BrainProviderFailure) -> Self {
        Self::Failure(Box::new(failure))
    }

    pub fn failure(&self) -> &BrainProviderFailure {
        match self {
            Self::Failure(failure) => failure,
        }
    }

    pub fn terminal_reason(&self) -> TerminalSessionReason {
        self.failure().terminal_reason()
    }
}

#[async_trait]
pub trait RealtimeBrain: Send + Sync {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "unknown".to_owned(),
            configured: false,
            selectable: false,
            live_runtime: false,
        }
    }

    async fn connect(&self, _config: SessionConfig) -> Result<BrainEventStream, BrainError> {
        Ok(Box::pin(futures_util::stream::empty()))
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let mut stream = self.connect(config).await?;
        let (input, mut input_rx) = mpsc::channel(32);
        let (event_tx, events) = mpsc::channel(32);
        let input_task = tokio::spawn(async move { while input_rx.recv().await.is_some() {} });
        let event_task = tokio::spawn(async move {
            while let Some(event) = stream.next().await {
                if event_tx.send(event).await.is_err() {
                    break;
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![
                input_task.abort_handle(),
                event_task.abort_handle(),
            ])),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RealtimeBrainCapabilities {
    pub provider: String,
    pub configured: bool,
    pub selectable: bool,
    pub live_runtime: bool,
}

#[async_trait]
pub trait Planner: Send + Sync {
    async fn plan(&self, goal: &str) -> Result<ToolPlan, BrainError>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SpeechIntent {
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_failure() -> BrainProviderFailure {
        BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::Timeout,
            stage: BrainFailureStage::Gemini,
            retry_eligible: true,
            latency_ms: 42,
            provider: "gemini".to_owned(),
            model: "gemini-realtime".to_owned(),
            metadata: "http_status=504".to_owned(),
        })
    }

    /// The serialized field names and their order are the published wire
    /// contract for Plans 05/07/08; a rename here is a protocol break.
    #[test]
    fn failure_serializes_with_the_published_field_names_in_order() {
        assert_eq!(
            serde_json::to_string(&fixture_failure()).expect("failure serializes"),
            concat!(
                r#"{"failure_class":"timeout","stage":"gemini","#,
                r#""terminal_reason":"provider_timeout","retry_eligible":true,"#,
                r#""latency_ms":42,"provider":"gemini","model":"gemini-realtime","#,
                r#""metadata":"http_status=504"}"#,
            ),
        );
    }

    #[test]
    fn failure_round_trips_through_the_sanitizing_deserializer() {
        let failure = fixture_failure();
        let encoded = serde_json::to_string(&failure).expect("failure serializes");
        let decoded: BrainProviderFailure =
            serde_json::from_str(&encoded).expect("failure deserializes");
        assert_eq!(decoded, failure);
    }

    #[test]
    fn provider_fallback_event_carries_a_typed_failure_across_the_wire() {
        let event = BrainEvent::ProviderFallbackActivated {
            response_id: "response-1".to_owned(),
            provider: "gemini".to_owned(),
            from_model: "gemini-realtime".to_owned(),
            to_model: "gemini-fallback".to_owned(),
            reason: "provider timeout".to_owned(),
            failure: Some(fixture_failure()),
        };

        let decoded: BrainEvent =
            serde_json::from_value(serde_json::to_value(&event).expect("event serializes"))
                .expect("event deserializes");
        assert_eq!(decoded, event);
    }

    #[test]
    fn sanitize_stage_token_keeps_only_allowlisted_characters() {
        assert_eq!(
            sanitize_stage_token("gemini\nBearer secret-token".to_owned()),
            "geminiBearersecret-token",
        );
        assert_eq!(
            sanitize_stage_token("model\u{1F525}/../../raw_prompt".to_owned()),
            "modelraw_prompt",
        );
    }

    #[test]
    fn sanitize_stage_token_falls_back_to_unknown_when_nothing_survives() {
        assert_eq!(sanitize_stage_token(String::new()), "unknown");
        assert_eq!(
            sanitize_stage_token("\u{1F525} \u{2028}".to_owned()),
            "unknown",
        );
    }

    #[test]
    fn sanitize_stage_token_caps_at_ninety_six_characters() {
        assert_eq!(sanitize_stage_token("p".repeat(4_096)).len(), 96);
    }

    #[test]
    fn sanitize_stage_metadata_keeps_only_diagnostic_punctuation() {
        assert_eq!(
            sanitize_stage_metadata(
                "http_status=503\nraw_prompt=<secret> bearer.token \"quoted\"".to_owned()
            ),
            "http_status=503raw_prompt=secret bearer.token quoted",
        );
        assert_eq!(sanitize_stage_metadata("k=v,".repeat(4_096)).len(), 240);
    }
}
