//! One backend-parameterized characterization suite for both stores (`DATA-015`).
//!
//! `ARC-05`/`QLT-09`/`REL-07` are about concentration: two very large adapter
//! files carrying every invariant between them, with the memory and Postgres
//! semantics only ever compared one behaviour at a time. Splitting those files is
//! safe only if something already pins what the split must preserve, so this
//! module is written and proven green *before* any code moves, and re-run after
//! every extraction.
//!
//! The suite is one scenario runner over a backend-agnostic port sequence. It
//! records what a caller can actually observe — write outcomes, published counts,
//! canonical learning evidence, progression results, the authenticated projection,
//! typed error kinds, and every order-bearing identifier — into one comparable
//! [`CanonicalStoreTrace`]. Nothing is normalized away except the two things that
//! genuinely are not shared state: server-generated surrogate ids for freshly
//! ingested content (both backends mint a fresh `Uuid::new_v4()`), and database
//! wall-clock instants. Both are replaced by the deterministic, content-derived
//! facts the port contract actually promises.
//!
//! It lives under `memory/` only so `memory.rs` can declare it under `#[cfg(test)]`
//! without changing `lib.rs`; it is not memory-specific.

use std::collections::BTreeSet;

use agent_domain::{
    learning_outcome::{TurnOutcome, TurnResolution},
    learning_recap::SessionLearningEvidence,
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    AnswerEvaluation, AuthenticatedStudyProjectionV1, ChallengeResolution, ConceptStatus,
    CreateFileStudySet, CreatePasteStudySet, PortErrorKind, ProgressionPolicyId,
    QuestionDisposition, QuestionProgressionResult, SessionConfig, SessionId,
    SessionTokenNonceClaim, StudyMemoryStore, StudyMode, StudyQuestion, StudySetIngestionRecord,
    StudySetIngestionStatus, StudyStoreWriteCounts, StudyStoreWriteOutcome, VoiceUsageRecord,
};

use crate::{
    memory::{current_epoch_seconds, SESSION_TOKEN_NONCE_SKEW_SECONDS},
    migrations::tests::{
        evidence_fixture, learning_core_seed, seed_learning_core_memory,
        seed_learning_core_postgres, turn_outcome_fixture, LearningCoreSeed, PostgresSchemaFixture,
        LEARNING_SET_ID, LEARNING_USER_ID,
    },
    InMemoryStudyStore, PostgresStudyStore,
};

use super::pdf_ingestion_tests::{
    generated_encrypted_pdf, generated_flate_pdf, generated_malformed_pdf, generated_scanned_pdf,
    generated_text_pdf, magic_prefixed_plaintext,
};

/// The learner-authored marker every deletion scenario writes and then proves is
/// gone. Test text only; it never appears in a fixture that outlives a test.
const CONFORMANCE_CANARY: &str = "VIVA_STORE_CONFORMANCE_CANARY_4C1D";

/// Which adapter the scenario runs against.
///
/// Deliberately an enum over the two concrete stores rather than `&dyn
/// StudyMemoryStore`: a scenario occasionally needs the concrete type (a second
/// instance over the same pool, a state snapshot), and an enum keeps that
/// explicit instead of hiding it behind a downcast.
pub(crate) enum ConformanceBackend<'a> {
    Memory(&'a InMemoryStudyStore),
    Postgres(&'a PostgresStudyStore),
}

impl ConformanceBackend<'_> {
    fn store(&self) -> &dyn StudyMemoryStore {
        match self {
            Self::Memory(store) => *store,
            Self::Postgres(store) => *store,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Memory(_) => "memory",
            Self::Postgres(_) => "postgres",
        }
    }
}

/// The one comparable value a scenario produces.
///
/// Every field is something a caller depends on: which writes inserted versus
/// replayed, the published counts, the canonical learning evidence, the
/// progression decisions, the authenticated projection, the typed error taxonomy,
/// and the identifiers whose *order* is part of the contract.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CanonicalStoreTrace {
    pub(crate) write_outcomes: Vec<StudyStoreWriteOutcome>,
    pub(crate) write_counts: StudyStoreWriteCounts,
    pub(crate) learning_evidence: SessionLearningEvidence,
    pub(crate) progression: Vec<QuestionProgressionResult>,
    pub(crate) projection: AuthenticatedStudyProjectionV1,
    pub(crate) error_kinds: Vec<PortErrorKind>,
    pub(crate) ordered_ids: Vec<String>,
}

/// Where two traces first disagree, named precisely enough to fix.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct TraceMismatch {
    pub(crate) field: String,
    pub(crate) detail: String,
}

/// The single comparison both the real scenarios and the harness self-test use.
///
/// It reports the *first* difference by field and index rather than dumping two
/// whole traces, so an extraction that drifts says which invariant drifted.
pub(crate) fn compare_traces(
    expected: &CanonicalStoreTrace,
    actual: &CanonicalStoreTrace,
) -> Result<(), TraceMismatch> {
    compare_sequence(
        "write_outcomes",
        &expected.write_outcomes,
        &actual.write_outcomes,
    )?;
    if expected.write_counts != actual.write_counts {
        return Err(TraceMismatch {
            field: "write_counts".to_owned(),
            detail: format!("{:?} != {:?}", expected.write_counts, actual.write_counts),
        });
    }
    if expected.learning_evidence != actual.learning_evidence {
        return Err(TraceMismatch {
            field: "learning_evidence".to_owned(),
            detail: format!(
                "{:?} != {:?}",
                expected.learning_evidence, actual.learning_evidence
            ),
        });
    }
    compare_sequence("progression", &expected.progression, &actual.progression)?;
    if expected.projection != actual.projection {
        return Err(TraceMismatch {
            field: "projection".to_owned(),
            detail: format!("{:?} != {:?}", expected.projection, actual.projection),
        });
    }
    compare_sequence("error_kinds", &expected.error_kinds, &actual.error_kinds)?;
    compare_sequence("ordered_ids", &expected.ordered_ids, &actual.ordered_ids)?;
    Ok(())
}

fn compare_sequence<T: std::fmt::Debug + PartialEq>(
    field: &str,
    expected: &[T],
    actual: &[T],
) -> Result<(), TraceMismatch> {
    for (index, (left, right)) in expected.iter().zip(actual.iter()).enumerate() {
        if left != right {
            return Err(TraceMismatch {
                field: format!("{field}[{index}]"),
                detail: format!("{left:?} != {right:?}"),
            });
        }
    }
    if expected.len() != actual.len() {
        return Err(TraceMismatch {
            field: format!("{field}.len()"),
            detail: format!("{} != {}", expected.len(), actual.len()),
        });
    }
    Ok(())
}

pub(crate) fn assert_traces_match(
    expected: &CanonicalStoreTrace,
    actual: &CanonicalStoreTrace,
    context: &str,
) {
    if let Err(mismatch) = compare_traces(expected, actual) {
        panic!(
            "{context}: shared store semantics drifted at `{}`: {}",
            mismatch.field, mismatch.detail
        );
    }
}

/// Which slice of the port surface one run exercises.
///
/// `AllOwnedPorts` runs every slice in one store, in the order a session actually
/// uses them, so an interaction between two subsystems is covered too.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConformanceScenario {
    Ingestion,
    LearningAndProgression,
    AuthorizationAndNonces,
    PrivacyAndDelete,
    AllOwnedPorts,
}

impl ConformanceScenario {
    fn covers_ingestion(self) -> bool {
        matches!(self, Self::Ingestion | Self::AllOwnedPorts)
    }

    fn covers_learning(self) -> bool {
        matches!(self, Self::LearningAndProgression | Self::AllOwnedPorts)
    }

    fn covers_authorization(self) -> bool {
        matches!(self, Self::AuthorizationAndNonces | Self::AllOwnedPorts)
    }

    fn covers_privacy(self) -> bool {
        matches!(self, Self::PrivacyAndDelete | Self::AllOwnedPorts)
    }
}

