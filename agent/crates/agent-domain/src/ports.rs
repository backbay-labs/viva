use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AnswerEvaluation, ConceptStatus, ManuscriptIntent, SessionConfig, SourceConfidence,
    StudyQuestion, StudySessionRecap, StudySourceReference, ToolProposal,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyStoreCapabilities {
    pub backend: StudyStoreBackend,
    pub available: bool,
    pub durable: bool,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatePasteStudySet {
    pub user_id: String,
    pub title: String,
    pub course: Option<String>,
    pub exam_date: Option<String>,
    pub pasted_text: String,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudySetIngestionStatus {
    Pending,
    Processing,
    Ready,
    Failed,
}

impl StudySetIngestionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
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

#[derive(Debug, thiserror::Error)]
pub enum PortError {
    #[error("{port} unavailable for {id}: {reason}")]
    Unavailable {
        port: &'static str,
        id: String,
        reason: String,
    },
    #[error("{port} adapter error: {reason}")]
    Adapter { port: &'static str, reason: String },
}

impl PortError {
    pub fn unavailable(
        port: &'static str,
        id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self::Unavailable {
            port,
            id: id.into(),
            reason: reason.into(),
        }
    }

    pub fn adapter(port: &'static str, reason: impl Into<String>) -> Self {
        Self::Adapter {
            port,
            reason: reason.into(),
        }
    }
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

    async fn record_voice_session(&self, _config: &SessionConfig) -> Result<(), PortError> {
        Ok(())
    }

    async fn close_voice_session(
        &self,
        _voice_session_id: &str,
        _terminal_reason: &str,
    ) -> Result<Value, PortError> {
        Ok(serde_json::json!({ "closed": false }))
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

    async fn active_question(
        &self,
        _user_id: &str,
        _study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        Ok(None)
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

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<Value, PortError>;

    async fn record_voice_usage(&self, _event: VoiceUsageRecord) -> Result<(), PortError> {
        Ok(())
    }
}

pub trait ToolIssuer<Outcome>: Send + Sync {
    fn issue(&self, proposal: ToolProposal) -> Outcome;
}
