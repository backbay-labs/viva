use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    sync::{Arc, RwLock},
};

use agent_domain::{
    format_rfc3339_millis,
    learning_outcome::{
        VIVA_CHALLENGE_RESOLUTION_SCHEMA, VIVA_TURN_OUTCOME_RECORD_SCHEMA, VIVA_TURN_OUTCOME_SCHEMA,
    },
    learning_recap::{
        ConceptLabel, ReviewScheduleAuthority, ReviewScheduleSummary, SessionLearningEvidence,
    },
    parse_utc_instant,
    study_projection::{
        StudyProjectionActiveQuestionV1, StudyProjectionConceptV1,
        StudyProjectionQuestionProgressV1, StudyProjectionReviewItemV1, StudyProjectionSessionV1,
        StudyProjectionSourceCitationV1, StudyProjectionStudySetV1, StudyProjectionVersionV1,
    },
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    AnswerEvaluation, AuthenticatedStudyProjectionV1, ChallengeDisposition, ChallengeResolution,
    ConceptStatus, ConceptStatusTransition, CreateFileStudySet, CreatePasteStudySet,
    EvaluationLabel, LibraryNextReviewSummary, LibrarySessionRecapSummary, LibrarySessionSummary,
    LibraryStudyDocumentSummary, LibraryStudySetSummary, PersistedTurnOutcome, PortError,
    ProgressionPolicyId, QuestionDisposition, QuestionProgressionCursor, QuestionProgressionResult,
    ReviewScheduleCapReasonV1, ReviewScheduleDecisionV1, ReviewSchedulingContextV1, SessionConfig,
    SessionStore, SessionTokenNonceClaim, SourceConfidence, StudyConceptSummary,
    StudyDocumentSummary, StudyLibrarySnapshot, StudyMemoryStore, StudyMode, StudyQuestion,
    StudySessionDurableCounts, StudySessionRecap, StudySetIngestionRecord, StudySetIngestionStatus,
    StudySetSummary, StudySourceReference, StudySourceSpanSummary, StudyStoreBackend,
    StudyStoreCapabilities, StudyStoreWriteCounts, StudyStoreWriteOutcome, TurnOutcome,
    TurnOutcomeRecordReceipt, TurnResolution, VoiceUsageRecord,
    VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// `DATA-015`: the one shared memory/Postgres characterization suite.
///
/// It is declared here, not in `lib.rs`, so the crate's public surface is
/// untouched; it is not memory-specific and imports both backends.
#[cfg(test)]
pub(crate) mod store_conformance;

/// `DATA-015`: ingestion — classification, decoding, and generation, owned in one
/// place. The port methods below delegate their whole body to it.
mod ingestion;

/// `DATA-015`: learning — canonical outcomes, challenges, progression, the
/// selected D-01 schedule, and both canonical reads built from them.
mod learning;

/// `DATA-015`: authorization — the canonical browser-event digest and the nonce
/// replay ledger's bounded retention.
mod authorization;

/// `DATA-015`: privacy — the tombstone-aware ownership guard, usage/delete
/// serialization, and the selected D-05 finalizer.
mod privacy;

pub(crate) use authorization::{
    current_epoch_seconds, event_authorization_record, payload_sha256,
    AnswerEvaluationEventPayload, ConceptStatusEventPayload, EventAuthorizationKind,
    EventAuthorizationRecord, ReviewScheduleEventPayload, SESSION_TOKEN_NONCE_SKEW_SECONDS,
};
#[cfg(test)]
use ingestion::MAX_PASTE_SOURCE_EXCERPT_CHARS;
pub(crate) use ingestion::{generate_file_study_set, generate_paste_study_set};
pub(crate) use learning::{
    browser_answer_evaluation, cursor_current_question, last_reviewed_at,
    projection_active_question, require_selected_progression_policy, review_schedule_summaries,
    session_answered_questions, turn_outcome_disposition, turn_outcome_transitions,
    validate_challenge_resolution, validate_turn_outcome,
};
/// The raw-payload inventory is a schema gate, exercised only by the migration
/// suite that enforces it.
#[cfg(test)]
pub(crate) use learning::{raw_learner_payload_field, FORBIDDEN_RAW_LEARNER_PAYLOAD_FIELDS};
pub(crate) use privacy::{
    deletion_receipt, DATA_RETENTION_POLICY, DELETED_ROW_CONSTANT, DELETED_STUDY_SET_TITLE,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySetRecord {
    pub study_set_id: String,
    pub user_id: String,
    pub title: String,
    pub course: Option<String>,
    pub ingestion_status: StudySetIngestionStatus,
    pub ingestion_error: Option<String>,
    pub concept_ids: Vec<String>,
    pub question_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyDocumentRecord {
    pub study_set_id: String,
    pub document_id: String,
    pub title: String,
    pub source_kind: String,
    pub processing_status: StudySetIngestionStatus,
    pub tombstoned: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceSpanRecord {
    pub study_set_id: String,
    pub source: StudySourceReference,
    pub tombstoned: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConceptRecord {
    pub study_set_id: String,
    pub concept_id: String,
    pub label: String,
    pub status: ConceptStatus,
    pub source_span_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyQuestionRecord {
    pub study_set_id: String,
    pub question: StudyQuestion,
    pub active: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VoiceSessionRecord {
    pub voice_session_id: String,
    pub user_id: String,
    pub study_set_id: String,
    pub mode: StudyMode,
    pub status: String,
    pub ended_at: Option<String>,
    pub terminal_reason: Option<String>,
}

impl VoiceSessionRecord {
    pub fn from_config(config: &SessionConfig) -> Self {
        Self {
            voice_session_id: required_session_id(config)
                .expect("voice session config is missing session_id")
                .to_owned(),
            user_id: required_user_id(config)
                .expect("voice session config is missing user_id")
                .to_owned(),
            study_set_id: required_study_set_id(config)
                .expect("voice session config is missing study_set_id")
                .to_owned(),
            mode: config.mode.clone().unwrap_or_default(),
            status: "open".to_owned(),
            ended_at: None,
            terminal_reason: None,
        }
    }
}

fn required_session_id(config: &SessionConfig) -> Result<&str, PortError> {
    let session_id = config
        .session_id
        .as_deref()
        .ok_or_else(|| PortError::unavailable("memory", "<missing>", "session_id is required"))?;
    if session_id.trim().is_empty() {
        return Err(PortError::unavailable(
            "memory",
            "<empty>",
            "session_id is required",
        ));
    }
    Ok(session_id)
}

fn required_user_id(config: &SessionConfig) -> Result<&str, PortError> {
    let user_id = config
        .user_id
        .as_deref()
        .ok_or_else(|| PortError::unavailable("memory", "<missing>", "user_id is required"))?;
    if user_id.trim().is_empty() {
        return Err(PortError::unavailable(
            "memory",
            "<empty>",
            "user_id is required",
        ));
    }
    Ok(user_id)
}

fn required_study_set_id(config: &SessionConfig) -> Result<&str, PortError> {
    let study_set_id = config
        .study_set_id
        .as_deref()
        .ok_or_else(|| PortError::unavailable("memory", "<missing>", "study_set_id is required"))?;
    if study_set_id.trim().is_empty() {
        return Err(PortError::unavailable(
            "memory",
            "<empty>",
            "study_set_id is required",
        ));
    }
    Ok(study_set_id)
}

/// A poisoned state lock is a broken adapter invariant, not a caller error and
/// not a storage failure.
fn state_lock_poisoned() -> PortError {
    PortError::internal(
        "memory",
        "study_state",
        "in-memory study state lock poisoned",
    )
}

/// Encoding an already-typed record this store itself holds cannot fail for a
/// caller reason; a failure here means the adapter's own invariant broke.
fn json_invariant(id: &'static str, error: &serde_json::Error) -> PortError {
    PortError::internal("memory", id, error.to_string())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersistedSourceReference {
    pub source_id: String,
    pub document_id: String,
    pub span: String,
    pub confidence: agent_domain::SourceConfidence,
    pub retrieval_reason: String,
}

impl From<&StudySourceReference> for PersistedSourceReference {
    fn from(source: &StudySourceReference) -> Self {
        Self {
            source_id: source.source_id.clone(),
            document_id: source.document_id.clone(),
            span: source.span.clone(),
            confidence: source.confidence.clone(),
            retrieval_reason: source.retrieval_reason.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersistedAnswerEvaluation {
    pub question_id: String,
    pub label: String,
    pub concept_status: ConceptStatus,
    pub confidence_score: f32,
    pub source: PersistedSourceReference,
}

impl From<&AnswerEvaluation> for PersistedAnswerEvaluation {
    fn from(evaluation: &AnswerEvaluation) -> Self {
        Self {
            question_id: evaluation.question_id.clone(),
            label: evaluation.label.clone(),
            concept_status: evaluation.concept_status.clone(),
            confidence_score: evaluation.confidence_score,
            source: PersistedSourceReference::from(&evaluation.source),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersistedAnswerAttemptEnvelope {
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

impl From<&AnswerAttemptEnvelope> for PersistedAnswerAttemptEnvelope {
    fn from(envelope: &AnswerAttemptEnvelope) -> Self {
        Self {
            response_id: envelope.response_id.clone(),
            question_id: envelope.question_id.clone(),
            submission_sequence: envelope.submission_sequence,
            idempotency_key: envelope.idempotency_key.clone(),
            capture_mode: envelope.capture_mode,
            byte_count: envelope.byte_count,
            char_count: envelope.char_count,
            duration_ms: envelope.duration_ms,
            client_generation_id: envelope.client_generation_id.clone(),
            locale: envelope.locale.clone(),
            capture_status: envelope.capture_status,
            content_policy: envelope.content_policy,
            answer_digest_hmac: envelope.answer_digest_hmac.clone(),
            transcript_status: envelope.transcript_status.clone(),
            transcript_confidence_bucket: envelope.transcript_confidence_bucket.clone(),
            pre_provider_state: envelope.pre_provider_state.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnswerAttemptRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub response_id: String,
    pub envelope: PersistedAnswerAttemptEnvelope,
    pub evaluation: Option<PersistedAnswerEvaluation>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConceptStatusRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub concept_id: String,
    pub status: ConceptStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReviewItemRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub concept_id: String,
    pub due_at: String,
}

/// One persisted D-01 `SERVER_PERSISTED_FSRS` decision. Written in the same critical
/// section as its `ReviewItemRecord`, so the due date and the v1 JSON land together
/// or not at all.
///
/// `response_id` and `payload_sha256` are the record's replay identity: the scope, the
/// model response that graded the concept, and a digest of the graded outcome. The
/// computed schedule is deliberately not part of that identity, because a replay reads
/// a later clock and so computes a different `due_at`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReviewScheduleDecisionRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub response_id: String,
    pub concept_id: String,
    pub payload_sha256: String,
    pub decision: ReviewScheduleDecisionV1,
}

impl ReviewScheduleDecisionRecord {
    /// `payload_sha256` already binds `response_id` (see [`payload_sha256`]), so the
    /// explicit `response_id` comparison below is belt-and-braces: it keeps the replay
    /// key readable off the struct instead of resting on a property of the digest.
    fn is_replay_of(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.study_set_id == other.study_set_id
            && self.voice_session_id == other.voice_session_id
            && self.response_id == other.response_id
            && self.concept_id == other.concept_id
            && self.payload_sha256 == other.payload_sha256
    }
}

/// The stored half of a v2 recap source moment. Plan 04's recap carries only the
/// response and source identity — no excerpt, no status label — so this record
/// holds exactly that and nothing learner-authored.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersistedRecapSourceMoment {
    pub response_id: String,
    pub source_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersistedSessionRecap {
    pub voice_session_id: String,
    pub strong_concepts: Vec<String>,
    pub shaky_concepts: Vec<String>,
    pub missed_concepts: Vec<String>,
    pub review_later: Vec<String>,
    pub source_moments: Vec<PersistedRecapSourceMoment>,
}

impl From<&StudySessionRecap> for PersistedSessionRecap {
    fn from(recap: &StudySessionRecap) -> Self {
        let buckets = crate::recap_label_buckets(recap);
        Self {
            voice_session_id: recap.voice_session_id.clone(),
            strong_concepts: buckets.strong,
            shaky_concepts: buckets.shaky,
            missed_concepts: buckets.missed,
            review_later: buckets.review_later,
            source_moments: recap
                .source_moments
                .iter()
                .map(|moment| PersistedRecapSourceMoment {
                    response_id: moment.response_id.clone(),
                    source_id: moment.source_id.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecapRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub recap: PersistedSessionRecap,
}

/// One accepted Plan 06 [`agent_domain::VoiceUsageRecord`].
///
/// The port type is not serializable, so this is the same
/// `Persisted*`-from-port-type projection the rest of this module uses. Usage has
/// no stable event identity, so every accepted write appends exactly one record
/// and the collection's length is the published `voice_usage` count.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersistedVoiceUsage {
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

impl From<&VoiceUsageRecord> for PersistedVoiceUsage {
    fn from(event: &VoiceUsageRecord) -> Self {
        Self {
            voice_session_id: event.voice_session_id.clone(),
            provider: event.provider.clone(),
            model: event.model.clone(),
            duration_seconds: event.duration_seconds,
            text_input_tokens: event.text_input_tokens,
            text_output_tokens: event.text_output_tokens,
            audio_input_tokens: event.audio_input_tokens,
            audio_output_tokens: event.audio_output_tokens,
            cost_estimate_usd: event.cost_estimate_usd,
            first_audio_latency_ms: event.first_audio_latency_ms,
            answer_eval_latency_ms: event.answer_eval_latency_ms,
            source_retrieval_latency_ms: event.source_retrieval_latency_ms,
            source_grounded_correction_count: event.source_grounded_correction_count,
        }
    }
}

/// One persisted Plan 04 [`TurnOutcome`], stored as the canonical typed object.
///
/// `payload_sha256` is the same canonical digest the durable backend stores, so
/// insert-versus-replay truth and divergence detection are decided identically on
/// both backends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcomeRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub response_id: String,
    pub payload_sha256: String,
    pub outcome: TurnOutcome,
}

/// One persisted Plan 04 [`ChallengeResolution`], keyed by its correction id.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChallengeResolutionRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub payload_sha256: String,
    pub resolution: ChallengeResolution,
}

/// The one session-scoped progression cursor, plus the responses already applied
/// to it.
///
/// `applied_response_ids` is what makes a replay a replay: selecting again under
/// an already-authorized response returns the stored selection and does not
/// advance `cursor.revision`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QuestionProgressionRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub cursor: QuestionProgressionCursor,
    pub applied_response_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct InMemoryStudyState {
    pub study_sets: HashMap<String, StudySetRecord>,
    pub documents: HashMap<String, StudyDocumentRecord>,
    pub source_spans: HashMap<String, SourceSpanRecord>,
    pub concepts: HashMap<String, ConceptRecord>,
    pub questions: HashMap<String, StudyQuestionRecord>,
    pub sessions: Vec<VoiceSessionRecord>,
    pub answer_attempts: Vec<AnswerAttemptRecord>,
    pub concept_statuses: Vec<ConceptStatusRecord>,
    pub review_items: Vec<ReviewItemRecord>,
    /// Authoritative exam instant per study set for D-01 scheduling, keyed by
    /// `study_set_id`. Accepts an RFC3339 instant or a bare `YYYY-MM-DD` calendar
    /// date read as midnight UTC. Never supplied by a tool argument.
    #[serde(default)]
    pub study_set_exam_dates: HashMap<String, String>,
    #[serde(default)]
    pub review_schedule_decisions: Vec<ReviewScheduleDecisionRecord>,
    pub recaps: Vec<RecapRecord>,
    /// Plan 06's usage collection (Task 7). Usage carries no stable event
    /// identity, so this is an append-only log and its length is the published
    /// `voice_usage` count.
    #[serde(default)]
    pub voice_usage_events: Vec<PersistedVoiceUsage>,
    /// Plan 04's canonical learning persistence (Task 6).
    #[serde(default)]
    pub turn_outcomes: Vec<TurnOutcomeRecord>,
    #[serde(default)]
    pub challenge_resolutions: Vec<ChallengeResolutionRecord>,
    #[serde(default)]
    pub question_progressions: Vec<QuestionProgressionRecord>,
    /// `DATA-005`: a set, not a log. Authorization is only ever consulted by
    /// membership, so an identical replay carries no new information and must
    /// not cost another entry; the bound is structural rather than a cap.
    pub event_authorizations: HashSet<EventAuthorizationRecord>,
    pub session_token_nonces: Vec<SessionTokenNonceClaim>,
    /// `DATA-004`: this backend's `study_sets.deleted_at`, keyed by study set id
    /// and holding the RFC3339 UTC instant the deletion committed.
    ///
    /// It is a separate map rather than a `StudySetRecord` field because that
    /// record is public API of this crate and other lanes build it with exhaustive
    /// struct literals. The authority is the same either way: every ordinary read
    /// goes through `study_set_locked`, which refuses a set named here.
    #[serde(default)]
    pub deleted_study_sets: HashMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FixtureIdTranslation {
    pub logical_id: String,
    pub storage_uuid: Uuid,
}

/// Fixture logical id to durable storage UUID, in both directions.
///
/// Every id below names a checked-in fixture, never learner data: the seeded
/// development study set, and Plan 04's canonical learning-core study set,
/// documents, source spans, and voice sessions. The durable schema keys those
/// entities by UUID, so without this table the Postgres backend could not return
/// a canonical fixture under the same identifier the in-memory backend uses and
/// no cross-backend fixture comparison would be possible at all.
const FIXTURE_ID_TRANSLATIONS: &[(&str, &str)] = &[
    // Seeded development fixture.
    ("biology-midterm", "11111111-1111-4111-8111-111111111111"),
    ("lec-5", "22222222-2222-4222-8222-222222222222"),
    (
        "src-lecture-5-slide-18",
        "33333333-3333-4333-8333-333333333333",
    ),
    ("voice-session-1", "44444444-4444-4444-8444-444444444444"),
    // Plan 04 learning-core fixtures (`agent/fixtures/learning-core/*.json`).
    (
        "set-cellular-respiration",
        "5e700001-0000-4000-8000-000000000001",
    ),
    ("lec5", "5e700001-0000-4000-8000-000000000002"),
    ("lec3", "5e700001-0000-4000-8000-000000000003"),
    ("src-lec5-slide-18", "5e700001-0000-4000-8000-000000000004"),
    ("src-lec5-slide-19", "5e700001-0000-4000-8000-000000000005"),
    ("src-lec5-slide-20", "5e700001-0000-4000-8000-000000000006"),
    ("src-lec3-slide-04", "5e700001-0000-4000-8000-000000000007"),
    ("lec4", "5e700001-0000-4000-8000-000000000008"),
    ("src-lec4-slide-11", "5e700001-0000-4000-8000-000000000009"),
    ("src-lec5-slide-22", "5e700001-0000-4000-8000-00000000000a"),
    ("vs-0001", "5e700001-0000-4000-8000-000000000011"),
    ("vs-0002", "5e700001-0000-4000-8000-000000000012"),
    ("vs-0003", "5e700001-0000-4000-8000-000000000013"),
    ("vs-0004", "5e700001-0000-4000-8000-000000000014"),
    ("vs-0005", "5e700001-0000-4000-8000-000000000015"),
    ("vs-0006", "5e700001-0000-4000-8000-000000000016"),
    ("vs-0007", "5e700001-0000-4000-8000-000000000017"),
    ("vs-0008", "5e700001-0000-4000-8000-000000000018"),
    ("vs-0009", "5e700001-0000-4000-8000-000000000019"),
    ("vs-1001", "5e700001-0000-4000-8000-000000000021"),
];

/// `DATA-012`: the one deterministic interleaving point this crate's tests can
/// stop an in-memory mutation at.
///
/// The hook sits between a method's validation and its mutation. A test arms one
/// site, waits until the writer has validated and is about to write, runs the
/// racing operation, and only then releases the writer. Under a method that holds
/// one state write lock across validation and mutation the racer cannot even
/// begin until the paused writer commits; under a validate-then-mutate method it
/// runs to completion inside the gap, which is exactly the state the RED tests
/// witness.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MutationSite {
    VoiceSession,
    AnswerEvaluation,
    TurnOutcome,
    VoiceUsage,
}

#[cfg(test)]
#[derive(Debug)]
struct MutationPause {
    site: MutationSite,
    entered: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

/// The test side of one armed pause.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct MutationPauseHandle {
    entered: std::sync::mpsc::Receiver<()>,
    release: std::sync::mpsc::Sender<()>,
}

#[cfg(test)]
impl MutationPauseHandle {
    /// Blocks the calling thread until the armed mutation has validated and is
    /// about to mutate. A site that is never reached fails the test rather than
    /// hanging the suite.
    pub(crate) fn wait_until_paused(&self) {
        self.entered
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the armed mutation reaches its pause point");
    }

    pub(crate) fn release(&self) {
        let _ = self.release.send(());
    }
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryStudyStore {
    inner: Arc<RwLock<InMemoryStudyState>>,
    #[cfg(test)]
    pause: Arc<RwLock<Option<MutationPause>>>,
}

impl InMemoryStudyStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms a one-shot pause at `site`.
    #[cfg(test)]
    pub(crate) fn pause_at(&self, site: MutationSite) -> MutationPauseHandle {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *self.pause.write().expect("pause lock poisoned") = Some(MutationPause {
            site,
            entered: std::sync::Mutex::new(entered_tx),
            release: std::sync::Mutex::new(release_rx),
        });
        MutationPauseHandle {
            entered: entered_rx,
            release: release_tx,
        }
    }

    /// The pause itself. Disarms before blocking, so a site is stopped at most
    /// once per arming and a second caller never waits on a released channel.
    #[cfg(test)]
    fn pause_hook(&self, site: MutationSite) {
        let armed = {
            let mut guard = self.pause.write().expect("pause lock poisoned");
            if guard.as_ref().is_some_and(|pause| pause.site == site) {
                guard.take()
            } else {
                None
            }
        };
        let Some(pause) = armed else {
            return;
        };
        let _ = pause
            .entered
            .lock()
            .expect("pause sender lock poisoned")
            .send(());
        let _ = pause
            .release
            .lock()
            .expect("pause receiver lock poisoned")
            .recv_timeout(std::time::Duration::from_secs(10));
    }

    pub fn seeded_fixture() -> Self {
        let store = Self::new();
        store.upsert_study_set(StudySetRecord {
            study_set_id: "biology-midterm".to_owned(),
            user_id: "user-1".to_owned(),
            title: "Biology Midterm".to_owned(),
            course: Some("Biology 201".to_owned()),
            ingestion_status: StudySetIngestionStatus::Ready,
            ingestion_error: None,
            concept_ids: vec![
                "oxidative-phosphorylation".to_owned(),
                "nadh".to_owned(),
                "atp-synthase".to_owned(),
                "cellular-respiration".to_owned(),
            ],
            question_ids: vec!["q-oxidative-phosphorylation-nadh".to_owned()],
        });
        store.upsert_document(StudyDocumentRecord {
            study_set_id: "biology-midterm".to_owned(),
            document_id: "lec-5".to_owned(),
            title: "Lecture 5".to_owned(),
            source_kind: "pdf".to_owned(),
            processing_status: StudySetIngestionStatus::Ready,
            tombstoned: false,
        });
        store.upsert_source_span(SourceSpanRecord {
            study_set_id: "biology-midterm".to_owned(),
            source: agent_domain::fixture_source_reference(),
            tombstoned: false,
        });
        for (concept_id, label, status) in [
            (
                "oxidative-phosphorylation",
                "Oxidative phosphorylation",
                ConceptStatus::Shaky,
            ),
            ("nadh", "NADH", ConceptStatus::Review),
            ("atp-synthase", "ATP synthase", ConceptStatus::Review),
            (
                "cellular-respiration",
                "Cellular respiration",
                ConceptStatus::Shaky,
            ),
        ] {
            store.upsert_concept(ConceptRecord {
                study_set_id: "biology-midterm".to_owned(),
                concept_id: concept_id.to_owned(),
                label: label.to_owned(),
                status,
                source_span_id: "src-lecture-5-slide-18".to_owned(),
            });
        }
        store.upsert_question(StudyQuestionRecord {
            study_set_id: "biology-midterm".to_owned(),
            question: agent_domain::fixture_question(),
            active: true,
        });
        store
    }

    pub fn snapshot(&self) -> InMemoryStudyState {
        self.inner
            .read()
            .expect("memory store lock poisoned")
            .clone()
    }

    pub fn fixture_id_translation(logical_id: &str) -> Result<FixtureIdTranslation, PortError> {
        let storage_uuid = FIXTURE_ID_TRANSLATIONS
            .iter()
            .find_map(|(fixture_id, uuid)| (*fixture_id == logical_id).then_some(*uuid))
            .ok_or_else(|| {
                PortError::unavailable(
                    "memory",
                    logical_id,
                    "fixture logical id has no UUID storage mapping",
                )
            })?
            .parse()
            .map_err(|error| {
                PortError::internal(
                    "memory",
                    logical_id,
                    format!("invalid fixture UUID: {error}"),
                )
            })?;

        Ok(FixtureIdTranslation {
            logical_id: logical_id.to_owned(),
            storage_uuid,
        })
    }

    /// The reverse of [`Self::fixture_id_translation`].
    ///
    /// The durable backend stores UUIDs, so this is how it hands a fixture id back
    /// under the same name the in-memory backend uses. One table drives both
    /// directions: a mapping that existed in only one of them would make the two
    /// backends disagree about an id, which is exactly the class of drift
    /// `DATA-011` exists to prevent.
    pub fn fixture_logical_id_for_uuid(storage_uuid: Uuid) -> Option<&'static str> {
        let rendered = storage_uuid.to_string();
        FIXTURE_ID_TRANSLATIONS
            .iter()
            .find_map(|(fixture_id, uuid)| (*uuid == rendered).then_some(*fixture_id))
    }

    pub fn upsert_study_set(&self, record: StudySetRecord) {
        self.inner
            .write()
            .expect("memory store lock poisoned")
            .study_sets
            .insert(record.study_set_id.clone(), record);
    }

    /// Record the study set's authoritative exam instant for D-01 scheduling.
    pub fn set_study_set_exam_date(&self, study_set_id: &str, exam_date: Option<String>) {
        let mut state = self.inner.write().expect("memory store lock poisoned");
        match exam_date {
            Some(value) => {
                state
                    .study_set_exam_dates
                    .insert(study_set_id.to_owned(), value);
            }
            None => {
                state.study_set_exam_dates.remove(study_set_id);
            }
        }
    }

    pub fn upsert_document(&self, record: StudyDocumentRecord) {
        self.inner
            .write()
            .expect("memory store lock poisoned")
            .documents
            .insert(record.document_id.clone(), record);
    }

    pub fn upsert_source_span(&self, record: SourceSpanRecord) {
        self.inner
            .write()
            .expect("memory store lock poisoned")
            .source_spans
            .insert(record.source.source_id.clone(), record);
    }

    pub fn upsert_concept(&self, record: ConceptRecord) {
        self.inner
            .write()
            .expect("memory store lock poisoned")
            .concepts
            .insert(
                concept_key(&record.study_set_id, &record.concept_id),
                record,
            );
    }

    pub fn upsert_question(&self, record: StudyQuestionRecord) {
        self.inner
            .write()
            .expect("memory store lock poisoned")
            .questions
            .insert(
                question_key(&record.study_set_id, &record.question.question_id),
                record,
            );
    }

    pub fn save_recap(&self, record: RecapRecord) {
        let mut state = self.inner.write().expect("memory store lock poisoned");
        state.recaps.retain(|existing| {
            existing.user_id != record.user_id
                || existing.study_set_id != record.study_set_id
                || existing.voice_session_id != record.voice_session_id
        });
        state.recaps.push(record);
    }

    fn source_reference_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Option<StudySourceReference> {
        let study_set = state.study_sets.get(study_set_id)?;
        if study_set.user_id != user_id {
            return None;
        }
        let span = state.source_spans.get(source_id)?;
        if span.study_set_id != study_set_id || span.tombstoned {
            return None;
        }
        let document = state.documents.get(&span.source.document_id)?;
        if document.study_set_id != study_set_id || document.tombstoned {
            return None;
        }
        Some(span.source.clone())
    }

    fn active_question_source_locked(
        study_set: &StudySetRecord,
        state: &InMemoryStudyState,
        user_id: &str,
        question_id: &str,
    ) -> Result<StudySourceReference, PortError> {
        Self::ensure_question_locked(study_set, state, question_id)?;
        let record = state
            .questions
            .get(&question_key(&study_set.study_set_id, question_id))
            .filter(|record| record.active)
            .ok_or_else(|| {
                PortError::unavailable(
                    "memory",
                    question_id,
                    "question is not active for this study set",
                )
            })?;
        let source = Self::source_reference_locked(
            state,
            user_id,
            &study_set.study_set_id,
            &record.question.source.source_id,
        )
        .ok_or_else(|| {
            PortError::unavailable(
                "memory",
                &record.question.source.source_id,
                "question source reference is not available for this user and study set",
            )
        })?;
        if source != record.question.source {
            return Err(PortError::internal(
                "memory",
                &record.question.question_id,
                "active question source tuple does not match deterministic retrieval",
            ));
        }
        Ok(source)
    }

    fn ensure_concept_locked(
        study_set: &StudySetRecord,
        state: &InMemoryStudyState,
        concept_id: &str,
    ) -> Result<(), PortError> {
        if study_set
            .concept_ids
            .iter()
            .any(|known| known == concept_id)
            && state
                .concepts
                .contains_key(&concept_key(&study_set.study_set_id, concept_id))
        {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            concept_id,
            "concept is not available for this study set",
        ))
    }

    /// The set's active questions in committed ingestion order.
    ///
    /// `StudySetRecord::question_ids` is the in-memory ingestion ordinal; the
    /// durable backend orders by the `ingestion_ordinal` column migration `0018`
    /// allocates. Both are the order the questions were committed in.
    fn active_questions_locked(
        state: &InMemoryStudyState,
        study_set_id: &str,
    ) -> Vec<StudyQuestion> {
        let Some(study_set) = state.study_sets.get(study_set_id) else {
            return Vec::new();
        };
        study_set
            .question_ids
            .iter()
            .filter_map(|question_id| {
                state
                    .questions
                    .get(&question_key(study_set_id, question_id))
            })
            .filter(|record| record.active)
            .filter(|record| {
                Self::source_span_available_locked(
                    state,
                    study_set_id,
                    &record.question.source.source_id,
                )
            })
            .map(|record| record.question.clone())
            .collect()
    }

    /// Whether a source span is still retrievable for this study set.
    ///
    /// `DATA-011`: this is the in-memory form of the durable
    /// `ACTIVE_QUESTION_SELECT` join, which requires the span and its document to
    /// belong to the set and to be un-tombstoned. Without it a tombstoned document
    /// left its questions active on one backend and removed them on the other, so
    /// the two projections disagreed about the very thing deletion is supposed to
    /// hide.
    fn source_span_available_locked(
        state: &InMemoryStudyState,
        study_set_id: &str,
        source_id: &str,
    ) -> bool {
        let Some(span) = state.source_spans.get(source_id) else {
            return false;
        };
        if span.study_set_id != study_set_id || span.tombstoned {
            return false;
        }
        state
            .documents
            .get(&span.source.document_id)
            .is_some_and(|document| document.study_set_id == study_set_id && !document.tombstoned)
    }
}

fn concept_key(study_set_id: &str, concept_id: &str) -> String {
    format!("{study_set_id}::{concept_id}")
}

fn question_key(study_set_id: &str, question_id: &str) -> String {
    format!("{study_set_id}::{question_id}")
}

pub(crate) fn source_reference_to_summary(source: &StudySourceReference) -> StudySourceSpanSummary {
    StudySourceSpanSummary {
        id: source.source_id.clone(),
        document_id: source.document_id.clone(),
        locator: json!({ "span": source.span }),
        excerpt: source.excerpt.clone(),
        confidence: source.confidence.clone(),
        retrieval_reason: source.retrieval_reason.clone(),
    }
}

pub(crate) fn source_summary_to_reference(source: &StudySourceSpanSummary) -> StudySourceReference {
    StudySourceReference {
        source_id: source.id.clone(),
        document_id: source.document_id.clone(),
        span: source
            .locator
            .get("span")
            .and_then(Value::as_str)
            .unwrap_or("source span")
            .to_owned(),
        excerpt: source.excerpt.clone(),
        confidence: source.confidence.clone(),
        retrieval_reason: source.retrieval_reason.clone(),
    }
}

#[async_trait]
impl SessionStore<VoiceSessionRecord> for InMemoryStudyStore {
    async fn load_latest_for_user(
        &self,
        user_id: &str,
    ) -> Result<Option<VoiceSessionRecord>, PortError> {
        Ok(self
            .inner
            .read()
            .map_err(|_| state_lock_poisoned())?
            .sessions
            .iter()
            .rev()
            .find(|session| session.user_id == user_id)
            .cloned())
    }

    async fn save(&self, session: &VoiceSessionRecord) -> Result<(), PortError> {
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        state.sessions.retain(|existing| {
            existing.voice_session_id != session.voice_session_id
                || existing.user_id != session.user_id
                || existing.study_set_id != session.study_set_id
        });
        state.sessions.push(session.clone());
        Ok(())
    }
}

#[async_trait]
impl StudyMemoryStore for InMemoryStudyStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        StudyStoreCapabilities {
            backend: StudyStoreBackend::InMemory,
            available: true,
            durable: false,
            nonce_replay_protection: true,
            raw_audio_persistence: false,
            transcript_persistence: false,
            uuid_schema_translation: true,
        }
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        let state = self.inner.read().expect("memory store lock poisoned");
        StudyStoreWriteCounts {
            sessions: state.sessions.len(),
            answer_attempts: state.answer_attempts.len(),
            concept_statuses: state.concept_statuses.len(),
            review_items: state.review_items.len(),
            recaps: state.recaps.len(),
            // Every published count is derived from the committed collection it
            // describes, so a count can never disagree with the state that
            // produced it.
            voice_usage: state.voice_usage_events.len(),
        }
    }

    async fn pending_answer_attempts_for_session(
        &self,
        voice_session_id: &str,
    ) -> Result<usize, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;
        Ok(state
            .answer_attempts
            .iter()
            .filter(|record| {
                record.voice_session_id == voice_session_id && record.evaluation.is_none()
            })
            .count())
    }

    async fn study_session_durable_counts(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<StudySessionDurableCounts, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;
        Ok(StudySessionDurableCounts {
            answer_attempts: state
                .answer_attempts
                .iter()
                .filter(|attempt| {
                    attempt.user_id == user_id
                        && attempt.study_set_id == study_set_id
                        && attempt.voice_session_id == voice_session_id
                })
                .count(),
            concept_statuses: state
                .concept_statuses
                .iter()
                .filter(|status| {
                    status.user_id == user_id
                        && status.study_set_id == study_set_id
                        && status.voice_session_id == voice_session_id
                })
                .count(),
            review_items: state
                .review_items
                .iter()
                .filter(|review| {
                    review.user_id == user_id
                        && review.study_set_id == study_set_id
                        && review.voice_session_id == voice_session_id
                })
                .count(),
            prior_recaps: state
                .recaps
                .iter()
                .filter(|recap| {
                    recap.user_id == user_id
                        && recap.study_set_id == study_set_id
                        && recap.voice_session_id == voice_session_id
                })
                .count(),
        })
    }

    async fn answer_attempt_was_recorded(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
    ) -> Result<bool, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;
        Ok(state.answer_attempts.iter().any(|attempt| {
            attempt.user_id == user_id
                && attempt.study_set_id == study_set_id
                && attempt.voice_session_id == voice_session_id
                && attempt.response_id == response_id
        }))
    }

    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        let user_id = required_user_id(config)?;
        let study_set_id = required_study_set_id(config)?;
        let voice_session_id = required_session_id(config)?;
        let record = VoiceSessionRecord::from_config(config);

        // `DATA-012`: one write lock spans the validation and the write. The
        // previous read-lock-then-`SessionStore::save` shape let a `close` commit
        // in the gap, and `save`'s remove-and-push then resurrected the session as
        // `open`.
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        Self::study_set_locked(&state, user_id, study_set_id)?;
        let existing = state
            .sessions
            .iter()
            .position(|session| session.voice_session_id == voice_session_id);
        if let Some(index) = existing {
            let session = &state.sessions[index];
            if session.user_id != user_id || session.study_set_id != study_set_id {
                return Err(PortError::conflict(
                    "memory",
                    voice_session_id,
                    "voice session ownership cannot be changed",
                ));
            }
            if session.status != "open" {
                return Err(PortError::conflict(
                    "memory",
                    voice_session_id,
                    "closed voice session cannot be reopened",
                ));
            }
        }
        #[cfg(test)]
        self.pause_hook(MutationSite::VoiceSession);
        // The outcome reports the physical truth this backend can see: the row
        // already existed, or it did not.
        match existing {
            Some(index) => {
                // In place, never remove-and-push: the committed insertion
                // position is this backend's recency ordinal (`DATA-011`), exactly
                // as Postgres preserves `started_at` across a replay.
                state.sessions[index] = record;
                Ok(StudyStoreWriteOutcome::IdempotentReplay)
            }
            None => {
                state.sessions.push(record);
                Ok(StudyStoreWriteOutcome::Inserted)
            }
        }
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        self.claim_session_token_nonce_at(claim, current_epoch_seconds())
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<Value, PortError> {
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        let session = state
            .sessions
            .iter_mut()
            .find(|session| session.voice_session_id == voice_session_id)
            .ok_or_else(|| {
                PortError::unavailable("memory", voice_session_id, "voice session does not exist")
            })?;
        if session.status != "deleted" {
            session.status = "closed".to_owned();
            session.ended_at = Some("closed".to_owned());
            session.terminal_reason = Some(terminal_reason.to_owned());
        }
        let status = session.status.clone();
        let terminal_reason = session.terminal_reason.clone();
        authorization::evict_session_locked(&mut state, voice_session_id);
        Ok(json!({
            "voice_session_id": voice_session_id,
            "status": status,
            "terminal_reason": terminal_reason,
        }))
    }

    async fn create_paste_study_set(
        &self,
        input: CreatePasteStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        ingestion::create_paste_study_set(self, input)
    }

    async fn create_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        ingestion::create_file_study_set(self, input)
    }

    async fn retry_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        ingestion::retry_file_study_set(self, input)
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;
        let Some(study_set) = state.study_sets.get(study_set_id) else {
            return Ok(None);
        };
        if study_set.user_id != user_id {
            return Ok(None);
        }
        // `DATA-004`/D-05 `HARD_PURGE_TEXT`: a tombstoned set is not part of any
        // ordinary read projection. Postgres already excludes it with
        // `deleted_at IS NULL`; without this, one backend answered a deleted set's
        // context with its scrubbed tombstone — content-free, but still an
        // existence answer the other backend refuses to give.
        if privacy::is_deleted_locked(&state, study_set_id) {
            return Ok(None);
        }
        let documents = state
            .documents
            .values()
            .filter(|document| document.study_set_id == study_set_id && !document.tombstoned)
            .collect::<Vec<_>>();
        let source_spans = state
            .source_spans
            .values()
            .filter(|span| {
                span.study_set_id == study_set_id
                    && !span.tombstoned
                    && Self::source_reference_locked(
                        &state,
                        user_id,
                        study_set_id,
                        &span.source.source_id,
                    )
                    .is_some()
            })
            .collect::<Vec<_>>();
        let concepts = study_set
            .concept_ids
            .iter()
            .filter_map(|concept_id| state.concepts.get(&concept_key(study_set_id, concept_id)))
            .map(|concept| {
                json!({
                    "public_id": &concept.concept_id,
                    "label": &concept.label,
                    "status": &concept.status,
                    "source_span_id": &concept.source_span_id,
                })
            })
            .collect::<Vec<_>>();
        let questions = study_set
            .question_ids
            .iter()
            .filter_map(|question_id| {
                state
                    .questions
                    .get(&question_key(study_set_id, question_id))
            })
            .filter(|record| record.active)
            .map(|record| &record.question)
            .collect::<Vec<_>>();

        Ok(Some(json!({
            "study_set": study_set,
            "documents": documents,
            "source_spans": source_spans,
            "concepts": concepts,
            "questions": questions,
        })))
    }

    async fn library_snapshot(&self, user_id: &str) -> Result<StudyLibrarySnapshot, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;

        let mut study_sets = state
            .study_sets
            .values()
            .filter(|study_set| study_set.user_id == user_id)
            // `DATA-004`: the library is an active read, so a tombstone is not in
            // it. Under `HARD_PURGE_TEXT` the tombstone exists only to keep a
            // repeated delete idempotent and to stop a seed recreating the set.
            .filter(|study_set| !privacy::is_deleted_locked(&state, &study_set.study_set_id))
            .map(|study_set| {
                let mut documents = state
                    .documents
                    .values()
                    .filter(|document| document.study_set_id == study_set.study_set_id)
                    .map(|document| LibraryStudyDocumentSummary {
                        id: document.document_id.clone(),
                        display_name: document.title.clone(),
                        source_kind: document.source_kind.clone(),
                        processing_status: document.processing_status.clone(),
                        deleted: document.tombstoned,
                    })
                    .collect::<Vec<_>>();
                documents.sort_by(|a, b| {
                    a.display_name
                        .cmp(&b.display_name)
                        .then_with(|| a.id.cmp(&b.id))
                });
                let question_count = Self::retrievable_question_count_locked(
                    &state,
                    user_id,
                    &study_set.study_set_id,
                );
                let open_session_id = state
                    .sessions
                    .iter()
                    .rev()
                    .find(|session| {
                        session.user_id == user_id
                            && session.study_set_id == study_set.study_set_id
                            && session.status == "open"
                    })
                    .map(|session| session.voice_session_id.clone());

                LibraryStudySetSummary {
                    id: study_set.study_set_id.clone(),
                    user_id: study_set.user_id.clone(),
                    title: study_set.title.clone(),
                    course: study_set.course.clone(),
                    ingestion_status: study_set.ingestion_status.clone(),
                    ingestion_error: study_set.ingestion_error.clone(),
                    server_owned: true,
                    documents,
                    concept_count: study_set.concept_ids.len(),
                    question_count,
                    open_session_id,
                }
            })
            .collect::<Vec<_>>();
        study_sets.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));

        // `DATA-011`: the committed insertion position *is* this backend's recency
        // ordinal — Plan 06 deliberately adds no timestamp to `VoiceSessionRecord`,
        // and `record_voice_session` replays in place so a replay never moves a
        // session. Sorting by session id, as this list used to, is not recency at
        // all: for two non-lexical UUIDs it can invert the order Postgres returns
        // from `started_at DESC`.
        let mut sessions = state
            .sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| {
                session.user_id == user_id
                    && session.status == "closed"
                    && session.terminal_reason.as_deref() == Some("completed")
            })
            .map(|(insertion_ordinal, session)| {
                let study_set_title = state
                    .study_sets
                    .get(&session.study_set_id)
                    .map(|study_set| study_set.title.clone())
                    .unwrap_or_else(|| session.study_set_id.clone());
                let recap = state
                    .recaps
                    .iter()
                    .rev()
                    .find(|record| {
                        record.user_id == user_id
                            && record.study_set_id == session.study_set_id
                            && record.voice_session_id == session.voice_session_id
                    })
                    .map(|record| LibrarySessionRecapSummary {
                        voice_session_id: record.recap.voice_session_id.clone(),
                        strong_concepts: record.recap.strong_concepts.clone(),
                        shaky_concepts: record.recap.shaky_concepts.clone(),
                        missed_concepts: record.recap.missed_concepts.clone(),
                        review_later: record.recap.review_later.clone(),
                    });
                // D-01: the authenticated read model selects only valid v1 decisions.
                // A legacy or superseded `review_items` row is never a fallback, and a
                // `past_exam`-capped decision is excluded from the learner-visible
                // schedule entirely.
                let next_review = state
                    .review_schedule_decisions
                    .iter()
                    .filter(|record| {
                        record.user_id == user_id
                            && record.study_set_id == session.study_set_id
                            && record.voice_session_id == session.voice_session_id
                            && record.decision.validate().is_ok()
                            && record.decision.cap_reason
                                != Some(ReviewScheduleCapReasonV1::PastExam)
                    })
                    .min_by(|a, b| {
                        a.decision
                            .due_at
                            .cmp(&b.decision.due_at)
                            .then_with(|| a.concept_id.cmp(&b.concept_id))
                    })
                    .map(|record| {
                        let concept = state
                            .concepts
                            .get(&concept_key(&record.study_set_id, &record.concept_id));

                        LibraryNextReviewSummary {
                            concept_id: record.concept_id.clone(),
                            label: concept
                                .map(|entry| entry.label.clone())
                                .unwrap_or_else(|| record.concept_id.clone()),
                            status: record.decision.status.clone(),
                            persisted_due_at: format_rfc3339_millis(record.decision.due_at),
                            source: "review_schedule_decision_v1".to_owned(),
                        }
                    });

                (
                    insertion_ordinal,
                    LibrarySessionSummary {
                        voice_session_id: session.voice_session_id.clone(),
                        user_id: session.user_id.clone(),
                        study_set_id: session.study_set_id.clone(),
                        study_set_title,
                        status: session.status.clone(),
                        terminal_reason: session.terminal_reason.clone(),
                        recap,
                        next_review,
                    },
                )
            })
            .collect::<Vec<_>>();
        // Most recent first, with the session id as the documented tie-break —
        // the same rule the durable backend states as `started_at DESC, id DESC`.
        sessions.sort_by(|(left_ordinal, left), (right_ordinal, right)| {
            right_ordinal
                .cmp(left_ordinal)
                .then_with(|| right.voice_session_id.cmp(&left.voice_session_id))
        });

        Ok(StudyLibrarySnapshot {
            user_id: user_id.to_owned(),
            study_sets,
            sessions: sessions.into_iter().map(|(_, session)| session).collect(),
        })
    }

    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Value, PortError> {
        privacy::delete_study_set(self, user_id, study_set_id)
    }

    async fn delete_session_history(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<Value, PortError> {
        privacy::delete_session_history(self, user_id, study_set_id, voice_session_id)
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;
        Self::active_question_locked(&state, user_id, study_set_id)
    }

    async fn authorize_question_started(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        authorization::authorize_question_started(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            question,
        )
    }

    async fn authorize_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: &AnswerEvaluation,
    ) -> Result<(), PortError> {
        authorization::authorize_answer_evaluation(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            evaluation,
        )
    }

    async fn authorize_source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        source: &StudySourceReference,
    ) -> Result<(), PortError> {
        authorization::authorize_source_reference(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            source,
        )
    }

    async fn authorize_concept_status(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        status: &ConceptStatus,
    ) -> Result<(), PortError> {
        authorization::authorize_concept_status(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            concept_id,
            status,
        )
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &agent_domain::ManuscriptIntent,
    ) -> Result<(), PortError> {
        authorization::authorize_manuscript_intent(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            intent,
        )
    }

    async fn authorize_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: &StudySessionRecap,
    ) -> Result<(), PortError> {
        authorization::authorize_recap(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            recap,
        )
    }

    async fn record_answer_attempt_envelope(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<Value, PortError> {
        envelope
            .validate_fail_closed()
            .map_err(|reason| PortError::invalid_input("memory", &envelope.response_id, reason))?;
        let persisted = PersistedAnswerAttemptEnvelope::from(&envelope);
        let record = AnswerAttemptRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            response_id: envelope.response_id.clone(),
            envelope: persisted,
            evaluation: None,
        };
        let result = serde_json::to_value(&record)
            .map_err(|error| json_invariant("study_store_record", &error))?;
        // `DATA-012`: validate against the same locked state the mutation writes.
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        {
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::active_question_source_locked(study_set, &state, user_id, &envelope.question_id)?;
        }
        if let Some(existing) = state.answer_attempts.iter_mut().find(|existing| {
            existing.user_id == user_id
                && existing.study_set_id == study_set_id
                && existing.voice_session_id == voice_session_id
                && existing.response_id == envelope.response_id
        }) {
            if existing.envelope != record.envelope {
                return Err(PortError::conflict(
                    "memory",
                    &envelope.response_id,
                    "answer attempt envelope cannot be changed",
                ));
            }
            return serde_json::to_value(existing)
                .map_err(|error| json_invariant("answer_attempt_record", &error));
        }
        state.answer_attempts.push(record);
        Ok(result)
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError> {
        evaluation.validate_fail_closed().map_err(|reason| {
            PortError::invalid_input("memory", &evaluation.question_id, reason)
        })?;
        let persisted_evaluation = PersistedAnswerEvaluation::from(&evaluation);
        // `A-22`: one digest definition for the `answer_evaluation` event, shared
        // with the turn-outcome authority that superseded this writer and with the
        // gate that reads it. A second definition here would authorize on one
        // write path what the other cannot.
        let authorization = event_authorization_record(
            "memory",
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::AnswerEvaluation,
            &AnswerEvaluationEventPayload::from_browser_event(&evaluation),
        )?;
        // `DATA-012`: one write lock spans the validation and the write, so a
        // deletion that commits first cannot be followed by a late attempt row or
        // a late authorization digest.
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        let canonical_source = {
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::active_question_source_locked(
                study_set,
                &state,
                user_id,
                &evaluation.question_id,
            )?
        };
        if canonical_source != evaluation.source {
            return Err(PortError::invalid_input(
                "memory",
                &evaluation.question_id,
                "answer evaluation source tuple does not match active question source",
            ));
        }
        #[cfg(test)]
        self.pause_hook(MutationSite::AnswerEvaluation);
        let result = if let Some(existing) = state.answer_attempts.iter_mut().find(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.response_id == response_id
        }) {
            if existing.envelope.question_id != evaluation.question_id {
                return Err(PortError::conflict(
                    "memory",
                    response_id,
                    "answer evaluation question does not match attempt envelope",
                ));
            }
            existing.evaluation = Some(persisted_evaluation);
            serde_json::to_value(existing)
                .map_err(|error| json_invariant("study_store_record", &error))?
        } else {
            let record = AnswerAttemptRecord {
                user_id: user_id.to_owned(),
                study_set_id: study_set_id.to_owned(),
                voice_session_id: voice_session_id.to_owned(),
                response_id: response_id.to_owned(),
                envelope: PersistedAnswerAttemptEnvelope {
                    response_id: response_id.to_owned(),
                    question_id: evaluation.question_id.clone(),
                    submission_sequence: 1,
                    idempotency_key: format!(
                        "{voice_session_id}:{}:1:{response_id}:compat",
                        evaluation.question_id
                    ),
                    capture_mode: AnswerCaptureMode::Typed,
                    byte_count: None,
                    char_count: None,
                    duration_ms: None,
                    client_generation_id: None,
                    locale: None,
                    capture_status: AnswerCaptureStatus::Accepted,
                    content_policy: AnswerContentPolicy::None,
                    answer_digest_hmac: None,
                    transcript_status: None,
                    transcript_confidence_bucket: None,
                    pre_provider_state: "evaluation_only_compat".to_owned(),
                },
                evaluation: Some(persisted_evaluation),
            };
            let result = serde_json::to_value(&record)
                .map_err(|error| json_invariant("study_store_record", &error))?;
            state.answer_attempts.push(record);
            result
        };
        authorization::record_locked(&mut state, authorization);
        Ok(result)
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        let state = self.inner.read().map_err(|_| state_lock_poisoned())?;
        Ok(Self::source_reference_locked(
            &state,
            user_id,
            study_set_id,
            source_id,
        ))
    }

    async fn record_concept_status(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        let record = ConceptStatusRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            concept_id: concept_id.to_owned(),
            status: status.clone(),
        };
        let payload = ConceptStatusEventPayload {
            concept_id,
            status: &status,
        };
        let authorization = event_authorization_record(
            "memory",
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )?;
        // `DATA-012`: validate against the same locked state the mutation writes.
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        {
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::ensure_concept_locked(study_set, &state, concept_id)?;
        }
        if authorization::is_recorded_locked(&state, &authorization) {
            return Ok(status);
        }
        if let Some(concept) = state
            .concepts
            .get_mut(&concept_key(study_set_id, concept_id))
        {
            concept.status = status.clone();
        }
        state.concept_statuses.push(record);
        authorization::record_locked(&mut state, authorization);
        Ok(status)
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<Value, PortError> {
        let record = ReviewItemRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            concept_id: concept_id.to_owned(),
            due_at: due_at.to_owned(),
        };
        let result = serde_json::to_value(&record)
            .map_err(|error| json_invariant("study_store_record", &error))?;
        // `DATA-012`: validate against the same locked state the mutation writes.
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        {
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::ensure_concept_locked(study_set, &state, concept_id)?;
        }
        if !state.review_items.contains(&record) {
            state.review_items.push(record);
        }
        Ok(result)
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        learning::review_scheduling_context(self, user_id, study_set_id, concept_id)
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: ReviewScheduleDecisionV1,
    ) -> Result<Value, PortError> {
        learning::persist_review_schedule_decision(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            concept_id,
            decision,
        )
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<Value, PortError> {
        if recap.voice_session_id != voice_session_id {
            return Err(PortError::invalid_input(
                "memory",
                voice_session_id,
                "recap session does not match authorized session",
            ));
        }
        let record = RecapRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            recap: PersistedSessionRecap::from(&recap),
        };
        let authorization = event_authorization_record(
            "memory",
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            &recap,
        )?;
        let result = serde_json::to_value(&record)
            .map_err(|error| json_invariant("study_store_record", &error))?;
        // `DATA-012`: one write lock spans the set/session/source validation and
        // the write. The previous shape took a fresh read lock per source moment,
        // so a deletion could commit between two of them.
        let mut state = self.inner.write().map_err(|_| state_lock_poisoned())?;
        Self::study_set_locked(&state, user_id, study_set_id)?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        for moment in &recap.source_moments {
            Self::source_reference_locked(&state, user_id, study_set_id, &moment.source_id)
                .ok_or_else(|| {
                    PortError::unavailable(
                        "memory",
                        moment.source_id.clone(),
                        "recap source reference is not available for this user and study set",
                    )
                })?;
        }
        state.recaps.retain(|existing| {
            existing.user_id != record.user_id
                || existing.study_set_id != record.study_set_id
                || existing.voice_session_id != record.voice_session_id
        });
        state.recaps.push(record);
        authorization::record_locked(&mut state, authorization);
        Ok(result)
    }

    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        privacy::record_voice_usage(self, event)
    }

    /// `LEARN-003`/Task 6: the canonical outcome, its concept transitions, its
    /// progression effect, and its browser authorization digests, all under one
    /// state write lock.
    ///
    /// Every validation reads the same locked state the mutation writes, so there
    /// is no window in which a deletion or a close can slip between them. A
    /// divergent payload under an already-recorded response identity is a
    /// `Conflict` that changes nothing.
    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        learning::record_turn_outcome(self, user_id, study_set_id, voice_session_id, outcome)
    }

    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        learning::session_learning_evidence(self, user_id, study_set_id, voice_session_id)
    }

    async fn record_challenge_resolution(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        resolution: ChallengeResolution,
    ) -> Result<ChallengeResolution, PortError> {
        learning::record_challenge_resolution(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            resolution,
        )
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        learning::select_next_question(
            self,
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            policy,
        )
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<AuthenticatedStudyProjectionV1, PortError> {
        learning::authenticated_study_projection(self, user_id, study_set_id, voice_session_id)
    }
}

#[cfg(test)]
mod tests {
    use agent_domain::{
        fixture_question, fixture_source_reference,
        learning_recap::{
            RecapConceptOutcome, RecapSourceMoment, ReviewScheduleAuthority, ReviewScheduleSummary,
            VIVA_STUDY_SESSION_RECAP_SCHEMA,
        },
        ConceptStatus, PortErrorKind, SessionId, SourceConfidence,
    };

    use super::*;

    fn seeded_store() -> InMemoryStudyStore {
        InMemoryStudyStore::seeded_fixture()
    }

    fn pending_attempt_record(voice_session_id: &str, response_id: &str) -> AnswerAttemptRecord {
        AnswerAttemptRecord {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            response_id: response_id.to_owned(),
            envelope: PersistedAnswerAttemptEnvelope {
                response_id: response_id.to_owned(),
                question_id: "q-1".to_owned(),
                submission_sequence: 1,
                idempotency_key: format!("{voice_session_id}:{response_id}"),
                capture_mode: AnswerCaptureMode::Typed,
                byte_count: None,
                char_count: Some(12),
                duration_ms: None,
                client_generation_id: None,
                locale: None,
                capture_status: AnswerCaptureStatus::Accepted,
                content_policy: AnswerContentPolicy::DigestOnly,
                answer_digest_hmac: Some("digest".to_owned()),
                transcript_status: None,
                transcript_confidence_bucket: None,
                pre_provider_state: "submitted".to_owned(),
            },
            evaluation: None,
        }
    }

    fn evaluated_attempt_record(voice_session_id: &str, response_id: &str) -> AnswerAttemptRecord {
        let question = fixture_question();
        AnswerAttemptRecord {
            evaluation: Some(PersistedAnswerEvaluation {
                question_id: question.question_id,
                label: "mostly correct".to_owned(),
                concept_status: ConceptStatus::Strong,
                confidence_score: 0.84,
                source: PersistedSourceReference::from(&fixture_source_reference()),
            }),
            ..pending_attempt_record(voice_session_id, response_id)
        }
    }

    async fn record_fixture_session(store: &InMemoryStudyStore) {
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .unwrap();
    }

    /// One accepted evaluation for the store's own active question, so the source
    /// tuple always matches deterministic retrieval.
    fn fixture_evaluation(question: &StudyQuestion) -> AnswerEvaluation {
        AnswerEvaluation {
            question_id: question.question_id.clone(),
            answer_text: "NADH donates electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Grounded in the seeded source.".to_owned(),
            retry_prompt: question.follow_up.clone(),
            source: question.source.clone(),
            concept_status: ConceptStatus::Strong,
            confidence_score: 0.84,
        }
    }

    fn fixture_recap() -> StudySessionRecap {
        StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Strong concepts: 1 of 2.".to_owned(),
            summary: "Graded concepts: 2. Evaluated turns: 1. Deferred turns: 0.".to_owned(),
            concepts: vec![
                RecapConceptOutcome {
                    concept_id: "oxidative-phosphorylation".to_owned(),
                    label: "Oxidative phosphorylation".to_owned(),
                    status: ConceptStatus::Strong,
                },
                RecapConceptOutcome {
                    concept_id: "atp-synthase".to_owned(),
                    label: "ATP synthase".to_owned(),
                    status: ConceptStatus::Shaky,
                },
            ],
            review_schedule: vec![ReviewScheduleSummary {
                concept_id: "atp-synthase".to_owned(),
                due_at: "2031-04-07T12:00:00.000Z".to_owned(),
                authority: ReviewScheduleAuthority::ServerPersistedFsrs,
            }],
            next_action: "Review the scheduled concepts on their due dates.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-1".to_owned(),
                source_id: fixture_source_reference().source_id,
            }],
            deferred_turns: 0,
        }
    }

    #[tokio::test]
    async fn pending_answer_attempts_are_scoped_to_voice_session() {
        let store = InMemoryStudyStore::new();
        {
            let mut state = store.inner.write().expect("memory store lock poisoned");
            state
                .answer_attempts
                .push(pending_attempt_record("voice-session-1", "response-1"));
            state
                .answer_attempts
                .push(pending_attempt_record("voice-session-2", "response-2"));
            state
                .answer_attempts
                .push(evaluated_attempt_record("voice-session-2", "response-3"));
        }

        assert_eq!(
            store
                .pending_answer_attempts_for_session("voice-session-1")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .pending_answer_attempts_for_session("voice-session-2")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .pending_answer_attempts_for_session("voice-session-3")
                .await
                .unwrap(),
            0
        );
    }

    fn fixture_session_config() -> SessionConfig {
        SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        }
    }

    async fn record_fixture_answer(store: &InMemoryStudyStore, voice_session_id: &str) {
        let question = fixture_question();
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                voice_session_id,
                "response-1",
                AnswerEvaluation {
                    question_id: question.question_id,
                    answer_text: "NADH gives electrons.".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Source-backed correction.".to_owned(),
                    retry_prompt: question.follow_up,
                    source: question.source,
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.84,
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn study_session_durable_counts_are_scoped_to_authorized_session() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("voice-session-2")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .unwrap();

        for session_id in ["voice-session-1", "voice-session-2"] {
            record_fixture_answer(&store, session_id).await;
            store
                .record_concept_status(
                    "user-1",
                    "biology-midterm",
                    session_id,
                    "response-1",
                    "oxidative-phosphorylation",
                    ConceptStatus::Strong,
                )
                .await
                .unwrap();
            store
                .schedule_review_item(
                    "user-1",
                    "biology-midterm",
                    session_id,
                    "atp-synthase",
                    "2026-06-16T09:00:00Z",
                )
                .await
                .unwrap();
            store
                .record_recap(
                    "user-1",
                    "biology-midterm",
                    session_id,
                    "response-1",
                    StudySessionRecap {
                        schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA
                            .to_owned(),
                        voice_session_id: session_id.to_owned(),
                        headline: "Durable recap".to_owned(),
                        summary: "Recorded from durable state.".to_owned(),
                        concepts: vec![
                            agent_domain::learning_recap::RecapConceptOutcome {
                                concept_id: "oxidative-phosphorylation".to_owned(),
                                label: "Oxidative phosphorylation".to_owned(),
                                status: ConceptStatus::Strong,
                            },
                            agent_domain::learning_recap::RecapConceptOutcome {
                                concept_id: "atp-synthase".to_owned(),
                                label: "ATP synthase".to_owned(),
                                status: ConceptStatus::Shaky,
                            },
                        ],
                        review_schedule: vec![
                            agent_domain::learning_recap::ReviewScheduleSummary {
                                concept_id: "atp-synthase".to_owned(),
                                due_at: "2031-04-07T12:00:00.000Z".to_owned(),
                                authority:
                                    agent_domain::learning_recap::ReviewScheduleAuthority::ServerPersistedFsrs,
                            },
                        ],
                        next_action: "Continue".to_owned(),
                        source_moments: vec![],
                        deferred_turns: 0,
                    },
                )
                .await
                .unwrap();
        }

        let counts = store
            .study_session_durable_counts("user-1", "biology-midterm", "voice-session-1")
            .await
            .unwrap();
        assert_eq!(counts.answer_attempts, 1);
        assert_eq!(counts.concept_statuses, 1);
        assert_eq!(counts.review_items, 1);
        assert_eq!(counts.prior_recaps, 1);
        assert_eq!(store.write_counts().answer_attempts, 2);
    }

    #[tokio::test]
    async fn deletion_removes_session_nonces_and_answer_envelopes() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let session_nonce = SessionTokenNonceClaim {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            nonce: "nonce-session-delete".to_owned(),
            expires_at: 1_800_000_000,
        };
        store
            .claim_session_token_nonce(session_nonce)
            .await
            .expect("records nonce for session deletion");
        record_fixture_answer(&store, "voice-session-1").await;
        assert_eq!(store.snapshot().session_token_nonces.len(), 1);
        assert_eq!(store.snapshot().answer_attempts.len(), 1);

        store
            .delete_session_history("user-1", "biology-midterm", "voice-session-1")
            .await
            .expect("deletes session history");
        let session_deleted = store.snapshot();
        assert!(session_deleted.session_token_nonces.is_empty());
        assert!(session_deleted.answer_attempts.is_empty());

        let study_delete_session_id = "voice-session-study-delete";
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(study_delete_session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("records study-delete session");
        let study_nonce = SessionTokenNonceClaim {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: study_delete_session_id.to_owned(),
            nonce: "nonce-study-delete".to_owned(),
            expires_at: 1_800_000_000,
        };
        store
            .claim_session_token_nonce(study_nonce)
            .await
            .expect("records nonce for study deletion");
        record_fixture_answer(&store, study_delete_session_id).await;
        assert_eq!(store.snapshot().session_token_nonces.len(), 1);
        assert_eq!(store.snapshot().answer_attempts.len(), 1);

        store
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("deletes study set");
        let study_deleted = store.snapshot();
        assert!(study_deleted.session_token_nonces.is_empty());
        assert!(study_deleted.answer_attempts.is_empty());
    }

    fn add_second_active_question_with_source(store: &InMemoryStudyStore) -> StudyQuestion {
        let mut source = fixture_source_reference();
        source.source_id = "src-lecture-5-slide-19".to_owned();
        source.span = "slide:19".to_owned();
        source.excerpt = "FADH2 enters later in the electron transport chain and contributes fewer protons than NADH.".to_owned();
        source.retrieval_reason = "server fixture source for FADH2 contrast".to_owned();
        store.upsert_source_span(SourceSpanRecord {
            study_set_id: "biology-midterm".to_owned(),
            source: source.clone(),
            tombstoned: false,
        });
        let question = StudyQuestion {
            question_id: "q-fadh2-entry-point".to_owned(),
            concept_id: crate::generated_question_concept_id("q-fadh2-entry-point"),
            prompt: "Where does FADH2 enter the electron transport chain?".to_owned(),
            expected_terms: vec!["complex ii".to_owned(), "fewer protons".to_owned()],
            follow_up: "Connect the entry point to ATP yield.".to_owned(),
            rubric: crate::generated_question_rubric(
                "q-fadh2-entry-point",
                "Where does FADH2 enter the electron transport chain?",
                &source.source_id,
            ),
            source,
        };
        store.upsert_question(StudyQuestionRecord {
            study_set_id: "biology-midterm".to_owned(),
            question: question.clone(),
            active: true,
        });
        store
            .inner
            .write()
            .expect("memory store lock poisoned")
            .study_sets
            .get_mut("biology-midterm")
            .expect("fixture study set")
            .question_ids
            .push(question.question_id.clone());
        question
    }

    const MAX_TEST_SOURCE_EXCERPT_CHARS: usize = 360;

    fn locator_span(source: &StudySourceSpanSummary) -> &str {
        source
            .locator
            .get("span")
            .and_then(Value::as_str)
            .expect("source span locator")
    }

    fn assert_reference_ready_source_span(source: &StudySourceSpanSummary) {
        assert!(source.excerpt.chars().count() <= MAX_TEST_SOURCE_EXCERPT_CHARS);
        assert!(!source.excerpt.trim().is_empty());
        assert!(locator_span(source).starts_with("chars:"));
        assert!(source.locator.get("page").is_none());
        assert!(source.locator.get("bbox").is_none());
        assert!(source.locator.get("x").is_none());
        assert!(source.locator.get("y").is_none());
        assert!(!source.retrieval_reason.trim().is_empty());
        assert!(!source.retrieval_reason.contains("browser"));
    }

    #[tokio::test]
    async fn retrieves_only_server_owned_live_source_tuple() {
        let store = seeded_store();
        let source = store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(source.document_id, "lec-5");
        assert_eq!(source.span, "slide:18");
        assert_eq!(source.confidence, SourceConfidence::High);
        assert!(store
            .source_reference("user-2", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn tombstoned_documents_remove_source_retrieval() {
        let store = seeded_store();
        store.upsert_document(StudyDocumentRecord {
            study_set_id: "biology-midterm".to_owned(),
            document_id: "lec-5".to_owned(),
            title: "Lecture 5".to_owned(),
            source_kind: "pdf".to_owned(),
            processing_status: StudySetIngestionStatus::Ready,
            tombstoned: true,
        });

        assert!(store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn tombstoned_source_spans_remove_source_retrieval() {
        let store = seeded_store();
        store.upsert_source_span(SourceSpanRecord {
            study_set_id: "biology-midterm".to_owned(),
            source: fixture_source_reference(),
            tombstoned: true,
        });

        assert!(store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn reports_non_durable_store_capabilities_and_uuid_translation() {
        let store = seeded_store();
        let capabilities = store.capabilities();

        assert_eq!(capabilities.backend, StudyStoreBackend::InMemory);
        assert!(capabilities.available);
        assert!(!capabilities.durable);
        assert!(!capabilities.raw_audio_persistence);
        assert!(!capabilities.transcript_persistence);
        assert!(capabilities.uuid_schema_translation);

        let translated = InMemoryStudyStore::fixture_id_translation("biology-midterm").unwrap();
        assert_eq!(translated.logical_id, "biology-midterm");
        assert_eq!(
            translated.storage_uuid.to_string(),
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(
            InMemoryStudyStore::fixture_id_translation("voice-session-1")
                .unwrap()
                .storage_uuid
                .to_string(),
            "44444444-4444-4444-8444-444444444444"
        );
        assert!(InMemoryStudyStore::fixture_id_translation("unmapped").is_err());
    }

    #[tokio::test]
    async fn saves_voice_session_and_answer_attempts_without_postgres() {
        let store = seeded_store();
        let session = VoiceSessionRecord::from_config(&SessionConfig {
            session_id: Some(SessionId::new("voice-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        });
        store.save(&session).await.unwrap();

        assert_eq!(
            store
                .load_latest_for_user("user-1")
                .await
                .unwrap()
                .unwrap()
                .voice_session_id,
            "voice-session-1"
        );

        let question = fixture_question();
        let evaluation = AnswerEvaluation {
            question_id: question.question_id,
            answer_text: "NADH gives electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Source-backed correction.".to_owned(),
            retry_prompt: question.follow_up,
            source: question.source,
            concept_status: ConceptStatus::Strong,
            confidence_score: 0.84,
        };
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                evaluation,
            )
            .await
            .unwrap();

        let snapshot = store.snapshot();
        assert_eq!(snapshot.answer_attempts.len(), 1);
        let persisted = serde_json::to_string(&snapshot.answer_attempts).unwrap();
        assert!(persisted.contains("src-lecture-5-slide-18"));
        assert!(!persisted.contains("NADH gives electrons."));
        assert!(!persisted.contains("NADH donates high-energy electrons"));
    }

    #[tokio::test]
    async fn paste_ingestion_writes_bounded_server_owned_question_bank() {
        let store = InMemoryStudyStore::new();
        let source_sentences = [
            "Mitochondria electron transport builds a proton gradient across the inner membrane for ATP synthase.",
            "NADH transfers electrons through Complex I while oxygen accepts them at the end of the chain.",
            "Chemiosmosis couples proton flow to ATP production during oxidative phosphorylation.",
        ]
        .join(" ");
        let full_notes = format!("{source_sentences} {}", source_sentences.repeat(8));
        let record = store
            .create_paste_study_set(CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Bio paste".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: None,
                pasted_text: full_notes.clone(),
                session_id: Some("paste-session-1".to_owned()),
            })
            .await
            .expect("paste ingestion succeeds");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert_eq!(record.documents.len(), 1);
        assert!(record.source_spans.len() >= 2);
        assert!(record.source_spans.len() <= 4);
        for source in &record.source_spans {
            assert_reference_ready_source_span(source);
            assert_ne!(source.excerpt, full_notes);
        }
        let joined_excerpts = record
            .source_spans
            .iter()
            .map(|source| source.excerpt.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined_excerpts.contains("Mitochondria"));
        assert!(joined_excerpts.contains("ATP synthase"));
        assert!(joined_excerpts.contains("NADH") || joined_excerpts.contains("oxygen"));
        assert!(record.concepts.len() >= 3);
        assert_eq!(record.questions.len(), record.concepts.len());
        let mut question_ids = std::collections::HashSet::new();
        for concept in &record.concepts {
            assert!(record
                .source_spans
                .iter()
                .any(|source| source.id == concept.source_span_id));
            let question = record
                .questions
                .iter()
                .find(|question| question.question_id == format!("q-{}", concept.public_id))
                .expect("concept has a generated question");
            assert!(question_ids.insert(question.question_id.clone()));
            assert_ne!(question.question_id, "q-oxidative-phosphorylation-nadh");
            assert_eq!(question.source.source_id, concept.source_span_id);
            assert!(question
                .expected_terms
                .iter()
                .any(|term| term == &concept.label));
            assert!(question.prompt.contains(&concept.label));
            assert!(!question
                .prompt
                .to_ascii_lowercase()
                .contains("multiple choice"));
            assert!(!question.prompt.contains("A)"));
        }

        let snapshot_json = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!snapshot_json.contains(&full_notes));
        assert!(!snapshot_json.contains("NADH donates high-energy electrons"));
    }

    #[tokio::test]
    async fn paste_ingestion_generates_distinct_concept_question_sets_for_different_inputs() {
        let first = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Cell division".to_owned(),
            course: None,
            exam_date: None,
            pasted_text: "Mitosis spindle checkpoint holds chromatids until kinetochores attach. Cytokinesis pinches the membrane after sister chromatids separate.".to_owned(),
            session_id: Some("paste-session-cell".to_owned()),
        })
        .expect("first paste ingests");
        let second = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Plant energy".to_owned(),
            course: None,
            exam_date: None,
            pasted_text: "Photosynthesis chloroplast thylakoid membranes split water. Carbon fixation stores energy in glucose after light reactions.".to_owned(),
            session_id: Some("paste-session-plant".to_owned()),
        })
        .expect("second paste ingests");

        let first_concepts = first
            .concepts
            .iter()
            .map(|concept| concept.public_id.as_str())
            .collect::<Vec<_>>();
        let second_concepts = second
            .concepts
            .iter()
            .map(|concept| concept.public_id.as_str())
            .collect::<Vec<_>>();
        let first_questions = first
            .questions
            .iter()
            .map(|question| question.question_id.as_str())
            .collect::<Vec<_>>();
        let second_questions = second
            .questions
            .iter()
            .map(|question| question.question_id.as_str())
            .collect::<Vec<_>>();

        assert!(first_questions.len() >= 2);
        assert!(second_questions.len() >= 2);
        assert_ne!(first_concepts, second_concepts);
        assert_ne!(first_questions, second_questions);
        assert!(!first_questions
            .iter()
            .chain(second_questions.iter())
            .any(|question_id| *question_id == "q-oxidative-phosphorylation-nadh"));
    }

    #[tokio::test]
    async fn paste_ingestion_handles_short_notes_with_bounded_source_span() {
        let short_notes = "SN1 carbocation rearrangement competes with elimination.";
        let record = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Organic chemistry".to_owned(),
            course: None,
            exam_date: None,
            pasted_text: short_notes.to_owned(),
            session_id: Some("paste-session-short".to_owned()),
        })
        .expect("short paste ingests");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert_eq!(record.source_spans.len(), 1);
        assert_reference_ready_source_span(&record.source_spans[0]);
        assert!(record.source_spans[0].excerpt.contains("carbocation"));
        assert_ne!(record.source_spans[0].excerpt, short_notes);
        assert!(!serde_json::to_string(&record)
            .unwrap()
            .contains(short_notes));
        assert_eq!(record.source_spans[0].confidence, SourceConfidence::Medium);
        assert!(record.source_spans[0]
            .retrieval_reason
            .contains("short paste"));
        assert!(!record.questions[0]
            .expected_terms
            .iter()
            .any(|term| term == "Elimination"));
        assert_eq!(
            record.questions[0].source.source_id,
            record.source_spans[0].id
        );
    }

    #[tokio::test]
    async fn paste_ingestion_keeps_question_source_on_primary_concept_span() {
        let record = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Mixed paste".to_owned(),
            course: None,
            exam_date: None,
            pasted_text: "Cell wall. Mitochondria transport proteins.".to_owned(),
            session_id: Some("paste-session-source".to_owned()),
        })
        .expect("mixed paste ingests");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert!(record.questions[0].prompt.contains("Mitochondria"));
        assert!(record.questions[0].source.excerpt.contains("Mitochondria"));
        assert!(!record.questions[0].source.excerpt.contains("Cell wall"));
    }

    #[tokio::test]
    async fn paste_ingestion_does_not_reconstruct_compact_multi_sentence_paste() {
        let compact_notes = [
            "Mitosis spindle checkpoint holds chromatids until kinetochores attach.",
            "Cytokinesis pinches the membrane after sister chromatids separate.",
            "Cyclin degradation helps mitotic exit and resets the cell cycle.",
        ]
        .join(" ");
        let record = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Cell division".to_owned(),
            course: None,
            exam_date: None,
            pasted_text: compact_notes.clone(),
            session_id: Some("paste-session-compact".to_owned()),
        })
        .expect("compact paste ingests");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert!(record.source_spans.len() >= 2);
        let reconstructed = record
            .source_spans
            .iter()
            .map(|source| source.excerpt.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert_ne!(reconstructed, compact_notes);
        assert!(!serde_json::to_string(&record)
            .unwrap()
            .contains(&compact_notes));
    }

    #[tokio::test]
    async fn paste_ingestion_preserves_inequality_notes_when_stripping_markup() {
        let record = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Clinical thresholds".to_owned(),
            course: None,
            exam_date: None,
            pasted_text:
                "LDL < 100 reduces cardiovascular risk. Potassium K+ > 5.0 can indicate hyperkalemia."
                    .to_owned(),
            session_id: Some("paste-session-inequality".to_owned()),
        })
        .expect("inequality paste ingests");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        let joined_excerpts = record
            .source_spans
            .iter()
            .map(|source| source.excerpt.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined_excerpts.contains("LDL < 100"));
        assert!(joined_excerpts.contains("K+ > 5.0"));
    }

    #[tokio::test]
    async fn paste_ingestion_marks_ambiguous_notes_low_confidence() {
        let record = generate_paste_study_set(CreatePasteStudySet {
            user_id: "user-1".to_owned(),
            title: "Ambiguous metabolism note".to_owned(),
            course: None,
            exam_date: None,
            pasted_text: "Maybe Krebs cycle? not sure. NADH unclear; ask professor later."
                .to_owned(),
            session_id: Some("paste-session-ambiguous".to_owned()),
        })
        .expect("ambiguous paste ingests with low confidence");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert_eq!(record.source_spans.len(), 1);
        assert_reference_ready_source_span(&record.source_spans[0]);
        assert_eq!(record.source_spans[0].confidence, SourceConfidence::Low);
        assert!(record.source_spans[0]
            .retrieval_reason
            .contains("ambiguous"));
        assert!(record.source_spans[0].excerpt.contains("Krebs"));
        assert!(!record.questions[0].prompt.contains("Maybe"));
    }

    #[tokio::test]
    async fn paste_ingestion_fails_without_usable_source_spans() {
        let store = InMemoryStudyStore::new();
        let unusable_notes = "!!! ??? ... ---";
        let record = store
            .create_paste_study_set(CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Empty paste".to_owned(),
                course: None,
                exam_date: None,
                pasted_text: unusable_notes.to_owned(),
                session_id: Some("paste-session-empty".to_owned()),
            })
            .await
            .expect("unusable paste returns a failed record");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Failed
        );
        assert!(record
            .study_set
            .ingestion_error
            .as_deref()
            .unwrap_or_default()
            .contains("usable source span"));
        assert_eq!(
            record.documents[0].processing_status,
            StudySetIngestionStatus::Failed
        );
        assert!(record.source_spans.is_empty());
        assert!(record.concepts.is_empty());
        assert!(record.questions.is_empty());
        assert!(store
            .active_question("user-1", &record.study_set.id)
            .await
            .unwrap()
            .is_none());

        let snapshot_json = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!snapshot_json.contains(unusable_notes));
    }

    #[tokio::test]
    async fn file_ingestion_writes_document_level_spans_without_exact_region_provenance() {
        let store = InMemoryStudyStore::new();
        let file_text = [
            "Mitochondria electron transport builds a proton gradient across the inner membrane.",
            "NADH transfers electrons while oxygen accepts them at the end of the chain.",
            "ATP synthase uses chemiosmosis to make ATP from ADP.",
        ]
        .join("\n");

        let record = store
            .create_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Bio notes".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: None,
                file_name: "Lecture 9.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: file_text.as_bytes().to_vec(),
                session_id: Some("file-session-1".to_owned()),
            })
            .await
            .expect("file ingestion succeeds");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert_eq!(record.documents[0].display_name, "Lecture 9.txt");
        assert_eq!(record.documents[0].source_kind, "file");
        assert!(!record.source_spans.is_empty());
        for source in &record.source_spans {
            assert!(locator_span(source).starts_with("document:chars:"));
            assert!(source.locator.get("page").is_none());
            assert!(source.locator.get("bbox").is_none());
            assert!(!source.excerpt.is_empty());
            assert!(source.excerpt.chars().count() <= MAX_PASTE_SOURCE_EXCERPT_CHARS);
            assert_ne!(source.excerpt, file_text);
            assert!(source
                .retrieval_reason
                .contains("server-owned file ingestion"));
        }
        assert!(!record.concepts.is_empty());
        assert_eq!(record.questions.len(), record.concepts.len());
        assert!(store
            .active_question("user-1", &record.study_set.id)
            .await
            .unwrap()
            .is_some());

        let snapshot_json = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!snapshot_json.contains(&file_text));
    }

    #[tokio::test]
    async fn file_ingested_study_set_flows_through_authorized_tools() {
        let store = Arc::new(InMemoryStudyStore::new());
        let file_text = [
            "Electron transport in mitochondria transfers electrons from NADH to oxygen.",
            "The proton gradient powers ATP synthase during oxidative phosphorylation.",
        ]
        .join("\n");

        let record = store
            .create_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Tool Flow notes".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: None,
                file_name: "notes.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: file_text.as_bytes().to_vec(),
                session_id: Some("file-session-tool-flow".to_owned()),
            })
            .await
            .expect("file ingestion succeeds");
        let voice_session_id = "voice-session-file-flow";
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(voice_session_id)),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some(record.study_set.id.clone()),
                mode: Some(StudyMode::Quiz),
                active_concepts: record
                    .concepts
                    .iter()
                    .map(|concept| concept.public_id.clone())
                    .collect(),
                ..SessionConfig::default()
            })
            .await
            .unwrap();
        let active_question = store
            .active_question("user-1", &record.study_set.id)
            .await
            .unwrap()
            .expect("file-generated active question");
        let concept_id = record
            .concepts
            .first()
            .expect("file-generated concept")
            .public_id
            .clone();
        assert!(active_question.source.span.starts_with("document:chars:"));

        let canonical_source = store
            .source_reference(
                "user-1",
                &record.study_set.id,
                &active_question.source.source_id,
            )
            .await
            .unwrap()
            .expect("file-generated source reference");
        assert_eq!(canonical_source.document_id, record.documents[0].id);
        assert!(canonical_source.span.starts_with("document:chars:"));

        let concept_status = store
            .record_concept_status(
                "user-1",
                &record.study_set.id,
                voice_session_id,
                "response-file-2",
                &concept_id,
                ConceptStatus::Shaky,
            )
            .await
            .unwrap();
        assert_eq!(concept_status, ConceptStatus::Shaky);

        let snapshot = store.snapshot();
        assert!(snapshot.concept_statuses.iter().any(|status| {
            status.study_set_id == record.study_set.id
                && status.voice_session_id == voice_session_id
                && status.concept_id == concept_id
                && status.status == ConceptStatus::Shaky
        }));
    }

    #[tokio::test]
    async fn failed_file_ingestion_blocks_questions_until_retry_succeeds() {
        let store = InMemoryStudyStore::new();
        let failed = store
            .create_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Bad upload".to_owned(),
                course: None,
                exam_date: None,
                file_name: "empty.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: b"!!! ??? ---".to_vec(),
                session_id: Some("file-session-failed".to_owned()),
            })
            .await
            .expect("unusable file returns failed record");
        assert_eq!(
            failed.study_set.ingestion_status,
            StudySetIngestionStatus::Failed
        );
        assert!(failed.questions.is_empty());
        assert!(store
            .active_question("user-1", &failed.study_set.id)
            .await
            .unwrap()
            .is_none());

        let retry_failed = store
            .retry_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: Some(failed.study_set.id.clone()),
                title: "Bad upload".to_owned(),
                course: None,
                exam_date: None,
                file_name: "still-empty.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: b"??? --- !!!".to_vec(),
                session_id: Some("file-session-retry-failed".to_owned()),
            })
            .await
            .expect("unusable retry returns retry state");
        assert_eq!(
            retry_failed.study_set.ingestion_status,
            StudySetIngestionStatus::Retry
        );
        assert!(retry_failed.questions.is_empty());

        let retry_text =
            "Photosynthesis chloroplast thylakoid membranes split water. Carbon fixation stores energy in glucose after light reactions.";
        let ready = store
            .retry_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: Some(failed.study_set.id.clone()),
                title: "Bad upload".to_owned(),
                course: None,
                exam_date: None,
                file_name: "replacement.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: retry_text.as_bytes().to_vec(),
                session_id: Some("file-session-retry".to_owned()),
            })
            .await
            .expect("retry succeeds");

        assert_eq!(ready.study_set.id, failed.study_set.id);
        assert_eq!(
            ready.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert!(!ready.questions.is_empty());
        assert!(store
            .active_question("user-1", &ready.study_set.id)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn tool_executor_selects_generated_question_per_authorized_study_set() {
        let store = Arc::new(InMemoryStudyStore::new());
        let first = store
            .create_paste_study_set(CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Cell division".to_owned(),
                course: None,
                exam_date: None,
                pasted_text: "mitosis chromosome spindle metaphase cytokinesis".to_owned(),
                session_id: Some("session-a".to_owned()),
            })
            .await
            .expect("first paste ingests");
        let second = store
            .create_paste_study_set(CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Plant energy".to_owned(),
                course: None,
                exam_date: None,
                pasted_text: "photosynthesis chloroplast thylakoid carbon fixation".to_owned(),
                session_id: Some("session-b".to_owned()),
            })
            .await
            .expect("second paste ingests");
        for record in [&first, &second] {
            // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
            // truth is asserted.
            let _outcome = store
                .record_voice_session(&SessionConfig {
                    session_id: Some(SessionId::new(record.session_id.clone())),
                    user_id: Some(record.study_set.user_id.clone()),
                    study_set_id: Some(record.study_set.id.clone()),
                    mode: Some(StudyMode::Quiz),
                    ..SessionConfig::default()
                })
                .await
                .expect("records paste voice session");
        }

        let first_question = store
            .active_question("user-1", &first.study_set.id)
            .await
            .expect("first active question read")
            .expect("selects first generated question");
        let second_question = store
            .active_question("user-1", &second.study_set.id)
            .await
            .expect("second active question read")
            .expect("selects second generated question");

        assert_ne!(
            first_question.question_id,
            "q-oxidative-phosphorylation-nadh"
        );
        assert_ne!(
            second_question.question_id,
            "q-oxidative-phosphorylation-nadh"
        );
        assert_ne!(first_question.question_id, second_question.question_id);
        assert_ne!(first_question.source.source_id, "src-lecture-5-slide-18");

        store
            .record_answer_evaluation(
                "user-1",
                &first.study_set.id,
                &first.session_id,
                "response-1",
                AnswerEvaluation {
                    question_id: first_question.question_id.clone(),
                    answer_text: "mitosis chromosome spindle".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Grounded in the first study set.".to_owned(),
                    retry_prompt: first_question.follow_up.clone(),
                    source: first_question.source.clone(),
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.8,
                },
            )
            .await
            .expect("first generated answer records");

        // The second set's question and source belong to a different study set, so
        // the first session may not evaluate against them and may not write.
        let baseline_writes = store.write_counts();
        let wrong_set = store
            .record_answer_evaluation(
                "user-1",
                &first.study_set.id,
                &first.session_id,
                "response-2",
                AnswerEvaluation {
                    question_id: second_question.question_id.clone(),
                    answer_text: "photosynthesis chloroplast".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Wrong study set.".to_owned(),
                    retry_prompt: second_question.follow_up.clone(),
                    source: second_question.source.clone(),
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.8,
                },
            )
            .await;

        assert!(wrong_set.is_err());
        assert_eq!(store.write_counts(), baseline_writes);
    }

    #[tokio::test]
    async fn rejects_forged_answer_evaluation_source_tuple() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let question = fixture_question();
        let mut forged_source = question.source;
        forged_source.excerpt = "invented source text".to_owned();
        let evaluation = AnswerEvaluation {
            question_id: question.question_id,
            answer_text: "NADH gives electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Forged correction.".to_owned(),
            retry_prompt: question.follow_up,
            source: forged_source,
            concept_status: ConceptStatus::Strong,
            confidence_score: 0.84,
        };

        let result = store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                evaluation,
            )
            .await;

        assert!(result.is_err());
        assert!(store.snapshot().answer_attempts.is_empty());
    }

    #[tokio::test]
    async fn rejects_each_forged_answer_source_field() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let question = fixture_question();

        for forged_source in [
            {
                let mut source = question.source.clone();
                source.document_id = "wrong-doc".to_owned();
                source
            },
            {
                let mut source = question.source.clone();
                source.span = "slide:99".to_owned();
                source
            },
            {
                let mut source = question.source.clone();
                source.confidence = SourceConfidence::Low;
                source
            },
            {
                let mut source = question.source.clone();
                source.retrieval_reason = "browser supplied reason".to_owned();
                source
            },
        ] {
            let evaluation = AnswerEvaluation {
                question_id: question.question_id.clone(),
                answer_text: "NADH gives electrons.".to_owned(),
                label: "mostly correct".to_owned(),
                concise_feedback: "Forged correction.".to_owned(),
                retry_prompt: question.follow_up.clone(),
                source: forged_source,
                concept_status: ConceptStatus::Strong,
                confidence_score: 0.84,
            };

            assert!(store
                .record_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    evaluation
                )
                .await
                .is_err());
        }
        assert!(store.snapshot().answer_attempts.is_empty());
    }

    #[tokio::test]
    async fn rejects_answer_evaluation_source_from_wrong_active_question() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let other_question = add_second_active_question_with_source(&store);
        let question = fixture_question();
        let evaluation = AnswerEvaluation {
            question_id: question.question_id,
            answer_text: "NADH gives electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Wrong source for this question.".to_owned(),
            retry_prompt: question.follow_up,
            source: other_question.source,
            concept_status: ConceptStatus::Strong,
            confidence_score: 0.84,
        };

        let result = store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                evaluation,
            )
            .await;

        assert!(result.is_err());
        assert!(store.snapshot().answer_attempts.is_empty());
    }

    #[tokio::test]
    async fn rejects_writes_after_voice_session_is_closed() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        store
            .close_voice_session("voice-session-1", "client_stop")
            .await
            .unwrap();
        let question = fixture_question();

        assert!(store
            .record_voice_session(&fixture_session_config())
            .await
            .is_err());
        assert!(store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                AnswerEvaluation {
                    question_id: question.question_id.clone(),
                    answer_text: "NADH gives electrons.".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Closed session.".to_owned(),
                    retry_prompt: question.follow_up.clone(),
                    source: question.source.clone(),
                    concept_status: ConceptStatus::Strong,
                    confidence_score: 0.84,
                },
            )
            .await
            .is_err());
        assert!(store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .is_err());
        assert!(store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "atp-synthase",
                "2026-06-16T09:00:00Z",
            )
            .await
            .is_err());
        assert!(store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                StudySessionRecap {
                    schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Closed".to_owned(),
                    summary: "Closed session recap.".to_owned(),
                    concepts: vec![RecapConceptOutcome {
                        concept_id: "nadh".to_owned(),
                        label: "NADH".to_owned(),
                        status: ConceptStatus::Strong,
                    }],
                    review_schedule: vec![],
                    next_action: "Stop".to_owned(),
                    source_moments: vec![RecapSourceMoment {
                        response_id: "response-0".to_owned(),
                        source_id: fixture_source_reference().source_id,
                    }],
                    deferred_turns: 0,
                },
            )
            .await
            .is_err());

        let snapshot = store.snapshot();
        assert!(snapshot.answer_attempts.is_empty());
        assert!(snapshot.concept_statuses.is_empty());
        assert!(snapshot.review_items.is_empty());
        assert!(snapshot.recaps.is_empty());
    }

    #[tokio::test]
    async fn rejects_browser_event_payloads_that_do_not_match_recorded_payload_hash() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let question = fixture_question();
        let evaluation = AnswerEvaluation {
            question_id: question.question_id.clone(),
            answer_text: "NADH gives electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Connect this to the proton gradient.".to_owned(),
            retry_prompt: question.follow_up.clone(),
            source: question.source.clone(),
            concept_status: ConceptStatus::Strong,
            confidence_score: 0.84,
        };
        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                evaluation.clone(),
            )
            .await
            .unwrap();
        assert!(store
            .authorize_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-2",
                &evaluation,
            )
            .await
            .is_err());

        let mut forged_evaluation = evaluation.clone();
        forged_evaluation.concise_feedback = "Forged browser-only feedback.".to_owned();

        assert!(store
            .authorize_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                &forged_evaluation,
            )
            .await
            .is_err());

        let recap = StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            concepts: vec![
                RecapConceptOutcome {
                    concept_id: "nadh".to_owned(),
                    label: "NADH".to_owned(),
                    status: ConceptStatus::Strong,
                },
                RecapConceptOutcome {
                    concept_id: "atp-synthase".to_owned(),
                    label: "ATP synthase".to_owned(),
                    status: ConceptStatus::Shaky,
                },
            ],
            review_schedule: vec![ReviewScheduleSummary {
                concept_id: "atp-synthase".to_owned(),
                due_at: "2031-04-07T12:00:00.000Z".to_owned(),
                authority: ReviewScheduleAuthority::ServerPersistedFsrs,
            }],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-0".to_owned(),
                source_id: fixture_source_reference().source_id,
            }],
            deferred_turns: 0,
        };
        store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                recap.clone(),
            )
            .await
            .unwrap();
        assert!(store
            .authorize_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                &recap
            )
            .await
            .is_err());

        let mut forged_recap = recap.clone();
        forged_recap.summary = "Forged browser-only recap.".to_owned();

        assert!(store
            .authorize_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                &forged_recap
            )
            .await
            .is_err());

        let persisted = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!persisted.contains("NADH gives electrons"));
        assert!(!persisted.contains("Connect this to the proton gradient"));
        assert!(!persisted.contains("NADH source"));
        assert!(!persisted.contains("Forged browser-only"));
    }

    #[tokio::test]
    async fn authorizes_recap_event_from_recorded_write_after_later_recap_replacement() {
        let store = seeded_store();
        record_fixture_session(&store).await;

        let first_recap = StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "First recap".to_owned(),
            summary: "Initial recap.".to_owned(),
            concepts: vec![
                RecapConceptOutcome {
                    concept_id: "nadh".to_owned(),
                    label: "NADH".to_owned(),
                    status: ConceptStatus::Strong,
                },
                RecapConceptOutcome {
                    concept_id: "atp-synthase".to_owned(),
                    label: "ATP synthase".to_owned(),
                    status: ConceptStatus::Shaky,
                },
            ],
            review_schedule: vec![ReviewScheduleSummary {
                concept_id: "atp-synthase".to_owned(),
                due_at: "2031-04-07T12:00:00.000Z".to_owned(),
                authority: ReviewScheduleAuthority::ServerPersistedFsrs,
            }],
            next_action: "Review oxidative phosphorylation.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-a".to_owned(),
                source_id: fixture_source_reference().source_id,
            }],
            deferred_turns: 0,
        };
        let second_recap = StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Second recap".to_owned(),
            summary: "Replacement recap.".to_owned(),
            concepts: vec![
                RecapConceptOutcome {
                    concept_id: "atp-synthase".to_owned(),
                    label: "ATP synthase".to_owned(),
                    status: ConceptStatus::Strong,
                },
                RecapConceptOutcome {
                    concept_id: "nadh".to_owned(),
                    label: "NADH".to_owned(),
                    status: ConceptStatus::Shaky,
                },
            ],
            review_schedule: vec![],
            next_action: "Compare electron transport steps.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-b".to_owned(),
                source_id: fixture_source_reference().source_id,
            }],
            deferred_turns: 0,
        };

        store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-a",
                first_recap.clone(),
            )
            .await
            .unwrap();
        store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-b",
                second_recap.clone(),
            )
            .await
            .unwrap();

        store
            .authorize_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-a",
                &first_recap,
            )
            .await
            .unwrap();
        assert!(store
            .authorize_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-b",
                &first_recap,
            )
            .await
            .is_err());
        store
            .authorize_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-b",
                &second_recap,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn authorizes_concept_event_from_recorded_write_after_later_status_change() {
        let store = seeded_store();
        record_fixture_session(&store).await;

        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                ConceptStatus::Review,
            )
            .await
            .unwrap();
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-2",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .unwrap();

        store
            .authorize_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                &ConceptStatus::Review,
            )
            .await
            .unwrap();
        assert!(store
            .authorize_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-2",
                "nadh",
                &ConceptStatus::Review,
            )
            .await
            .is_err());
    }

    /// `DATA-005`: the in-memory authorization ledger is a set, not a log.
    ///
    /// Authorization is only ever consulted by membership, so an identical replay
    /// carries no new information — but a `Vec` still grew by one entry per
    /// replay, which is an unbounded process-local allocation driven by a remote
    /// caller. The bound is structural: identical records deduplicate.
    #[tokio::test]
    async fn memory_authorization_replay_is_deduplicated_and_bounded() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let question = store
            .active_question("user-1", "biology-midterm")
            .await
            .expect("active question read")
            .expect("seeded active question");
        let evaluation = fixture_evaluation(&question);
        let recap = fixture_recap();

        for _ in 0..16 {
            store
                .record_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    evaluation.clone(),
                )
                .await
                .expect("evaluation replay is accepted");
            store
                .record_concept_status(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    "nadh",
                    ConceptStatus::Strong,
                )
                .await
                .expect("concept status replay is accepted");
            store
                .record_recap(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    recap.clone(),
                )
                .await
                .expect("recap replay is accepted");
        }

        // Three distinct authorized events, sixteen replays each.
        assert_eq!(store.snapshot().event_authorizations.len(), 3);

        // Deduplication must not weaken live authorization.
        store
            .authorize_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                &evaluation,
            )
            .await
            .expect("the deduplicated record still authorizes its own event");
        store
            .authorize_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                &ConceptStatus::Strong,
            )
            .await
            .expect("the deduplicated record still authorizes its own event");
        store
            .authorize_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                &recap,
            )
            .await
            .expect("the deduplicated record still authorizes its own event");

        // A one-field change is still refused.
        let mut forged = evaluation.clone();
        forged.label = "wrong".to_owned();
        let error = store
            .authorize_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                &forged,
            )
            .await
            .expect_err("a changed payload is not authorized");
        assert_eq!(error.kind(), PortErrorKind::Conflict);
    }

    #[tokio::test]
    async fn close_voice_session_evicts_event_authorizations() {
        let store = seeded_store();
        record_fixture_session(&store).await;

        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .unwrap();
        assert_eq!(store.snapshot().event_authorizations.len(), 1);

        store
            .close_voice_session("voice-session-1", "client_stop")
            .await
            .unwrap();

        assert!(store.snapshot().event_authorizations.is_empty());
    }

    #[tokio::test]
    async fn rejects_wrong_study_set_and_forged_recap_source() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        let question = fixture_question();
        let evaluation = AnswerEvaluation {
            question_id: question.question_id.clone(),
            answer_text: "NADH gives electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Wrong set.".to_owned(),
            retry_prompt: question.follow_up.clone(),
            source: question.source.clone(),
            concept_status: ConceptStatus::Strong,
            confidence_score: 0.84,
        };

        assert!(store
            .record_answer_evaluation(
                "user-1",
                "wrong-set",
                "voice-session-1",
                "response-1",
                evaluation
            )
            .await
            .is_err());

        let mismatched_session_recap = StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-2".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            concepts: vec![RecapConceptOutcome {
                concept_id: "nadh".to_owned(),
                label: "NADH".to_owned(),
                status: ConceptStatus::Strong,
            }],
            review_schedule: vec![],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-0".to_owned(),
                source_id: fixture_source_reference().source_id,
            }],
            deferred_turns: 0,
        };
        assert!(store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                mismatched_session_recap,
            )
            .await
            .is_err());

        // The v2 recap moment carries only a source id, so a forged moment is a
        // source id this user and study set do not own.
        let recap = StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            concepts: vec![RecapConceptOutcome {
                concept_id: "nadh".to_owned(),
                label: "NADH".to_owned(),
                status: ConceptStatus::Strong,
            }],
            review_schedule: vec![],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![RecapSourceMoment {
                response_id: "response-0".to_owned(),
                source_id: "src-not-owned-by-this-study-set".to_owned(),
            }],
            deferred_turns: 0,
        };

        assert!(store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                recap
            )
            .await
            .is_err());
        assert!(store.snapshot().recaps.is_empty());
    }

    #[tokio::test]
    async fn records_concept_status_review_item_and_recap() {
        let store = seeded_store();
        record_fixture_session(&store).await;
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                ConceptStatus::Strong,
            )
            .await
            .unwrap();
        store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "atp-synthase",
                "2026-06-16T09:00:00Z",
            )
            .await
            .unwrap();
        store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                StudySessionRecap {
                    schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Done".to_owned(),
                    summary: "Recap".to_owned(),
                    concepts: vec![
                        RecapConceptOutcome {
                            concept_id: "nadh".to_owned(),
                            label: "NADH".to_owned(),
                            status: ConceptStatus::Strong,
                        },
                        RecapConceptOutcome {
                            concept_id: "atp-synthase".to_owned(),
                            label: "ATP synthase".to_owned(),
                            status: ConceptStatus::Shaky,
                        },
                    ],
                    review_schedule: vec![ReviewScheduleSummary {
                        concept_id: "atp-synthase".to_owned(),
                        due_at: "2031-04-07T12:00:00.000Z".to_owned(),
                        authority: ReviewScheduleAuthority::ServerPersistedFsrs,
                    }],
                    next_action: "Review tomorrow".to_owned(),
                    source_moments: vec![RecapSourceMoment {
                        response_id: "response-0".to_owned(),
                        source_id: fixture_source_reference().source_id,
                    }],
                    deferred_turns: 0,
                },
            )
            .await
            .unwrap();

        let snapshot = store.snapshot();
        assert_eq!(snapshot.concept_statuses.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.recaps.len(), 1);
        let persisted = serde_json::to_string(&snapshot.recaps).unwrap();
        assert!(persisted.contains("src-lecture-5-slide-18"));
        assert!(!persisted.contains("NADH source"));
        assert!(!persisted.contains("NADH donates high-energy electrons"));
    }

    #[tokio::test]
    async fn every_authorized_store_write_lands_exactly_once_for_one_session() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;
        let question = store
            .active_question("user-1", "biology-midterm")
            .await
            .unwrap()
            .expect("seeded active question");
        assert_eq!(question.source.source_id, "src-lecture-5-slide-18");

        store
            .record_answer_evaluation(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                fixture_evaluation(&question),
            )
            .await
            .unwrap();
        assert!(store
            .source_reference("user-1", "biology-midterm", "src-lecture-5-slide-18")
            .await
            .unwrap()
            .is_some());
        store
            .record_concept_status(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "oxidative-phosphorylation",
                ConceptStatus::Strong,
            )
            .await
            .unwrap();
        store
            .schedule_review_item(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "atp-synthase",
                "2031-04-07T12:00:00.000Z",
            )
            .await
            .unwrap();
        store
            .record_recap(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-0",
                fixture_recap(),
            )
            .await
            .unwrap();

        let snapshot = store.snapshot();
        assert_eq!(snapshot.answer_attempts.len(), 1);
        assert_eq!(snapshot.concept_statuses.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.recaps.len(), 1);
    }

    #[tokio::test]
    async fn replaying_every_authorized_store_write_keeps_counts_exact() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;
        let question = store
            .active_question("user-1", "biology-midterm")
            .await
            .unwrap()
            .expect("seeded active question");

        for _ in 0..2 {
            store
                .record_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    fixture_evaluation(&question),
                )
                .await
                .unwrap();
            store
                .record_concept_status(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    "oxidative-phosphorylation",
                    ConceptStatus::Strong,
                )
                .await
                .unwrap();
            store
                .schedule_review_item(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "atp-synthase",
                    "2031-04-07T12:00:00.000Z",
                )
                .await
                .unwrap();
            store
                .record_recap(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-0",
                    fixture_recap(),
                )
                .await
                .unwrap();
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.answer_attempts.len(), 1);
        assert_eq!(snapshot.concept_statuses.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.recaps.len(), 1);
    }

    #[tokio::test]
    async fn store_rejects_wrong_study_set_and_forged_source_tuple() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;

        // A study set this session is not bound to yields no question at all: the
        // store refuses rather than answering with someone else's question.
        assert!(store.active_question("user-1", "wrong-set").await.is_err());

        let mut forged_source = fixture_source_reference();
        forged_source.excerpt = "forged excerpt".to_owned();
        assert!(store
            .authorize_source_reference(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                &forged_source,
            )
            .await
            .is_err());
    }

    // ------------------------------------------------------------------
    // Task 7 (`DATA-012`)
    //
    // Every in-memory check-and-mutate path has to hold one state write lock
    // across its validation and its mutation. The tests below arm the
    // deterministic pause between the two halves, run the racing operation, and
    // assert the *final committed state* — a validate-then-mutate method lets
    // the racer finish inside the gap and then writes on top of it.
    // ------------------------------------------------------------------

    /// Runs `wait_until_paused` off the async runtime: it blocks a thread, and the
    /// mutation it waits for is blocking a worker thread of its own.
    async fn await_pause(handle: MutationPauseHandle) -> MutationPauseHandle {
        tokio::task::spawn_blocking(move || {
            handle.wait_until_paused();
            handle
        })
        .await
        .expect("pause waiter joins")
    }

    fn fixture_usage_record(voice_session_id: Option<&str>) -> agent_domain::VoiceUsageRecord {
        agent_domain::VoiceUsageRecord {
            voice_session_id: voice_session_id.map(ToOwned::to_owned),
            provider: "synthetic".to_owned(),
            model: "synthetic-viva".to_owned(),
            duration_seconds: 2,
            text_input_tokens: 20,
            text_output_tokens: 10,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
            cost_estimate_usd: 0.000_02,
            first_audio_latency_ms: None,
            answer_eval_latency_ms: Some(1),
            source_retrieval_latency_ms: None,
            source_grounded_correction_count: 1,
        }
    }

    /// One evaluated turn for the seeded fixture's own question and concepts.
    fn fixture_turn_outcome(response_id: &str) -> TurnOutcome {
        let question = fixture_question();
        let criterion_id = question.rubric.criteria[0].criterion_id.clone();
        TurnOutcome {
            schema: VIVA_TURN_OUTCOME_SCHEMA.to_owned(),
            response_id: response_id.to_owned(),
            question_id: question.question_id.clone(),
            rubric_policy_version: question.rubric.policy_version.clone(),
            recorded_at: "2031-04-05T12:00:00.000Z".to_owned(),
            source_ids: vec![question.source.source_id.clone()],
            supersedes_response_id: None,
            resolution: TurnResolution::Evaluated {
                label: agent_domain::EvaluationLabel::MostlyCorrect,
                confidence: 0.84,
                assessments: vec![agent_domain::CriterionAssessment {
                    criterion_id: criterion_id.clone(),
                    assessment: agent_domain::CriterionAssessmentKind::Satisfied,
                    confidence: 0.84,
                }],
                concept_transitions: vec![ConceptStatusTransition {
                    concept_id: "oxidative-phosphorylation".to_owned(),
                    from_status: ConceptStatus::Shaky,
                    to_status: ConceptStatus::Strong,
                    criterion_ids: vec![criterion_id],
                }],
                concise_feedback: "Grounded in the seeded source.".to_owned(),
                retry_prompt: None,
                disposition: QuestionDisposition::Advance,
            },
        }
    }

    /// A session write that validated while the session was open must not resurrect
    /// it after a close that committed in between.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn memory_close_and_session_replay_cannot_reopen_closed_session() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;

        let pause = store.pause_at(MutationSite::VoiceSession);
        let replay_store = Arc::clone(&store);
        let replay = tokio::spawn(async move {
            replay_store
                .record_voice_session(&fixture_session_config())
                .await
        });
        let pause = await_pause(pause).await;

        let close_store = Arc::clone(&store);
        let close = tokio::spawn(async move {
            close_store
                .close_voice_session("voice-session-1", "completed")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        pause.release();

        let replayed = replay
            .await
            .expect("session replay joins")
            .expect("replaying an open session succeeds");
        let closed = close
            .await
            .expect("close joins")
            .expect("closing the session succeeds");

        assert_eq!(replayed, StudyStoreWriteOutcome::IdempotentReplay);
        assert_eq!(closed["status"], "closed");

        let state = store.snapshot();
        let session = state
            .sessions
            .iter()
            .find(|session| session.voice_session_id == "voice-session-1")
            .expect("the fixture session row still exists");
        assert_eq!(
            session.status, "closed",
            "a replayed session write must never reopen a closed session"
        );
        assert_eq!(session.terminal_reason.as_deref(), Some("completed"));
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(store.write_counts().sessions, 1);
    }

    /// An evaluation that validated before a deletion must not append after it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn memory_delete_and_answer_evaluation_cannot_leave_late_artifact() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;

        let pause = store.pause_at(MutationSite::AnswerEvaluation);
        let evaluation_store = Arc::clone(&store);
        let evaluation = fixture_evaluation(&fixture_question());
        let write = tokio::spawn(async move {
            evaluation_store
                .record_answer_evaluation(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-race",
                    evaluation,
                )
                .await
        });
        let pause = await_pause(pause).await;

        let delete_store = Arc::clone(&store);
        let delete = tokio::spawn(async move {
            delete_store
                .delete_study_set("user-1", "biology-midterm")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        pause.release();

        let _ = write.await.expect("evaluation joins");
        delete
            .await
            .expect("delete joins")
            .expect("study set deletion succeeds");

        let state = store.snapshot();
        assert!(
            state.answer_attempts.is_empty(),
            "deletion must not be followed by a late answer attempt: {:?}",
            state.answer_attempts
        );
        assert!(
            state.event_authorizations.is_empty(),
            "deletion must not be followed by a late authorization digest"
        );
        assert_eq!(store.write_counts().answer_attempts, 0);
    }

    /// The same race for Plan 04's canonical outcome, its transitions, its
    /// progression cursor, its schedule, and its digests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn memory_delete_and_turn_outcome_cannot_leave_late_artifact() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;

        let pause = store.pause_at(MutationSite::TurnOutcome);
        let outcome_store = Arc::clone(&store);
        let write = tokio::spawn(async move {
            outcome_store
                .record_turn_outcome(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    fixture_turn_outcome("response-race"),
                )
                .await
        });
        let pause = await_pause(pause).await;

        let delete_store = Arc::clone(&store);
        let delete = tokio::spawn(async move {
            delete_store
                .delete_study_set("user-1", "biology-midterm")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        pause.release();

        let _ = write.await.expect("turn outcome joins");
        delete
            .await
            .expect("delete joins")
            .expect("study set deletion succeeds");

        let state = store.snapshot();
        assert!(
            state.turn_outcomes.is_empty(),
            "deletion must not be followed by a late turn outcome"
        );
        assert!(
            state.question_progressions.is_empty(),
            "deletion must not be followed by a late progression cursor"
        );
        assert!(
            state.review_schedule_decisions.is_empty(),
            "deletion must not be followed by a late review schedule decision"
        );
        assert!(
            state.event_authorizations.is_empty(),
            "deletion must not be followed by a late authorization digest"
        );
    }

    /// `DATA-010` for this backend: usage and session deletion serialize, and the
    /// order that ends deleted ends with no usage record.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn memory_voice_usage_and_session_delete_serialize_to_no_usage_record() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;

        let pause = store.pause_at(MutationSite::VoiceUsage);
        let usage_store = Arc::clone(&store);
        let usage = tokio::spawn(async move {
            usage_store
                .record_voice_usage(fixture_usage_record(Some("voice-session-1")))
                .await
        });
        let pause = await_pause(pause).await;

        let delete_store = Arc::clone(&store);
        let delete = tokio::spawn(async move {
            delete_store
                .delete_session_history("user-1", "biology-midterm", "voice-session-1")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        pause.release();

        let _ = usage.await.expect("usage joins");
        delete
            .await
            .expect("delete joins")
            .expect("session history deletion succeeds");

        assert_eq!(
            store.write_counts().voice_usage,
            0,
            "a deleted session must end with no usage record"
        );

        // The other serial order: usage that arrives after the deletion is a
        // typed conflict, not a silent success.
        let late = store
            .record_voice_usage(fixture_usage_record(Some("voice-session-1")))
            .await
            .expect_err("usage for a deleted session is refused");
        assert_eq!(late.kind(), PortErrorKind::Conflict);
        assert_eq!(store.write_counts().voice_usage, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn memory_voice_usage_and_study_delete_serialize_to_no_usage_record() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;

        let pause = store.pause_at(MutationSite::VoiceUsage);
        let usage_store = Arc::clone(&store);
        let usage = tokio::spawn(async move {
            usage_store
                .record_voice_usage(fixture_usage_record(Some("voice-session-1")))
                .await
        });
        let pause = await_pause(pause).await;

        let delete_store = Arc::clone(&store);
        let delete = tokio::spawn(async move {
            delete_store
                .delete_study_set("user-1", "biology-midterm")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        pause.release();

        let _ = usage.await.expect("usage joins");
        delete
            .await
            .expect("delete joins")
            .expect("study set deletion succeeds");

        assert_eq!(
            store.write_counts().voice_usage,
            0,
            "a deleted study set must end with no usage record"
        );

        let late = store
            .record_voice_usage(fixture_usage_record(Some("voice-session-1")))
            .await
            .expect_err("usage after study set deletion is refused");
        assert_eq!(late.kind(), PortErrorKind::Conflict);
        assert_eq!(store.write_counts().voice_usage, 0);
    }

    /// Eight racers replaying byte-identical writes leave exactly one of each.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn memory_concurrent_identical_replays_keep_every_count_exact() {
        const RACERS: usize = 8;

        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;
        assert_eq!(
            store
                .record_voice_usage(fixture_usage_record(Some("voice-session-1")))
                .await
                .expect("usage is recorded by this backend"),
            StudyStoreWriteOutcome::Inserted
        );

        let barrier = Arc::new(tokio::sync::Barrier::new(RACERS));
        let mut handles = Vec::with_capacity(RACERS);
        for _ in 0..RACERS {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            handles.push(tokio::spawn(async move {
                barrier.wait().await;
                assert_eq!(
                    store
                        .record_voice_session(&fixture_session_config())
                        .await
                        .expect("session replay succeeds"),
                    StudyStoreWriteOutcome::IdempotentReplay
                );
                store
                    .record_answer_evaluation(
                        "user-1",
                        "biology-midterm",
                        "voice-session-1",
                        "response-replay",
                        fixture_evaluation(&fixture_question()),
                    )
                    .await
                    .expect("evaluation replay succeeds");
                store
                    .record_concept_status(
                        "user-1",
                        "biology-midterm",
                        "voice-session-1",
                        "response-replay",
                        "nadh",
                        ConceptStatus::Strong,
                    )
                    .await
                    .expect("concept status replay succeeds");
                store
                    .schedule_review_item(
                        "user-1",
                        "biology-midterm",
                        "voice-session-1",
                        "atp-synthase",
                        "2031-04-07T12:00:00.000Z",
                    )
                    .await
                    .expect("review item replay succeeds");
                store
                    .record_recap(
                        "user-1",
                        "biology-midterm",
                        "voice-session-1",
                        "response-replay",
                        fixture_recap(),
                    )
                    .await
                    .expect("recap replay succeeds");
                store
                    .record_turn_outcome(
                        "user-1",
                        "biology-midterm",
                        "voice-session-1",
                        fixture_turn_outcome("response-replay-outcome"),
                    )
                    .await
                    .expect("turn outcome replay succeeds");
            }));
        }
        for handle in handles {
            handle.await.expect("racer joins");
        }

        let counts = store.write_counts();
        assert_eq!(
            counts,
            StudyStoreWriteCounts {
                sessions: 1,
                answer_attempts: 1,
                // Two distinct concepts move exactly once each: the explicit
                // `nadh` call, and the graded transition on
                // `oxidative-phosphorylation` that the turn outcome now records
                // under `A-22`, so that turn's `concept_status` browser event is
                // backed by a durable write rather than a digest alone.
                concept_statuses: 2,
                // Two distinct concepts are scheduled exactly once each: the
                // explicit `atp-synthase` call, and the graded transition on
                // `oxidative-phosphorylation` that the turn outcome schedules
                // under D-01 `SERVER_PERSISTED_FSRS`.
                review_items: 2,
                recaps: 1,
                voice_usage: 1,
            }
        );

        let state = store.snapshot();
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.answer_attempts.len(), 1);
        assert_eq!(state.concept_statuses.len(), 2);
        assert_eq!(state.review_items.len(), 2);
        assert_eq!(state.review_schedule_decisions.len(), 1);
        assert_eq!(state.recaps.len(), 1);
        assert_eq!(state.turn_outcomes.len(), 1);
        assert_eq!(state.question_progressions.len(), 1);
        assert_eq!(state.voice_usage_events.len(), 1);
    }

    /// `A-22`: the six wire tokens a browser evaluation is authorized against,
    /// pinned arm by arm.
    ///
    /// The mapping is duplicated in
    /// `agent_adapters::cartesia_gemini::projection::evaluation_label_wire` with no
    /// compile-time link between the copies (see the hazard note on
    /// `learning::evaluation_label_wire`). Only two arms are exercised end to end
    /// by a fixture — `strong` in the frozen v5 replays, `mostly correct` in the
    /// shared conformance suite — so the other four were unpinned in either copy,
    /// and a rename of one of them would have surfaced only as a live session
    /// closing with `provider source authority rejected`.
    ///
    /// Three separate facts, because each fails differently:
    /// 1. the literal token of every arm, so a rename in this copy is a red test;
    /// 2. every token passes `AnswerEvaluation::validate_fail_closed`, the check
    ///    the event itself must survive — a token this store hashed but the domain
    ///    refuses could never be presented at all;
    /// 3. no two labels share a token, because the digest is the only thing
    ///    separating two differently graded turns of the same response identity.
    #[test]
    fn a22_evaluation_label_wire_pins_every_arm() {
        let mapping = [
            (EvaluationLabel::Strong, "strong"),
            (EvaluationLabel::MostlyCorrect, "mostly correct"),
            (EvaluationLabel::PartiallyCorrect, "partially correct"),
            (EvaluationLabel::Vague, "vague"),
            (EvaluationLabel::Wrong, "wrong"),
            (
                EvaluationLabel::InsufficientEvidence,
                "insufficient evidence",
            ),
        ];
        let presented = |label: &str| AnswerEvaluation {
            question_id: "q-1".to_owned(),
            answer_text: "the learner said something".to_owned(),
            label: label.to_owned(),
            concise_feedback: "feedback".to_owned(),
            retry_prompt: String::new(),
            source: fixture_source_reference(),
            concept_status: ConceptStatus::Shaky,
            confidence_score: 0.5,
        };
        for (label, token) in mapping {
            assert_eq!(
                super::learning::evaluation_label_wire(label),
                token,
                "the browser is shown `{token}` for {label:?}"
            );
            presented(token)
                .validate_fail_closed()
                .unwrap_or_else(|error| {
                    panic!("`{token}` must be a label the browser contract accepts: {error}")
                });
        }
        // The negative control: the same construction with a token outside the
        // rubric is refused for exactly the label reason, so the assertion above is
        // testing the label and not merely a well-formed struct.
        assert_eq!(
            presented("mostly_correct").validate_fail_closed(),
            Err("answer evaluation label is not in the typed rubric"),
            "the canonical serde token is not a browser token"
        );
        let tokens: std::collections::BTreeSet<&str> =
            mapping.iter().map(|(_, token)| *token).collect();
        assert_eq!(
            tokens.len(),
            mapping.len(),
            "two labels sharing a wire token would let one grade authorize the other's event"
        );
    }
}

#[cfg(test)]
mod review_schedule_decision_tests {
    use agent_domain::{
        decide_review_schedule, format_rfc3339_millis, parse_utc_instant, Clock, ConceptStatus,
        FsrsCardStateV1, ReviewOutcomeV1, ReviewScheduleCapReasonV1, ReviewScheduleDecisionV1,
        ReviewSchedulingContextV1, SessionConfig, SessionId, StudyMemoryStore, StudyMode,
        VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
    };
    use chrono::{DateTime, Duration, Utc};
    use std::sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    };

    use super::*;

    /// Literals copied from `packages/core/src/review-scheduling-conformance-v1.json`
    /// (`new-shaky-hinted-one-miss-no-exam`, `exam-closer-than-margin`,
    /// `exam-already-past-fail-closed`).
    const GRADED_AT: &str = "2031-04-05T12:00:00.000Z";
    const SHAKY_DUE_AT: &str = "2031-04-07T12:00:00.000Z";
    const CLOSE_EXAM_AT: &str = "2031-04-05T18:30:00.000Z";
    const CLOSE_EXAM_DUE_AT: &str = "2031-04-04T18:30:00.000Z";
    const PAST_EXAM_AT: &str = "2031-03-30T09:15:00.000Z";

    async fn seeded_session_store() -> InMemoryStudyStore {
        let store = InMemoryStudyStore::seeded_fixture();
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("voice-session-1")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("voice session recorded");
        store
    }

    fn decision_at(
        now: &str,
        status: ConceptStatus,
        exam_at: Option<&str>,
    ) -> ReviewScheduleDecisionV1 {
        decide_review_schedule(
            parse_utc_instant(now).expect("instant parses"),
            &ReviewOutcomeV1 {
                status,
                hint_count: Some(2),
                miss_count: Some(1),
            },
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: exam_at.map(|raw| parse_utc_instant(raw).expect("exam instant parses")),
                card: None,
            },
        )
        .expect("authoritative decision")
    }

    /// A clock that moves one second per read, which is exactly what the production
    /// `SystemClock` does between a tool call and the replay of that same tool call.
    /// Any replay guard keyed on the *computed* schedule (`due_at`, `generated_at`)
    /// silently stops holding the moment this clock advances.
    #[derive(Debug)]
    struct AdvancingClock {
        start: DateTime<Utc>,
        reads: AtomicI64,
    }

    impl AdvancingClock {
        fn new(start: DateTime<Utc>) -> Self {
            Self {
                start,
                reads: AtomicI64::new(0),
            }
        }
    }

    impl Clock for AdvancingClock {
        fn now(&self) -> DateTime<Utc> {
            self.start + Duration::seconds(self.reads.fetch_add(1, Ordering::SeqCst))
        }
    }

    /// Grade the same outcome again a moment later, exactly as a live replay does.
    ///
    /// `LEARN-009` removed the `schedule_review_item` tool, so the wall-clock replay
    /// this test cares about is expressed directly: two decisions computed from one
    /// graded outcome at two instants necessarily differ, and the store must still
    /// keep the first one authoritative.
    async fn schedule_shaky(
        store: &InMemoryStudyStore,
        clock: &AdvancingClock,
        response_id: &str,
    ) -> Value {
        // Exactly what the live path does: the authoritative card and exam instant
        // are read from the store, never supplied by the caller.
        let context = store
            .review_scheduling_context("user-1", "biology-midterm", "nadh")
            .await
            .expect("scheduling context");
        let decision = decide_review_schedule(
            clock.now(),
            &ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: Some(2),
                miss_count: Some(1),
            },
            &context,
        )
        .expect("authoritative decision");
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                response_id,
                "nadh",
                decision,
            )
            .await
            .expect("decision persists")
    }

    /// The replay property that matters: the same graded outcome, replayed while the
    /// wall clock moves, must not write a second scheduled review and must not
    /// advance the persisted FSRS card. Replaying a decision object that was built
    /// once cannot exercise this, because the second decision differs.
    #[tokio::test]
    async fn review_schedule_decision_replay_under_a_moving_clock_never_writes_twice() {
        let store = Arc::new(seeded_session_store().await);
        let clock = AdvancingClock::new(parse_utc_instant(GRADED_AT).expect("instant parses"));

        let first = schedule_shaky(&store, &clock, "response-7").await;
        let replay = schedule_shaky(&store, &clock, "response-7").await;

        assert_eq!(
            replay, first,
            "a replayed graded outcome must report the already-persisted decision"
        );

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_schedule_decisions.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.review_items[0].due_at, SHAKY_DUE_AT);

        let card = &snapshot.review_schedule_decisions[0].decision.card;
        assert_eq!(card.reps, 1, "a replay must not advance the FSRS card");
        assert_eq!(card.state, FsrsCardStateV1::Review);
        assert_eq!(format_rfc3339_millis(card.due_at), SHAKY_DUE_AT);

        // The authoritative context the *next* real outcome will read is still the
        // single graded review, not a replay-inflated one.
        let context = store
            .review_scheduling_context("user-1", "biology-midterm", "nadh")
            .await
            .expect("context");
        assert_eq!(context.card.as_ref().map(|card| card.reps), Some(1));
    }

    /// The same property under concurrency: eight racing replays each read a
    /// different instant from the clock and so each compute a different schedule,
    /// and exactly one of them may be persisted.
    #[tokio::test]
    async fn review_schedule_decision_concurrent_replays_write_exactly_one_row() {
        let store = Arc::new(seeded_session_store().await);
        let clock = Arc::new(AdvancingClock::new(
            parse_utc_instant(GRADED_AT).expect("instant parses"),
        ));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let store = Arc::clone(&store);
            let clock = Arc::clone(&clock);
            handles.push(tokio::spawn(async move {
                schedule_shaky(&store, &clock, "response-7").await
            }));
        }
        let mut results = Vec::new();
        for handle in handles {
            results.push(handle.await.expect("join"));
        }
        for result in &results {
            assert_eq!(result, &results[0], "every replay reports one schedule");
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_schedule_decisions.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.review_schedule_decisions[0].decision.card.reps, 1);
    }

    /// The guard must not over-collapse: a genuinely new graded outcome (a new model
    /// response) still schedules again and still advances the card.
    #[tokio::test]
    async fn review_schedule_decision_a_distinct_graded_outcome_still_advances_the_card() {
        let store = Arc::new(seeded_session_store().await);
        let clock = AdvancingClock::new(parse_utc_instant(GRADED_AT).expect("instant parses"));

        schedule_shaky(&store, &clock, "response-7").await;
        schedule_shaky(&store, &clock, "response-8").await;

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_schedule_decisions.len(), 2);

        let context = store
            .review_scheduling_context("user-1", "biology-midterm", "nadh")
            .await
            .expect("context");
        assert_eq!(context.card.as_ref().map(|card| card.reps), Some(2));
    }

    /// A different outcome under the *same* response id is a different event, not a
    /// replay: the payload, not just the response id, is part of the guard.
    #[tokio::test]
    async fn review_schedule_decision_guard_separates_outcomes_within_one_response() {
        let store = Arc::new(seeded_session_store().await);
        let clock = AdvancingClock::new(parse_utc_instant(GRADED_AT).expect("instant parses"));

        schedule_shaky(&store, &clock, "response-7").await;
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-7",
                "nadh",
                decision_at(GRADED_AT, ConceptStatus::Strong, None),
            )
            .await
            .expect("strong schedule");

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_schedule_decisions.len(), 2);
        assert_eq!(
            snapshot.review_schedule_decisions[0].decision.status,
            ConceptStatus::Shaky
        );
        assert_eq!(
            snapshot.review_schedule_decisions[1].decision.status,
            ConceptStatus::Strong
        );
    }

    #[tokio::test]
    async fn review_schedule_decision_round_trips_with_its_review_item() {
        let store = seeded_session_store().await;
        let decision = decision_at(GRADED_AT, ConceptStatus::Shaky, None);
        let result = store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                decision.clone(),
            )
            .await
            .expect("decision persists");

        // The tool-visible result exposes the date and policy, never raw FSRS state.
        assert_eq!(result["due_at"], SHAKY_DUE_AT);
        assert_eq!(result["schema_version"], 1);
        let encoded = result.to_string();
        assert!(!encoded.contains("stability"), "{encoded}");
        assert!(!encoded.contains("difficulty"), "{encoded}");

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_schedule_decisions.len(), 1);
        assert_eq!(snapshot.review_schedule_decisions[0].decision, decision);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.review_items[0].due_at, SHAKY_DUE_AT);
        assert_eq!(snapshot.review_items[0].concept_id, "nadh");
    }

    #[tokio::test]
    async fn review_schedule_decision_replay_is_idempotent_including_concurrently() {
        let store = Arc::new(seeded_session_store().await);
        let decision = decision_at(GRADED_AT, ConceptStatus::Shaky, None);

        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                decision.clone(),
            )
            .await
            .expect("first write");

        let mut handles = Vec::new();
        for _ in 0..8 {
            let store = Arc::clone(&store);
            let decision = decision.clone();
            handles.push(tokio::spawn(async move {
                store
                    .persist_review_schedule_decision(
                        "user-1",
                        "biology-midterm",
                        "voice-session-1",
                        "response-1",
                        "nadh",
                        decision,
                    )
                    .await
            }));
        }
        for handle in handles {
            handle.await.expect("join").expect("replay succeeds");
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_schedule_decisions.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
    }

    #[tokio::test]
    async fn review_schedule_decision_rejects_out_of_scope_writes_without_persisting_either_row() {
        let store = seeded_session_store().await;
        let decision = decision_at(GRADED_AT, ConceptStatus::Shaky, None);
        for (user_id, study_set_id, voice_session_id, concept_id) in [
            ("intruder", "biology-midterm", "voice-session-1", "nadh"),
            ("user-1", "other-set", "voice-session-1", "nadh"),
            ("user-1", "biology-midterm", "voice-session-9", "nadh"),
            (
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "not-a-concept",
            ),
        ] {
            assert!(
                store
                    .persist_review_schedule_decision(
                        user_id,
                        study_set_id,
                        voice_session_id,
                        "response-1",
                        concept_id,
                        decision.clone(),
                    )
                    .await
                    .is_err(),
                "{user_id}/{study_set_id}/{voice_session_id}/{concept_id} must be rejected"
            );
        }
        let snapshot = store.snapshot();
        assert!(snapshot.review_schedule_decisions.is_empty());
        assert!(snapshot.review_items.is_empty());
    }

    #[tokio::test]
    async fn review_schedule_decision_context_supplies_exam_and_latest_card_only() {
        let store = seeded_session_store().await;
        let empty = store
            .review_scheduling_context("user-1", "biology-midterm", "nadh")
            .await
            .expect("context");
        assert_eq!(empty.schema_version, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION);
        assert_eq!(empty.exam_at, None);
        assert_eq!(empty.card, None);

        let decision = decision_at(GRADED_AT, ConceptStatus::Shaky, None);
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                decision.clone(),
            )
            .await
            .expect("decision persists");
        store.set_study_set_exam_date("biology-midterm", Some(CLOSE_EXAM_AT.to_owned()));

        let loaded = store
            .review_scheduling_context("user-1", "biology-midterm", "nadh")
            .await
            .expect("context");
        assert_eq!(
            loaded.exam_at,
            Some(parse_utc_instant(CLOSE_EXAM_AT).expect("exam instant"))
        );
        assert_eq!(loaded.card, Some(decision.card.clone()));

        // Another concept in the same study set never inherits this card.
        let other = store
            .review_scheduling_context("user-1", "biology-midterm", "atp-synthase")
            .await
            .expect("context");
        assert_eq!(other.card, None);
    }

    /// The exam cap needs a real exam instant on this backend too, not only on
    /// Postgres: ingestion is where the learner supplies it, so ingestion is where the
    /// store must capture it.
    #[tokio::test]
    async fn review_schedule_decision_context_uses_the_exam_date_captured_at_ingestion() {
        let store = InMemoryStudyStore::new();
        let source_sentences = [
            "Mitochondria electron transport builds a proton gradient across the inner membrane for ATP synthase.",
            "NADH transfers electrons through Complex I while oxygen accepts them at the end of the chain.",
            "Chemiosmosis couples proton flow to ATP production during oxidative phosphorylation.",
        ]
        .join(" ");
        let record = store
            .create_paste_study_set(CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Bio paste".to_owned(),
                course: None,
                exam_date: Some(CLOSE_EXAM_AT.to_owned()),
                pasted_text: format!("{source_sentences} {}", source_sentences.repeat(8)),
                session_id: Some("paste-session-1".to_owned()),
            })
            .await
            .expect("paste ingestion succeeds");
        let concept_id = record
            .concepts
            .first()
            .expect("ingestion produced a concept")
            .public_id
            .clone();

        let context = store
            .review_scheduling_context("user-1", &record.study_set.id, &concept_id)
            .await
            .expect("context");
        assert_eq!(
            context.exam_at,
            Some(parse_utc_instant(CLOSE_EXAM_AT).expect("exam instant")),
            "the exam cap has no authoritative input if ingestion drops the exam date"
        );

        // The cap is now reachable end to end on this backend.
        let decision = decide_review_schedule(
            parse_utc_instant(GRADED_AT).expect("instant parses"),
            &ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: None,
                miss_count: None,
            },
            &context,
        )
        .expect("authoritative decision");
        assert_eq!(format_rfc3339_millis(decision.due_at), CLOSE_EXAM_DUE_AT);
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::ExamMargin)
        );
    }

    #[tokio::test]
    async fn review_schedule_decision_context_rejects_an_unparseable_exam_instant() {
        let store = seeded_session_store().await;
        store.set_study_set_exam_date("biology-midterm", Some("sometime next week".to_owned()));
        assert!(store
            .review_scheduling_context("user-1", "biology-midterm", "nadh")
            .await
            .is_err());
    }

    /// Long enough for the paste/file ingestion heuristics to derive real source
    /// spans and concepts.
    fn ingestible_text() -> String {
        let sentences = [
            "Mitochondria electron transport builds a proton gradient across the inner membrane for ATP synthase.",
            "NADH transfers electrons through Complex I while oxygen accepts them at the end of the chain.",
            "Chemiosmosis couples proton flow to ATP production during oxidative phosphorylation.",
        ]
        .join(" ");
        format!("{sentences} {}", sentences.repeat(8))
    }

    /// A retry re-ingests the file; it never re-asks the learner for the exam date,
    /// and the production HTTP retry route sends `exam_date: None` every time
    /// (`agent-service/src/app.rs`). An ingestion path that writes that `None`
    /// verbatim erases the only authoritative input D-01's exam cap has, so the cap
    /// silently stops firing for every retried study set.
    #[tokio::test]
    async fn review_schedule_decision_file_retry_keeps_the_exam_date_the_learner_recorded() {
        let store = InMemoryStudyStore::new();
        let ingested = store
            .create_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Bio notes".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: Some(CLOSE_EXAM_AT.to_owned()),
                file_name: "Lecture 9.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: ingestible_text().into_bytes(),
                session_id: Some("file-session-exam".to_owned()),
            })
            .await
            .expect("file ingestion succeeds");
        let study_set_id = ingested.study_set.id.clone();
        let ingested_concept = ingested
            .concepts
            .first()
            .expect("ingestion produced a concept")
            .public_id
            .clone();
        assert_eq!(
            store
                .review_scheduling_context("user-1", &study_set_id, &ingested_concept)
                .await
                .expect("context")
                .exam_at,
            Some(parse_utc_instant(CLOSE_EXAM_AT).expect("exam instant")),
            "ingestion must capture the exam instant before the retry can be judged"
        );

        // Exactly what the production retry route sends: no title, no course, no
        // exam date.
        let retried = store
            .retry_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: Some(study_set_id.clone()),
                title: String::new(),
                course: None,
                exam_date: None,
                file_name: "Lecture 9 rescan.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: ingestible_text().into_bytes(),
                session_id: Some("file-session-exam-retry".to_owned()),
            })
            .await
            .expect("retry succeeds");
        let retried_concept = retried
            .concepts
            .first()
            .expect("retry produced a concept")
            .public_id
            .clone();

        assert_eq!(
            store
                .review_scheduling_context("user-1", &study_set_id, &retried_concept)
                .await
                .expect("context")
                .exam_at,
            Some(parse_utc_instant(CLOSE_EXAM_AT).expect("exam instant")),
            "a file retry must not erase the exam date the learner already recorded"
        );
    }

    /// Fail closed at the boundary that accepts learner input, on both backends: a
    /// `study_sets` exam column that cannot hold the value is a scheduling input that
    /// silently disappears, and D-01 forbids a silently missing authoritative input.
    #[tokio::test]
    async fn review_schedule_decision_ingestion_rejects_an_unparseable_exam_date() {
        let store = InMemoryStudyStore::new();
        store
            .create_paste_study_set(CreatePasteStudySet {
                user_id: "user-1".to_owned(),
                title: "Bio paste".to_owned(),
                course: None,
                exam_date: Some("sometime next week".to_owned()),
                pasted_text: ingestible_text(),
                session_id: Some("paste-session-bad-exam".to_owned()),
            })
            .await
            .expect_err("an unparseable exam date is rejected where the learner supplies it");
    }

    /// Both backends must leave the same authorization ledger behind. A replay
    /// performs no write, so it must not append a second authorization either.
    #[tokio::test]
    async fn review_schedule_decision_replay_records_exactly_one_authorization() {
        let store = seeded_session_store().await;
        let decision = decision_at(GRADED_AT, ConceptStatus::Shaky, None);
        for _ in 0..3 {
            store
                .persist_review_schedule_decision(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    "nadh",
                    decision.clone(),
                )
                .await
                .expect("decision persists");
        }
        assert_eq!(
            store.snapshot().event_authorizations.len(),
            1,
            "a replay writes nothing, so it appends no second authorization"
        );
    }

    #[tokio::test]
    async fn review_schedule_decision_library_snapshot_reads_only_valid_v1_decisions() {
        let store = seeded_session_store().await;
        // The fixture only needs the session row to exist; Task 4 is where insert-versus-replay
        // truth is asserted.
        let _outcome = store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new("voice-session-2")),
                user_id: Some("user-1".to_owned()),
                study_set_id: Some("biology-midterm".to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("second voice session recorded");

        // A legacy fixed-date review item must never reach the authenticated read
        // model, and its presence must not shadow the authoritative v1 decision.
        for voice_session_id in ["voice-session-1", "voice-session-2"] {
            store
                .schedule_review_item(
                    "user-1",
                    "biology-midterm",
                    voice_session_id,
                    "nadh",
                    "2026-06-19T09:00:00Z",
                )
                .await
                .expect("legacy seed");
        }
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                decision_at(GRADED_AT, ConceptStatus::Shaky, None),
            )
            .await
            .expect("decision persists");
        for voice_session_id in ["voice-session-1", "voice-session-2"] {
            store
                .close_voice_session(voice_session_id, "completed")
                .await
                .expect("session closes");
        }

        let snapshot = store.library_snapshot("user-1").await.expect("snapshot");
        let legacy_only = snapshot
            .sessions
            .iter()
            .find(|session| session.voice_session_id == "voice-session-2")
            .expect("legacy-only session");
        assert!(
            legacy_only.next_review.is_none(),
            "a legacy review item is superseded, not a fallback"
        );

        let projected = snapshot
            .sessions
            .iter()
            .find(|session| session.voice_session_id == "voice-session-1")
            .expect("projected session");
        let next_review = projected.next_review.as_ref().expect("v1 next review");
        assert_eq!(next_review.concept_id, "nadh");
        assert_eq!(next_review.persisted_due_at, SHAKY_DUE_AT);
        assert_eq!(next_review.source, "review_schedule_decision_v1");
        assert_eq!(next_review.status, ConceptStatus::Shaky);
    }

    #[tokio::test]
    async fn review_schedule_decision_library_snapshot_hides_past_exam_capped_reviews() {
        let store = seeded_session_store().await;
        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                decision_at(GRADED_AT, ConceptStatus::Shaky, Some(PAST_EXAM_AT)),
            )
            .await
            .expect("decision persists");
        store
            .close_voice_session("voice-session-1", "completed")
            .await
            .expect("session closes");

        let snapshot = store.library_snapshot("user-1").await.expect("snapshot");
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.voice_session_id == "voice-session-1")
            .expect("completed session");
        assert!(
            session.next_review.is_none(),
            "a past-exam-capped decision is excluded from the learner-visible schedule"
        );
    }

    #[tokio::test]
    async fn review_schedule_decision_persists_the_exam_margin_cap_verbatim() {
        let store = seeded_session_store().await;
        let decision = decision_at(GRADED_AT, ConceptStatus::Shaky, Some(CLOSE_EXAM_AT));
        assert_eq!(format_rfc3339_millis(decision.due_at), CLOSE_EXAM_DUE_AT);
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::ExamMargin)
        );

        store
            .persist_review_schedule_decision(
                "user-1",
                "biology-midterm",
                "voice-session-1",
                "response-1",
                "nadh",
                decision,
            )
            .await
            .expect("decision persists");

        let snapshot = store.snapshot();
        assert_eq!(snapshot.review_items[0].due_at, CLOSE_EXAM_DUE_AT);
        assert_eq!(
            snapshot.review_schedule_decisions[0].decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::ExamMargin)
        );
    }

    #[tokio::test]
    async fn review_schedule_decision_snapshot_never_contains_a_fixed_june_2026_literal() {
        let store = seeded_session_store().await;
        for status in [
            ConceptStatus::Missed,
            ConceptStatus::Shaky,
            ConceptStatus::Review,
            ConceptStatus::Strong,
        ] {
            store
                .persist_review_schedule_decision(
                    "user-1",
                    "biology-midterm",
                    "voice-session-1",
                    "response-1",
                    "nadh",
                    decision_at(GRADED_AT, status, None),
                )
                .await
                .expect("decision persists");
        }
        let encoded = serde_json::to_string(&store.snapshot()).expect("snapshot serializes");
        assert!(!encoded.contains("2026-06-"), "{encoded}");
    }
}