/// The canonical inputs one run is built from.
///
/// Content comes from `agent/fixtures/learning-core/*.json` through the same
/// seed both per-task suites use, so a difference between the backends is a
/// difference in the store and never in the test data.
pub(crate) struct CanonicalStoreFixture {
    pub(crate) scenario: ConformanceScenario,
    pub(crate) seed: LearningCoreSeed,
    pub(crate) voice_session_id: &'static str,
    pub(crate) nonce_epoch: u64,
}

impl CanonicalStoreFixture {
    pub(crate) fn new(scenario: ConformanceScenario) -> Self {
        Self {
            scenario,
            seed: learning_core_seed(),
            voice_session_id: "vs-0002",
            // One fixed epoch for the whole run: the nonce contract is about the
            // published 60-second skew, not about how long the test took.
            nonce_epoch: current_epoch_seconds(),
        }
    }
}

#[derive(Default)]
struct TraceDraft {
    write_outcomes: Vec<StudyStoreWriteOutcome>,
    progression: Vec<QuestionProgressionResult>,
    error_kinds: Vec<PortErrorKind>,
    ordered_ids: Vec<String>,
}

impl TraceDraft {
    /// Records a typed failure: its kind, and its safe id when that id is a shared
    /// constant rather than a per-run identifier.
    fn record_error(&mut self, label: &str, error: &agent_domain::PortError) {
        self.error_kinds.push(error.kind());
        self.ordered_ids.push(format!("{label}={}", error.id()));
    }

    fn record_id(&mut self, label: &str, value: impl std::fmt::Display) {
        self.ordered_ids.push(format!("{label}={value}"));
    }
}

/// Run one scenario end to end and return its canonical trace.
pub(crate) async fn exercise_store_scenario(
    backend: ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
) -> CanonicalStoreTrace {
    let store = backend.store();
    let mut draft = TraceDraft::default();

    // Session insert then replay is the first shared truth in every scenario: one
    // physical row, and two outcomes that say which was which.
    let config = SessionConfig {
        session_id: Some(SessionId::new(fixture.voice_session_id)),
        user_id: Some(LEARNING_USER_ID.to_owned()),
        study_set_id: Some(LEARNING_SET_ID.to_owned()),
        mode: Some(StudyMode::Quiz),
        ..SessionConfig::default()
    };
    for _ in 0..2 {
        draft.write_outcomes.push(
            store
                .record_voice_session(&config)
                .await
                .expect("the canonical session is accepted"),
        );
    }

    if fixture.scenario.covers_ingestion() {
        exercise_ingestion(&backend, &mut draft).await;
    }
    if fixture.scenario.covers_learning() {
        exercise_learning(&backend, fixture, &mut draft).await;
    }
    if fixture.scenario.covers_authorization() {
        exercise_authorization(&backend, fixture, &mut draft).await;
    }

    // The canonical reads are taken at the same point in every scenario — after
    // every write, before any deletion — so a scenario that never wrote a learning
    // artifact still pins the empty shape.
    //
    // `write_counts` is snapshotted here for a contract reason, not a convenience
    // one. The two backends implement it differently *by plan*: Postgres counts
    // committed inserts on lock-free atomics that never decrement (Task 4, so a
    // poisoned local lock cannot turn a committed row into a returned error),
    // while memory derives the counts from its live state collections (Task 7).
    // Both are the same number until something is deleted, and deletion is the one
    // point at which the two definitions were never specified to agree. Comparing
    // them here compares what both backends actually promise.
    let write_counts = store.write_counts();
    let learning_evidence = store
        .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, fixture.voice_session_id)
        .await
        .expect("session learning evidence reads");
    let projection = store
        .authenticated_study_projection(LEARNING_USER_ID, LEARNING_SET_ID, fixture.voice_session_id)
        .await
        .expect("authenticated study projection reads");

    if fixture.scenario.covers_privacy() {
        exercise_privacy(&backend, fixture, &mut draft).await;
    }

    CanonicalStoreTrace {
        write_outcomes: draft.write_outcomes,
        write_counts,
        learning_evidence,
        progression: draft.progression,
        projection,
        error_kinds: draft.error_kinds,
        ordered_ids: draft.ordered_ids,
    }
}

// ---------------------------------------------------------------------------
// Ingestion: `DATA-014`/`COR-04` fail-closed PDF handling plus the honest UTF-8
// path, through the same ports on both backends.
// ---------------------------------------------------------------------------

async fn exercise_ingestion(backend: &ConformanceBackend<'_>, draft: &mut TraceDraft) {
    let store = backend.store();

    let pasted = store
        .create_paste_study_set(CreatePasteStudySet {
            user_id: LEARNING_USER_ID.to_owned(),
            title: "Conformance paste".to_owned(),
            course: Some("BIO 201".to_owned()),
            exam_date: None,
            pasted_text: conformance_paste_text(),
            session_id: None,
        })
        .await
        .expect("valid pasted text ingests");
    record_ingestion_shape(draft, "paste", &pasted);

    let ingested_file = store
        .create_file_study_set(text_file_input("notes.txt", Some("text/plain"), None))
        .await
        .expect("valid UTF-8 file ingests");
    record_ingestion_shape(draft, "file", &ingested_file);

    // Every generated PDF shape fails closed with the same typed error, and the
    // classifier runs before any decoding, so a `%PDF` prefix is enough on its own.
    for (label, bytes, file_name, content_type) in [
        (
            "pdf_text",
            generated_text_pdf(),
            "lecture.pdf",
            Some("application/pdf"),
        ),
        (
            "pdf_flate",
            generated_flate_pdf(),
            "lecture.pdf",
            Some("application/pdf"),
        ),
        (
            "pdf_scanned",
            generated_scanned_pdf(),
            "scan.PDF",
            Some("application/pdf; charset=binary"),
        ),
        (
            "pdf_encrypted",
            generated_encrypted_pdf(),
            "secure.pdf",
            Some("application/pdf"),
        ),
        (
            "pdf_malformed",
            generated_malformed_pdf(),
            "broken.pdf",
            Some("application/pdf"),
        ),
        (
            "pdf_magic_plaintext",
            magic_prefixed_plaintext(),
            "notes.txt",
            Some("text/plain"),
        ),
    ] {
        let error = store
            .create_file_study_set(CreateFileStudySet {
                file_bytes: bytes,
                ..text_file_input(file_name, content_type, None)
            })
            .await
            .expect_err("PDF ingestion fails closed");
        draft.record_error(label, &error);
    }

    // Invalid UTF-8 that is not a PDF is rejected too, and never repaired with
    // replacement characters.
    let error = store
        .create_file_study_set(CreateFileStudySet {
            file_bytes: vec![0x66, 0x6f, 0x6f, 0xff, 0xfe],
            ..text_file_input("notes.txt", Some("text/plain"), None)
        })
        .await
        .expect_err("invalid UTF-8 fails closed");
    draft.record_error("invalid_utf8", &error);

    // Retry carries the same classifier, on the set the honest file ingestion made.
    let error = store
        .retry_file_study_set(CreateFileStudySet {
            file_bytes: generated_text_pdf(),
            ..text_file_input(
                "lecture.pdf",
                Some("application/pdf"),
                Some(ingested_file.study_set.id.clone()),
            )
        })
        .await
        .expect_err("PDF retry fails closed");
    draft.record_error("pdf_retry", &error);
}

