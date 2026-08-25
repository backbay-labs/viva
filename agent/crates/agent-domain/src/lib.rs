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
pub mod learning_outcome;
pub mod learning_progression;
pub mod learning_recap;
pub mod ports;
pub mod review_schedule;
mod session_state;
mod study;
pub mod study_projection;
pub mod tool_executor;
mod tools;

// The typed failure boundary Plans 07/08 classify against: `BrainFailureClass`
// selects the terminal reason, `BrainFailureStage` records where the failure was
// observed, and `BrainProviderErrorClassificationError` turns a missing typed
// failure into a typed error instead of a message-substring fallback.
pub use brain::{
    BrainError, BrainEvent, BrainEventStream, BrainFailureClass, BrainFailureStage, BrainInput,
    BrainProviderError, BrainProviderErrorClassificationError, BrainProviderFailure,
    BrainProviderFailureParts, BrainUsage, ConceptStatus, ManuscriptEmphasis, ManuscriptEntityKind,
    ManuscriptIntent, ManuscriptRegister, Planner, RealtimeBrain, RealtimeBrainCapabilities,
    RealtimeSession, RealtimeSessionTaskGuard, SessionConfig, SourceConfidence, SourceContext,
    SpeechIntent, StudyMode,
};
pub use ids::{CallId, SessionId, ToolName};
// Plan 04 owns every declaration below: `agent-domain` re-exports the authoritative
// learning seam so Plans 05/07/08/09 consume one public path, and never redeclares,
// mirrors, or aliases a learner fact at a consumer boundary.
pub use learning_outcome::{
    AnswerEvaluator, ChallengeDisposition, ChallengeResolution, ConceptStatusTransition,
    CriterionAssessment, CriterionAssessmentKind, EvaluationDecision, EvaluationDeferralReason,
    EvaluationError, EvaluationLabel, EvaluationRequest, EvaluationRubricV1, PersistedTurnOutcome,
    QuestionDisposition, RubricCriterionV1, TurnOutcome, TurnOutcomeRecordReceipt, TurnResolution,
};
pub use learning_progression::{
    ProgressionPolicyId, QuestionProgressionCursor, QuestionProgressionResult,
};
pub use learning_recap::{
    ConceptLabel, RecapBuildError, RecapConceptOutcome, ReviewScheduleAuthority,
    ReviewScheduleSummary, SessionLearningEvidence, StudySessionRecap,
};
// `PortErrorKind` is the store-side half of the typed classification boundary:
// Plans 07/08/09 select retry policy, terminal reason, HTTP status, and
// durability handling from it, and `StudyStoreWriteOutcome` makes a session or
// usage write report what it actually did.
pub use ports::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    CreateFileStudySet, CreatePasteStudySet, LibraryNextReviewSummary, LibrarySessionRecapSummary,
    LibrarySessionSummary, LibraryStudyDocumentSummary, LibraryStudySetSummary, PortError,
    PortErrorKind, SessionStore, SessionTokenNonceClaim, StudyConceptSummary, StudyDocumentSummary,
    StudyLibrarySnapshot, StudyMemoryStore, StudySessionDurableCounts, StudySetIngestionRecord,
    StudySetIngestionStatus, StudySetSummary, StudySourceSpanSummary, StudyStoreBackend,
    StudyStoreCapabilities, StudyStoreWriteCounts, StudyStoreWriteOutcome, ToolIssuer,
    VoiceUsageRecord, ANSWER_DIGEST_HMAC_HEX_LENGTH, MAX_ANSWER_BYTE_COUNT, MAX_ANSWER_CHAR_COUNT,
    MAX_ANSWER_DURATION_MS,
};
pub use review_schedule::{
    decide_review_schedule, format_rfc3339_millis, parse_utc_instant, status_rating, Clock,
    FixedClock, FsrsCardStateV1, PersistedFsrsCardV1, ReviewOutcomeV1, ReviewScheduleCapReasonV1,
    ReviewScheduleDecisionV1, ReviewScheduleError, ReviewSchedulingContextV1, SystemClock,
    VIVA_REVIEW_DESIRED_RETENTION, VIVA_REVIEW_EXAM_MARGIN_SECONDS, VIVA_REVIEW_MAX_INTERVAL_DAYS,
    VIVA_REVIEW_SCHEDULE_POLICY_ID, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
// The one legal-transition table and absorbing terminal state; `study.rs` keeps
// the Plan-04-owned phase and terminal-reason declarations this machine drives.
pub use session_state::{StudySessionState, StudySessionTransitionError};
/// The superseded recap shape, kept reachable under an explicit version name
/// while Plans 07/08/09 migrate their call sites off it.
///
/// The crate-root `StudySessionRecap` is Plan 04's evidence-derived
/// [`learning_recap::StudySessionRecap`], and it is the only recap the domain
/// builds, emits, or persists. This name exists so the adapter, service, and data
/// crates that still name the old fields have something honest to point at during
/// their migration; nothing in `agent-domain` produces one. Delete it once those
/// three lanes have landed.
pub use study::StudySessionRecap as StudySessionRecapV1;
pub use study::{
    fixture_question, fixture_source_reference, AnswerEvaluation, RecapSourceMoment, StudyQuestion,
    StudySessionPhase, StudySourceReference, TerminalSessionReason,
};
pub use study_projection::AuthenticatedStudyProjectionV1;
pub use tool_executor::{AuthorizedStudySession, ToolExecutionError, VivaToolExecutor};
pub use tools::{ToolPlan, ToolProposal, ToolResult};

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

/// Plan 06 Task 5 (`DOMAIN-007`): decoded PCM16 samples plus the base64 encoding
/// of exactly those samples, computed once.
///
/// Both fields are always populated, so `pcm16_base64()` borrows rather than
/// re-encoding on every access — a realtime turn reads the encoding on the hot
/// path. The two constructors are the whole public surface: samples arrive as
/// decoded bytes or as base64 that has already been validated by decoding it.
/// There is deliberately no text constructor; `tests/ui/audio_frame_text_constructor.rs`
/// compile-proves its absence.
#[derive(Clone, Debug)]
pub struct AudioFrame {
    pcm16: Bytes,
    pcm16_base64: Arc<str>,
}

impl AudioFrame {
    pub fn from_pcm16_bytes(bytes: impl Into<Bytes>) -> Self {
        let pcm16 = bytes.into();
        let pcm16_base64 = Arc::<str>::from(STANDARD.encode(&pcm16));
        Self {
            pcm16,
            pcm16_base64,
        }
    }

    pub fn from_base64(encoded: impl AsRef<str>) -> Result<Self, String> {
        let encoded = encoded.as_ref();
        STANDARD
            .decode(encoded)
            .map(|pcm16| Self {
                pcm16: Bytes::from(pcm16),
                pcm16_base64: Arc::<str>::from(encoded),
            })
            .map_err(|error| format!("invalid base64 PCM: {error}"))
    }

    pub fn pcm16_bytes(&self) -> &[u8] {
        &self.pcm16
    }

    pub fn pcm16_bytes_owned(&self) -> Bytes {
        self.pcm16.clone()
    }

    pub fn pcm16_base64(&self) -> &str {
        &self.pcm16_base64
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
        frame.serialize_field("pcm16_base64", self.pcm16_base64())?;
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
