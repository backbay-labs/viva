use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use agent_domain::{
    AnswerEvaluation, ConceptStatus, CreatePasteStudySet, PortError, SessionConfig, SessionStore,
    SourceConfidence, StudyConceptSummary, StudyDocumentSummary, StudyMemoryStore, StudyMode,
    StudyQuestion, StudySessionRecap, StudySetIngestionRecord, StudySetIngestionStatus,
    StudySetSummary, StudySourceReference, StudySourceSpanSummary, StudyStoreBackend,
    StudyStoreCapabilities, StudyStoreWriteCounts,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnswerAttemptRecord {
    pub user_id: String,
    pub voice_session_id: String,
    pub evaluation: PersistedAnswerEvaluation,
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
        }) {
            return Ok(());
        }
        Err(PortError::unavailable(
            "memory",
            voice_session_id,
            "voice session is not available for this user and study set",
        ))
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
    let expected_terms = concepts
        .iter()
        .map(|concept| concept.label.clone())
        .collect::<Vec<_>>();
    let primary = concepts
        .first()
        .map(|concept| concept.label.as_str())
        .unwrap_or(title.as_str())
        .to_owned();
    let secondary = concepts
        .get(1)
        .map(|concept| concept.label.as_str())
        .unwrap_or("the source")
        .to_owned();
    let source = concepts
        .first()
        .map(|concept| source_for_concept(concept, &sources))
        .unwrap_or(&sources[0])
        .clone();
    let concepts = concepts
        .into_iter()
        .map(|concept| StudyConceptSummary {
            source_span_id: source_id_for_concept(&concept, &sources),
            public_id: concept.public_id,
            label: concept.label,
            status: ConceptStatus::Review,
        })
        .collect::<Vec<_>>();
    let question = StudyQuestion {
        question_id: format!("q-{}", slugify(&primary)),
        prompt: format!("Explain {primary} using the uploaded notes."),
        expected_terms,
        follow_up: format!("Now connect that answer to {secondary} in one precise sentence."),
        source: source.clone(),
    };

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
        questions: vec![question],
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

fn has_ambiguous_source_markers(lower: &str) -> bool {
    lower.contains("maybe")
        || lower.contains("not sure")
        || lower.contains("unclear")
        || lower.contains("ask professor")
}