/// The content-derived half of an ingestion result.
///
/// Both backends mint fresh `Uuid::new_v4()` surrogates for a new set, document,
/// and source span, so those bytes are not shared state and cannot be compared.
/// Everything the generator actually derives from the input — status, counts,
/// concept public ids, question ids and prompts, span text — is shared, and is
/// what this records.
fn record_ingestion_shape(draft: &mut TraceDraft, label: &str, record: &StudySetIngestionRecord) {
    draft.record_id(
        &format!("{label}.status"),
        record.study_set.ingestion_status.as_str(),
    );
    draft.record_id(&format!("{label}.title"), &record.study_set.title);
    draft.record_id(&format!("{label}.documents"), record.documents.len());
    draft.record_id(&format!("{label}.spans"), record.source_spans.len());
    for span in &record.source_spans {
        draft.record_id(&format!("{label}.span.excerpt"), &span.excerpt);
        draft.record_id(
            &format!("{label}.span.confidence"),
            format!("{:?}", span.confidence),
        );
    }
    for concept in &record.concepts {
        draft.record_id(&format!("{label}.concept"), &concept.public_id);
        draft.record_id(&format!("{label}.concept.label"), &concept.label);
    }
    for question in &record.questions {
        draft.record_id(&format!("{label}.question"), &question.question_id);
        draft.record_id(&format!("{label}.question.prompt"), &question.prompt);
        draft.record_id(
            &format!("{label}.question.terms"),
            question.expected_terms.join("|"),
        );
    }
}

fn text_file_input(
    file_name: &str,
    content_type: Option<&str>,
    study_set_id: Option<String>,
) -> CreateFileStudySet {
    CreateFileStudySet {
        user_id: LEARNING_USER_ID.to_owned(),
        study_set_id,
        title: "Conformance upload".to_owned(),
        course: Some("BIO 201".to_owned()),
        exam_date: None,
        file_name: file_name.to_owned(),
        content_type: content_type.map(ToOwned::to_owned),
        file_bytes: conformance_paste_text().into_bytes(),
        session_id: None,
    }
}

fn conformance_paste_text() -> String {
    [
        "The electron transport chain moves electrons through four complexes.",
        "The proton gradient stores the free energy that ATP synthase spends.",
        "ATP synthesis couples proton return to phosphorylation of ADP.",
    ]
    .join(" ")
}

// ---------------------------------------------------------------------------
// Learning and progression: Plan 04's canonical outcome, challenge, cursor, and
// the selected D-01 authority, all through Plan 06's five ports.
// ---------------------------------------------------------------------------

async fn exercise_learning(
    backend: &ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
    draft: &mut TraceDraft,
) {
    let store = backend.store();
    let seeded = evidence_fixture().evidence["mixed_strong_shaky_missed"].clone();

    for outcome in &seeded.outcomes {
        let persisted = store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                fixture.voice_session_id,
                outcome.clone(),
            )
            .await
            .expect("canonical turn outcome persists");
        assert_eq!(persisted.turn_outcome, *outcome);
        draft.record_id("outcome.response", &persisted.record.response_id);
        draft.record_id("outcome.schema", persisted.record.schema);
        draft.record_id("outcome.replayed", persisted.record.replayed);
    }

    // An identical replay is a replay, and says so.
    let replayed = store
        .record_turn_outcome(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            seeded.outcomes[0].clone(),
        )
        .await
        .expect("identical replay is accepted");
    assert_eq!(replayed.turn_outcome, seeded.outcomes[0]);
    draft.record_id("outcome.replay.replayed", replayed.record.replayed);

    // One changed field under the same response identity is a conflict, and
    // changes nothing.
    let mut mutated = seeded.outcomes[0].clone();
    mutated.rubric_policy_version = format!("{}-mutated", mutated.rubric_policy_version);
    let error = store
        .record_turn_outcome(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            mutated,
        )
        .await
        .expect_err("a divergent replay is refused");
    draft.error_kinds.push(error.kind());

    let challenge = ChallengeResolution {
        schema: agent_domain::learning_outcome::VIVA_CHALLENGE_RESOLUTION_SCHEMA.to_owned(),
        correction_id: "corr-conformance-1".to_owned(),
        challenged_response_id: seeded.outcomes[0].response_id.clone(),
        source_id: "src-lec5-slide-19".to_owned(),
        disposition: agent_domain::ChallengeDisposition::SourceConfirmed,
        replacement_response_id: None,
    };
    let stored = store
        .record_challenge_resolution(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            challenge.clone(),
        )
        .await
        .expect("canonical challenge resolution persists");
    assert_eq!(stored, challenge);
    let replayed_challenge = store
        .record_challenge_resolution(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            challenge.clone(),
        )
        .await
        .expect("identical challenge replay is accepted");
    assert_eq!(replayed_challenge, challenge);
    draft.record_id("challenge.correction", &stored.correction_id);
    draft.record_id("challenge.disposition", format!("{:?}", stored.disposition));

    // Progression: first selection, replay of the same authorized response, and a
    // second response. One cursor, deterministic order.
    for response_id in [
        seeded.outcomes[0].response_id.as_str(),
        seeded.outcomes[0].response_id.as_str(),
        seeded.outcomes[1].response_id.as_str(),
    ] {
        draft.progression.push(
            store
                .select_next_question(
                    LEARNING_USER_ID,
                    LEARNING_SET_ID,
                    fixture.voice_session_id,
                    response_id,
                    ProgressionPolicyId::OrderedV1,
                )
                .await
                .expect("ordered progression selects"),
        );
    }

    // A policy the coordinator did not select is refused, not silently downgraded.
    let error = store
        .select_next_question(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            &seeded.outcomes[0].response_id,
            ProgressionPolicyId::AdaptiveV1,
        )
        .await
        .expect_err("an unselected progression policy is refused");
    draft.record_error("progression.unselected_policy", &error);
}

// ---------------------------------------------------------------------------
// Session-scoped question fields (`A-14`): the two facts the executor gates a
// spoken turn on, supplied by both backends from persisted state alone.
// ---------------------------------------------------------------------------

/// The seeded active question at `index` in committed ingestion order.
///
/// The whole value is the expectation — prompt, expected terms, follow-up,
/// rubric, and bound source — because the rubric is precisely what a turn is
/// graded by and precisely what a store could silently drop.
fn seeded_active_question(fixture: &CanonicalStoreFixture, index: usize) -> StudyQuestion {
    let active = fixture.seed.active_questions();
    assert!(
        index < active.len(),
        "the learning-core seed publishes {} active questions, so index {index} does not exist",
        active.len()
    );
    active[index].clone()
}

/// One evaluated outcome bound to `question_id` and `disposition` under a fresh
/// response identity.
///
/// It is a fixture outcome re-bound, not an invented shape: the same schema,
/// rubric policy version, and evaluated resolution the canonical fixture pins,
/// with its concept transitions cleared so this helper moves the cursor without
/// also writing a second review decision for a concept the fixture already
/// scheduled.
fn rebound_outcome(
    template: &TurnOutcome,
    response_id: &str,
    question_id: &str,
    disposition: QuestionDisposition,
) -> TurnOutcome {
    let mut outcome = template.clone();
    outcome.response_id = response_id.to_owned();
    outcome.question_id = question_id.to_owned();
    outcome.supersedes_response_id = None;
    outcome.resolution = match outcome.resolution {
        TurnResolution::Evaluated {
            label,
            confidence,
            concise_feedback,
            retry_prompt,
            ..
        } => TurnResolution::Evaluated {
            label,
            confidence,
            assessments: Vec::new(),
            concept_transitions: Vec::new(),
            concise_feedback,
            retry_prompt,
            disposition,
        },
        other => panic!("the re-bound template must be an evaluated outcome, got {other:?}"),
    };
    outcome
}

/// Every question `answered_questions` reports, by identity, in the order read.
fn answered_question_ids(evidence: &SessionLearningEvidence) -> Vec<String> {
    evidence
        .answered_questions
        .iter()
        .map(|question| question.question_id.clone())
        .collect()
}

/// How many entries `answered_questions` carries for one question identity.
fn answered_occurrences(evidence: &SessionLearningEvidence, question_id: &str) -> usize {
    evidence
        .answered_questions
        .iter()
        .filter(|question| question.question_id == question_id)
        .count()
}

