use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    sync::{Arc, RwLock},
};

use agent_domain::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    AnswerEvaluation, ConceptStatus, CreateFileStudySet, CreatePasteStudySet,
    LibraryNextReviewSummary, LibrarySessionRecapSummary, LibrarySessionSummary,
    LibraryStudyDocumentSummary, LibraryStudySetSummary, PortError, SessionConfig, SessionStore,
    SessionTokenNonceClaim, SourceConfidence, StudyConceptSummary, StudyDocumentSummary,
    StudyLibrarySnapshot, StudyMemoryStore, StudyMode, StudyQuestion, StudySessionDurableCounts,
    StudySessionRecap, StudySetIngestionRecord, StudySetIngestionStatus, StudySetSummary,
    StudySourceReference, StudySourceSpanSummary, StudyStoreBackend, StudyStoreCapabilities,
    StudyStoreWriteCounts,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_PASTE_SOURCE_EXCERPT_CHARS: usize = 360;
const MAX_PASTE_SOURCE_SPANS: usize = 4;

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

fn event_authorization_record<T: Serialize>(
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    kind: EventAuthorizationKind,
    payload: &T,
) -> Result<EventAuthorizationRecord, PortError> {
    Ok(EventAuthorizationRecord {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        response_id: response_id.to_owned(),
        kind,
        payload_sha256: payload_sha256(kind, response_id, payload)?,
    })
}