/// `DATA-014`/`COR-04`: PDF uploads fail closed until real page-aware extraction
/// exists.
///
/// The fixtures here are generated, not checked in, and each builder validates its
/// own structure before the bytes reach ingestion — a fixture that silently stopped
/// being a PDF would otherwise turn these into tests of nothing. The MD5 and RC4
/// routines exist only to build the encrypted fixture and are checked against their
/// published vectors below; nothing outside this module may use them, and no
/// production dependency was added for a fixture.
#[cfg(test)]
pub(crate) mod pdf_ingestion_tests {
    use super::*;
    use agent_domain::{CreateFileStudySet, PortErrorKind, StudyMemoryStore};

    // -----------------------------------------------------------------------
    // Test-only primitives (RFC 1321 MD5, RC4, zlib stored-block DEFLATE).
    // -----------------------------------------------------------------------

    const MD5_SHIFTS: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const MD5_SINE: [u32; 64] = [
        0xd76a_a478,
        0xe8c7_b756,
        0x2420_70db,
        0xc1bd_ceee,
        0xf57c_0faf,
        0x4787_c62a,
        0xa830_4613,
        0xfd46_9501,
        0x6980_98d8,
        0x8b44_f7af,
        0xffff_5bb1,
        0x895c_d7be,
        0x6b90_1122,
        0xfd98_7193,
        0xa679_438e,
        0x49b4_0821,
        0xf61e_2562,
        0xc040_b340,
        0x265e_5a51,
        0xe9b6_c7aa,
        0xd62f_105d,
        0x0244_1453,
        0xd8a1_e681,
        0xe7d3_fbc8,
        0x21e1_cde6,
        0xc337_07d6,
        0xf4d5_0d87,
        0x455a_14ed,
        0xa9e3_e905,
        0xfcef_a3f8,
        0x676f_02d9,
        0x8d2a_4c8a,
        0xfffa_3942,
        0x8771_f681,
        0x6d9d_6122,
        0xfde5_380c,
        0xa4be_ea44,
        0x4bde_cfa9,
        0xf6bb_4b60,
        0xbebf_bc70,
        0x289b_7ec6,
        0xeaa1_27fa,
        0xd4ef_3085,
        0x0488_1d05,
        0xd9d4_d039,
        0xe6db_99e5,
        0x1fa2_7cf8,
        0xc4ac_5665,
        0xf429_2244,
        0x432a_ff97,
        0xab94_23a7,
        0xfc93_a039,
        0x655b_59c3,
        0x8f0c_cc92,
        0xffef_f47d,
        0x8584_5dd1,
        0x6fa8_7e4f,
        0xfe2c_e6e0,
        0xa301_4314,
        0x4e08_11a1,
        0xf753_7e82,
        0xbd3a_f235,
        0x2ad7_d2bb,
        0xeb86_d391,
    ];