/// `A-14`: both backends must supply `current_question` from the persisted
/// progression cursor and `answered_questions` from the persisted outcomes.
///
/// This is scripted rather than trace-compared because two backends that are
/// identically wrong compare equal. Each step asserts the fact the executor
/// actually gates on: a new turn is authorized only by the cursor's question,
/// and a redelivery is rebound only from the question its recorded outcome was
/// graded against. A store that reports neither fails every real spoken answer
/// closed, which is the window this closes.
pub(crate) async fn exercise_session_question_fields(
    backend: &ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
) {
    let store = backend.store();
    let label = backend.label();
    let seeded = evidence_fixture().evidence["mixed_strong_shaky_missed"].clone();
    let first = seeded_active_question(fixture, 0);
    let second = seeded_active_question(fixture, 1);
    let third = seeded_active_question(fixture, 2);

    let opened = store
        .record_voice_session(&SessionConfig {
            session_id: Some(SessionId::new(fixture.voice_session_id)),
            user_id: Some(LEARNING_USER_ID.to_owned()),
            study_set_id: Some(LEARNING_SET_ID.to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        })
        .await
        .expect("the canonical session is accepted");
    assert_eq!(
        opened,
        StudyStoreWriteOutcome::Inserted,
        "{label}: this scenario opens the session itself"
    );

    let read = || async {
        store
            .session_learning_evidence(LEARNING_USER_ID, LEARNING_SET_ID, fixture.voice_session_id)
            .await
            .expect("session learning evidence reads")
    };
    let select = |response_id: String| async move {
        store
            .select_next_question(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                fixture.voice_session_id,
                &response_id,
                ProgressionPolicyId::OrderedV1,
            )
            .await
            .expect("ordered progression selects")
    };
    let record = |outcome: TurnOutcome| async move {
        store
            .record_turn_outcome(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                fixture.voice_session_id,
                outcome,
            )
            .await
            .expect("canonical turn outcome persists")
    };

    // A session that has never selected has no cursor, so no turn is authorized
    // and no redelivery can be rebound.
    let evidence = read().await;
    assert_eq!(
        evidence.current_question, None,
        "{label}: a session with no progression cursor is on no question"
    );
    assert!(
        evidence.answered_questions.is_empty(),
        "{label}: a session with no outcome has answered no question, got {:?}",
        answered_question_ids(&evidence)
    );

    // Mid-progression: the cursor's question is reported whole, rubric included.
    select(seeded.outcomes[0].response_id.clone()).await;
    let evidence = read().await;
    assert_eq!(
        evidence.current_question.as_ref(),
        Some(&first),
        "{label}: a session mid-progression reports the cursor's question, rubric intact"
    );
    assert!(
        !first.rubric.criteria.is_empty(),
        "the seeded question must carry a rubric for this comparison to mean anything"
    );
    assert!(
        evidence.answered_questions.is_empty(),
        "{label}: selecting a question answers none of them, got {:?}",
        answered_question_ids(&evidence)
    );

    // One persisted outcome contributes exactly one answered question, whole. A
    // retried turn does not move the cursor, so the session is still on it.
    record(rebound_outcome(
        &seeded.outcomes[0],
        "resp-a14-first-retry",
        &first.question_id,
        QuestionDisposition::RetryCurrent,
    ))
    .await;
    let evidence = read().await;
    assert_eq!(
        answered_question_ids(&evidence),
        vec![first.question_id.clone()],
        "{label}: one persisted outcome names exactly one answered question"
    );
    assert_eq!(
        evidence.answered_questions[0], first,
        "{label}: an answered question is reported whole, rubric intact"
    );
    assert_eq!(
        evidence.current_question.as_ref(),
        Some(&first),
        "{label}: a retried turn leaves the cursor on its question"
    );

    // A second, distinct outcome on the same question is still one answered
    // question: the field is keyed by question identity, not by outcome count.
    record(seeded.outcomes[0].clone()).await;
    let evidence = read().await;
    assert_eq!(
        answered_question_ids(&evidence),
        vec![first.question_id.clone()],
        "{label}: two outcomes on one question name that question exactly once"
    );

    // A redelivery of the same response identity is one answer, not two.
    let replayed = store
        .record_turn_outcome(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            seeded.outcomes[0].clone(),
        )
        .await
        .expect("identical replay is accepted");
    assert!(
        replayed.record.replayed,
        "{label}: an identical redelivery must report itself as a replay"
    );
    let evidence = read().await;
    assert_eq!(
        answered_occurrences(&evidence, &first.question_id),
        1,
        "{label}: a replayed response adds no second entry, got {:?}",
        answered_question_ids(&evidence)
    );

    // The advance moved the cursor off its question, so the session is on no
    // question until the next selection — and the history it already has stays.
    let evidence = read().await;
    assert_eq!(
        evidence.current_question, None,
        "{label}: an advanced cursor is on no question until the next selection"
    );
    assert_eq!(
        answered_question_ids(&evidence),
        vec![first.question_id.clone()],
        "{label}: moving off a question does not forget it was answered"
    );

    // A second distinct outcome adds exactly one more answered question.
    select(seeded.outcomes[1].response_id.clone()).await;
    let evidence = read().await;
    assert_eq!(
        evidence.current_question.as_ref(),
        Some(&second),
        "{label}: the cursor's second question is reported whole, rubric intact"
    );
    record(seeded.outcomes[1].clone()).await;
    let evidence = read().await;
    assert_eq!(
        answered_question_ids(&evidence),
        vec![first.question_id.clone(), second.question_id.clone()],
        "{label}: a second distinct outcome adds exactly one more answered question"
    );
    assert_eq!(
        evidence.answered_questions[1], second,
        "{label}: the second answered question is reported whole, rubric intact"
    );

    // Drive the ordered policy to genuine exhaustion.
    select("resp-a14-third-selection".to_owned()).await;
    let evidence = read().await;
    assert_eq!(
        evidence.current_question.as_ref(),
        Some(&third),
        "{label}: the cursor's third question is reported whole, rubric intact"
    );
    record(rebound_outcome(
        &seeded.outcomes[1],
        "resp-a14-third-outcome",
        &third.question_id,
        QuestionDisposition::Advance,
    ))
    .await;
    let exhausted = select("resp-a14-fourth-selection".to_owned()).await;
    assert!(
        matches!(exhausted, QuestionProgressionResult::Exhausted { .. }),
        "{label}: every active question is completed, so progression is exhausted, got \
         {exhausted:?}"
    );

    // Exhausted: no question authorizes a new turn, and every recorded answer is
    // still rebindable.
    let evidence = read().await;
    assert_eq!(
        evidence.current_question, None,
        "{label}: an exhausted session is on no question"
    );
    assert_eq!(
        answered_question_ids(&evidence),
        vec![
            first.question_id.clone(),
            second.question_id.clone(),
            third.question_id.clone(),
        ],
        "{label}: an exhausted session still carries every answered question"
    );
    for question in [&first, &second, &third] {
        assert_eq!(
            answered_occurrences(&evidence, &question.question_id),
            1,
            "{label}: `{}` is answered exactly once",
            question.question_id
        );
    }
}

// ---------------------------------------------------------------------------
// Browser-event authority from the turn-outcome authority (`A-22`): the events a
// genuinely evaluated turn authorizes, and the ones it still refuses.
// ---------------------------------------------------------------------------

/// The evaluation half of one persisted `answer_attempts` row, in the one shape
/// both backends can be read into.
///
/// Memory keeps the whole `PersistedSourceReference`; Postgres keeps only the
/// span id and rebuilds the tuple on read, so the id is the widest honest
/// cross-backend comparison for the *row*. The whole source tuple is still
/// compared — by `authorize_answer_evaluation`, which refuses any event whose
/// source differs from the question's canonical retrieval.
#[derive(Clone, Debug, PartialEq)]
struct PersistedEvaluationRow {
    question_id: String,
    label: Option<String>,
    concept_status: Option<ConceptStatus>,
    confidence_score: Option<f32>,
    source_id: Option<String>,
}

/// The raw `answer_attempts` columns Postgres keeps for one response identity:
/// the question it graded, then the four evaluation columns, which are all NULL
/// until something completes the row.
type DurableAttemptColumns = (
    String,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<uuid::Uuid>,
);

/// Read the persisted attempt row for `response_id` from whichever backend is
/// under test, or `None` when no attempt row exists at all.
async fn persisted_evaluation_row(
    backend: &ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
    response_id: &str,
) -> Option<PersistedEvaluationRow> {
    match backend {
        ConformanceBackend::Memory(store) => store
            .snapshot()
            .answer_attempts
            .iter()
            .find(|record| {
                record.user_id == LEARNING_USER_ID
                    && record.study_set_id == LEARNING_SET_ID
                    && record.voice_session_id == fixture.voice_session_id
                    && record.response_id == response_id
            })
            .map(|record| PersistedEvaluationRow {
                question_id: record.envelope.question_id.clone(),
                label: record
                    .evaluation
                    .as_ref()
                    .map(|evaluation| evaluation.label.clone()),
                concept_status: record
                    .evaluation
                    .as_ref()
                    .map(|evaluation| evaluation.concept_status.clone()),
                confidence_score: record
                    .evaluation
                    .as_ref()
                    .map(|evaluation| evaluation.confidence_score),
                source_id: record
                    .evaluation
                    .as_ref()
                    .map(|evaluation| evaluation.source.source_id.clone()),
            }),
        ConformanceBackend::Postgres(store) => {
            let row = sqlx::query_as::<_, DurableAttemptColumns>(
                "SELECT aa.question_id,
                        aa.evaluation_label,
                        aa.concept_status,
                        aa.confidence_score,
                        aa.source_span_id
                 FROM answer_attempts aa
                 JOIN voice_sessions vs ON vs.id = aa.voice_session_id
                 WHERE vs.user_id = $1
                   AND vs.study_set_id = $2
                   AND vs.id = $3
                   AND aa.response_id = $4",
            )
            .bind(LEARNING_USER_ID)
            .bind(
                InMemoryStudyStore::fixture_id_translation(LEARNING_SET_ID)
                    .expect("the learning set has a fixture UUID")
                    .storage_uuid,
            )
            .bind(
                InMemoryStudyStore::fixture_id_translation(fixture.voice_session_id)
                    .expect("the conformance session has a fixture UUID")
                    .storage_uuid,
            )
            .bind(response_id)
            .fetch_optional(store.pool())
            .await
            .expect("the durable answer attempt row reads");
            row.map(
                |(question_id, label, concept_status, confidence_score, source_span_id)| {
                    PersistedEvaluationRow {
                        question_id,
                        label,
                        concept_status: concept_status.as_deref().map(|status| {
                            serde_json::from_value(serde_json::Value::String(status.to_owned()))
                                .expect("a persisted concept status is a canonical status")
                        }),
                        #[expect(
                            clippy::cast_possible_truncation,
                            reason = "the column is the f32 confidence the store bound, widened by \
                                      the driver"
                        )]
                        confidence_score: confidence_score.map(|value| value as f32),
                        source_id: source_span_id.map(|uuid| {
                            InMemoryStudyStore::fixture_logical_id_for_uuid(uuid)
                                .map_or_else(|| uuid.to_string(), ToOwned::to_owned)
                        }),
                    }
                },
            )
        }
    }
}

