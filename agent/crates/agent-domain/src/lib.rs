#![forbid(unsafe_code)]

use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use serde::{
    de::{self, MapAccess, Visitor},
    ser::SerializeStruct,
    Deserialize, Deserializer, Serialize, Serializer,
};
use std::{fmt, sync::Arc, time::Duration};

mod brain;
mod ids;
pub mod ports;
mod study;
pub mod tool_executor;
mod tools;

pub use brain::{
    BrainError, BrainEvent, BrainEventStream, BrainInput, BrainProviderError, BrainProviderFailure,
    BrainProviderFailureParts, BrainUsage, ConceptStatus, ManuscriptEmphasis, ManuscriptEntityKind,
    ManuscriptIntent, ManuscriptRegister, Planner, RealtimeBrain, RealtimeBrainCapabilities,
    RealtimeSession, RealtimeSessionTaskGuard, SessionConfig, SourceConfidence, SourceContext,
    SpeechIntent, StudyMode,
};
pub use ids::{CallId, SessionId, ToolName};
pub use ports::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    CreateFileStudySet, CreatePasteStudySet, LibraryNextReviewSummary, LibrarySessionRecapSummary,
    LibrarySessionSummary, LibraryStudyDocumentSummary, LibraryStudySetSummary, PortError,
    SessionStore, SessionTokenNonceClaim, StudyConceptSummary, StudyDocumentSummary,
    StudyLibrarySnapshot, StudyMemoryStore, StudySessionDurableCounts, StudySetIngestionRecord,
    StudySetIngestionStatus, StudySetSummary, StudySourceSpanSummary, StudyStoreBackend,
    StudyStoreCapabilities, StudyStoreWriteCounts, ToolIssuer, VoiceUsageRecord,
};
pub use study::{
    answer_retry_eligible, fixture_question, fixture_source_reference,
    is_repairable_evaluation_label, one_shot_retry_prompt, AnswerEvaluation, OralRoutePlan,
    OralRouteStrategy, RecapSourceMoment, StudyQuestion, StudySessionPhase, StudySessionRecap,
    StudySourceReference, TerminalSessionReason,
};
pub use tool_executor::{AuthorizedStudySession, ToolExecutionError, VivaToolExecutor};
pub use tools::{CorrectionChallengeReason, ToolPlan, ToolProposal, ToolResult};

const BAC_510_LEARNER_LOOP_CONTRACT_JSON: &str =
    include_str!("../../../../packages/core/src/learner-loop-contract.json");

pub fn viva_max_submitted_answer_resolution() -> Duration {
    let contract: serde_json::Value = serde_json::from_str(BAC_510_LEARNER_LOOP_CONTRACT_JSON)
        .expect("BAC-510 learner loop contract JSON must parse");
    let max_resolution_ms = contract
        .get("max_submitted_answer_resolution_ms")
        .and_then(serde_json::Value::as_u64)
        .expect("BAC-510 learner loop contract must define max_submitted_answer_resolution_ms");
    assert!(
        max_resolution_ms <= 45_000,
        "BAC-510 learner loop contract max turn bound must be <= 45 seconds"
    );
    Duration::from_millis(max_resolution_ms)
}

#[derive(Clone, Debug)]
pub struct AudioFrame {
    pcm16: Bytes,
    pcm16_base64: Option<Arc<str>>,
}

impl AudioFrame {
    pub fn from_pcm16_bytes(bytes: impl Into<Bytes>) -> Self {
        Self {
            pcm16: bytes.into(),
            pcm16_base64: None,
        }
    }

    pub fn from_pcm16_text(text: impl AsRef<str>) -> Self {
        Self::from_pcm16_bytes(Bytes::copy_from_slice(text.as_ref().as_bytes()))
    }

    pub fn from_base64(encoded: impl AsRef<str>) -> Result<Self, String> {
        let encoded = encoded.as_ref();
        STANDARD
            .decode(encoded)
            .map(|pcm16| Self {
                pcm16: Bytes::from(pcm16),
                pcm16_base64: Some(Arc::<str>::from(encoded)),
            })
            .map_err(|error| format!("invalid base64 PCM: {error}"))
    }

    pub fn pcm16_bytes(&self) -> &[u8] {
        &self.pcm16
    }

    pub fn pcm16_bytes_owned(&self) -> Bytes {
        self.pcm16.clone()
    }

    pub fn pcm16_base64(&self) -> String {
        self.pcm16_base64
            .as_deref()
            .map(str::to_owned)
            .unwrap_or_else(|| STANDARD.encode(&self.pcm16))
    }
}

impl PartialEq for AudioFrame {
    fn eq(&self, other: &Self) -> bool {
        self.pcm16 == other.pcm16
    }
}

impl Eq for AudioFrame {}

impl Serialize for AudioFrame {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut frame = serializer.serialize_struct("AudioFrame", 1)?;
        frame.serialize_field("pcm16_base64", &self.pcm16_base64())?;
        frame.end()
    }
}

impl<'de> Deserialize<'de> for AudioFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_struct("AudioFrame", &["pcm16_base64"], AudioFrameVisitor)
    }
}

struct AudioFrameVisitor;

impl<'de> Visitor<'de> for AudioFrameVisitor {
    type Value = AudioFrame;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an audio frame with base64-encoded pcm16_base64")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut pcm16_base64 = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "pcm16_base64" => pcm16_base64 = Some(map.next_value::<String>()?),
                _ => {
                    let _ = map.next_value::<de::IgnoredAny>()?;
                }
            }
        }
        let encoded = pcm16_base64.ok_or_else(|| de::Error::missing_field("pcm16_base64"))?;
        AudioFrame::from_base64(encoded).map_err(de::Error::custom)
    }
}
