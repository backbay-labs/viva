//! Plan 06 Task 3 (`DOMAIN-006`, part of `DOMAIN-009`): the `StudyMemoryStore`
//! contract fails closed and reports what a write actually did.
//!
//! Two separate claims are pinned here.
//!
//! 1. A partial store — one that implements only the trait's required methods —
//!    must never answer a truth-bearing read or mutation with success. Every
//!    default that used to return `Ok(0)`, `Ok(false)`, `Ok(())`, `Ok(None)`, or
//!    a fabricated `{"closed": false}` document is an `Unavailable` failure.
//! 2. Classification is data. `PortError` carries a `PortErrorKind`; its `reason`
//!    is a diagnostic that no consumer may parse (proved at compile time by
//!    `tests/ui/port_error_struct_pattern.rs`), and `StudyStoreWriteOutcome`
//!    cannot be silently dropped (`tests/ui/study_store_write_outcome_unused.rs`).
//!
//! Learning fixtures are Plan 04's canonical `turn-outcomes-v1.json` values; this
//! file defines no simplified Plan 06 learner fact.

use std::sync::atomic::{AtomicUsize, Ordering};

use agent_domain::{
    learning_outcome::{ChallengeResolution, TurnOutcome},
    AnswerEvaluation, ConceptStatus, PortError, PortErrorKind, ProgressionPolicyId, SessionConfig,
    SessionId, StudyMemoryStore, StudyMode, StudySessionRecap, StudySourceReference,
    StudyStoreWriteCounts, StudyStoreWriteOutcome, VoiceUsageRecord,
};
use async_trait::async_trait;
use serde_json::Value;

const TURN_OUTCOMES_FIXTURE: &str =
    include_str!("../../../fixtures/learning-core/turn-outcomes-v1.json");

fn fixture_node(section: &str, key: &str) -> Value {
    let fixture: Value = serde_json::from_str(TURN_OUTCOMES_FIXTURE)
        .expect("Plan 04 turn-outcomes fixture is valid JSON");
    fixture
        .get(section)
        .and_then(|node| node.get(key))
        .cloned()
        .unwrap_or_else(|| panic!("canonical fixture defines {section}.{key}"))
}

/// Plan 04's canonical evaluated outcome, parsed through Plan 04's own type.
fn fixture_turn_outcome() -> TurnOutcome {
    serde_json::from_value(fixture_node("outcomes", "evaluated_strong"))
        .expect("canonical outcome parses through Plan 04's TurnOutcome")
}

/// Plan 04's canonical challenge resolution, parsed through Plan 04's own type.
fn fixture_challenge() -> ChallengeResolution {
    serde_json::from_value(fixture_node("challenges", "source_confirmed"))
        .expect("canonical challenge parses through Plan 04's ChallengeResolution")
}

fn fixture_session_config() -> SessionConfig {
    SessionConfig {
        session_id: Some(SessionId::new("voice-1")),
        user_id: Some("u".to_owned()),
        study_set_id: Some("s".to_owned()),
        mode: Some(StudyMode::Quiz),
        source_context: Vec::new(),
        active_concepts: vec!["concept-electron-transport-chain".to_owned()],
        client_generation_id: None,
    }
}

fn fixture_usage() -> VoiceUsageRecord {
    VoiceUsageRecord {
        voice_session_id: Some("voice-1".to_owned()),
        provider: "gemini".to_owned(),
        model: "gemini-live".to_owned(),
        duration_seconds: 42,
        text_input_tokens: 11,
        text_output_tokens: 12,
        audio_input_tokens: 13,
        audio_output_tokens: 14,
        cost_estimate_usd: 0.25,
        first_audio_latency_ms: Some(320),
        answer_eval_latency_ms: Some(410),
        source_retrieval_latency_ms: Some(90),
        source_grounded_correction_count: 1,
    }
}

#[track_caller]
fn assert_unavailable<T: std::fmt::Debug>(result: Result<T, PortError>) {
    match result {
        Ok(value) => {
            panic!("a partial store reported success instead of failing closed: {value:?}")
        }
        Err(error) => assert_eq!(
            error.kind(),
            PortErrorKind::Unavailable,
            "a partial store must fail closed with Unavailable, got {error}",
        ),
    }
}

/// Implements exactly the trait's required methods. Every other call therefore
/// exercises the shipped default, which is the subject of this suite.
struct DefaultsProbeStore;

#[async_trait]
impl StudyMemoryStore for DefaultsProbeStore {
    async fn study_context(
        &self,
        _user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        Err(PortError::unavailable(
            "defaults_probe_store",
            study_set_id,
            "study_context is not implemented by the probe",
        ))
    }