/// The `answer_evaluation` payload the browser will be shown for one persisted
/// evaluated turn, assembled here the way the adapter assembles it.
///
/// This is the test's own independent expectation, not a call into the rule under
/// test: the wire label token, the mastery value, the feedback, and the retry
/// prompt are all passed in explicitly by each scripted turn.
fn browser_evaluation(
    question: &StudyQuestion,
    answer_text: &str,
    label: &str,
    concise_feedback: &str,
    retry_prompt: &str,
    concept_status: ConceptStatus,
    confidence_score: f32,
) -> AnswerEvaluation {
    AnswerEvaluation {
        question_id: question.question_id.clone(),
        answer_text: answer_text.to_owned(),
        label: label.to_owned(),
        concise_feedback: concise_feedback.to_owned(),
        retry_prompt: retry_prompt.to_owned(),
        source: question.source.clone(),
        concept_status,
        confidence_score,
    }
}

/// One turn in the production order the adapters use: the capture envelope
/// first, then the graded outcome that completes it.
async fn persist_captured_turn(
    store: &dyn StudyMemoryStore,
    fixture: &CanonicalStoreFixture,
    question: &StudyQuestion,
    outcome: TurnOutcome,
) {
    store
        .record_answer_attempt_envelope(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            conformance_envelope(&outcome.response_id, question),
        )
        .await
        .expect("the answer envelope records");
    store
        .record_turn_outcome(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            outcome,
        )
        .await
        .expect("canonical turn outcome persists");
}

/// Present one `answer_evaluation` browser event to the store's gate.
async fn authorize_evaluation(
    store: &dyn StudyMemoryStore,
    fixture: &CanonicalStoreFixture,
    response_id: &str,
    evaluation: &AnswerEvaluation,
) -> Result<(), agent_domain::PortError> {
    store
        .authorize_answer_evaluation(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            response_id,
            evaluation,
        )
        .await
}

