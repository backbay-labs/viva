use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    learning_outcome::{ChallengeResolution, PersistedTurnOutcome, TurnOutcome},
    learning_progression::{ProgressionPolicyId, QuestionProgressionResult},
    learning_recap::{SessionLearningEvidence, StudySessionRecap},
    review_schedule::{ReviewScheduleDecisionV1, ReviewSchedulingContextV1},
    study_projection::AuthenticatedStudyProjectionV1,
    AnswerEvaluation, ConceptStatus, ManuscriptIntent, SessionConfig, SourceConfidence,
    StudyQuestion, StudySourceReference, ToolProposal,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyStoreCapabilities {
    pub backend: StudyStoreBackend,
    pub available: bool,
    pub durable: bool,
    pub nonce_replay_protection: bool,
    pub raw_audio_persistence: bool,
    pub transcript_persistence: bool,
    pub uuid_schema_translation: bool,
}

impl StudyStoreCapabilities {
    pub fn unavailable(backend: StudyStoreBackend) -> Self {
        Self {
            backend,
            available: false,
            durable: false,
            nonce_replay_protection: false,
            raw_audio_persistence: false,
            transcript_persistence: false,
            uuid_schema_translation: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudyStoreBackend {
    InMemory,
    Postgres,
    Unknown,
}

impl StudyStoreBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InMemory => "in_memory",
            Self::Postgres => "postgres",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StudyStoreWriteCounts {
    pub sessions: usize,
    pub answer_attempts: usize,
    pub concept_statuses: usize,
    pub review_items: usize,
    pub recaps: usize,
    pub voice_usage: usize,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StudySessionDurableCounts {
    pub answer_attempts: usize,
    pub concept_statuses: usize,
    pub review_items: usize,
    pub prior_recaps: usize,
}

/// Plan 06 Task 4 (`DOMAIN-008`): the domain bounds on answer evidence.
///
/// 45 seconds x 24,000 Hz x 2 PCM16 bytes is the largest answer capture the
/// BAC-510 turn bound can produce, so it is also the largest byte count any
/// store may be asked to record.
pub const MAX_ANSWER_BYTE_COUNT: u64 = 2_160_000;
/// The largest typed answer, in characters.
pub const MAX_ANSWER_CHAR_COUNT: u64 = 65_536;
/// The BAC-510 maximum submitted-answer resolution, in milliseconds.
pub const MAX_ANSWER_DURATION_MS: u64 = 45_000;
/// `AnswerContentPolicy::DigestOnly` stores exactly one durable content trace:
/// an HMAC-SHA256 digest rendered as this many lowercase hexadecimal
/// characters.
pub const ANSWER_DIGEST_HMAC_HEX_LENGTH: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerCaptureMode {
    Audio,
    Typed,
}

impl AnswerCaptureMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::Typed => "typed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerCaptureStatus {
    Accepted,
}

impl AnswerCaptureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerContentPolicy {
    None,
    DigestOnly,
}

impl AnswerContentPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DigestOnly => "digest_only",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnswerAttemptEnvelope {
    pub response_id: String,
    pub question_id: String,
    pub submission_sequence: u32,
    pub idempotency_key: String,
    pub capture_mode: AnswerCaptureMode,
    pub byte_count: Option<u64>,
    pub char_count: Option<u64>,
    pub duration_ms: Option<u64>,
    pub client_generation_id: Option<String>,
    pub locale: Option<String>,
    pub capture_status: AnswerCaptureStatus,
    pub content_policy: AnswerContentPolicy,
    pub answer_digest_hmac: Option<String>,
    pub transcript_status: Option<String>,
    pub transcript_confidence_bucket: Option<String>,
    pub pre_provider_state: String,
}

impl AnswerAttemptEnvelope {
    pub fn validate_fail_closed(&self) -> Result<(), &'static str> {
        if self.response_id.trim().is_empty() {
            return Err("answer attempt envelope is missing response_id");
        }
        if self.question_id.trim().is_empty() {
            return Err("answer attempt envelope is missing question_id");
        }
        if self.submission_sequence == 0 {
            return Err("answer attempt envelope is missing submission_sequence");
        }
        if self.idempotency_key.trim().is_empty() {
            return Err("answer attempt envelope is missing idempotency_key");
        }
        if self.pre_provider_state.trim().is_empty() {
            return Err("answer attempt envelope is missing pre_provider_state");
        }

        // The content-policy converse, both ways: `DigestOnly` means exactly one
        // durable content trace and `None` means none at all. The digest shape is
        // checked on ASCII bytes; an invalid digest is never trimmed, lowercased,
        // or re-encoded into acceptance.
        match (self.content_policy, self.answer_digest_hmac.as_deref()) {
            (AnswerContentPolicy::DigestOnly, None) => {
                return Err("digest_only content policy requires answer_digest_hmac");
            }
            (AnswerContentPolicy::DigestOnly, Some(digest)) => {
                if !is_canonical_answer_digest_hmac(digest) {
                    return Err("answer_digest_hmac must be 64 lowercase hexadecimal characters");
                }
            }
            (AnswerContentPolicy::None, Some(_)) => {
                return Err("answer digest requires digest_only content policy");
            }
            (AnswerContentPolicy::None, None) => {}
        }

        // Capture-mode field presence and absence. A byte count is the one
        // measure both modes record; a character count is typed-only evidence and
        // an audio capture is a whole number of PCM16 samples.
        let Some(byte_count) = self.byte_count else {
            return Err("answer attempt envelope is missing byte_count");
        };
        match self.capture_mode {
            AnswerCaptureMode::Typed => {
                if self.char_count.is_none() {
                    return Err("typed answer capture requires char_count");
                }
            }
            AnswerCaptureMode::Audio => {
                if self.char_count.is_some() {
                    return Err("audio answer capture must not carry char_count");
                }
                if byte_count % 2 != 0 {
                    return Err("audio answer capture requires an even PCM16 byte_count");
                }
            }
        }

        // Positive, inclusive bounds. A present count of zero is not evidence of
        // an empty answer; it is an envelope that cannot be trusted.
        if byte_count == 0 || byte_count > MAX_ANSWER_BYTE_COUNT {
            return Err("answer byte_count must be positive and within MAX_ANSWER_BYTE_COUNT");
        }
        if let Some(char_count) = self.char_count {
            if char_count == 0 || char_count > MAX_ANSWER_CHAR_COUNT {
                return Err("answer char_count must be positive and within MAX_ANSWER_CHAR_COUNT");
            }
        }
        if let Some(duration_ms) = self.duration_ms {
            if duration_ms == 0 || duration_ms > MAX_ANSWER_DURATION_MS {
                return Err(
                    "answer duration_ms must be positive and within MAX_ANSWER_DURATION_MS",
                );
            }
        }

        Ok(())
    }
}

/// Exactly `ANSWER_DIGEST_HMAC_HEX_LENGTH` lowercase hexadecimal ASCII bytes.
///
/// Byte length is the right measure here: every accepted character is ASCII, so
/// a value whose byte length differs from its character length is rejected by
/// construction rather than by a separate check.
fn is_canonical_answer_digest_hmac(digest: &str) -> bool {
    digest.len() == ANSWER_DIGEST_HMAC_HEX_LENGTH
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoiceUsageRecord {
    pub voice_session_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub duration_seconds: u64,
    pub text_input_tokens: u64,
    pub text_output_tokens: u64,
    pub audio_input_tokens: u64,
    pub audio_output_tokens: u64,
    pub cost_estimate_usd: f64,
    pub first_audio_latency_ms: Option<u64>,
    pub answer_eval_latency_ms: Option<u64>,
    pub source_retrieval_latency_ms: Option<u64>,
    pub source_grounded_correction_count: u64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct SessionTokenNonceClaim {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub nonce: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatePasteStudySet {
    pub user_id: String,
    pub title: String,
    pub course: Option<String>,
    pub exam_date: Option<String>,
    pub pasted_text: String,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateFileStudySet {
    pub user_id: String,
    pub study_set_id: Option<String>,
    pub title: String,
    pub course: Option<String>,
    pub exam_date: Option<String>,
    pub file_name: String,
    pub content_type: Option<String>,
    pub file_bytes: Vec<u8>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudySetIngestionStatus {
    Pending,
    Processing,
    Retry,
    Ready,
    Failed,
}

impl StudySetIngestionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Retry => "retry",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySetSummary {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub course: Option<String>,
    pub ingestion_status: StudySetIngestionStatus,
    pub ingestion_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyDocumentSummary {
    pub id: String,
    pub display_name: String,
    pub source_kind: String,
    pub processing_status: StudySetIngestionStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyConceptSummary {
    pub public_id: String,
    pub label: String,
    pub status: ConceptStatus,
    pub source_span_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySourceSpanSummary {
    pub id: String,
    pub document_id: String,
    pub locator: Value,
    pub excerpt: String,
    pub confidence: SourceConfidence,
    pub retrieval_reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySetIngestionRecord {
    pub study_set: StudySetSummary,
    pub documents: Vec<StudyDocumentSummary>,
    pub source_spans: Vec<StudySourceSpanSummary>,
    pub concepts: Vec<StudyConceptSummary>,
    pub questions: Vec<StudyQuestion>,
    pub session_id: String,
    pub session_token: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LibraryStudyDocumentSummary {
    pub id: String,
    pub display_name: String,
    pub source_kind: String,
    pub processing_status: StudySetIngestionStatus,
    pub deleted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LibraryStudySetSummary {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub course: Option<String>,
    pub ingestion_status: StudySetIngestionStatus,
    pub ingestion_error: Option<String>,
    pub server_owned: bool,
    pub documents: Vec<LibraryStudyDocumentSummary>,
    pub concept_count: usize,
    pub question_count: usize,
    pub open_session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LibrarySessionRecapSummary {
    pub voice_session_id: String,
    pub strong_concepts: Vec<String>,
    pub shaky_concepts: Vec<String>,
    pub missed_concepts: Vec<String>,
    pub review_later: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LibraryNextReviewSummary {
    pub concept_id: String,
    pub label: String,
    pub status: ConceptStatus,
    pub persisted_due_at: String,
    pub source: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LibrarySessionSummary {
    pub voice_session_id: String,
    pub user_id: String,
    pub study_set_id: String,
    pub study_set_title: String,
    pub status: String,
    pub terminal_reason: Option<String>,
    pub recap: Option<LibrarySessionRecapSummary>,
    pub next_review: Option<LibraryNextReviewSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyLibrarySnapshot {
    pub user_id: String,
    pub study_sets: Vec<LibraryStudySetSummary>,
    pub sessions: Vec<LibrarySessionSummary>,
}

/// How a port failed, as data. Plans 07/08/09 select retry policy, terminal
/// reason, HTTP status, and durability handling from this enum — never from the
/// diagnostic `reason` text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PortErrorKind {
    /// The port cannot answer at all: unimplemented, disabled, or unreachable.
    Unavailable,
    /// The caller's arguments are semantically invalid; retrying is pointless.
    InvalidInput,
    /// The write lost a uniqueness/replay race, such as a reused nonce.
    Conflict,
    /// The backing store could not durably commit: SQL, pool, or transaction.
    Durability,
    /// An invariant inside the adapter broke; nothing about the request was wrong.
    Internal,
}

impl PortErrorKind {
    pub const ALL: [Self; 5] = [
        Self::Unavailable,
        Self::InvalidInput,
        Self::Conflict,
        Self::Durability,
        Self::Internal,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::InvalidInput => "invalid_input",
            Self::Conflict => "conflict",
            Self::Durability => "durability",
            Self::Internal => "internal",
        }
    }
}

impl std::fmt::Display for PortErrorKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One structured port failure. Every field is private: `reason` is a diagnostic
/// string for logs, and a consumer that could destructure it would be one
/// refactor away from classifying on prose again.
#[derive(Debug, thiserror::Error)]
#[error("{port} {kind} for {id}: {reason}")]
pub struct PortError {
    kind: PortErrorKind,
    port: &'static str,
    id: String,
    reason: String,
}

impl PortError {
    fn new(
        kind: PortErrorKind,
        port: &'static str,
        id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            port,
            id: id.into(),
            reason: reason.into(),
        }
    }

    pub fn unavailable(
        port: &'static str,
        id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self::new(PortErrorKind::Unavailable, port, id, reason)
    }

    pub fn invalid_input(
        port: &'static str,
        id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self::new(PortErrorKind::InvalidInput, port, id, reason)
    }

    pub fn conflict(port: &'static str, id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(PortErrorKind::Conflict, port, id, reason)
    }

    pub fn durability(
        port: &'static str,
        id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self::new(PortErrorKind::Durability, port, id, reason)
    }

    pub fn internal(port: &'static str, id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(PortErrorKind::Internal, port, id, reason)
    }

    pub fn kind(&self) -> PortErrorKind {
        self.kind
    }

    pub fn port(&self) -> &'static str {
        self.port
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Diagnostics only. Nothing may branch on this text.
    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn is_durability(&self) -> bool {
        matches!(self.kind, PortErrorKind::Durability)
    }
}

/// What a study-store write actually did. A caller that cannot tell an insert
/// from a replay cannot report truthfully, so the outcome may not be dropped.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use]
pub enum StudyStoreWriteOutcome {
    Inserted,
    IdempotentReplay,
}

#[async_trait]
pub trait SessionStore<Session>: Send + Sync {
    async fn load_latest_for_user(&self, user_id: &str) -> Result<Option<Session>, PortError>;

    async fn save(&self, session: &Session) -> Result<(), PortError>;
}

#[async_trait]
pub trait StudyMemoryStore: Send + Sync {
    fn capabilities(&self) -> StudyStoreCapabilities {
        StudyStoreCapabilities::unavailable(StudyStoreBackend::Unknown)
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        StudyStoreWriteCounts::default()
    }

    /// Every default below is truth-bearing: it either claims a read observed the
    /// durable record or claims a write happened. A partial store cannot make
    /// either claim, so each one fails closed with `Unavailable` rather than
    /// answering `Ok(0)`, `Ok(false)`, `Ok(())`, `Ok(None)`, or a fabricated
    /// document. These are intentional compatibility boundaries for partial/test
    /// stores, not acceptable production behavior; Plan 09 overrides them all.
    async fn pending_answer_attempts_for_session(
        &self,
        voice_session_id: &str,
    ) -> Result<usize, PortError> {
        Err(PortError::unavailable(
            "study_store",
            voice_session_id,
            "pending answer attempt counting is not implemented by this store",
        ))
    }

    /// Reports whether the session row was inserted or replayed. Plan 09 returns
    /// `IdempotentReplay` only for a genuine replay of the same session.
    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        Err(PortError::unavailable(
            "study_store",
            config
                .session_id
                .as_ref()
                .map_or("unknown", |session_id| session_id.as_str()),
            "voice session recording is not implemented by this store",
        ))
    }

    async fn study_session_durable_counts(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<StudySessionDurableCounts, PortError> {
        Err(PortError::unavailable(
            "study_store",
            voice_session_id,
            "durable session counts are not implemented by this store",
        ))
    }

    async fn answer_attempt_was_recorded(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
    ) -> Result<bool, PortError> {
        Err(PortError::unavailable(
            "study_store",
            response_id,
            "answer attempt durability lookup is not implemented by this store",
        ))
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            format!(
                "{}/{}/{}",
                claim.user_id, claim.study_set_id, claim.voice_session_id
            ),
            "session token nonce replay protection is not implemented by this store",
        ))
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        _terminal_reason: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "study_store",
            voice_session_id,
            "voice session closure is not implemented by this store",
        ))
    }

    async fn create_paste_study_set(
        &self,
        _input: CreatePasteStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        Err(PortError::unavailable(
            "study_store",
            "paste",
            "paste ingestion is not implemented by this store",
        ))
    }

    async fn create_file_study_set(
        &self,
        _input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        Err(PortError::unavailable(
            "study_store",
            "file",
            "file ingestion is not implemented by this store",
        ))
    }

    async fn retry_file_study_set(
        &self,
        _input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        Err(PortError::unavailable(
            "study_store",
            "file_retry",
            "file ingestion retry is not implemented by this store",
        ))
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<Value>, PortError>;

    async fn library_snapshot(&self, user_id: &str) -> Result<StudyLibrarySnapshot, PortError> {
        Err(PortError::unavailable(
            "study_store",
            user_id,
            "library snapshot is not implemented by this store",
        ))
    }

    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "study_store",
            format!("{user_id}/{study_set_id}"),
            "study set deletion is not implemented by this store",
        ))
    }

    async fn delete_session_history(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "study_store",
            format!("{user_id}/{study_set_id}/{voice_session_id}"),
            "session history deletion is not implemented by this store",
        ))
    }

    async fn active_question(
        &self,
        _user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        Err(PortError::unavailable(
            "study_store",
            study_set_id,
            "active question lookup is not implemented by this store",
        ))
    }

    async fn authorize_question_started(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            &question.question_id,
            "question event authorization is not implemented by this store",
        ))
    }

    async fn authorize_answer_evaluation(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _evaluation: &AnswerEvaluation,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            response_id,
            "answer evaluation authorization is not implemented by this store",
        ))
    }

    async fn authorize_source_reference(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        source: &StudySourceReference,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            &source.source_id,
            "source reference authorization is not implemented by this store",
        ))
    }