    async fn record_answer_evaluation(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "defaults_probe_store",
            response_id,
            "record_answer_evaluation is not implemented by the probe",
        ))
    }

    async fn source_reference(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        Err(PortError::unavailable(
            "defaults_probe_store",
            source_id,
            "source_reference is not implemented by the probe",
        ))
    }

    async fn record_concept_status(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _response_id: &str,
        concept_id: &str,
        _status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        Err(PortError::unavailable(
            "defaults_probe_store",
            concept_id,
            "record_concept_status is not implemented by the probe",
        ))
    }

    async fn schedule_review_item(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        concept_id: &str,
        _due_at: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "defaults_probe_store",
            concept_id,
            "schedule_review_item is not implemented by the probe",
        ))
    }

    async fn record_recap(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _recap: StudySessionRecap,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "defaults_probe_store",
            response_id,
            "record_recap is not implemented by the probe",
        ))
    }
}

#[tokio::test]
async fn incomplete_store_never_reports_successful_truth_or_mutation() {
    let store = DefaultsProbeStore;
    let config = fixture_session_config();

    assert_unavailable(store.record_voice_session(&config).await);
    assert_unavailable(store.pending_answer_attempts_for_session("voice-1").await);
    assert_unavailable(
        store
            .study_session_durable_counts("u", "s", "voice-1")
            .await,
    );
    assert_unavailable(
        store
            .answer_attempt_was_recorded("u", "s", "voice-1", "r")
            .await,
    );
    assert_unavailable(store.close_voice_session("voice-1", "drained").await);
    assert_unavailable(store.active_question("u", "s").await);
    assert_unavailable(store.record_voice_usage(fixture_usage()).await);
    assert_unavailable(
        store
            .record_turn_outcome("u", "s", "voice-1", fixture_turn_outcome())
            .await,
    );
    assert_unavailable(store.session_learning_evidence("u", "s", "voice-1").await);
    assert_unavailable(
        store
            .record_challenge_resolution("u", "s", "voice-1", fixture_challenge())
            .await,
    );
    assert_unavailable(
        store
            .select_next_question(
                "u",
                "s",
                "voice-1",
                "response-1",
                ProgressionPolicyId::OrderedV1,
            )
            .await,
    );
    assert_unavailable(
        store
            .authenticated_study_projection("u", "s", "voice-1")
            .await,
    );
}

/// The already fail-closed authorization/mutation defaults must stay fail closed;
/// Task 3 changes their error type, never their disposition.
#[tokio::test]
async fn incomplete_store_keeps_its_existing_fail_closed_authorization_defaults() {
    let store = DefaultsProbeStore;

    assert_unavailable(store.library_snapshot("u").await);
    assert_unavailable(store.delete_study_set("u", "s").await);
    assert_unavailable(store.delete_session_history("u", "s", "voice-1").await);
    assert_unavailable(store.review_scheduling_context("u", "s", "concept-1").await);
}

/// Capability and count observations are *observations*, not claims that a read
/// or write succeeded, so they remain values rather than errors.
#[test]
fn capability_and_count_observations_stay_values_and_report_nothing_durable() {
    let store = DefaultsProbeStore;

    let capabilities = store.capabilities();
    assert!(!capabilities.available);
    assert!(!capabilities.durable);
    assert!(!capabilities.nonce_replay_protection);

    assert_eq!(store.write_counts(), StudyStoreWriteCounts::default());
}

#[test]
fn write_counts_default_counts_every_write_class_including_voice_usage() {
    let counts = StudyStoreWriteCounts::default();

    assert_eq!(counts.sessions, 0);
    assert_eq!(counts.answer_attempts, 0);
    assert_eq!(counts.concept_statuses, 0);
    assert_eq!(counts.review_items, 0);
    assert_eq!(counts.recaps, 0);
    assert_eq!(counts.voice_usage, 0);
}

#[test]
fn durability_is_a_kind_not_a_reason_substring() {
    let durability = PortError::durability(
        "study_store",
        "voice-1",
        "connection pool timed out while committing",
    );

    assert_eq!(durability.kind(), PortErrorKind::Durability);
    assert!(durability.is_durability());

    for error in [
        PortError::unavailable("study_store", "voice-1", "store is not implemented"),
        PortError::invalid_input("study_store", "voice-1", "response_id is empty"),
        PortError::conflict("study_store", "voice-1", "nonce already claimed"),
        PortError::internal("study_store", "voice-1", "write count lock poisoned"),
    ] {
        assert!(
            !error.is_durability(),
            "{} must not be classified as a durability failure",
            error.kind().as_str(),
        );
        assert_ne!(error.kind(), PortErrorKind::Durability);
    }
}