/// `A-22`: an evaluated turn's browser events are authoritative, and only the
/// exact payload the store derived is.
///
/// Scripted rather than trace-compared: two backends that refuse every real
/// evaluation compare equal, which is precisely the defect this closes. Each step
/// is what the socket actually does — persist the capture envelope, persist the
/// graded outcome, then present the projected `answer_evaluation` and
/// `concept_status` events for authorization.
pub(crate) async fn exercise_turn_outcome_browser_authority(
    backend: &ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
) {
    let store = backend.store();
    let label = backend.label();
    let canonical = turn_outcome_fixture();
    let question = seeded_active_question(fixture, 0);
    let strong = canonical.outcomes["evaluated_strong"].clone();
    let mostly_correct = canonical.outcomes["evaluated_mostly_correct"].clone();
    let deferred = canonical.outcomes["deferred_insufficient_semantic_evidence"].clone();
    for outcome in [&strong, &mostly_correct, &deferred] {
        assert_eq!(
            outcome.question_id, question.question_id,
            "the canonical fixture outcomes must all grade the first seeded question"
        );
    }

    assert_eq!(
        store
            .record_voice_session(&SessionConfig {
                session_id: Some(SessionId::new(fixture.voice_session_id)),
                user_id: Some(LEARNING_USER_ID.to_owned()),
                study_set_id: Some(LEARNING_SET_ID.to_owned()),
                mode: Some(StudyMode::Quiz),
                ..SessionConfig::default()
            })
            .await
            .expect("the canonical session is accepted"),
        StudyStoreWriteOutcome::Inserted,
        "{label}: this scenario opens the session itself"
    );

    // --- Turn A: a strong evaluated outcome ---------------------------------
    persist_captured_turn(store, fixture, &question, strong.clone()).await;

    // (1) The attempt row carries the payload the browser event will present.
    assert_eq!(
        persisted_evaluation_row(backend, fixture, &strong.response_id).await,
        Some(PersistedEvaluationRow {
            question_id: question.question_id.clone(),
            label: Some("strong".to_owned()),
            concept_status: Some(ConceptStatus::Strong),
            confidence_score: Some(0.9),
            source_id: Some(question.source.source_id.clone()),
        }),
        "{label}: the turn-outcome authority completes its turn's answer attempt"
    );

    // (2) That exact event is admitted.
    let evaluation = browser_evaluation(
        &question,
        "NADH hands its electrons to complex I, and the pumped protons build the gradient.",
        "strong",
        "Every required criterion held: the electron donation, the ordered complexes, and the \
         pumped proton gradient.",
        "",
        ConceptStatus::Strong,
        0.9,
    );
    authorize_evaluation(store, fixture, &strong.response_id, &evaluation)
        .await
        .unwrap_or_else(|error| {
            panic!("{label}: a genuinely evaluated turn authorizes its own evaluation: {error:?}")
        });

    // The sibling event of the same turn: the mastery move the outcome persisted.
    store
        .authorize_concept_status(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            &strong.response_id,
            "concept-electron-transport-chain",
            &ConceptStatus::Strong,
        )
        .await
        .unwrap_or_else(|error| {
            panic!("{label}: the persisted transition authorizes its concept status: {error:?}")
        });

    // The transcript echo is the one field the store never sees — `TurnOutcome`
    // carries no answer text by design, and the store persists none. It is
    // therefore deliberately outside the digest, and this pins that boundary as a
    // decision rather than leaving it to be discovered: the same graded payload
    // under a different transcript is still admitted, exactly as the ungated
    // `transcript_final` frame that carried it already was.
    let mut retranscribed = evaluation.clone();
    retranscribed.answer_text = "A different transcript of the same turn.".to_owned();
    authorize_evaluation(store, fixture, &strong.response_id, &retranscribed)
        .await
        .unwrap_or_else(|error| {
            panic!("{label}: the transcript echo is not part of the graded payload: {error:?}")
        });

    // (3) Every server-derived field is bound. One changed field at a time, each
    // refused — including the two the attempt row does not carry, which proves
    // the digest is doing work the row cannot.
    let mut forged_label = evaluation.clone();
    forged_label.label = "mostly correct".to_owned();
    let mut forged_feedback = evaluation.clone();
    forged_feedback.concise_feedback = format!("{CONFORMANCE_CANARY} you did great");
    let mut forged_retry = evaluation.clone();
    forged_retry.retry_prompt = format!("{CONFORMANCE_CANARY} try again");
    let mut forged_status = evaluation.clone();
    forged_status.concept_status = ConceptStatus::Shaky;
    let mut forged_confidence = evaluation.clone();
    forged_confidence.confidence_score = 0.5;
    let mut forged_source = evaluation.clone();
    forged_source.source.excerpt = format!("{} {CONFORMANCE_CANARY}", forged_source.source.excerpt);
    let mut forged_question = evaluation.clone();
    forged_question.question_id = seeded_active_question(fixture, 1).question_id;
    for (field, forged) in [
        ("label", forged_label),
        ("concise_feedback", forged_feedback),
        ("retry_prompt", forged_retry),
        ("concept_status", forged_status),
        ("confidence_score", forged_confidence),
        ("source", forged_source),
        ("question_id", forged_question),
    ] {
        let error = authorize_evaluation(store, fixture, &strong.response_id, &forged)
            .await
            .expect_err(&format!(
                "{label}: a forged `{field}` must not be authoritative"
            ));
        assert!(
            matches!(
                error.kind(),
                PortErrorKind::Conflict | PortErrorKind::InvalidInput
            ),
            "{label}: a forged `{field}` is refused as a typed conflict, got {error:?}"
        );
    }

    // A response identity the store never graded has no authority either.
    authorize_evaluation(store, fixture, "resp-a22-never-recorded", &evaluation)
        .await
        .expect_err(&format!(
            "{label}: an ungraded response identity has no authority"
        ));

    // --- Turn B: the browser's label token is not the canonical serde token ---
    persist_captured_turn(store, fixture, &question, mostly_correct.clone()).await;
    let mostly_correct_evaluation = browser_evaluation(
        &question,
        "NADH starts the flow, and the protons go somewhere outward.",
        "mostly correct",
        "The chain description held. The proton gradient claim was correct but only weakly \
         supported.",
        "Say precisely where the pumped protons accumulate.",
        ConceptStatus::Strong,
        0.79,
    );
    authorize_evaluation(
        store,
        fixture,
        &mostly_correct.response_id,
        &mostly_correct_evaluation,
    )
    .await
    .unwrap_or_else(|error| {
        panic!("{label}: the browser's `mostly correct` token is the authorized one: {error:?}")
    });
    let mut serde_token = mostly_correct_evaluation.clone();
    serde_token.label = "mostly_correct".to_owned();
    authorize_evaluation(store, fixture, &mostly_correct.response_id, &serde_token)
        .await
        .expect_err(&format!(
            "{label}: the canonical serde token is not the browser token and is not authoritative"
        ));

    // --- Turn C: the mastery shown is the question's own concept -------------
    let mut reordered = mostly_correct.clone();
    reordered.response_id = "resp-a22-concept-order".to_owned();
    reordered.resolution = match reordered.resolution {
        TurnResolution::Evaluated {
            label,
            confidence,
            assessments,
            mut concept_transitions,
            concise_feedback,
            retry_prompt,
            disposition,
        } => {
            concept_transitions.reverse();
            assert_ne!(
                concept_transitions[0].concept_id, question.concept_id,
                "this turn only discriminates while the question's concept is not the first \
                 transition"
            );
            TurnResolution::Evaluated {
                label,
                confidence,
                assessments,
                concept_transitions,
                concise_feedback,
                retry_prompt,
                disposition,
            }
        }
        other => panic!("the re-bound template must be an evaluated outcome, got {other:?}"),
    };
    persist_captured_turn(store, fixture, &question, reordered.clone()).await;
    let mut first_transition_status = mostly_correct_evaluation.clone();
    first_transition_status.concept_status = ConceptStatus::Shaky;
    authorize_evaluation(
        store,
        fixture,
        &reordered.response_id,
        &first_transition_status,
    )
    .await
    .expect_err(&format!(
        "{label}: the browser is shown this question's concept, not the first transition"
    ));
    authorize_evaluation(
        store,
        fixture,
        &reordered.response_id,
        &mostly_correct_evaluation,
    )
    .await
    .unwrap_or_else(|error| {
        panic!("{label}: the question's own concept is the authorized mastery value: {error:?}")
    });

    // --- Turn D: a deferred turn grades nothing ------------------------------
    persist_captured_turn(store, fixture, &question, deferred.clone()).await;
    assert_eq!(
        persisted_evaluation_row(backend, fixture, &deferred.response_id).await,
        Some(PersistedEvaluationRow {
            question_id: question.question_id.clone(),
            label: None,
            concept_status: None,
            confidence_score: None,
            source_id: None,
        }),
        "{label}: a deferred turn leaves its attempt row ungraded"
    );
    for candidate in [evaluation.clone(), mostly_correct_evaluation.clone()] {
        authorize_evaluation(store, fixture, &deferred.response_id, &candidate)
            .await
            .expect_err(&format!(
                "{label}: a deferred turn authorizes no evaluation at all"
            ));
    }
    store
        .authorize_concept_status(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            &deferred.response_id,
            "concept-electron-transport-chain",
            &ConceptStatus::Strong,
        )
        .await
        .expect_err(&format!(
            "{label}: a deferred turn moves no concept and authorizes no status event"
        ));
}

// ---------------------------------------------------------------------------
// Authorization and nonces: durable browser-event authority, and replay defence
// bounded by the published token skew.
// ---------------------------------------------------------------------------

