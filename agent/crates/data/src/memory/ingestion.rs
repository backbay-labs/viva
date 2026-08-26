//! Ingestion: turning one learner upload into a study set (`DATA-014`, `DATA-015`).
//!
//! Owned invariant: nothing becomes a persisted artifact until the upload has been
//! classified and decoded. The PDF classifier runs before any decoding, ID
//! generation, or state write, and file bytes are decoded fallibly — never with
//! lossy replacement — so a rejected upload leaves the store byte-identical.
//!
//! Both backends generate their study sets through the same functions here, so the
//! concepts, questions, source spans, and bounds a paste or file produces cannot
//! differ between memory and Postgres. `memory.rs` keeps the port methods and
//! delegates their whole body here.

use super::*;

pub(super) const MAX_PASTE_SOURCE_EXCERPT_CHARS: usize = 360;
const MAX_PASTE_SOURCE_SPANS: usize = 4;

impl InMemoryStudyStore {
    /// Capture the study set's exam instant at ingestion so D-01's exam cap has the
    /// same authoritative input on this backend as `study_sets.exam_at` gives the
    /// Postgres backend. It is store context, never a tool argument.
    ///
    /// An absent exam date leaves the recorded instant untouched. A retry re-ingests
    /// the file without re-asking the learner for the exam date — the production
    /// retry route sends none every time — so writing that absence verbatim would
    /// erase the only authoritative input the cap has. Title and course already
    /// follow the same rule; clearing a recorded exam date is a separate, explicit
    /// operation (`set_study_set_exam_date`).
    fn capture_exam_instant_locked(
        state: &mut InMemoryStudyState,
        study_set_id: &str,
        exam_at: Option<DateTime<Utc>>,
    ) {
        if let Some(instant) = exam_at {
            state
                .study_set_exam_dates
                .insert(study_set_id.to_owned(), format_rfc3339_millis(instant));
        }
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
            // A retry replaces the question bank, so the cursor into it and the
            // outcomes bound to the replaced questions cannot survive it.
            state
                .turn_outcomes
                .retain(|record| record.study_set_id != study_set_id);
            state
                .challenge_resolutions
                .retain(|record| record.study_set_id != study_set_id);
            state
                .question_progressions
                .retain(|record| record.study_set_id != study_set_id);
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
    // Before normalization, source derivation, ID generation, or any state write: a
    // rejected PDF must leave the store byte-identical, and the cheapest way to
    // guarantee that is to have created nothing yet.
    if classify_uploaded_file(&file_name, input.content_type.as_deref(), &input.file_bytes)
        == UploadedFileKind::Pdf
    {
        return Err(unsupported_pdf_error());
    }
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
    let normalized = supported_text_from_bytes(&input.file_bytes)?;
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

/// `COR-04`: what an upload actually is, decided before a single byte is decoded.
///
/// The name and the declared content type both come from the client, so neither can
/// be the only signal; the `%PDF` magic is checked too. Nothing here inspects
/// content beyond the leading marker, because this classifier runs before there is
/// any decision to make about content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UploadedFileKind {
    Pdf,
    Utf8Text,
}

fn classify_uploaded_file(
    file_name: &str,
    content_type: Option<&str>,
    bytes: &[u8],
) -> UploadedFileKind {
    if file_name.to_ascii_lowercase().ends_with(".pdf") {
        return UploadedFileKind::Pdf;
    }
    if let Some(declared) = content_type {
        let media_type = declared.split(';').next().unwrap_or_default().trim();
        if media_type.eq_ignore_ascii_case("application/pdf") {
            return UploadedFileKind::Pdf;
        }
    }
    let mut rest = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    while let Some((first, tail)) = rest.split_first() {
        if first.is_ascii_whitespace() {
            rest = tail;
        } else {
            break;
        }
    }
    if rest.starts_with(b"%PDF") {
        return UploadedFileKind::Pdf;
    }
    UploadedFileKind::Utf8Text
}

/// `DATA-014`: the one typed refusal every PDF shape returns.
///
/// Viva has no page-aware extraction, so a PDF cannot be turned into grounded source
/// spans. Accepting it anyway produced study material made of PDF syntax — concepts
/// literally named "Catalog" and "Endobj" — which is worse than refusing, because
/// the learner cannot tell that their material was never read.
///
/// # Handoff to Plan 08 (HTTP mapping is Plan 08's, not this crate's)
///
/// The contract is exactly `kind() == PortErrorKind::InvalidInput`,
/// `port() == "study_store.file_ingestion"`, `id() == "unsupported_pdf"`, and this
/// bounded reason literal. Plan 08 maps `InvalidInput` uniformly to a sanitized HTTP
/// 400 with the fixed public message `"uploaded content is invalid or unsupported"`
/// and the route's coarse `file_ingestion_failed` / `file_retry_failed` code. It must
/// branch on `kind()`, never substring-match `reason()`, and must not add a
/// data-specific route escape hatch: `reason()` is diagnostic text and a consumer
/// that branches on it is one wording change away from failing open. Plan 08's
/// handler test submits the generated text / flate-compressed / scanned / encrypted /
/// malformed / magic-plus-plaintext matrix, asserts no raw bytes or error internals
/// reach the response, and verifies zero persisted artifacts through the store.
/// No new `PortErrorKind` is introduced for this, and this crate adds no PDF parser,
/// no OCR, and no claim of PDF support.
fn unsupported_pdf_error() -> PortError {
    PortError::invalid_input(
        "study_store.file_ingestion",
        "unsupported_pdf",
        "PDF ingestion requires page-aware extraction",
    )
}

/// The supported-text path. Invalid UTF-8 is refused, never repaired: a replacement
/// character is a fabricated learner fact, and every downstream artifact derived from
/// it would inherit the fabrication.
fn supported_text_from_bytes(bytes: &[u8]) -> Result<String, PortError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        PortError::invalid_input(
            "study_store.file_ingestion",
            "invalid_utf8_file",
            "uploaded file is not valid UTF-8 text",
        )
    })?;
    let printable = text
        .chars()
        .map(|ch| {
            if ch.is_control() && !ch.is_whitespace() {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    Ok(normalize_whitespace(&printable))
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
            let question_id = format!("q-{}", concept.public_id);
            let prompt = format!(
                "Explain {} in your own words using the pasted notes.",
                concept.label
            );
            let rubric = crate::generated_question_rubric(&question_id, &prompt, &source.source_id);
            StudyQuestion {
                question_id,
                concept_id: concept.public_id.clone(),
                prompt,
                expected_terms: expected_terms_for_concept(concepts, concept, &source),
                follow_up: format!(
                    "Now connect {} to {secondary} in one precise sentence.",
                    concept.label
                ),
                rubric,
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

/// The three ingestion port bodies. `memory.rs` keeps the trait signatures; the
/// work — exam capture, generation, and the single state write that commits the
/// generated artifacts — lives here.
pub(super) fn create_paste_study_set(
    store: &InMemoryStudyStore,
    input: CreatePasteStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let exam_at = crate::ingestion_exam_instant("memory", input.exam_date.as_deref())?;
    let generated = generate_paste_study_set(input)?;
    {
        let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
        InMemoryStudyStore::persist_ingestion_record_locked(&mut state, &generated, false);
        InMemoryStudyStore::capture_exam_instant_locked(
            &mut state,
            &generated.study_set.id,
            exam_at,
        );
    }
    Ok(generated)
}

pub(super) fn create_file_study_set(
    store: &InMemoryStudyStore,
    input: CreateFileStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let exam_at = crate::ingestion_exam_instant("memory", input.exam_date.as_deref())?;
    let generated = generate_file_study_set(input)?;
    {
        let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
        InMemoryStudyStore::persist_ingestion_record_locked(&mut state, &generated, false);
        InMemoryStudyStore::capture_exam_instant_locked(
            &mut state,
            &generated.study_set.id,
            exam_at,
        );
    }
    Ok(generated)
}

pub(super) fn retry_file_study_set(
    store: &InMemoryStudyStore,
    input: CreateFileStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let study_set_id = input
        .study_set_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PortError::unavailable("memory", "file_retry", "study_set_id is required"))?
        .to_owned();
    let (title, course) = {
        let state = store.inner.read().map_err(|_| state_lock_poisoned())?;
        let existing = InMemoryStudyStore::study_set_locked(&state, &input.user_id, &study_set_id)?;
        (existing.title.clone(), existing.course.clone())
    };
    let exam_at = crate::ingestion_exam_instant("memory", input.exam_date.as_deref())?;
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
        let mut state = store.inner.write().map_err(|_| state_lock_poisoned())?;
        InMemoryStudyStore::persist_ingestion_record_locked(&mut state, &generated, true);
        InMemoryStudyStore::capture_exam_instant_locked(
            &mut state,
            &generated.study_set.id,
            exam_at,
        );
    }
    Ok(generated)
}