#[test]
fn port_error_kinds_are_a_closed_vocabulary_with_stable_tokens() {
    let cases = [
        (
            PortError::unavailable("study_store", "id", "reason"),
            PortErrorKind::Unavailable,
            "unavailable",
        ),
        (
            PortError::invalid_input("study_store", "id", "reason"),
            PortErrorKind::InvalidInput,
            "invalid_input",
        ),
        (
            PortError::conflict("study_store", "id", "reason"),
            PortErrorKind::Conflict,
            "conflict",
        ),
        (
            PortError::durability("study_store", "id", "reason"),
            PortErrorKind::Durability,
            "durability",
        ),
        (
            PortError::internal("study_store", "id", "reason"),
            PortErrorKind::Internal,
            "internal",
        ),
    ];

    for (error, expected_kind, expected_token) in cases {
        assert_eq!(error.kind(), expected_kind);
        assert_eq!(expected_kind.as_str(), expected_token);
        assert_eq!(expected_kind.to_string(), expected_token);
    }
}

#[test]
fn port_error_exposes_read_only_accessors_and_keeps_reason_diagnostic() {
    let error = PortError::conflict(
        "study_store",
        "voice-1",
        "session token nonce was already claimed",
    );

    assert_eq!(error.kind(), PortErrorKind::Conflict);
    assert_eq!(error.port(), "study_store");
    assert_eq!(error.id(), "voice-1");
    assert_eq!(error.reason(), "session token nonce was already claimed");
    assert_eq!(
        error.to_string(),
        "study_store conflict for voice-1: session token nonce was already claimed",
    );
}

#[test]
fn write_outcome_is_a_two_valued_copy_observation() {
    let inserted = StudyStoreWriteOutcome::Inserted;
    let replay = StudyStoreWriteOutcome::IdempotentReplay;

    assert_ne!(inserted, replay);
    let copied = inserted;
    assert_eq!(copied, inserted);
}

/// A store that actually persists reports what the write did. Session writes may
/// report an idempotent replay; usage has no stable event key and therefore
/// always reports `Inserted` after a successful insert.
struct RecordingProbeStore {
    sessions: AtomicUsize,
    usage: AtomicUsize,
}

impl RecordingProbeStore {
    fn new() -> Self {
        Self {
            sessions: AtomicUsize::new(0),
            usage: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl StudyMemoryStore for RecordingProbeStore {
    async fn record_voice_session(
        &self,
        _config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        if self.sessions.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(StudyStoreWriteOutcome::Inserted)
        } else {
            Ok(StudyStoreWriteOutcome::IdempotentReplay)
        }
    }

    async fn record_voice_usage(
        &self,
        _event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        self.usage.fetch_add(1, Ordering::SeqCst);
        Ok(StudyStoreWriteOutcome::Inserted)
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        StudyStoreWriteCounts {
            sessions: self.sessions.load(Ordering::SeqCst),
            voice_usage: self.usage.load(Ordering::SeqCst),
            ..StudyStoreWriteCounts::default()
        }
    }

    async fn study_context(
        &self,
        _user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<Value>, PortError> {
        Err(PortError::unavailable(
            "recording_probe_store",
            study_set_id,
            "study_context is not implemented by the probe",
        ))
    }

    async fn record_answer_evaluation(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _evaluation: AnswerEvaluation,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "recording_probe_store",
            response_id,
            "record_answer_evaluation is not implemented by the probe",
        ))
    }

    async fn source_reference(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        Err(PortError::unavailable(
            "recording_probe_store",
            source_id,
            "source_reference is not implemented by the probe",
        ))
    }

    async fn record_concept_status(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _response_id: &str,
        concept_id: &str,
        _status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        Err(PortError::unavailable(
            "recording_probe_store",
            concept_id,
            "record_concept_status is not implemented by the probe",
        ))
    }

    async fn schedule_review_item(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        concept_id: &str,
        _due_at: &str,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "recording_probe_store",
            concept_id,
            "schedule_review_item is not implemented by the probe",
        ))
    }

    async fn record_recap(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _recap: StudySessionRecap,
    ) -> Result<Value, PortError> {
        Err(PortError::unavailable(
            "recording_probe_store",
            response_id,
            "record_recap is not implemented by the probe",
        ))
    }
}

#[tokio::test]
async fn session_and_usage_writes_report_an_observable_outcome() {
    let store = RecordingProbeStore::new();
    let config = fixture_session_config();

    assert_eq!(
        store
            .record_voice_session(&config)
            .await
            .expect("first session write succeeds"),
        StudyStoreWriteOutcome::Inserted,
    );
    assert_eq!(
        store
            .record_voice_session(&config)
            .await
            .expect("replayed session write succeeds"),
        StudyStoreWriteOutcome::IdempotentReplay,
    );

    assert_eq!(
        store
            .record_voice_usage(fixture_usage())
            .await
            .expect("first usage write succeeds"),
        StudyStoreWriteOutcome::Inserted,
    );
    assert_eq!(
        store
            .record_voice_usage(fixture_usage())
            .await
            .expect("second usage write succeeds"),
        StudyStoreWriteOutcome::Inserted,
        "usage has no stable event key, so this plan invents no usage idempotency",
    );

    assert_eq!(store.write_counts().sessions, 2);
    assert_eq!(store.write_counts().voice_usage, 2);
}
