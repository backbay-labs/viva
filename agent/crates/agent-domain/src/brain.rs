use async_trait::async_trait;
use futures_util::{stream::BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::{sync::mpsc, task::AbortHandle};

use crate::{
    ids::SessionId,
    tools::{ToolPlan, ToolProposal, ToolResult},
    AnswerEvaluation, AudioFrame, StudyQuestion, StudySessionPhase, StudySessionRecap,
    StudySourceReference, TerminalSessionReason,
};

pub type BrainEventStream = BoxStream<'static, BrainEvent>;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudyMode {
    #[default]
    Quiz,
    Teach,
    Mock,
    Cram,
}

impl StudyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Quiz => "quiz",
            Self::Teach => "teach",
            Self::Mock => "mock",
            Self::Cram => "cram",
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

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionConfig {
    pub session_id: Option<SessionId>,
    pub user_id: Option<String>,
    pub study_set_id: Option<String>,
    pub mode: Option<StudyMode>,
    pub initial_goal: Option<String>,
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
            | Self::TranscriptFinal { response_id, .. } => Some(response_id),
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

#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("missing API key for realtime brain")]
    MissingApiKey,
    #[error("brain connection failed: {0}")]
    Connection(String),
    #[error("brain protocol error: {0}")]
    Protocol(String),
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