async fn exercise_authorization(
    backend: &ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
    draft: &mut TraceDraft,
) {
    let store = backend.store();
    let question = store
        .active_question(LEARNING_USER_ID, LEARNING_SET_ID)
        .await
        .expect("active question reads")
        .expect("the seeded set has an active question");

    // A question the store itself published is authorized; a forged source tuple
    // on the same question is not.
    store
        .authorize_question_started(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            &question,
        )
        .await
        .expect("the server-owned question is authorized");
    let mut forged = question.clone();
    forged.source.excerpt = format!("{} {CONFORMANCE_CANARY}", forged.source.excerpt);
    let error = store
        .authorize_question_started(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            &forged,
        )
        .await
        .expect_err("a forged source excerpt is refused");
    draft.error_kinds.push(error.kind());

    // An evaluation is authoritative only after the store recorded it, and only
    // for the exact payload it recorded.
    let response_id = "resp-conformance-eval";
    let evaluation = conformance_evaluation(&question);
    let error = store
        .authorize_answer_evaluation(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            response_id,
            &evaluation,
        )
        .await
        .expect_err("an unrecorded evaluation has no authority");
    draft.error_kinds.push(error.kind());

    store
        .record_answer_attempt_envelope(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            conformance_envelope(response_id, &question),
        )
        .await
        .expect("the answer envelope records");
    store
        .record_answer_evaluation(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            response_id,
            evaluation.clone(),
        )
        .await
        .expect("the answer evaluation records");
    store
        .authorize_answer_evaluation(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            response_id,
            &evaluation,
        )
        .await
        .expect("the recorded evaluation is authorized");

    let mut tampered = evaluation.clone();
    tampered.label = format!("{} {CONFORMANCE_CANARY}", tampered.label);
    let error = store
        .authorize_answer_evaluation(
            LEARNING_USER_ID,
            LEARNING_SET_ID,
            fixture.voice_session_id,
            response_id,
            &tampered,
        )
        .await
        .expect_err("a tampered evaluation payload is refused");
    draft.error_kinds.push(error.kind());

    draft.record_id(
        "durable_attempt",
        store
            .answer_attempt_was_recorded(
                LEARNING_USER_ID,
                LEARNING_SET_ID,
                fixture.voice_session_id,
                response_id,
            )
            .await
            .expect("durable attempt lookup answers"),
    );
    draft.record_id(
        "pending_attempts",
        store
            .pending_answer_attempts_for_session(fixture.voice_session_id)
            .await
            .expect("pending attempt count answers"),
    );

    // Nonces: a live claim, its replay, a stale claim that the published skew
    // does not protect, and proof that the stale row was actually pruned.
    let live = nonce_claim(fixture, "nonce-live", fixture.nonce_epoch + 300);
    store
        .claim_session_token_nonce(live.clone())
        .await
        .expect("a live nonce claims");
    let error = store
        .claim_session_token_nonce(live.clone())
        .await
        .expect_err("a live nonce cannot be replayed");
    draft.error_kinds.push(error.kind());

    let stale_expiry = fixture.nonce_epoch - (SESSION_TOKEN_NONCE_SKEW_SECONDS * 5);
    let stale = nonce_claim(fixture, "nonce-stale", stale_expiry);
    store
        .claim_session_token_nonce(stale.clone())
        .await
        .expect("a stale nonce claims");
    store
        .claim_session_token_nonce(nonce_claim(
            fixture,
            "nonce-trigger",
            fixture.nonce_epoch + 300,
        ))
        .await
        .expect("a later claim prunes past the published skew");
    // Re-claimable means pruned; the live claim below proves the prune stopped at
    // the skew boundary instead of clearing everything.
    store
        .claim_session_token_nonce(stale)
        .await
        .expect("the pruned stale nonce is claimable again");
    let error = store
        .claim_session_token_nonce(live)
        .await
        .expect_err("the retained live nonce still rejects replay");
    draft.error_kinds.push(error.kind());
}

fn nonce_claim(
    fixture: &CanonicalStoreFixture,
    nonce: &str,
    expires_at: u64,
) -> SessionTokenNonceClaim {
    SessionTokenNonceClaim {
        user_id: LEARNING_USER_ID.to_owned(),
        study_set_id: LEARNING_SET_ID.to_owned(),
        voice_session_id: fixture.voice_session_id.to_owned(),
        nonce: nonce.to_owned(),
        expires_at,
    }
}

fn conformance_evaluation(question: &StudyQuestion) -> AnswerEvaluation {
    AnswerEvaluation {
        question_id: question.question_id.clone(),
        answer_text: "The gradient drives ATP synthase.".to_owned(),
        label: "mostly correct".to_owned(),
        concise_feedback: "Grounded in the seeded source.".to_owned(),
        retry_prompt: question.follow_up.clone(),
        source: question.source.clone(),
        concept_status: ConceptStatus::Strong,
        confidence_score: 0.84,
    }
}

fn conformance_envelope(response_id: &str, question: &StudyQuestion) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        response_id: response_id.to_owned(),
        question_id: question.question_id.clone(),
        submission_sequence: 1,
        idempotency_key: format!("{}:1:{response_id}", question.question_id),
        capture_mode: AnswerCaptureMode::Typed,
        byte_count: Some(32),
        char_count: Some(32),
        duration_ms: Some(1_100),
        client_generation_id: Some("generation-conformance".to_owned()),
        locale: Some("en-US".to_owned()),
        capture_status: AnswerCaptureStatus::Accepted,
        content_policy: AnswerContentPolicy::None,
        answer_digest_hmac: None,
        transcript_status: Some("final".to_owned()),
        transcript_confidence_bucket: Some("high".to_owned()),
        pre_provider_state: "captured".to_owned(),
    }
}

// ---------------------------------------------------------------------------
// Privacy and deletion: the selected D-05 `HARD_PURGE_TEXT` result, read/export
// exclusion, and idempotent content-free tombstones.
// ---------------------------------------------------------------------------

async fn exercise_privacy(
    backend: &ConformanceBackend<'_>,
    fixture: &CanonicalStoreFixture,
    draft: &mut TraceDraft,
) {
    let store = backend.store();

    // Usage first: it is the write that must serialize against deletion.
    draft.write_outcomes.push(
        store
            .record_voice_usage(conformance_usage(fixture.voice_session_id))
            .await
            .expect("voice usage records"),
    );

    // A set of the learner's own, carrying the canary in every authored field the
    // generator derives one from.
    let doomed = store
        .create_paste_study_set(CreatePasteStudySet {
            user_id: LEARNING_USER_ID.to_owned(),
            title: format!("Doomed {CONFORMANCE_CANARY}"),
            course: Some(format!("Course {CONFORMANCE_CANARY}")),
            exam_date: None,
            pasted_text: conformance_canary_text(),
            session_id: None,
        })
        .await
        .expect("the doomed set ingests");
    let doomed_id = doomed.study_set.id.clone();
    assert_eq!(
        doomed.study_set.ingestion_status,
        StudySetIngestionStatus::Ready
    );
    draft.record_id("doomed.canary_before", canary_occurrences(&doomed));

    let receipt = store
        .delete_study_set(LEARNING_USER_ID, &doomed_id)
        .await
        .expect("the doomed set deletes");
    let repeated = store
        .delete_study_set(LEARNING_USER_ID, &doomed_id)
        .await
        .expect("a repeated delete is idempotent");
    draft.record_id("delete.policy", receipt["policy"].to_string());
    draft.record_id("delete.repeat_matches", receipt == repeated);

    // Read and export exclusion, on the tombstone and on the library.
    draft.record_id(
        "delete.context_is_none",
        store
            .study_context(LEARNING_USER_ID, &doomed_id)
            .await
            .expect("study context reads")
            .is_none(),
    );
    let library = store
        .library_snapshot(LEARNING_USER_ID)
        .await
        .expect("library snapshot reads");
    draft.record_id(
        "delete.library_excludes",
        !library
            .study_sets
            .iter()
            .any(|study_set| study_set.id == doomed_id),
    );
    draft.record_id(
        "delete.library_has_no_canary",
        !serde_json::to_string(&library)
            .expect("library snapshot serializes")
            .contains(CONFORMANCE_CANARY),
    );

    // The tombstone refuses every learner-content read path, and it refuses them
    // as `Unavailable` rather than by pretending the set is empty.
    let error = store
        .active_question(LEARNING_USER_ID, &doomed_id)
        .await
        .expect_err("a tombstoned set has no active question");
    draft.error_kinds.push(error.kind());

    // Session history deletion is the same contract at session scope.
    let receipt = store
        .delete_session_history(LEARNING_USER_ID, LEARNING_SET_ID, fixture.voice_session_id)
        .await
        .expect("session history deletes");
    draft.record_id("delete_history.sessions", receipt["sessions"].to_string());
    let error = store
        .record_voice_usage(conformance_usage(fixture.voice_session_id))
        .await
        .expect_err("a deleted session accepts no late usage");
    draft.error_kinds.push(error.kind());
}

fn conformance_usage(voice_session_id: &str) -> VoiceUsageRecord {
    VoiceUsageRecord {
        voice_session_id: Some(voice_session_id.to_owned()),
        provider: "synthetic".to_owned(),
        model: "synthetic-viva".to_owned(),
        duration_seconds: 3,
        text_input_tokens: 30,
        text_output_tokens: 12,
        audio_input_tokens: 0,
        audio_output_tokens: 0,
        cost_estimate_usd: 0.00003,
        first_audio_latency_ms: None,
        answer_eval_latency_ms: Some(2),
        source_retrieval_latency_ms: None,
        source_grounded_correction_count: 1,
    }
}