    fn md5(input: &[u8]) -> [u8; 16] {
        let mut message = input.to_vec();
        let bit_length = (input.len() as u64).wrapping_mul(8);
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&bit_length.to_le_bytes());

        let mut state = [0x6745_2301u32, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
        for chunk in message.chunks_exact(64) {
            let mut words = [0u32; 16];
            for (index, word) in words.iter_mut().enumerate() {
                let start = index * 4;
                *word = u32::from_le_bytes([
                    chunk[start],
                    chunk[start + 1],
                    chunk[start + 2],
                    chunk[start + 3],
                ]);
            }
            let [mut a, mut b, mut c, mut d] = state;
            for round in 0..64usize {
                let (mixed, word_index) = match round {
                    0..=15 => ((b & c) | (!b & d), round),
                    16..=31 => ((d & b) | (!d & c), (5 * round + 1) % 16),
                    32..=47 => (b ^ c ^ d, (3 * round + 5) % 16),
                    _ => (c ^ (b | !d), (7 * round) % 16),
                };
                let temp = d;
                d = c;
                c = b;
                let sum = a
                    .wrapping_add(mixed)
                    .wrapping_add(MD5_SINE[round])
                    .wrapping_add(words[word_index]);
                b = b.wrapping_add(sum.rotate_left(MD5_SHIFTS[round]));
                a = temp;
            }
            state[0] = state[0].wrapping_add(a);
            state[1] = state[1].wrapping_add(b);
            state[2] = state[2].wrapping_add(c);
            state[3] = state[3].wrapping_add(d);
        }

        let mut digest = [0u8; 16];
        for (index, word) in state.iter().enumerate() {
            digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        digest
    }

    fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
        assert!(!key.is_empty(), "RC4 needs a key");
        let mut permutation: [u8; 256] = core::array::from_fn(|index| index as u8);
        let mut swap_index = 0usize;
        for index in 0..256usize {
            swap_index = (swap_index
                + usize::from(permutation[index])
                + usize::from(key[index % key.len()]))
                % 256;
            permutation.swap(index, swap_index);
        }
        let (mut i, mut j) = (0usize, 0usize);
        data.iter()
            .map(|byte| {
                i = (i + 1) % 256;
                j = (j + usize::from(permutation[i])) % 256;
                permutation.swap(i, j);
                let keystream =
                    permutation[(usize::from(permutation[i]) + usize::from(permutation[j])) % 256];
                byte ^ keystream
            })
            .collect()
    }