    async fn authorize_concept_status(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _concept_id: &str,
        _status: &ConceptStatus,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            response_id,
            "concept status authorization is not implemented by this store",
        ))
    }

    async fn authorize_manuscript_intent(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _intent: &ManuscriptIntent,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            "manuscript_intent",
            "manuscript intent authorization is not implemented by this store",
        ))
    }

    async fn authorize_recap(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _recap: &StudySessionRecap,
    ) -> Result<(), PortError> {
        Err(PortError::unavailable(
            "study_store",
            response_id,
            "recap authorization is not implemented by this store",
        ))
    }

    async fn record_answer_attempt_envelope(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "study_store",
            &envelope.response_id,
            "answer attempt envelope recording is not implemented by this store",
        ))
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError>;

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError>;

    async fn record_concept_status(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError>;

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<Value, PortError>;

    /// The authoritative scheduling inputs the store owns for one concept: the study
    /// set's persisted exam instant and the latest persisted v1 FSRS card. D-01
    /// forbids taking either from tool arguments.
    async fn review_scheduling_context(
        &self,
        _user_id: &str,
        study_set_id: &str,
        _concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        Err(PortError::unavailable(
            "study_store",
            study_set_id,
            "authoritative review scheduling context is not implemented by this store",
        ))
    }

    /// Persist one authoritative D-01 decision. The due date and the v1 card/decision
    /// JSON are written together or not at all.
    ///
    /// The write is idempotent per graded outcome, keyed on `response_id` plus the
    /// outcome payload — never on the computed schedule. A replayed tool call reads a
    /// later wall clock and therefore produces a *different* `due_at`/`generated_at`,
    /// so a guard keyed on those values silently lets a replay write a second
    /// scheduled review and advance the persisted FSRS card. On a replay the store
    /// writes nothing and returns the already-persisted decision's public summary,
    /// which is what the caller must report back to the model.
    async fn persist_review_schedule_decision(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _response_id: &str,
        concept_id: &str,
        _decision: ReviewScheduleDecisionV1,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "study_store",
            concept_id,
            "authoritative review schedule persistence is not implemented by this store",
        ))
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<Value, PortError>;

    /// Usage has no stable event key, so a successful insert always reports
    /// `Inserted`; this plan invents no usage idempotency.
    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        Err(PortError::unavailable(
            "study_store",
            event.voice_session_id.as_deref().unwrap_or("unknown"),
            "voice usage recording is not implemented by this store",
        ))
    }

    /// Persist one authoritative Plan 04 [`TurnOutcome`] and return the exact
    /// persisted pair. The receipt's `replayed` flag is insert-versus-replay truth
    /// owned by the store; no caller may reconstruct or fabricate it.
    ///
    /// This default — like the four below — is an intentional fail-closed
    /// compatibility boundary for partial/test stores, not RED-only scaffolding and
    /// not acceptable production behavior. There is no successful default.
    async fn record_turn_outcome(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
        _outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        Err(PortError::unavailable(
            "study_memory_store",
            voice_session_id,
            "record_turn_outcome is not implemented",
        ))
    }

    async fn session_learning_evidence(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        Err(PortError::unavailable(
            "study_memory_store",
            voice_session_id,
            "session_learning_evidence is not implemented",
        ))
    }

    async fn record_challenge_resolution(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
        _resolution: ChallengeResolution,
    ) -> Result<ChallengeResolution, PortError> {
        Err(PortError::unavailable(
            "study_memory_store",
            voice_session_id,
            "record_challenge_resolution is not implemented",
        ))
    }

    async fn select_next_question(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
        _response_id: &str,
        _policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        Err(PortError::unavailable(
            "study_memory_store",
            voice_session_id,
            "select_next_question is not implemented",
        ))
    }

    async fn authenticated_study_projection(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<AuthenticatedStudyProjectionV1, PortError> {
        Err(PortError::unavailable(
            "study_memory_store",
            voice_session_id,
            "authenticated_study_projection is not implemented",
        ))
    }
}

pub trait ToolIssuer<Outcome>: Send + Sync {
    fn issue(&self, proposal: ToolProposal) -> Outcome;
}