fn conformance_canary_text() -> String {
    format!(
        "{CONFORMANCE_CANARY} respiration couples the proton gradient to ATP synthase. \
         The {CONFORMANCE_CANARY} complex accepts electrons from NADH in the chain. \
         Oxidative phosphorylation of ADP finishes the {CONFORMANCE_CANARY} pathway."
    )
}

fn canary_occurrences(record: &StudySetIngestionRecord) -> usize {
    let mut seen = BTreeSet::new();
    if record.study_set.title.contains(CONFORMANCE_CANARY) {
        seen.insert("title");
    }
    if record
        .study_set
        .course
        .as_deref()
        .is_some_and(|course| course.contains(CONFORMANCE_CANARY))
    {
        seen.insert("course");
    }
    if record
        .source_spans
        .iter()
        .any(|span| span.excerpt.contains(CONFORMANCE_CANARY))
    {
        seen.insert("excerpt");
    }
    if record
        .concepts
        .iter()
        .any(|concept| concept.label.contains(CONFORMANCE_CANARY))
    {
        seen.insert("concept_label");
    }
    if record
        .questions
        .iter()
        .any(|question| question.prompt.contains(CONFORMANCE_CANARY))
    {
        seen.insert("question_prompt");
    }
    seen.len()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async fn memory_trace(scenario: ConformanceScenario) -> CanonicalStoreTrace {
    memory_trace_of(&CanonicalStoreFixture::new(scenario)).await
}

async fn memory_trace_of(fixture: &CanonicalStoreFixture) -> CanonicalStoreTrace {
    let store = seed_learning_core_memory(&fixture.seed);
    exercise_store_scenario(ConformanceBackend::Memory(&store), fixture).await
}

/// Both backends over the same scenario, compared as one value.
///
/// The Postgres run is the one under test; the in-process memory run is the
/// reference, recomputed here from the *same* `CanonicalStoreFixture` value so
/// the two are the same inputs on the same code path, rather than a stored
/// expectation that can rot.
pub(crate) async fn assert_backends_agree(scenario: ConformanceScenario) {
    let schema = PostgresSchemaFixture::migrated().await;
    let pool = schema.pool().clone();
    let fixture = CanonicalStoreFixture::new(scenario);
    seed_learning_core_postgres(&pool, &fixture.seed).await;
    let postgres = PostgresStudyStore::new(pool.clone());
    let actual = exercise_store_scenario(ConformanceBackend::Postgres(&postgres), &fixture).await;

    let expected = memory_trace_of(&fixture).await;
    assert_traces_match(
        &expected,
        &actual,
        &format!(
            "{scenario:?} on {}",
            ConformanceBackend::Postgres(&postgres).label()
        ),
    );

    if scenario.covers_privacy() {
        // `COR-03`/`SEC-03`, on the one path only Postgres has: fixture seeding is
        // insert-only. It succeeds once into a clean schema, and once the fixture's
        // own study set has been deleted it refuses rather than writing over the
        // tombstone, so a restart cannot resurrect deleted learner material.
        crate::seed_postgres_fixture(&pool)
            .await
            .expect("a clean schema accepts one fixture seed");
        postgres
            .delete_study_set("user-1", "biology-midterm")
            .await
            .expect("the seeded fixture set deletes");
        let refused = crate::seed_postgres_fixture(&pool).await;
        assert!(
            matches!(
                refused,
                Err(crate::FixtureSeedError::ExistingFixture { .. })
            ),
            "fixture seeding must refuse a deleted fixture tombstone, got {refused:?}"
        );
    }

    schema
        .cleanup()
        .await
        .expect("isolated test schema drops cleanly");
}

/// The permanent self-test: proof that the comparison detects semantic drift
/// rather than merely running the methods.
///
/// It takes a real trace, changes only the session replay outcome from
/// `IdempotentReplay` to `Inserted`, and requires the same comparison function
/// used by every scenario to name that exact position.
#[tokio::test]
async fn store_conformance_harness_rejects_inverted_replay_outcome() {
    let trace = memory_trace(ConformanceScenario::LearningAndProgression).await;
    assert!(trace.write_outcomes.len() >= 2);
    assert_eq!(
        trace.write_outcomes[1],
        StudyStoreWriteOutcome::IdempotentReplay
    );

    let mut inverted = trace.clone();
    inverted.write_outcomes[1] = StudyStoreWriteOutcome::Inserted;
    let mismatch = compare_traces(&trace, &inverted)
        .expect_err("an inverted replay outcome must be reported, not accepted");
    assert_eq!(mismatch.field, "write_outcomes[1]");
    assert_eq!(
        compare_traces(&trace, &trace),
        Ok(()),
        "an unchanged trace must compare equal"
    );
}

#[tokio::test]
async fn memory_store_conformance_session_question_fields() {
    let fixture = CanonicalStoreFixture::new(ConformanceScenario::LearningAndProgression);
    let store = seed_learning_core_memory(&fixture.seed);
    exercise_session_question_fields(&ConformanceBackend::Memory(&store), &fixture).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_session_question_fields() {
    let schema = PostgresSchemaFixture::migrated().await;
    let pool = schema.pool().clone();
    let fixture = CanonicalStoreFixture::new(ConformanceScenario::LearningAndProgression);
    seed_learning_core_postgres(&pool, &fixture.seed).await;
    let postgres = PostgresStudyStore::new(pool.clone());
    exercise_session_question_fields(&ConformanceBackend::Postgres(&postgres), &fixture).await;
    schema
        .cleanup()
        .await
        .expect("isolated test schema drops cleanly");
}

#[tokio::test]
async fn memory_store_conformance_turn_outcome_browser_authority() {
    let fixture = CanonicalStoreFixture::new(ConformanceScenario::LearningAndProgression);
    let store = seed_learning_core_memory(&fixture.seed);
    exercise_turn_outcome_browser_authority(&ConformanceBackend::Memory(&store), &fixture).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_turn_outcome_browser_authority() {
    let schema = PostgresSchemaFixture::migrated().await;
    let pool = schema.pool().clone();
    let fixture = CanonicalStoreFixture::new(ConformanceScenario::LearningAndProgression);
    seed_learning_core_postgres(&pool, &fixture.seed).await;
    let postgres = PostgresStudyStore::new(pool.clone());
    exercise_turn_outcome_browser_authority(&ConformanceBackend::Postgres(&postgres), &fixture)
        .await;
    schema
        .cleanup()
        .await
        .expect("isolated test schema drops cleanly");
}

#[tokio::test]
async fn memory_store_conformance_ingestion() {
    memory_trace(ConformanceScenario::Ingestion).await;
}

#[tokio::test]
async fn memory_store_conformance_learning_and_progression() {
    memory_trace(ConformanceScenario::LearningAndProgression).await;
}

#[tokio::test]
async fn memory_store_conformance_authorization_and_nonces() {
    memory_trace(ConformanceScenario::AuthorizationAndNonces).await;
}

#[tokio::test]
async fn memory_store_conformance_privacy_and_delete() {
    memory_trace(ConformanceScenario::PrivacyAndDelete).await;
}

#[tokio::test]
async fn memory_store_conformance_all_owned_ports() {
    memory_trace(ConformanceScenario::AllOwnedPorts).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_ingestion() {
    assert_backends_agree(ConformanceScenario::Ingestion).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_learning_and_progression() {
    assert_backends_agree(ConformanceScenario::LearningAndProgression).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_authorization_and_nonces() {
    assert_backends_agree(ConformanceScenario::AuthorizationAndNonces).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_privacy_and_delete() {
    assert_backends_agree(ConformanceScenario::PrivacyAndDelete).await;
}

#[tokio::test]
#[ignore = "requires DATA_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
async fn postgres_store_conformance_all_owned_ports() {
    assert_backends_agree(ConformanceScenario::AllOwnedPorts).await;
}