    fn adler32(data: &[u8]) -> u32 {
        let (mut low, mut high) = (1u32, 0u32);
        for byte in data {
            low = (low + u32::from(*byte)) % 65521;
            high = (high + low) % 65521;
        }
        (high << 16) | low
    }

    /// zlib container around a single stored (uncompressed) DEFLATE block. This is a
    /// real `/FlateDecode` stream: an extractor that inflates it recovers the page
    /// content operators exactly.
    fn zlib_stored(data: &[u8]) -> Vec<u8> {
        assert!(data.len() <= 0xFFFF, "one stored block only");
        let mut out = vec![0x78, 0x01];
        out.push(0x01);
        let length = u16::try_from(data.len()).expect("stored block length fits");
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&(!length).to_le_bytes());
        out.extend_from_slice(data);
        out.extend_from_slice(&adler32(data).to_be_bytes());
        out
    }

    #[test]
    fn test_only_md5_matches_rfc_1321_vectors() {
        assert_eq!(hex(&md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex(&md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            hex(&md5(b"message digest")),
            "f96b697d7cb7938d525a2f31aaf161d0"
        );
        assert_eq!(
            hex(&md5(b"abcdefghijklmnopqrstuvwxyz")),
            "c3fcd3d76192e4007dfb496cca67e13b"
        );
    }

    #[test]
    fn test_only_rc4_matches_its_published_vector() {
        assert_eq!(hex(&rc4(b"Key", b"Plaintext")), "bbf316e8d940af0ad3");
        assert_eq!(
            hex(&rc4(b"Secret", b"Attack at dawn")),
            "45a01f645fc35b383552544b9bf5"
        );
        // Symmetric: decrypting the ciphertext returns the plaintext.
        assert_eq!(
            rc4(b"Key", &rc4(b"Key", b"Plaintext")),
            b"Plaintext".to_vec()
        );
    }

    #[test]
    fn test_only_zlib_stored_block_round_trips_through_its_own_header() {
        let stream = zlib_stored(b"BT /F1 12 Tf ET");
        assert_eq!(&stream[0..2], &[0x78, 0x01], "zlib header");
        assert_eq!(
            (u32::from(stream[0]) * 256 + u32::from(stream[1])) % 31,
            0,
            "zlib header check bits"
        );
        assert_eq!(stream[2] & 0x07, 0x01, "final stored block");
        let length = u16::from_le_bytes([stream[3], stream[4]]);
        let inverse = u16::from_le_bytes([stream[5], stream[6]]);
        assert_eq!(length, 15);
        assert_eq!(inverse, !length);
        assert_eq!(&stream[7..7 + 15], b"BT /F1 12 Tf ET");
        assert_eq!(
            u32::from_be_bytes([
                stream[stream.len() - 4],
                stream[stream.len() - 3],
                stream[stream.len() - 2],
                stream[stream.len() - 1],
            ]),
            adler32(b"BT /F1 12 Tf ET")
        );
    }

    fn hex(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(&mut out, "{byte:02x}");
        }
        out
    }

    // -----------------------------------------------------------------------
    // PDF fixture builder.
    // -----------------------------------------------------------------------

    struct PdfBuilder {
        bytes: Vec<u8>,
        offsets: Vec<usize>,
    }

    impl PdfBuilder {
        fn new() -> Self {
            Self {
                bytes: b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec(),
                offsets: Vec::new(),
            }
        }

        /// Objects are emitted in order, so the object number is always
        /// `offsets.len() + 1` and the recorded offset is the real byte position.
        fn object(&mut self, body: &[u8]) -> usize {
            let number = self.offsets.len() + 1;
            self.offsets.push(self.bytes.len());
            self.bytes
                .extend_from_slice(format!("{number} 0 obj\n").as_bytes());
            self.bytes.extend_from_slice(body);
            self.bytes.extend_from_slice(b"\nendobj\n");
            number
        }

        fn stream_object(&mut self, dictionary_extra: &str, payload: &[u8]) -> usize {
            let mut body = format!(
                "<< /Length {}{dictionary_extra} >>\nstream\n",
                payload.len()
            )
            .into_bytes();
            body.extend_from_slice(payload);
            body.extend_from_slice(b"\nendstream");
            self.object(&body)
        }

        fn finish(mut self, root: usize, trailer_extra: &str) -> Vec<u8> {
            let xref_offset = self.bytes.len();
            let count = self.offsets.len() + 1;
            self.bytes
                .extend_from_slice(format!("xref\n0 {count}\n").as_bytes());
            self.bytes.extend_from_slice(b"0000000000 65535 f \n");
            for offset in &self.offsets {
                self.bytes
                    .extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
            }
            self.bytes.extend_from_slice(
                format!(
                    "trailer\n<< /Size {count} /Root {root} 0 R{trailer_extra} >>\nstartxref\n{xref_offset}\n%%EOF\n"
                )
                .as_bytes(),
            );
            assert_valid_pdf(&self.bytes, count, xref_offset, root);
            self.bytes
        }
    }

    /// Every builder proves its own output before ingestion sees it: header, exact
    /// xref byte offsets, `startxref`, trailer, and root reference.
    fn assert_valid_pdf(bytes: &[u8], count: usize, xref_offset: usize, root: usize) {
        assert!(bytes.starts_with(b"%PDF-1.7"), "PDF header");
        assert_eq!(
            &bytes[xref_offset..xref_offset + 4],
            b"xref",
            "xref keyword"
        );

        // Byte operations only: this module must contain no lossy UTF-8 decoding at
        // all, which is exactly the property the production gate scans for.
        let marker = b"startxref\n";
        let marker_start = rfind(bytes, marker).expect("startxref present");
        let value_start = marker_start + marker.len();
        let value_end = value_start
            + bytes[value_start..]
                .iter()
                .position(|byte| *byte == b'\n')
                .expect("startxref value ends");
        let startxref: usize = std::str::from_utf8(&bytes[value_start..value_end])
            .expect("startxref value is ascii")
            .parse()
            .expect("startxref parses");
        assert_eq!(startxref, xref_offset, "startxref points at the xref table");
        assert!(
            find(bytes, format!("/Root {root} 0 R").as_bytes()).is_some(),
            "trailer root"
        );
        assert!(bytes.ends_with(b"%%EOF\n"), "EOF marker");

        // Each recorded offset must actually be where that object starts.
        let table_start = xref_offset + format!("xref\n0 {count}\n").len();
        for object_number in 1..count {
            let entry_start = table_start + object_number * 20;
            let entry = &bytes[entry_start..entry_start + 20];
            assert_eq!(entry.len(), 20, "xref entries are exactly 20 bytes");
            let offset: usize = std::str::from_utf8(&entry[0..10])
                .expect("offset is ascii")
                .parse()
                .expect("offset parses");
            let expected = format!("{object_number} 0 obj\n");
            assert_eq!(
                &bytes[offset..offset + expected.len()],
                expected.as_bytes(),
                "xref offset for object {object_number}"
            );
        }
    }

    /// A real one-page text PDF: catalog, page tree, page, font, content stream.
    pub(crate) fn generated_text_pdf() -> Vec<u8> {
        let mut pdf = PdfBuilder::new();
        let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
        let _pages = pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        let _page = pdf.object(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        );
        let _font = pdf.object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
        let content =
            b"BT /F1 12 Tf 72 720 Td (Oxidative phosphorylation builds a proton gradient.) Tj ET";
        let _contents = pdf.stream_object("", content);
        assert_eq!(catalog, 1);
        let bytes = pdf.finish(catalog, "");
        assert!(
            find(&bytes, b" Tj").is_some(),
            "the text page must carry a real text-showing operator"
        );
        bytes
    }

    /// The same page with its content stream really deflated.
    pub(crate) fn generated_flate_pdf() -> Vec<u8> {
        let content =
            b"BT /F1 12 Tf 72 720 Td (ATP synthase converts the gradient into ATP.) Tj ET";
        let deflated = zlib_stored(content);
        let mut pdf = PdfBuilder::new();
        let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
        pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        pdf.object(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        );
        pdf.object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
        pdf.stream_object(" /Filter /FlateDecode", &deflated);
        let bytes = pdf.finish(catalog, "");
        assert!(find(&bytes, b"/FlateDecode").is_some(), "declared filter");
        // A stored DEFLATE block keeps its payload verbatim, so the operators appear
        // inside the stream and only there: an extractor still has to inflate the
        // declared filter to reach them, and a byte scan of the file is not
        // extraction.
        let stream_start = find(&bytes, b"stream\n").expect("content stream present") + 7;
        assert_eq!(
            &bytes[stream_start..stream_start + 2],
            &[0x78, 0x01],
            "the stream begins with the zlib header"
        );
        assert!(
            find(&bytes[..stream_start], b" Tj").is_none(),
            "no text operator exists outside the compressed stream"
        );
        assert!(
            find(&bytes, deflated.as_slice()).is_some(),
            "the deflated bytes are embedded verbatim"
        );
        bytes
    }

    /// A scanned page: one image XObject, no text operators anywhere.
    pub(crate) fn generated_scanned_pdf() -> Vec<u8> {
        // 8x8 greyscale, deliberately not text.
        let image: Vec<u8> = (0..64u16).map(|value| (value * 4) as u8).collect();
        let mut pdf = PdfBuilder::new();
        let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
        pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        pdf.object(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
        );
        pdf.stream_object(
            " /Type /XObject /Subtype /Image /Width 8 /Height 8 \
             /ColorSpace /DeviceGray /BitsPerComponent 8",
            &image,
        );
        pdf.stream_object("", b"q 612 0 0 792 0 0 cm /Im0 Do Q");
        let bytes = pdf.finish(catalog, "");
        assert!(find(&bytes, b"/Subtype /Image").is_some(), "image xobject");
        assert!(
            find(&bytes, b" Tj").is_none() && find(&bytes, b" TJ").is_none(),
            "a scanned page carries no text-showing operator"
        );
        bytes
    }

    const PDF_PASSWORD_PADDING: [u8; 32] = [
        0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01,
        0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53,
        0x69, 0x7A,
    ];

    fn padded_password(password: &[u8]) -> [u8; 32] {
        let mut padded = [0u8; 32];
        let taken = password.len().min(32);
        padded[..taken].copy_from_slice(&password[..taken]);
        padded[taken..].copy_from_slice(&PDF_PASSWORD_PADDING[..32 - taken]);
        padded
    }

    /// PDF Standard Security Handler, revision 2 (40-bit RC4), with deterministic
    /// test passwords. Algorithms 2, 3, 4 and 1 from the PDF specification.
    pub(crate) fn generated_encrypted_pdf() -> Vec<u8> {
        const USER_PASSWORD: &[u8] = b"viva-user";
        const OWNER_PASSWORD: &[u8] = b"viva-owner";
        const PERMISSIONS: i32 = -1;
        let document_id: [u8; 16] = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
            0xFF, 0x00,
        ];

        // Algorithm 3: /O.
        let owner_digest = md5(&padded_password(OWNER_PASSWORD));
        let owner_entry = rc4(&owner_digest[..5], &padded_password(USER_PASSWORD));
        assert_eq!(owner_entry.len(), 32, "/O is 32 bytes");

        // Algorithm 2: the file encryption key.
        let mut key_input = Vec::new();
        key_input.extend_from_slice(&padded_password(USER_PASSWORD));
        key_input.extend_from_slice(&owner_entry);
        key_input.extend_from_slice(&PERMISSIONS.to_le_bytes());
        key_input.extend_from_slice(&document_id);
        let encryption_key = md5(&key_input)[..5].to_vec();

        // Algorithm 4: /U for revision 2.
        let user_entry = rc4(&encryption_key, &PDF_PASSWORD_PADDING);
        assert_eq!(user_entry.len(), 32, "/U is 32 bytes");

        // Algorithm 1: the per-object key for the content stream (object 5).
        let mut object_key_input = encryption_key.clone();
        object_key_input.extend_from_slice(&5u32.to_le_bytes()[..3]);
        object_key_input.extend_from_slice(&0u32.to_le_bytes()[..2]);
        let object_key = md5(&object_key_input)[..(encryption_key.len() + 5).min(16)].to_vec();
        let plaintext_content =
            b"BT /F1 12 Tf 72 720 Td (Encrypted lecture content.) Tj ET".to_vec();
        let encrypted_content = rc4(&object_key, &plaintext_content);
        assert_ne!(
            encrypted_content, plaintext_content,
            "the content stream must actually be encrypted"
        );

        let mut pdf = PdfBuilder::new();
        let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
        pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        pdf.object(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        );
        pdf.object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
        pdf.stream_object("", &encrypted_content);
        let encrypt_dictionary = format!(
            "<< /Filter /Standard /V 1 /R 2 /O <{}> /U <{}> /P {PERMISSIONS} >>",
            hex(&owner_entry),
            hex(&user_entry)
        );
        let encrypt = pdf.object(encrypt_dictionary.as_bytes());
        let trailer_extra = format!(
            " /Encrypt {encrypt} 0 R /ID [<{}> <{}>]",
            hex(&document_id),
            hex(&document_id)
        );
        let bytes = pdf.finish(catalog, &trailer_extra);
        assert!(find(&bytes, b"/Filter /Standard").is_some(), "std handler");
        assert!(find(&bytes, b"/R 2").is_some(), "revision 2");
        assert!(
            find(&bytes, format!("/Encrypt {encrypt} 0 R").as_bytes()).is_some(),
            "the trailer references the encrypt dictionary"
        );
        assert!(
            find(&bytes, b"Encrypted lecture content").is_none(),
            "no plaintext content survives in the encrypted file"
        );
        bytes
    }

    /// A PDF whose xref table and trailer are cut off mid-file.
    pub(crate) fn generated_malformed_pdf() -> Vec<u8> {
        let complete = generated_text_pdf();
        let xref_start = find(&complete, b"xref\n").expect("xref keyword present");
        let mut truncated = complete[..xref_start + 12].to_vec();
        truncated.extend_from_slice(b"000000");
        assert!(
            truncated.starts_with(b"%PDF-1.7"),
            "still claims to be a PDF"
        );
        assert!(
            find(&truncated, b"trailer").is_none() && find(&truncated, b"startxref").is_none(),
            "the xref/trailer really is gone"
        );
        truncated
    }

    /// UTF-8 study prose wearing a `%PDF-1.7` header and nothing else.
    pub(crate) fn magic_prefixed_plaintext() -> Vec<u8> {
        let text = "%PDF-1.7\nMitochondria transfer electrons from NADH to oxygen. \
             The proton gradient powers ATP synthase during oxidative phosphorylation. \
             Chemiosmosis couples the gradient to ADP phosphorylation.";
        let bytes = text.as_bytes().to_vec();
        assert!(bytes.starts_with(b"%PDF"), "carries the magic prefix");
        assert!(find(&bytes, b" obj").is_none(), "carries no PDF object");
        assert!(find(&bytes, b"xref").is_none(), "carries no xref table");
        assert!(std::str::from_utf8(&bytes).is_ok(), "is valid UTF-8 prose");
        bytes
    }

    /// The whole persisted state as bytes. Comparing serialized state, not field by
    /// field, is what makes "no artifact was created" mean every artifact.
    fn state_bytes(state: &InMemoryStudyState) -> String {
        serde_json::to_string(state).expect("in-memory state serializes")
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .rposition(|window| window == needle)
    }

    // -----------------------------------------------------------------------
    // Fail-closed behaviour.
    // -----------------------------------------------------------------------

    fn assert_unsupported_pdf(error: &PortError) {
        assert_eq!(error.kind(), PortErrorKind::InvalidInput);
        assert_eq!(error.port(), "study_store.file_ingestion");
        assert_eq!(error.id(), "unsupported_pdf");
        assert_eq!(
            error.reason(),
            "PDF ingestion requires page-aware extraction"
        );
    }

    fn file_input(
        file_name: &str,
        content_type: Option<&str>,
        bytes: Vec<u8>,
    ) -> CreateFileStudySet {
        CreateFileStudySet {
            user_id: "user-1".to_owned(),
            study_set_id: None,
            title: "Lecture upload".to_owned(),
            course: Some("Biology 201".to_owned()),
            exam_date: None,
            file_name: file_name.to_owned(),
            content_type: content_type.map(ToOwned::to_owned),
            file_bytes: bytes,
            session_id: Some("file-session-pdf".to_owned()),
        }
    }

    /// Reject the upload and prove nothing at all was written: not a study set, a
    /// document, a source span, a concept, a question, a session, or a nonce.
    async fn assert_rejected_without_artifacts(
        file_name: &str,
        content_type: Option<&str>,
        bytes: Vec<u8>,
    ) {
        let store = InMemoryStudyStore::new();
        let before = store.snapshot();
        let before_counts = store.write_counts();

        let error = store
            .create_file_study_set(file_input(file_name, content_type, bytes))
            .await
            .expect_err("PDF ingestion must fail closed");
        assert_unsupported_pdf(&error);

        let after = store.snapshot();
        assert_eq!(
            state_bytes(&after),
            state_bytes(&before),
            "the store must be byte-identical after a rejected PDF"
        );
        assert_eq!(store.write_counts(), before_counts);
        assert!(after.study_sets.is_empty());
        assert!(after.documents.is_empty());
        assert!(after.source_spans.is_empty());
        assert!(after.concepts.is_empty());
        assert!(after.questions.is_empty());
        assert!(after.sessions.is_empty());
        assert!(after.session_token_nonces.is_empty());
    }

    #[tokio::test]
    async fn pdf_ingestion_fails_closed_text_page_without_artifacts() {
        assert_rejected_without_artifacts(
            "Lecture 9.pdf",
            Some("application/pdf"),
            generated_text_pdf(),
        )
        .await;
    }

    #[tokio::test]
    async fn pdf_ingestion_fails_closed_flate_compressed_text_without_artifacts() {
        assert_rejected_without_artifacts(
            "Lecture 9 compressed.pdf",
            Some("application/pdf"),
            generated_flate_pdf(),
        )
        .await;
    }

    #[tokio::test]
    async fn pdf_ingestion_fails_closed_scanned_image_only_without_artifacts() {
        assert_rejected_without_artifacts(
            "Scan 2026-08-24.pdf",
            Some("application/pdf; charset=binary"),
            generated_scanned_pdf(),
        )
        .await;
    }

    #[tokio::test]
    async fn pdf_ingestion_fails_closed_standard_encrypted_without_artifacts() {
        assert_rejected_without_artifacts(
            "Protected.pdf",
            Some("application/pdf"),
            generated_encrypted_pdf(),
        )
        .await;
    }

    #[tokio::test]
    async fn pdf_ingestion_fails_closed_malformed_without_artifacts() {
        assert_rejected_without_artifacts(
            "Truncated.PDF",
            Some("APPLICATION/PDF"),
            generated_malformed_pdf(),
        )
        .await;
    }

    #[tokio::test]
    async fn pdf_ingestion_fails_closed_magic_prefixed_plaintext_without_artifacts() {
        assert_rejected_without_artifacts(
            "notes.pdf",
            Some("application/pdf"),
            magic_prefixed_plaintext(),
        )
        .await;
    }

    /// The name and the declared type are both attacker-controlled, so neither may be
    /// the only thing standing between a PDF and the extractor that cannot read it.
    #[tokio::test]
    async fn pdf_ingestion_fails_closed_magic_even_without_pdf_name_or_mime() {
        assert_rejected_without_artifacts("notes.txt", Some("text/plain"), generated_text_pdf())
            .await;
        assert_rejected_without_artifacts("notes.txt", None, generated_flate_pdf()).await;
        // A UTF-8 BOM and leading whitespace do not hide the magic.
        let mut disguised = vec![0xEF, 0xBB, 0xBF, b'\n', b' ', b'\t'];
        disguised.extend_from_slice(&generated_text_pdf());
        assert_rejected_without_artifacts("notes.txt", Some("text/plain"), disguised).await;
    }

    /// A rejected retry must leave the study set exactly as the successful ingestion
    /// left it: same rows, same ids, same status.
    #[tokio::test]
    async fn pdf_ingestion_fails_closed_retry_without_state_mutation() {
        let store = InMemoryStudyStore::new();
        let ready = store
            .create_file_study_set(CreateFileStudySet {
                file_name: "notes.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                file_bytes: ingestible_text().into_bytes(),
                ..file_input("notes.txt", Some("text/plain"), Vec::new())
            })
            .await
            .expect("plain text ingests");
        assert_eq!(
            ready.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );

        let before = store.snapshot();
        let before_counts = store.write_counts();
        let error = store
            .retry_file_study_set(CreateFileStudySet {
                study_set_id: Some(ready.study_set.id.clone()),
                file_name: "rescan.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
                file_bytes: generated_text_pdf(),
                session_id: Some("file-session-pdf-retry".to_owned()),
                ..file_input("rescan.pdf", Some("application/pdf"), Vec::new())
            })
            .await
            .expect_err("a PDF retry must fail closed");
        assert_unsupported_pdf(&error);

        assert_eq!(
            state_bytes(&store.snapshot()),
            state_bytes(&before),
            "a rejected retry must leave byte-equivalent state"
        );
        assert_eq!(store.write_counts(), before_counts);
        assert!(store
            .active_question("user-1", &ready.study_set.id)
            .await
            .expect("active question read")
            .is_some());
    }

    #[tokio::test]
    async fn non_pdf_utf8_file_still_ingests_and_becomes_ready() {
        let store = InMemoryStudyStore::new();
        let record = store
            .create_file_study_set(file_input(
                "notes.txt",
                Some("text/plain"),
                ingestible_text().into_bytes(),
            ))
            .await
            .expect("valid non-PDF UTF-8 still ingests");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert_eq!(record.documents[0].source_kind, "file");
        assert!(!record.source_spans.is_empty());
        assert!(!record.concepts.is_empty());
        assert_eq!(record.questions.len(), record.concepts.len());
        assert!(store
            .active_question("user-1", &record.study_set.id)
            .await
            .expect("active question read")
            .is_some());
    }

    /// Invalid UTF-8 is refused, not repaired. A replacement character is a
    /// fabricated learner fact: it claims the file said something it did not.
    #[tokio::test]
    async fn non_pdf_invalid_utf8_fails_without_lossy_replacement() {
        let store = InMemoryStudyStore::new();
        let before = store.snapshot();

        let mut bytes = ingestible_text().into_bytes();
        bytes.extend_from_slice(&[0xFF, 0xFE, 0x80, 0x9F]);
        let error = store
            .create_file_study_set(file_input("notes.txt", Some("text/plain"), bytes))
            .await
            .expect_err("invalid UTF-8 must fail closed");

        assert_eq!(error.kind(), PortErrorKind::InvalidInput);
        assert_eq!(error.port(), "study_store.file_ingestion");
        assert_eq!(error.id(), "invalid_utf8_file");

        assert_eq!(
            state_bytes(&store.snapshot()),
            state_bytes(&before),
            "nothing was written"
        );
        let persisted = serde_json::to_string(&store.snapshot()).expect("snapshot serializes");
        assert!(
            !persisted.contains('\u{FFFD}'),
            "no replacement character may reach the store"
        );
    }

    fn ingestible_text() -> String {
        [
            "Mitochondria electron transport builds a proton gradient across the inner membrane.",
            "NADH transfers electrons while oxygen accepts them at the end of the chain.",
            "ATP synthase uses chemiosmosis to make ATP from ADP.",
        ]
        .join("\n")
    }
}
