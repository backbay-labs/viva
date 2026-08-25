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
    learning_recap::SessionLearningEvidence, AnswerAttemptEnvelope, AnswerCaptureMode,
    AnswerCaptureStatus, AnswerContentPolicy, AnswerEvaluation, AuthenticatedStudyProjectionV1,
    ChallengeResolution, ConceptStatus, CreateFileStudySet, CreatePasteStudySet, PortErrorKind,
    ProgressionPolicyId, QuestionProgressionResult, SessionConfig, SessionId,
    SessionTokenNonceClaim, StudyMemoryStore, StudyMode, StudyQuestion, StudySetIngestionRecord,
    StudySetIngestionStatus, StudyStoreWriteCounts, StudyStoreWriteOutcome, VoiceUsageRecord,
};

use crate::{
    memory::{current_epoch_seconds, SESSION_TOKEN_NONCE_SKEW_SECONDS},
    migrations::tests::{
        evidence_fixture, learning_core_seed, seed_learning_core_memory,
        seed_learning_core_postgres, LearningCoreSeed, PostgresSchemaFixture, LEARNING_SET_ID,
        LEARNING_USER_ID,
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