fn source_id_for_concept(concept: &ExtractedConcept, sources: &[StudySourceReference]) -> String {
    source_for_concept(concept, sources).source_id.clone()
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

    async fn record_voice_session(&self, config: &SessionConfig) -> Result<(), PortError> {
        let user_id = required_user_id(config)?;
        let study_set_id = required_study_set_id(config)?;
        let _voice_session_id = required_session_id(config)?;
        {
            let state = self
                .inner
                .read()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
            Self::study_set_locked(&state, user_id, study_set_id)?;
        }
        self.save(&VoiceSessionRecord::from_config(config)).await
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
        session.status = "closed".to_owned();
        session.ended_at = Some("closed".to_owned());
        session.terminal_reason = Some(terminal_reason.to_owned());
        Ok(json!({
            "voice_session_id": voice_session_id,
            "status": session.status,
            "terminal_reason": terminal_reason,
        }))
    }

    async fn create_paste_study_set(
        &self,
        input: CreatePasteStudySet,
    ) -> Result<StudySetIngestionRecord, PortError> {
        let generated = generate_paste_study_set(input)?;
        let study_set_id = generated.study_set.id.clone();
        {
            let mut state = self
                .inner
                .write()
                .map_err(|_| PortError::adapter("memory", "lock poisoned"))?;
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

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
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
            Self::ensure_question_locked(study_set, &state, &evaluation.question_id)?;
            Self::source_reference_locked(
                &state,
                user_id,
                study_set_id,
                &evaluation.source.source_id,
            )
        }
        .ok_or_else(|| {
            PortError::unavailable(
                "memory",
                evaluation.source.source_id.clone(),
                "source reference is not available for this user and study set",
            )
        })?;
        if canonical_source != evaluation.source {
            return Err(PortError::adapter(
                "memory",
                "answer evaluation source tuple does not match deterministic retrieval",
            ));
        }
        let record = AnswerAttemptRecord {
            user_id: user_id.to_owned(),
            voice_session_id: voice_session_id.to_owned(),
            evaluation: PersistedAnswerEvaluation::from(&evaluation),
        };
        let result = serde_json::to_value(&record)
            .map_err(|error| PortError::adapter("memory", error.to_string()))?;
        self.inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?
            .answer_attempts
            .push(record);
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
        self.inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?
            .concept_statuses
            .push(record);
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
        self.inner
            .write()
            .map_err(|_| PortError::adapter("memory", "lock poisoned"))?
            .review_items
            .push(record);
        Ok(result)
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        recap: StudySessionRecap,
    ) -> Result<Value, PortError> {
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
        let result = serde_json::to_value(&record)
            .map_err(|error| PortError::adapter("memory", error.to_string()))?;
        self.save_recap(record);
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
            .record_answer_evaluation("user-1", "biology-midterm", "voice-session-1", evaluation)
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
        assert_eq!(record.questions.len(), 1);
        assert_ne!(
            record.questions[0].question_id,
            "q-oxidative-phosphorylation-nadh"
        );
        assert!(record
            .source_spans
            .iter()
            .any(|source| source.id == record.questions[0].source.source_id));
        for concept in &record.concepts {
            assert!(record
                .source_spans
                .iter()
                .any(|source| source.id == concept.source_span_id));
        }

        let snapshot_json = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!snapshot_json.contains(&full_notes));
        assert!(!snapshot_json.contains("NADH donates high-energy electrons"));
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
            .execute(ToolProposal::select_next_question(
                &first.study_set.id,
                &first.session_id,
                "quiz",
            ))
            .await
            .expect("selects first generated question");
        let second_question = second_executor
            .execute(ToolProposal::select_next_question(
                &second.study_set.id,
                &second.session_id,
                "quiz",
            ))
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
            .execute(ToolProposal::evaluate_spoken_answer(
                &first.study_set.id,
                &first.session_id,
                first_question_id,
                "mitosis chromosome spindle",
            ))
            .await
            .expect("first generated answer records");
        let baseline_writes = store.write_counts();
        let wrong_set = first_executor
            .execute(ToolProposal::evaluate_spoken_answer(
                &first.study_set.id,
                &first.session_id,
                second_question_id,
                "photosynthesis chloroplast",
            ))
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
            .record_answer_evaluation("user-1", "biology-midterm", "voice-session-1", evaluation)
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
                    evaluation
                )
                .await
                .is_err());
        }
        assert!(store.snapshot().answer_attempts.is_empty());
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
            .record_answer_evaluation("user-1", "wrong-set", "voice-session-1", evaluation)
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
            .record_recap("user-1", "biology-midterm", "voice-session-1", recap)
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
            .execute(ToolProposal::select_next_question(
                "biology-midterm",
                "voice-session-1",
                "quiz",
            ))
            .await
            .unwrap();
        assert_eq!(
            question.result["question"]["source"]["source_id"],
            "src-lecture-5-slide-18"
        );

        executor
            .execute(ToolProposal::evaluate_spoken_answer(
                "biology-midterm",
                "voice-session-1",
                "q-oxidative-phosphorylation-nadh",
                "NADH donates electrons.",
            ))
            .await
            .unwrap();
        executor
            .execute(ToolProposal::retrieve_source_reference(
                "biology-midterm",
                "voice-session-1",
                "src-lecture-5-slide-18",
            ))
            .await
            .unwrap();
        executor
            .execute(ToolProposal::mark_concept_status(
                "biology-midterm",
                "voice-session-1",
                "oxidative-phosphorylation",
                "strong",
            ))
            .await
            .unwrap();
        executor
            .execute(ToolProposal::schedule_review_item(
                "biology-midterm",
                "voice-session-1",
                "atp-synthase",
                "2026-06-16T09:00:00Z",
            ))
            .await
            .unwrap();
        executor
            .execute(ToolProposal::build_session_recap(
                "biology-midterm",
                "voice-session-1",
            ))
            .await
            .unwrap();
        executor
            .execute(ToolProposal::challenge_correction(
                "biology-midterm",
                "voice-session-1",
                &fixture_source_reference(),
                "correction-1",
                "Re-check this source.",
            ))
            .await
            .unwrap();

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
            .execute(ToolProposal::select_next_question(
                "wrong-set",
                "voice-session-1",
                "quiz",
            ))
            .await
            .is_err());

        let mut forged_source = fixture_source_reference();
        forged_source.excerpt = "forged excerpt".to_owned();
        assert!(executor
            .execute(ToolProposal::challenge_correction(
                "biology-midterm",
                "voice-session-1",
                &forged_source,
                "correction-1",
                "Re-check this source.",
            ))
            .await
            .is_err());
    }
}