fn payload_sha256<T: Serialize>(
    kind: EventAuthorizationKind,
    response_id: &str,
    payload: &T,
) -> Result<String, PortError> {
    let payload = serde_json::to_vec(payload)
        .map_err(|error| PortError::adapter("memory", error.to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(kind.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(response_id.as_bytes());
    hasher.update([0]);
    hasher.update(payload);
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    Ok(encoded)
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersistedRecapSourceMoment {
    pub source: PersistedSourceReference,
    pub status: ConceptStatus,
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
        Self {
            voice_session_id: recap.voice_session_id.clone(),
            strong_concepts: recap.strong_concepts.clone(),
            shaky_concepts: recap.shaky_concepts.clone(),
            missed_concepts: recap.missed_concepts.clone(),
            review_later: recap.review_later.clone(),
            source_moments: recap
                .source_moments
                .iter()
                .map(|moment| PersistedRecapSourceMoment {
                    source: PersistedSourceReference::from(&moment.source),
                    status: moment.status.clone(),
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventAuthorizationKind {
    AnswerEvaluation,
    ConceptStatus,
    StudySessionRecap,
}

impl EventAuthorizationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AnswerEvaluation => "answer_evaluation",
            Self::ConceptStatus => "concept_status",
            Self::StudySessionRecap => "study_session_recap",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EventAuthorizationRecord {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub response_id: String,
    pub kind: EventAuthorizationKind,
    pub payload_sha256: String,
}

#[derive(Serialize)]
struct ConceptStatusEventPayload<'a> {
    concept_id: &'a str,
    status: &'a ConceptStatus,
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
    pub recaps: Vec<RecapRecord>,
    pub event_authorizations: Vec<EventAuthorizationRecord>,
    pub session_token_nonces: Vec<SessionTokenNonceClaim>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FixtureIdTranslation {
    pub logical_id: String,
    pub storage_uuid: Uuid,
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryStudyStore {
    inner: Arc<RwLock<InMemoryStudyState>>,
}

impl InMemoryStudyStore {
    pub fn new() -> Self {
        Self::default()
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
        let storage_uuid = match logical_id {
            "biology-midterm" => "11111111-1111-4111-8111-111111111111",
            "lec-5" => "22222222-2222-4222-8222-222222222222",
            "src-lecture-5-slide-18" => "33333333-3333-4333-8333-333333333333",
            "voice-session-1" => "44444444-4444-4444-8444-444444444444",
            _ => {
                return Err(PortError::unavailable(
                    "memory",
                    logical_id,
                    "fixture logical id has no UUID storage mapping",
                ));
            }
        }
        .parse()
        .map_err(|error| PortError::adapter("memory", format!("invalid fixture UUID: {error}")))?;

        Ok(FixtureIdTranslation {
            logical_id: logical_id.to_owned(),
            storage_uuid,
        })
    }

    pub fn upsert_study_set(&self, record: StudySetRecord) {
        self.inner
            .write()
            .expect("memory store lock poisoned")
            .study_sets
            .insert(record.study_set_id.clone(), record);
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

    fn persist_ingestion_record_locked(
        state: &mut InMemoryStudyState,
        generated: &StudySetIngestionRecord,
        replace_existing: bool,
    ) {
        let study_set_id = generated.study_set.id.clone();
        if replace_existing {
            state
                .documents
                .retain(|_, document| document.study_set_id != study_set_id);
            state
                .source_spans
                .retain(|_, source| source.study_set_id != study_set_id);
            state
                .concepts
                .retain(|_, concept| concept.study_set_id != study_set_id);
            state
                .questions
                .retain(|_, question| question.study_set_id != study_set_id);
            state
                .event_authorizations
                .retain(|authorization| authorization.study_set_id != study_set_id);
        }
        state.study_sets.insert(
            study_set_id.clone(),
            StudySetRecord {
                study_set_id: study_set_id.clone(),
                user_id: generated.study_set.user_id.clone(),
                title: generated.study_set.title.clone(),
                course: generated.study_set.course.clone(),
                ingestion_status: generated.study_set.ingestion_status.clone(),
                ingestion_error: generated.study_set.ingestion_error.clone(),
                concept_ids: generated
                    .concepts
                    .iter()
                    .map(|concept| concept.public_id.clone())
                    .collect(),
                question_ids: generated
                    .questions
                    .iter()
                    .map(|question| question.question_id.clone())
                    .collect(),
            },
        );
        for document in &generated.documents {
            state.documents.insert(
                document.id.clone(),
                StudyDocumentRecord {
                    study_set_id: study_set_id.clone(),
                    document_id: document.id.clone(),
                    title: document.display_name.clone(),
                    source_kind: document.source_kind.clone(),
                    processing_status: document.processing_status.clone(),
                    tombstoned: false,
                },
            );
        }
        for source in &generated.source_spans {
            state.source_spans.insert(
                source.id.clone(),
                SourceSpanRecord {
                    study_set_id: study_set_id.clone(),
                    source: source_summary_to_reference(source),
                    tombstoned: false,
                },
            );
        }
        for concept in &generated.concepts {
            state.concepts.insert(
                concept_key(&study_set_id, &concept.public_id),
                ConceptRecord {
                    study_set_id: study_set_id.clone(),
                    concept_id: concept.public_id.clone(),
                    label: concept.label.clone(),
                    status: concept.status.clone(),
                    source_span_id: concept.source_span_id.clone(),
                },
            );
        }
        for question in &generated.questions {
            state.questions.insert(
                question_key(&study_set_id, &question.question_id),
                StudyQuestionRecord {
                    study_set_id: study_set_id.clone(),
                    question: question.clone(),
                    active: true,
                },
            );
        }
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

    fn study_set_locked<'a>(
        state: &'a InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<&'a StudySetRecord, PortError> {
        let study_set = state.study_sets.get(study_set_id).ok_or_else(|| {
            PortError::unavailable("memory", study_set_id, "study set does not exist")
        })?;
        if study_set.user_id != user_id {
            return Err(PortError::unavailable(
                "memory",
                study_set_id,
                "study set is not available for this user",
            ));
        }
        Ok(study_set)
    }

    fn ensure_session_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<(), PortError> {
        if state.sessions.iter().any(|session| {
            session.user_id == user_id
                && session.study_set_id == study_set_id
                && session.voice_session_id == voice_session_id
                && session.status == "open"
        }) {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            voice_session_id,
            "voice session is not available for this user and study set",
        ))
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
            return Err(PortError::adapter(
                "memory",
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

    fn ensure_question_locked(
        study_set: &StudySetRecord,
        state: &InMemoryStudyState,
        question_id: &str,
    ) -> Result<(), PortError> {
        if study_set
            .question_ids
            .iter()
            .any(|known| known == question_id)
            && state
                .questions
                .get(&question_key(&study_set.study_set_id, question_id))
                .is_some_and(|record| record.active)
        {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            question_id,
            "question is not active for this study set",
        ))
    }

    fn active_question_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        let study_set = Self::study_set_locked(state, user_id, study_set_id)?;
        if study_set.ingestion_status != StudySetIngestionStatus::Ready {
            return Ok(None);
        }
        for question_id in &study_set.question_ids {
            let Some(record) = state
                .questions
                .get(&question_key(study_set_id, question_id))
                .filter(|record| record.active)
            else {
                continue;
            };
            let Some(source) = Self::source_reference_locked(
                state,
                user_id,
                study_set_id,
                &record.question.source.source_id,
            ) else {
                continue;
            };
            if source != record.question.source {
                return Err(PortError::adapter(
                    "memory",
                    "active question source tuple does not match deterministic retrieval",
                ));
            }
            return Ok(Some(record.question.clone()));
        }
        Ok(None)
    }

    fn retrievable_question_count_locked(
        state: &InMemoryStudyState,
        user_id: &str,
        study_set_id: &str,
    ) -> usize {
        let Some(study_set) = state.study_sets.get(study_set_id) else {
            return 0;
        };
        if study_set.user_id != user_id
            || study_set.ingestion_status != StudySetIngestionStatus::Ready
        {
            return 0;
        }
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
                Self::source_reference_locked(
                    state,
                    user_id,
                    study_set_id,
                    &record.question.source.source_id,
                )
                .is_some_and(|source| source == record.question.source)
            })
            .count()
    }
}

fn concept_key(study_set_id: &str, concept_id: &str) -> String {
    format!("{study_set_id}::{concept_id}")
}

fn question_key(study_set_id: &str, question_id: &str) -> String {
    format!("{study_set_id}::{question_id}")
}

fn remove_session_artifacts(
    state: &mut InMemoryStudyState,
    user_id: &str,
    study_set_id: &str,
    voice_session_ids: &HashSet<String>,
) {
    if voice_session_ids.is_empty() {
        return;
    }
    state.recaps.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.review_items.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.concept_statuses.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state
        .answer_attempts
        .retain(|record| !voice_session_ids.contains(&record.voice_session_id));
    state.event_authorizations.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
    state.session_token_nonces.retain(|record| {
        record.user_id != user_id
            || record.study_set_id != study_set_id
            || !voice_session_ids.contains(&record.voice_session_id)
    });
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

pub(crate) fn generate_paste_study_set(
    input: CreatePasteStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let user_id = required_text(&input.user_id, "user_id")?.to_owned();
    let title = required_text(&input.title, "title")?.to_owned();
    let pasted_text = required_text(&input.pasted_text, "pasted_text")?.to_owned();
    let course = input.course.and_then(non_empty_owned);
    let study_set_id = Uuid::new_v4().to_string();
    let document_id = Uuid::new_v4().to_string();
    let session_id = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let normalized = normalize_whitespace(&pasted_text);
    let source_candidates = derive_paste_source_spans(&normalized);
    if source_candidates.is_empty() {
        return Ok(failed_paste_study_set(
            study_set_id,
            user_id,
            title,
            course,
            document_id,
            session_id,
        ));
    }
    let source_text = source_candidates
        .iter()
        .map(|candidate| candidate.excerpt.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let concepts = extract_concepts(&source_text);
    if concepts.is_empty() {
        return Ok(failed_paste_study_set(
            study_set_id,
            user_id,
            title,
            course,
            document_id,
            session_id,
        ));
    }

    let source_quality = classify_paste_source_quality(&normalized);
    let sources = source_candidates
        .into_iter()
        .map(|candidate| StudySourceReference {
            source_id: Uuid::new_v4().to_string(),
            document_id: document_id.clone(),
            span: format!("chars:{}-{}", candidate.start_char, candidate.end_char),
            excerpt: candidate.excerpt,
            confidence: source_quality.confidence.clone(),
            retrieval_reason: source_quality.retrieval_reason.clone(),
        })
        .collect::<Vec<_>>();
    let questions = questions_for_concepts(&concepts, &sources, &title);
    let concepts = concepts
        .into_iter()
        .map(|concept| StudyConceptSummary {
            source_span_id: source_id_for_concept(&concept, &sources),
            public_id: concept.public_id,
            label: concept.label,
            status: ConceptStatus::Review,
        })
        .collect::<Vec<_>>();

    Ok(StudySetIngestionRecord {
        study_set: StudySetSummary {
            id: study_set_id,
            user_id,
            title,
            course,
            ingestion_status: StudySetIngestionStatus::Ready,
            ingestion_error: None,
        },
        documents: vec![StudyDocumentSummary {
            id: document_id,
            display_name: "Pasted notes".to_owned(),
            source_kind: "pasted_text".to_owned(),
            processing_status: StudySetIngestionStatus::Ready,
        }],
        source_spans: sources.iter().map(source_reference_to_summary).collect(),
        concepts,
        questions,
        session_id,
        session_token: None,
    })
}

pub(crate) fn generate_file_study_set(
    input: CreateFileStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let user_id = required_text(&input.user_id, "user_id")?.to_owned();
    let title = required_text(&input.title, "title")?.to_owned();
    let file_name = required_text(&input.file_name, "file_name")?.to_owned();
    let course = input.course.and_then(non_empty_owned);
    let failure_status = if input
        .study_set_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        StudySetIngestionStatus::Retry
    } else {
        StudySetIngestionStatus::Failed
    };
    let study_set_id = input
        .study_set_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let document_id = Uuid::new_v4().to_string();
    let session_id = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let source_kind = file_source_kind(&file_name, input.content_type.as_deref());
    let normalized = normalize_file_bytes(&input.file_bytes);
    let source_candidates = derive_paste_source_spans(&normalized);
    if source_candidates.is_empty() {
        return Ok(failed_file_study_set(
            FailedFileStudySetInput {
                study_set_id,
                user_id,
                title,
                course,
                document_id,
                file_name,
                source_kind,
                session_id,
                status: failure_status.clone(),
            },
            "no usable source span could be derived from uploaded file",
        ));
    }
    let source_text = source_candidates
        .iter()
        .map(|candidate| candidate.excerpt.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let concepts = extract_concepts(&source_text);
    if concepts.is_empty() {
        return Ok(failed_file_study_set(
            FailedFileStudySetInput {
                study_set_id,
                user_id,
                title,
                course,
                document_id,
                file_name,
                source_kind,
                session_id,
                status: failure_status,
            },
            "no source-grounded concepts could be derived from uploaded file",
        ));
    }

    let source_quality = classify_file_source_quality(&normalized);
    let sources = source_candidates
        .into_iter()
        .map(|candidate| StudySourceReference {
            source_id: Uuid::new_v4().to_string(),
            document_id: document_id.clone(),
            span: format!(
                "document:chars:{}-{}",
                candidate.start_char, candidate.end_char
            ),
            excerpt: candidate.excerpt,
            confidence: source_quality.confidence.clone(),
            retrieval_reason: source_quality.retrieval_reason.clone(),
        })
        .collect::<Vec<_>>();
    let questions = questions_for_concepts(&concepts, &sources, &title);
    let concepts = concepts
        .into_iter()
        .map(|concept| StudyConceptSummary {
            source_span_id: source_id_for_concept(&concept, &sources),
            public_id: concept.public_id,
            label: concept.label,
            status: ConceptStatus::Review,
        })
        .collect::<Vec<_>>();

    Ok(StudySetIngestionRecord {
        study_set: StudySetSummary {
            id: study_set_id,
            user_id,
            title,
            course,
            ingestion_status: StudySetIngestionStatus::Ready,
            ingestion_error: None,
        },
        documents: vec![StudyDocumentSummary {
            id: document_id,
            display_name: file_name,
            source_kind,
            processing_status: StudySetIngestionStatus::Ready,
        }],
        source_spans: sources.iter().map(source_reference_to_summary).collect(),
        concepts,
        questions,
        session_id,
        session_token: None,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExtractedConcept {
    public_id: String,
    label: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PasteSourceSpanCandidate {
    start_char: usize,
    end_char: usize,
    excerpt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PasteSourceQuality {
    confidence: SourceConfidence,
    retrieval_reason: String,
}

fn required_text<'a>(value: &'a str, label: &str) -> Result<&'a str, PortError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(PortError::unavailable(
            "memory",
            label,
            format!("{label} is required"),
        ));
    }
    Ok(value)
}

fn non_empty_owned(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn normalize_whitespace(value: &str) -> String {
    strip_markup_tags(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_file_bytes(bytes: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(bytes);
    let printable = lossy
        .chars()
        .map(|ch| {
            if ch.is_control() && !ch.is_whitespace() {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    normalize_whitespace(&printable)
}

fn file_source_kind(file_name: &str, content_type: Option<&str>) -> String {
    let lower_name = file_name.to_ascii_lowercase();
    let lower_content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    if lower_name.ends_with(".pdf") || lower_content_type.contains("pdf") {
        "pdf".to_owned()
    } else {
        "file".to_owned()
    }
}

fn strip_markup_tags(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut stripped = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '<' {
            if let Some(close_index) = chars[index + 1..]
                .iter()
                .take(128)
                .position(|ch| *ch == '>')
                .map(|offset| index + 1 + offset)
            {
                let content = chars[index + 1..close_index].iter().collect::<String>();
                if is_plausible_markup_tag(&content) {
                    stripped.push(' ');
                    index = close_index + 1;
                    continue;
                }
            }
        }
        stripped.push(chars[index]);
        index += 1;
    }
    stripped
}

fn is_plausible_markup_tag(content: &str) -> bool {
    if content.is_empty() || content.chars().next().is_some_and(char::is_whitespace) {
        return false;
    }
    let trimmed = content.trim_end();
    let name = trimmed
        .strip_prefix('/')
        .or_else(|| trimmed.strip_prefix('!'))
        .unwrap_or(trimmed);
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let tag_name_len = std::iter::once(first)
        .chain(chars)
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .count();
    tag_name_len > 0 && !trimmed.chars().any(|ch| matches!(ch, '<' | '\n' | '\r'))
}

fn failed_paste_study_set(
    study_set_id: String,
    user_id: String,
    title: String,
    course: Option<String>,
    document_id: String,
    session_id: String,
) -> StudySetIngestionRecord {
    StudySetIngestionRecord {
        study_set: StudySetSummary {
            id: study_set_id,
            user_id,
            title,
            course,
            ingestion_status: StudySetIngestionStatus::Failed,
            ingestion_error: Some(
                "no usable source span could be derived from pasted text".to_owned(),
            ),
        },
        documents: vec![StudyDocumentSummary {
            id: document_id,
            display_name: "Pasted notes".to_owned(),
            source_kind: "pasted_text".to_owned(),
            processing_status: StudySetIngestionStatus::Failed,
        }],
        source_spans: vec![],
        concepts: vec![],
        questions: vec![],
        session_id,
        session_token: None,
    }
}

struct FailedFileStudySetInput {
    study_set_id: String,
    user_id: String,
    title: String,
    course: Option<String>,
    document_id: String,
    file_name: String,
    source_kind: String,
    session_id: String,
    status: StudySetIngestionStatus,
}

fn failed_file_study_set(
    input: FailedFileStudySetInput,
    reason: &'static str,
) -> StudySetIngestionRecord {
    StudySetIngestionRecord {
        study_set: StudySetSummary {
            id: input.study_set_id,
            user_id: input.user_id,
            title: input.title,
            course: input.course,
            ingestion_status: input.status.clone(),
            ingestion_error: Some(reason.to_owned()),
        },
        documents: vec![StudyDocumentSummary {
            id: input.document_id,
            display_name: input.file_name,
            source_kind: input.source_kind,
            processing_status: input.status,
        }],
        source_spans: vec![],
        concepts: vec![],
        questions: vec![],
        session_id: input.session_id,
        session_token: None,
    }
}

fn derive_paste_source_spans(text: &str) -> Vec<PasteSourceSpanCandidate> {
    let chars = text.chars().collect::<Vec<_>>();
    if !has_usable_source_text(&chars) {
        return vec![];
    }

    let mut raw_ranges = Vec::new();
    let mut start = 0;
    for (index, ch) in chars.iter().enumerate() {
        if is_source_sentence_boundary(&chars, index, *ch) {
            raw_ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < chars.len() {
        raw_ranges.push((start, chars.len()));
    }
    if raw_ranges.is_empty() {
        raw_ranges.push((0, chars.len()));
    }

    let bounded_ranges = select_source_ranges(&chars, &raw_ranges, text);

    let mut seen = std::collections::HashSet::new();
    bounded_ranges
        .into_iter()
        .filter_map(|(start, end)| {
            let (start, end) = trim_char_range(&chars, start, end)?;
            let excerpt = collect_chars(&chars, start, end);
            let key = excerpt.to_ascii_lowercase();
            if !seen.insert(key) {
                return None;
            }
            Some(PasteSourceSpanCandidate {
                start_char: start,
                end_char: end,
                excerpt,
            })
        })
        .take(MAX_PASTE_SOURCE_SPANS)
        .collect()
}

fn is_source_sentence_boundary(chars: &[char], index: usize, ch: char) -> bool {
    if ch == '.' {
        let previous_is_digit = index
            .checked_sub(1)
            .and_then(|previous| chars.get(previous))
            .is_some_and(|previous| previous.is_ascii_digit());
        let next_is_digit = chars
            .get(index + 1)
            .is_some_and(|next| next.is_ascii_digit());
        return !(previous_is_digit && next_is_digit);
    }
    matches!(ch, '?' | '!' | ';')
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ScoredSourceRange {
    index: usize,
    start: usize,
    end: usize,
    score: usize,
}

fn select_source_ranges(
    chars: &[char],
    raw_ranges: &[(usize, usize)],
    text: &str,
) -> Vec<(usize, usize)> {
    let mut bounded_ranges = Vec::new();
    if raw_ranges.len() == 1 {
        let (start, end) = raw_ranges[0];
        append_non_full_single_source_range(chars, start, end, &mut bounded_ranges);
        return bounded_ranges;
    }

    let compact_ambiguous = chars.len() <= MAX_PASTE_SOURCE_EXCERPT_CHARS
        && has_ambiguous_source_markers(&text.to_ascii_lowercase());
    if compact_ambiguous {
        let (start, end) = raw_ranges[0];
        append_bounded_source_ranges(chars, start, end, &mut bounded_ranges);
        return bounded_ranges;
    }

    let limit = MAX_PASTE_SOURCE_SPANS.min(raw_ranges.len());
    let mut selected = raw_ranges
        .iter()
        .enumerate()
        .filter_map(|(index, (start, end))| {
            let (start, end) = trim_char_range(chars, *start, *end)?;
            Some(ScoredSourceRange {
                index,
                start,
                end,
                score: source_range_score(chars, start, end),
            })
        })
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.index.cmp(&right.index))
    });
    selected.truncate(limit);
    selected.sort_by_key(|range| range.index);
    let truncate_last_selected_range = selected.len() == raw_ranges.len();
    let last_selected_index = selected.last().map(|range| range.index);
    for range in selected {
        if truncate_last_selected_range && Some(range.index) == last_selected_index {
            append_non_full_single_source_range(chars, range.start, range.end, &mut bounded_ranges);
        } else {
            append_bounded_source_ranges(chars, range.start, range.end, &mut bounded_ranges);
        }
    }
    bounded_ranges
}

fn source_range_score(chars: &[char], start: usize, end: usize) -> usize {
    let text = collect_chars(chars, start, end);
    extract_concepts(&text).len()
}

fn append_non_full_single_source_range(
    chars: &[char],
    start: usize,
    end: usize,
    bounded_ranges: &mut Vec<(usize, usize)>,
) {
    let Some((start, end)) = trim_char_range(chars, start, end) else {
        return;
    };
    let token_ranges = token_char_ranges(chars, start, end);
    if token_ranges.len() < 2 {
        return;
    }
    let mut candidate_end = token_ranges[token_ranges.len() - 2].1;
    while candidate_end > start && chars[candidate_end - 1].is_whitespace() {
        candidate_end -= 1;
    }
    if candidate_end <= start {
        return;
    }
    if candidate_end - start > MAX_PASTE_SOURCE_EXCERPT_CHARS {
        append_bounded_source_ranges(chars, start, candidate_end, bounded_ranges);
    } else {
        bounded_ranges.push((start, candidate_end));
    }
}

fn append_bounded_source_ranges(
    chars: &[char],
    start: usize,
    end: usize,
    bounded_ranges: &mut Vec<(usize, usize)>,
) {
    let Some((mut cursor, end)) = trim_char_range(chars, start, end) else {
        return;
    };
    while cursor < end {
        let remaining = end - cursor;
        if remaining <= MAX_PASTE_SOURCE_EXCERPT_CHARS {
            bounded_ranges.push((cursor, end));
            break;
        }

        let hard_end = cursor + MAX_PASTE_SOURCE_EXCERPT_CHARS;
        let split_end = preferred_source_break(chars, cursor, hard_end).unwrap_or(hard_end);
        bounded_ranges.push((cursor, split_end));
        cursor = split_end;
        while cursor < end && chars[cursor].is_whitespace() {
            cursor += 1;
        }
    }
}

fn token_char_ranges(chars: &[char], start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut tokens = Vec::new();
    let mut token_start = None;
    for (index, ch) in chars.iter().enumerate().take(end).skip(start) {
        if ch.is_alphanumeric() {
            token_start.get_or_insert(index);
        } else if let Some(start) = token_start.take() {
            tokens.push((start, index));
        }
    }
    if let Some(start) = token_start {
        tokens.push((start, end));
    }
    tokens
}

fn preferred_source_break(chars: &[char], start: usize, hard_end: usize) -> Option<usize> {
    let minimum = start + (MAX_PASTE_SOURCE_EXCERPT_CHARS / 2);
    for index in (minimum..hard_end).rev() {
        if chars[index].is_whitespace() || matches!(chars[index], ',' | ':' | ';' | '.') {
            return Some((index + 1).min(hard_end));
        }
    }
    None
}

fn trim_char_range(chars: &[char], start: usize, end: usize) -> Option<(usize, usize)> {
    let mut start = start.min(chars.len());
    let mut end = end.min(chars.len());
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    if start >= end || !has_usable_source_text(&chars[start..end]) {
        None
    } else {
        Some((start, end))
    }
}

fn collect_chars(chars: &[char], start: usize, end: usize) -> String {
    chars[start..end].iter().collect()
}

fn has_usable_source_text(chars: &[char]) -> bool {
    let mut alpha_count = 0;
    let mut current_token_alpha = 0;
    let mut has_word_token = false;
    for ch in chars {
        if ch.is_alphabetic() {
            alpha_count += 1;
            current_token_alpha += 1;
        } else if ch.is_alphanumeric() {
            current_token_alpha += 1;
        } else {
            if current_token_alpha >= 3 {
                has_word_token = true;
            }
            current_token_alpha = 0;
        }
    }
    if current_token_alpha >= 3 {
        has_word_token = true;
    }
    alpha_count >= 3 && has_word_token
}

fn classify_paste_source_quality(text: &str) -> PasteSourceQuality {
    let lower = text.to_ascii_lowercase();
    if has_ambiguous_source_markers(&lower) {
        return PasteSourceQuality {
            confidence: SourceConfidence::Low,
            retrieval_reason:
                "ambiguous paste; bounded server-owned source span selected for review".to_owned(),
        };
    }
    if text.chars().count() <= 80 {
        return PasteSourceQuality {
            confidence: SourceConfidence::Medium,
            retrieval_reason:
                "short paste; bounded server-owned source span selected for source reference"
                    .to_owned(),
        };
    }
    PasteSourceQuality {
        confidence: SourceConfidence::High,
        retrieval_reason: "server-owned paste ingestion bounded source-specific excerpt".to_owned(),
    }
}

fn classify_file_source_quality(text: &str) -> PasteSourceQuality {
    let ambiguous = text.split_whitespace().any(|token| {
        matches!(
            token.to_ascii_lowercase().as_str(),
            "maybe" | "unclear" | "todo"
        )
    });
    if ambiguous {
        return PasteSourceQuality {
            confidence: SourceConfidence::Low,
            retrieval_reason:
                "server-owned file ingestion bounded document-level excerpt; ambiguous source text"
                    .to_owned(),
        };
    }
    PasteSourceQuality {
        confidence: SourceConfidence::Medium,
        retrieval_reason:
            "server-owned file ingestion bounded document-level excerpt; exact page/bbox provenance unverified"
                .to_owned(),
    }
}

fn has_ambiguous_source_markers(lower: &str) -> bool {
    lower.contains("maybe")
        || lower.contains("not sure")
        || lower.contains("unclear")
        || lower.contains("ask professor")
}

fn source_id_for_concept(concept: &ExtractedConcept, sources: &[StudySourceReference]) -> String {
    source_for_concept(concept, sources).source_id.clone()
}

fn questions_for_concepts(
    concepts: &[ExtractedConcept],
    sources: &[StudySourceReference],
    title: &str,
) -> Vec<StudyQuestion> {
    concepts
        .iter()
        .map(|concept| {
            let source = source_for_concept(concept, sources).clone();
            let secondary = follow_up_concept_label(concepts, concept, &source)
                .unwrap_or(title)
                .to_owned();
            StudyQuestion {
                question_id: format!("q-{}", concept.public_id),
                prompt: format!(
                    "Explain {} in your own words using the pasted notes.",
                    concept.label
                ),
                expected_terms: expected_terms_for_concept(concepts, concept, &source),
                follow_up: format!(
                    "Now connect {} to {secondary} in one precise sentence.",
                    concept.label
                ),
                source,
            }
        })
        .collect()
}

fn expected_terms_for_concept(
    concepts: &[ExtractedConcept],
    primary: &ExtractedConcept,
    source: &StudySourceReference,
) -> Vec<String> {
    let mut terms = Vec::new();
    push_expected_term(&mut terms, &primary.label);
    let source_lower = source.excerpt.to_ascii_lowercase();
    for concept in concepts {
        if concept.public_id != primary.public_id
            && source_lower.contains(&concept.label.to_ascii_lowercase())
        {
            push_expected_term(&mut terms, &concept.label);
        }
    }
    for concept in concepts {
        if concept.public_id != primary.public_id {
            push_expected_term(&mut terms, &concept.label);
        }
        if terms.len() >= 4 {
            break;
        }
    }
    terms
}

fn push_expected_term(terms: &mut Vec<String>, term: &str) {
    if !terms.iter().any(|known| known == term) {
        terms.push(term.to_owned());
    }
}

fn follow_up_concept_label<'a>(
    concepts: &'a [ExtractedConcept],
    primary: &ExtractedConcept,
    source: &StudySourceReference,
) -> Option<&'a str> {
    let source_lower = source.excerpt.to_ascii_lowercase();
    concepts
        .iter()
        .find(|concept| {
            concept.public_id != primary.public_id
                && source_lower.contains(&concept.label.to_ascii_lowercase())
        })
        .or_else(|| {
            concepts
                .iter()
                .find(|concept| concept.public_id != primary.public_id)
        })
        .map(|concept| concept.label.as_str())
}

fn source_for_concept<'a>(
    concept: &ExtractedConcept,
    sources: &'a [StudySourceReference],
) -> &'a StudySourceReference {
    let label = concept.label.to_ascii_lowercase();
    sources
        .iter()
        .find(|source| source.excerpt.to_ascii_lowercase().contains(&label))
        .unwrap_or(&sources[0])
}

fn extract_concepts(text: &str) -> Vec<ExtractedConcept> {
    let mut seen = std::collections::HashSet::new();
    let mut concepts = Vec::new();
    for raw in text.split(|ch: char| !ch.is_alphanumeric()) {
        let trimmed = raw.trim();
        let lower = trimmed.to_ascii_lowercase();
        if !is_concept_token(trimmed, &lower) || is_stop_word(&lower) || !seen.insert(lower.clone())
        {
            continue;
        }
        concepts.push(ExtractedConcept {
            public_id: slugify(&lower),
            label: concept_label(trimmed, &lower),
        });
        if concepts.len() >= 4 {
            break;
        }
    }
    concepts
}

fn is_concept_token(raw: &str, lower: &str) -> bool {
    if raw.is_empty() || !raw.chars().any(char::is_alphabetic) {
        return false;
    }
    if is_stop_word(lower) {
        return false;
    }
    if raw.chars().count() >= 5 {
        return true;
    }
    let alphabetic_count = raw.chars().filter(|ch| ch.is_alphabetic()).count();
    let acronym_like = alphabetic_count >= 3
        && raw
            .chars()
            .filter(|ch| ch.is_alphabetic())
            .all(|ch| ch.is_uppercase());
    let code_like = raw.chars().count() >= 3 && raw.chars().any(|ch| ch.is_ascii_digit());
    acronym_like || code_like
}

fn concept_label(raw: &str, lower: &str) -> String {
    let alphabetic = raw
        .chars()
        .filter(|ch| ch.is_alphabetic())
        .collect::<Vec<_>>();
    if !alphabetic.is_empty() && alphabetic.iter().all(|ch| ch.is_uppercase()) {
        return raw.to_owned();
    }
    if raw.chars().any(|ch| ch.is_ascii_digit()) {
        return raw.to_ascii_uppercase();
    }
    title_case(lower)
}

fn is_stop_word(value: &str) -> bool {
    matches!(
        value,
        "about"
            | "after"
            | "before"
            | "course"
            | "exam"
            | "explain"
            | "first"
            | "later"
            | "maybe"
            | "notes"
            | "professor"
            | "their"
            | "there"
            | "these"
            | "those"
            | "unclear"
            | "using"
            | "where"
            | "which"
            | "while"
    )
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "generated-question".to_owned()
    } else {
        slug
    }
}

fn title_case(value: &str) -> String {
    value
        .split('-')
        .flat_map(|part| part.split_whitespace())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
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
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?
            .sessions
            .iter()
            .rev()
            .find(|session| session.user_id == user_id)
            .cloned())
    }

    async fn save(&self, session: &VoiceSessionRecord) -> Result<(), PortError> {
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
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
        }
    }

    async fn pending_answer_attempts_for_session(
        &self,
        voice_session_id: &str,
    ) -> Result<usize, PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
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
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
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
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Ok(state.answer_attempts.iter().any(|attempt| {
            attempt.user_id == user_id
                && attempt.study_set_id == study_set_id
                && attempt.voice_session_id == voice_session_id
                && attempt.response_id == response_id
        }))
    }

    async fn record_voice_session(&self, config: &SessionConfig) -> Result<(), PortError> {
        let user_id = required_user_id(config)?;
        let study_set_id = required_study_set_id(config)?;
        let voice_session_id = required_session_id(config)?;
        {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            Self::study_set_locked(&state, user_id, study_set_id)?;
            if let Some(existing) = state
                .sessions
                .iter()
                .find(|session| session.voice_session_id == voice_session_id)
            {
                if existing.user_id != user_id || existing.study_set_id != study_set_id {
                    return Err(PortError::adapter(
                        "memory",
                        "voice session ownership cannot be changed",
                    ));
                }
                if existing.status != "open" {
                    return Err(PortError::unavailable(
                        "memory",
                        voice_session_id,
                        "closed voice session cannot be reopened",
                    ));
                }
            }
        }
        self.save(&VoiceSessionRecord::from_config(config)).await
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Self::study_set_locked(&state, &claim.user_id, &claim.study_set_id)?;
        if state.session_token_nonces.iter().any(|used| {
            used.user_id == claim.user_id
                && used.study_set_id == claim.study_set_id
                && used.voice_session_id == claim.voice_session_id
                && used.nonce == claim.nonce
        }) {
            return Err(PortError::unavailable(
                "memory",
                format!(
                    "{}/{}/{}",
                    claim.user_id, claim.study_set_id, claim.voice_session_id
                ),
                "session token nonce already used",
            ));
        }
        state.session_token_nonces.push(claim);
        Ok(())
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<Value, PortError> {
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
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
        state
            .event_authorizations
            .retain(|record| record.voice_session_id != voice_session_id);
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
        let generated = generate_paste_study_set(input)?;
        {
            let mut state = self
                .inner
                .write()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            Self::persist_ingestion_record_locked(&mut state, &generated, false);
        }
        Ok(generated)
    }

    async fn create_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        let generated = generate_file_study_set(input)?;
        {
            let mut state = self
                .inner
                .write()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            Self::persist_ingestion_record_locked(&mut state, &generated, false);
        }
        Ok(generated)
    }

    async fn retry_file_study_set(
        &self,
        input: CreateFileStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        let study_set_id = input
            .study_set_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                PortError::unavailable("memory", "file_retry", "study_set_id is required")
            })?
            .to_owned();
        let (title, course) = {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            let existing = Self::study_set_locked(&state, &input.user_id, &study_set_id)?;
            (existing.title.clone(), existing.course.clone())
        };
        let generated = generate_file_study_set(CreateFileStudySet {
            user_id: input.user_id,
            study_set_id: Some(study_set_id),
            title,
            course,
            exam_date: input.exam_date,
            file_name: input.file_name,
            content_type: input.content_type,
            file_bytes: input.file_bytes,
            session_id: input.session_id,
        })?;
        {
            let mut state = self
                .inner
                .write()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            Self::persist_ingestion_record_locked(&mut state, &generated, true);
        }
        Ok(generated)
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        let Some(study_set) = state.study_sets.get(study_set_id) else {
            return Ok(None);
        };
        if study_set.user_id != user_id {
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
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;

        let mut study_sets = state
            .study_sets
            .values()
            .filter(|study_set| study_set.user_id == user_id)
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

        let mut sessions = state
            .sessions
            .iter()
            .filter(|session| {
                session.user_id == user_id
                    && session.status == "closed"
                    && session.terminal_reason.as_deref() == Some("completed")
            })
            .map(|session| {
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
                let next_review = state
                    .review_items
                    .iter()
                    .filter(|review| {
                        review.user_id == user_id
                            && review.study_set_id == session.study_set_id
                            && review.voice_session_id == session.voice_session_id
                    })
                    .min_by(|a, b| {
                        a.due_at
                            .cmp(&b.due_at)
                            .then_with(|| a.concept_id.cmp(&b.concept_id))
                    })
                    .map(|review| {
                        let concept = state
                            .concepts
                            .get(&concept_key(&review.study_set_id, &review.concept_id));
                        let status = state
                            .concept_statuses
                            .iter()
                            .rev()
                            .find(|record| {
                                record.user_id == user_id
                                    && record.study_set_id == review.study_set_id
                                    && record.voice_session_id == review.voice_session_id
                                    && record.concept_id == review.concept_id
                            })
                            .map(|record| record.status.clone())
                            .or_else(|| concept.map(|record| record.status.clone()))
                            .unwrap_or(ConceptStatus::Review);

                        LibraryNextReviewSummary {
                            concept_id: review.concept_id.clone(),
                            label: concept
                                .map(|record| record.label.clone())
                                .unwrap_or_else(|| review.concept_id.clone()),
                            status,
                            persisted_due_at: review.due_at.clone(),
                            source: "persisted_review_item".to_owned(),
                        }
                    });

                LibrarySessionSummary {
                    voice_session_id: session.voice_session_id.clone(),
                    user_id: session.user_id.clone(),
                    study_set_id: session.study_set_id.clone(),
                    study_set_title,
                    status: session.status.clone(),
                    terminal_reason: session.terminal_reason.clone(),
                    recap,
                    next_review,
                }
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            b.voice_session_id
                .cmp(&a.voice_session_id)
                .then_with(|| a.study_set_title.cmp(&b.study_set_title))
        });

        Ok(StudyLibrarySnapshot {
            user_id: user_id.to_owned(),
            study_sets,
            sessions,
        })
    }

    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Value, PortError> {
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Self::study_set_locked(&state, user_id, study_set_id)?;

        let mut deleted_documents = 0usize;
        for document in state
            .documents
            .values_mut()
            .filter(|document| document.study_set_id == study_set_id && !document.tombstoned)
        {
            document.tombstoned = true;
            deleted_documents += 1;
        }

        let mut deleted_source_spans = 0usize;
        for span in state
            .source_spans
            .values_mut()
            .filter(|span| span.study_set_id == study_set_id && !span.tombstoned)
        {
            span.tombstoned = true;
            deleted_source_spans += 1;
        }

        let mut disabled_questions = 0usize;
        for question in state
            .questions
            .values_mut()
            .filter(|question| question.study_set_id == study_set_id && question.active)
        {
            question.active = false;
            disabled_questions += 1;
        }

        let mut hidden_sessions = 0usize;
        let mut affected_sessions = HashSet::new();
        for session in state
            .sessions
            .iter_mut()
            .filter(|session| session.user_id == user_id && session.study_set_id == study_set_id)
        {
            affected_sessions.insert(session.voice_session_id.clone());
            if session.status == "deleted" {
                continue;
            }
            session.status = "deleted".to_owned();
            session.ended_at.get_or_insert_with(|| "deleted".to_owned());
            session.terminal_reason = Some("deleted".to_owned());
            hidden_sessions += 1;
        }

        remove_session_artifacts(&mut state, user_id, study_set_id, &affected_sessions);

        Ok(json!({
            "study_set_id": study_set_id,
            "status": "deleted",
            "deleted_documents": deleted_documents,
            "deleted_source_spans": deleted_source_spans,
            "disabled_questions": disabled_questions,
            "hidden_sessions": hidden_sessions,
        }))
    }

    async fn delete_session_history(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<Value, PortError> {
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Self::study_set_locked(&state, user_id, study_set_id)?;

        let session = state
            .sessions
            .iter_mut()
            .find(|session| session.voice_session_id == voice_session_id)
            .ok_or_else(|| {
                PortError::unavailable("memory", voice_session_id, "voice session does not exist")
            })?;
        if session.user_id != user_id || session.study_set_id != study_set_id {
            return Err(PortError::unavailable(
                "memory",
                voice_session_id,
                "voice session is not available for this user and study set",
            ));
        }

        let already_deleted = session.status == "deleted";
        session.status = "deleted".to_owned();
        session.ended_at.get_or_insert_with(|| "deleted".to_owned());
        session.terminal_reason = Some("deleted".to_owned());

        let affected_sessions = HashSet::from([voice_session_id.to_owned()]);
        remove_session_artifacts(&mut state, user_id, study_set_id, &affected_sessions);

        Ok(json!({
            "voice_session_id": voice_session_id,
            "study_set_id": study_set_id,
            "status": "deleted",
            "already_deleted": already_deleted,
        }))
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Self::active_question_locked(&state, user_id, study_set_id)
    }

    async fn authorize_question_started(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        let canonical =
            Self::active_question_locked(&state, user_id, study_set_id)?.ok_or_else(|| {
                PortError::unavailable(
                    "memory",
                    &question.question_id,
                    "question is not active for this study set",
                )
            })?;
        if canonical != *question {
            return Err(PortError::adapter(
                "memory",
                "question tuple does not match deterministic retrieval",
            ));
        }
        Ok(())
    }

    async fn authorize_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: &AnswerEvaluation,
    ) -> Result<(), PortError> {
        evaluation
            .validate_fail_closed()
            .map_err(|reason| PortError::adapter("memory", reason))?;
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        let canonical_source = Self::active_question_source_locked(
            study_set,
            &state,
            user_id,
            &evaluation.question_id,
        )?;
        if canonical_source != evaluation.source {
            return Err(PortError::adapter(
                "memory",
                "answer evaluation source tuple does not match active question source",
            ));
        }
        let persisted = PersistedAnswerEvaluation::from(evaluation);
        if !state.answer_attempts.iter().any(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.response_id == response_id
                && record.evaluation.as_ref() == Some(&persisted)
        }) {
            return Err(PortError::adapter(
                "memory",
                "answer evaluation event does not match persisted answer attempt",
            ));
        }
        let authorization = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::AnswerEvaluation,
            evaluation,
        )?;
        if !state.event_authorizations.contains(&authorization) {
            return Err(PortError::adapter(
                "memory",
                "answer evaluation event does not match authorized browser payload",
            ));
        }
        Ok(())
    }

    async fn authorize_source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        source: &StudySourceReference,
    ) -> Result<(), PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        let canonical =
            Self::source_reference_locked(&state, user_id, study_set_id, &source.source_id)
                .ok_or_else(|| {
                    PortError::unavailable(
                        "memory",
                        &source.source_id,
                        "source reference is not available for this user and study set",
                    )
                })?;
        if canonical != *source {
            return Err(PortError::adapter(
                "memory",
                "source tuple does not match deterministic retrieval",
            ));
        }
        Ok(())
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
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        Self::ensure_concept_locked(study_set, &state, concept_id)?;
        if !state.concept_statuses.iter().any(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.concept_id == concept_id
                && record.status == *status
        }) {
            return Err(PortError::adapter(
                "memory",
                "concept status event does not match persisted concept status write",
            ));
        }
        let payload = ConceptStatusEventPayload { concept_id, status };
        let authorization = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )?;
        if !state.event_authorizations.contains(&authorization) {
            return Err(PortError::adapter(
                "memory",
                "concept status event does not match authorized browser payload",
            ));
        }
        Ok(())
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &agent_domain::ManuscriptIntent,
    ) -> Result<(), PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        match intent {
            agent_domain::ManuscriptIntent::Scene { .. } => Ok(()),
            agent_domain::ManuscriptIntent::Entity {
                entity_id,
                entity_kind,
                ..
            } => match entity_kind {
                agent_domain::ManuscriptEntityKind::Concept => {
                    Self::ensure_concept_locked(study_set, &state, entity_id)
                }
                agent_domain::ManuscriptEntityKind::Source => {
                    Self::source_reference_locked(&state, user_id, study_set_id, entity_id)
                        .map(|_| ())
                        .ok_or_else(|| {
                            PortError::unavailable(
                                "memory",
                                entity_id,
                                "source entity is not available for this study set",
                            )
                        })
                }
                agent_domain::ManuscriptEntityKind::MarginalNote => Err(PortError::unavailable(
                    "memory",
                    entity_id,
                    "marginal note entity is not server-owned",
                )),
            },
            agent_domain::ManuscriptIntent::Marginalia {
                anchor_entity_id, ..
            } => {
                if Self::ensure_concept_locked(study_set, &state, anchor_entity_id).is_ok()
                    || Self::source_reference_locked(
                        &state,
                        user_id,
                        study_set_id,
                        anchor_entity_id,
                    )
                    .is_some()
                {
                    return Ok(());
                }
                Err(PortError::unavailable(
                    "memory",
                    anchor_entity_id,
                    "marginalia anchor is not available for this study set",
                ))
            }
        }
    }

    async fn authorize_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: &StudySessionRecap,
    ) -> Result<(), PortError> {
        if recap.voice_session_id != voice_session_id {
            return Err(PortError::adapter(
                "memory",
                "recap session does not match authorized session",
            ));
        }
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        let _study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
        Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        for moment in &recap.source_moments {
            let canonical = Self::source_reference_locked(
                &state,
                user_id,
                study_set_id,
                &moment.source.source_id,
            )
            .ok_or_else(|| {
                PortError::unavailable(
                    "memory",
                    moment.source.source_id.clone(),
                    "recap source reference unavailable",
                )
            })?;
            if canonical != moment.source {
                return Err(PortError::adapter(
                    "memory",
                    "recap source tuple does not match deterministic retrieval",
                ));
            }
        }
        let authorization = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            recap,
        )?;
        if !state.event_authorizations.contains(&authorization) {
            return Err(PortError::adapter(
                "memory",
                "recap event does not match authorized browser payload",
            ));
        }
        Ok(())
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
            .map_err(|reason| PortError::adapter("memory", reason))?;
        {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::active_question_source_locked(study_set, &state, user_id, &envelope.question_id)?;
        }
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
            .map_err(|error| PortError::adapter("memory", error.to_string()))?;
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        if let Some(existing) = state.answer_attempts.iter_mut().find(|existing| {
            existing.user_id == user_id
                && existing.study_set_id == study_set_id
                && existing.voice_session_id == voice_session_id
                && existing.response_id == envelope.response_id
        }) {
            if existing.envelope != record.envelope {
                return Err(PortError::adapter(
                    "memory",
                    "answer attempt envelope cannot be changed",
                ));
            }
            return serde_json::to_value(existing)
                .map_err(|error| PortError::adapter("memory", error.to_string()));
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
        evaluation
            .validate_fail_closed()
            .map_err(|reason| PortError::adapter("memory", reason))?;
        let canonical_source = {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::active_question_source_locked(study_set, &state, user_id, &evaluation.question_id)
        }?;
        if canonical_source != evaluation.source {
            return Err(PortError::adapter(
                "memory",
                "answer evaluation source tuple does not match active question source",
            ));
        }
        let persisted_evaluation = PersistedAnswerEvaluation::from(&evaluation);
        let authorization = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::AnswerEvaluation,
            &evaluation,
        )?;
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        let result = if let Some(existing) = state.answer_attempts.iter_mut().find(|record| {
            record.user_id == user_id
                && record.study_set_id == study_set_id
                && record.voice_session_id == voice_session_id
                && record.response_id == response_id
        }) {
            if existing.envelope.question_id != evaluation.question_id {
                return Err(PortError::adapter(
                    "memory",
                    "answer evaluation question does not match attempt envelope",
                ));
            }
            existing.evaluation = Some(persisted_evaluation);
            serde_json::to_value(existing)
                .map_err(|error| PortError::adapter("memory", error.to_string()))?
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
                .map_err(|error| PortError::adapter("memory", error.to_string()))?;
            state.answer_attempts.push(record);
            result
        };
        state.event_authorizations.push(authorization);
        Ok(result)
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        let state = self
            .inner
            .read()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
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
        {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::ensure_concept_locked(study_set, &state, concept_id)?;
        }
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
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::ConceptStatus,
            &payload,
        )?;
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        if state.event_authorizations.contains(&authorization) {
            return Ok(status);
        }
        if let Some(concept) = state
            .concepts
            .get_mut(&concept_key(study_set_id, concept_id))
        {
            concept.status = status.clone();
        }
        state.concept_statuses.push(record);
        state.event_authorizations.push(authorization);
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
        {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            let study_set = Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
            Self::ensure_concept_locked(study_set, &state, concept_id)?;
        }
        let record = ReviewItemRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            concept_id: concept_id.to_owned(),
            due_at: due_at.to_owned(),
        };
        let result = serde_json::to_value(&record)
            .map_err(|error| PortError::adapter("memory", error.to_string()))?;
        let mut state = self
            .inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
        if !state.review_items.contains(&record) {
            state.review_items.push(record);
        }
        Ok(result)
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
            return Err(PortError::adapter(
                "memory",
                "recap session does not match authorized session",
            ));
        }
        {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            Self::study_set_locked(&state, user_id, study_set_id)?;
            Self::ensure_session_locked(&state, user_id, study_set_id, voice_session_id)?;
        }
        for moment in &recap.source_moments {
            let canonical_source = {
                let state = self
                    .inner
                    .read()
                    .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
                Self::source_reference_locked(
                    &state,
                    user_id,
                    study_set_id,
                    &moment.source.source_id,
                )
            }
            .ok_or_else(|| {
                PortError::unavailable(
                    "memory",
                    moment.source.source_id.clone(),
                    "recap source reference is not available for this user and study set",
                )
            })?;
            if canonical_source != moment.source {
                return Err(PortError::adapter(
                    "memory",
                    "recap source tuple does not match deterministic retrieval",
                ));
            }
        }
        let record = RecapRecord {
            user_id: user_id.to_owned(),
            study_set_id: study_set_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            recap: PersistedSessionRecap::from(&recap),
        };
        let authorization = event_authorization_record(
            user_id,
            study_set_id,
            voice_session_id,
            response_id,
            EventAuthorizationKind::StudySessionRecap,
            &recap,
        )?;
        let result = serde_json::to_value(&record)
            .map_err(|error| PortError::adapter("memory", error.to_string()))?;
        {
            let mut state = self
                .inner
                .write()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            state.recaps.retain(|existing| {
                existing.user_id != record.user_id
                    || existing.study_set_id != record.study_set_id
                    || existing.voice_session_id != record.voice_session_id
            });
            state.recaps.push(record);
            state.event_authorizations.push(authorization);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use agent_domain::{
        fixture_question, fixture_source_reference, AuthorizedStudySession, ConceptStatus,
        RecapSourceMoment, SessionId, SourceConfidence, ToolProposal, VivaToolExecutor,
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
        store
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
        store
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
                        voice_session_id: session_id.to_owned(),
                        headline: "Durable recap".to_owned(),
                        summary: "Recorded from durable state.".to_owned(),
                        strong_concepts: vec!["oxidative-phosphorylation".to_owned()],
                        shaky_concepts: vec![],
                        missed_concepts: vec![],
                        review_later: vec!["atp-synthase".to_owned()],
                        next_action: "Continue".to_owned(),
                        source_moments: vec![],
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
        store
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
            prompt: "Where does FADH2 enter the electron transport chain?".to_owned(),
            expected_terms: vec!["complex ii".to_owned(), "fewer protons".to_owned()],
            follow_up: "Connect the entry point to ATP yield.".to_owned(),
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
    async fn file_ingestion_writes_pdf_artifacts_without_exact_region_provenance() {
        let store = InMemoryStudyStore::new();
        let file_text = [
            "%PDF-1.7",
            "Mitochondria electron transport builds a proton gradient across the inner membrane.",
            "NADH transfers electrons while oxygen accepts them at the end of the chain.",
            "ATP synthase uses chemiosmosis to make ATP from ADP.",
        ]
        .join("\n");

        let record = store
            .create_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Bio PDF".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: None,
                file_name: "Lecture 9.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
                file_bytes: file_text.as_bytes().to_vec(),
                session_id: Some("file-session-1".to_owned()),
            })
            .await
            .expect("file ingestion succeeds");

        assert_eq!(
            record.study_set.ingestion_status,
            StudySetIngestionStatus::Ready
        );
        assert_eq!(record.documents[0].display_name, "Lecture 9.pdf");
        assert_eq!(record.documents[0].source_kind, "pdf");
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
            "%PDF-1.7",
            "Electron transport in mitochondria transfers electrons from NADH to oxygen.",
            "The proton gradient powers ATP synthase during oxidative phosphorylation.",
        ]
        .join("\n");

        let record = store
            .create_file_study_set(CreateFileStudySet {
                user_id: "user-1".to_owned(),
                study_set_id: None,
                title: "Tool Flow PDF".to_owned(),
                course: Some("Biology 201".to_owned()),
                exam_date: None,
                file_name: "tool-flow.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
                file_bytes: file_text.as_bytes().to_vec(),
                session_id: Some("file-session-tool-flow".to_owned()),
            })
            .await
            .expect("file ingestion succeeds");
        let voice_session_id = "voice-session-file-flow";
        store
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
        let executor = VivaToolExecutor::new(
            store.clone(),
            AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: record.study_set.id.clone(),
                voice_session_id: voice_session_id.to_owned(),
                mode: StudyMode::Quiz,
                active_concepts: vec![concept_id.clone()],
            },
        );

        let selected = executor
            .execute(
                "response-file-0",
                ToolProposal::select_next_question(&record.study_set.id, voice_session_id, "quiz"),
            )
            .await
            .unwrap();
        assert_eq!(
            selected.result["question"]["source"]["source_id"],
            active_question.source.source_id
        );
        assert!(selected.result["question"]["source"]["span"]
            .as_str()
            .unwrap()
            .starts_with("document:chars:"));

        let source_result = executor
            .execute(
                "response-file-1",
                ToolProposal::retrieve_source_reference(
                    &record.study_set.id,
                    voice_session_id,
                    &active_question.source.source_id,
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            source_result.result["source"]["document_id"],
            record.documents[0].id
        );
        assert!(source_result.result["source"]["span"]
            .as_str()
            .unwrap()
            .starts_with("document:chars:"));

        let concept_status = executor
            .execute(
                "response-file-2",
                ToolProposal::mark_concept_status(
                    &record.study_set.id,
                    voice_session_id,
                    &concept_id,
                    "shaky",
                ),
            )
            .await
            .unwrap();
        assert_eq!(concept_status.result["concept_id"], concept_id);
        assert_eq!(concept_status.result["status"], "shaky");

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
                title: "Bad PDF".to_owned(),
                course: None,
                exam_date: None,
                file_name: "empty.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
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
                title: "Bad PDF".to_owned(),
                course: None,
                exam_date: None,
                file_name: "still-empty.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
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
                title: "Bad PDF".to_owned(),
                course: None,
                exam_date: None,
                file_name: "replacement.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
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
            store
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

        let first_executor = VivaToolExecutor::new(
            store.clone(),
            AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: first.study_set.id.clone(),
                voice_session_id: first.session_id.clone(),
                mode: StudyMode::Quiz,
                active_concepts: first
                    .concepts
                    .iter()
                    .map(|concept| concept.public_id.clone())
                    .collect(),
            },
        );
        let second_executor = VivaToolExecutor::new(
            store.clone(),
            AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: second.study_set.id.clone(),
                voice_session_id: second.session_id.clone(),
                mode: StudyMode::Quiz,
                active_concepts: second
                    .concepts
                    .iter()
                    .map(|concept| concept.public_id.clone())
                    .collect(),
            },
        );

        let first_question = first_executor
            .execute(
                "response-0",
                ToolProposal::select_next_question(&first.study_set.id, &first.session_id, "quiz"),
            )
            .await
            .expect("selects first generated question");
        let second_question = second_executor
            .execute(
                "response-0",
                ToolProposal::select_next_question(
                    &second.study_set.id,
                    &second.session_id,
                    "quiz",
                ),
            )
            .await
            .expect("selects second generated question");
        let first_question_id = first_question.result["question"]["question_id"]
            .as_str()
            .expect("question id");
        let second_question_id = second_question.result["question"]["question_id"]
            .as_str()
            .expect("question id");

        assert_ne!(first_question_id, "q-oxidative-phosphorylation-nadh");
        assert_ne!(second_question_id, "q-oxidative-phosphorylation-nadh");
        assert_ne!(first_question_id, second_question_id);
        assert_ne!(
            first_question.result["question"]["source"]["source_id"],
            "src-lecture-5-slide-18"
        );

        first_executor
            .execute(
                "response-1",
                ToolProposal::evaluate_spoken_answer(
                    &first.study_set.id,
                    &first.session_id,
                    first_question_id,
                    "mitosis chromosome spindle",
                ),
            )
            .await
            .expect("first generated answer records");
        let baseline_writes = store.write_counts();
        let wrong_set = first_executor
            .execute(
                "response-1",
                ToolProposal::evaluate_spoken_answer(
                    &first.study_set.id,
                    &first.session_id,
                    second_question_id,
                    "photosynthesis chloroplast",
                ),
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
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Closed".to_owned(),
                    summary: "Closed session recap.".to_owned(),
                    strong_concepts: vec!["NADH".to_owned()],
                    shaky_concepts: vec![],
                    missed_concepts: vec![],
                    review_later: vec![],
                    next_action: "Stop".to_owned(),
                    source_moments: vec![RecapSourceMoment {
                        text: "Closed recap source".to_owned(),
                        source: fixture_source_reference(),
                        status: ConceptStatus::Strong,
                    }],
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
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            strong_concepts: vec!["NADH".to_owned()],
            shaky_concepts: vec![],
            missed_concepts: vec![],
            review_later: vec!["ATP synthase".to_owned()],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![RecapSourceMoment {
                text: "NADH source".to_owned(),
                source: fixture_source_reference(),
                status: ConceptStatus::Strong,
            }],
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
            voice_session_id: "voice-session-1".to_owned(),
            headline: "First recap".to_owned(),
            summary: "Initial recap.".to_owned(),
            strong_concepts: vec!["NADH".to_owned()],
            shaky_concepts: vec![],
            missed_concepts: vec![],
            review_later: vec!["ATP synthase".to_owned()],
            next_action: "Review oxidative phosphorylation.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                text: "NADH source".to_owned(),
                source: fixture_source_reference(),
                status: ConceptStatus::Strong,
            }],
        };
        let second_recap = StudySessionRecap {
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Second recap".to_owned(),
            summary: "Replacement recap.".to_owned(),
            strong_concepts: vec!["ATP synthase".to_owned()],
            shaky_concepts: vec!["NADH".to_owned()],
            missed_concepts: vec![],
            review_later: vec![],
            next_action: "Compare electron transport steps.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                text: "ATP synthase source".to_owned(),
                source: fixture_source_reference(),
                status: ConceptStatus::Shaky,
            }],
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
            voice_session_id: "voice-session-2".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            strong_concepts: vec!["NADH".to_owned()],
            shaky_concepts: vec![],
            missed_concepts: vec![],
            review_later: vec!["ATP synthase".to_owned()],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![RecapSourceMoment {
                text: "Mismatched recap source".to_owned(),
                source: fixture_source_reference(),
                status: ConceptStatus::Strong,
            }],
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

        let mut forged_recap_source = fixture_source_reference();
        forged_recap_source.document_id = "wrong-doc".to_owned();
        let recap = StudySessionRecap {
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Done".to_owned(),
            summary: "Recap".to_owned(),
            strong_concepts: vec!["NADH".to_owned()],
            shaky_concepts: vec![],
            missed_concepts: vec![],
            review_later: vec!["ATP synthase".to_owned()],
            next_action: "Review tomorrow".to_owned(),
            source_moments: vec![RecapSourceMoment {
                text: "Forged recap source".to_owned(),
                source: forged_recap_source,
                status: ConceptStatus::Strong,
            }],
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
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Done".to_owned(),
                    summary: "Recap".to_owned(),
                    strong_concepts: vec!["NADH".to_owned()],
                    shaky_concepts: vec![],
                    missed_concepts: vec![],
                    review_later: vec!["ATP synthase".to_owned()],
                    next_action: "Review tomorrow".to_owned(),
                    source_moments: vec![RecapSourceMoment {
                        text: "NADH source".to_owned(),
                        source: fixture_source_reference(),
                        status: ConceptStatus::Strong,
                    }],
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
    async fn server_tool_executor_handles_all_viva_tools_with_authorized_session() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;
        let executor = VivaToolExecutor::new(
            store.clone(),
            AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: "biology-midterm".to_owned(),
                voice_session_id: "voice-session-1".to_owned(),
                mode: StudyMode::Quiz,
                active_concepts: vec![
                    "oxidative-phosphorylation".to_owned(),
                    "atp-synthase".to_owned(),
                ],
            },
        );
        let question = executor
            .execute(
                "response-0",
                ToolProposal::select_next_question("biology-midterm", "voice-session-1", "quiz"),
            )
            .await
            .unwrap();
        assert_eq!(
            question.result["question"]["source"]["source_id"],
            "src-lecture-5-slide-18"
        );

        executor
            .execute(
                "response-1",
                ToolProposal::evaluate_spoken_answer(
                    "biology-midterm",
                    "voice-session-1",
                    "q-oxidative-phosphorylation-nadh",
                    "NADH donates electrons.",
                ),
            )
            .await
            .unwrap();
        executor
            .execute(
                "response-1",
                ToolProposal::retrieve_source_reference(
                    "biology-midterm",
                    "voice-session-1",
                    "src-lecture-5-slide-18",
                ),
            )
            .await
            .unwrap();
        executor
            .execute(
                "response-1",
                ToolProposal::mark_concept_status(
                    "biology-midterm",
                    "voice-session-1",
                    "oxidative-phosphorylation",
                    "strong",
                ),
            )
            .await
            .unwrap();
        executor
            .execute(
                "response-1",
                ToolProposal::schedule_review_item(
                    "biology-midterm",
                    "voice-session-1",
                    "atp-synthase",
                    "shaky",
                ),
            )
            .await
            .unwrap();
        executor
            .execute(
                "response-0",
                ToolProposal::build_session_recap("biology-midterm", "voice-session-1"),
            )
            .await
            .unwrap();
        executor
            .execute(
                "response-1",
                ToolProposal::challenge_correction(
                    "biology-midterm",
                    "voice-session-1",
                    &fixture_source_reference(),
                    "correction-1",
                    "Re-check this source.",
                ),
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
    async fn server_tool_executor_replay_keeps_store_counts_exact() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;
        let executor = VivaToolExecutor::new(
            store.clone(),
            AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: "biology-midterm".to_owned(),
                voice_session_id: "voice-session-1".to_owned(),
                mode: StudyMode::Quiz,
                active_concepts: vec![
                    "oxidative-phosphorylation".to_owned(),
                    "atp-synthase".to_owned(),
                ],
            },
        );

        for _ in 0..2 {
            executor
                .execute(
                    "response-1",
                    ToolProposal::evaluate_spoken_answer(
                        "biology-midterm",
                        "voice-session-1",
                        "q-oxidative-phosphorylation-nadh",
                        "NADH donates electrons.",
                    ),
                )
                .await
                .unwrap();
            executor
                .execute(
                    "response-1",
                    ToolProposal::mark_concept_status(
                        "biology-midterm",
                        "voice-session-1",
                        "oxidative-phosphorylation",
                        "strong",
                    ),
                )
                .await
                .unwrap();
            executor
                .execute(
                    "response-1",
                    ToolProposal::schedule_review_item(
                        "biology-midterm",
                        "voice-session-1",
                        "atp-synthase",
                        "shaky",
                    ),
                )
                .await
                .unwrap();
            executor
                .execute(
                    "response-0",
                    ToolProposal::build_session_recap("biology-midterm", "voice-session-1"),
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
    async fn server_tool_executor_rejects_session_and_source_forgery() {
        let store = Arc::new(seeded_store());
        record_fixture_session(&store).await;
        let executor = VivaToolExecutor::new(
            store,
            AuthorizedStudySession {
                user_id: "user-1".to_owned(),
                study_set_id: "biology-midterm".to_owned(),
                voice_session_id: "voice-session-1".to_owned(),
                mode: StudyMode::Quiz,
                active_concepts: vec![
                    "oxidative-phosphorylation".to_owned(),
                    "atp-synthase".to_owned(),
                ],
            },
        );
        assert!(executor
            .execute(
                "response-0",
                ToolProposal::select_next_question("wrong-set", "voice-session-1", "quiz",),
            )
            .await
            .is_err());

        let mut forged_source = fixture_source_reference();
        forged_source.excerpt = "forged excerpt".to_owned();
        assert!(executor
            .execute(
                "response-1",
                ToolProposal::challenge_correction(
                    "biology-midterm",
                    "voice-session-1",
                    &forged_source,
                    "correction-1",
                    "Re-check this source.",
                ),
            )
            .await
            .is_err());
    }
}
