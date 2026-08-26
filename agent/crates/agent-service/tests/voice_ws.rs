use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
};

use agent_adapters::{cartesia_gemini::FakeCartesiaGeminiRuntime, SyntheticBrain};
use agent_domain::{
    decide_review_schedule, parse_utc_instant, AnswerAttemptEnvelope, AnswerCaptureMode,
    AnswerCaptureStatus, AnswerContentPolicy, AnswerEvaluation, AudioFrame, BrainError, BrainEvent,
    BrainFailureClass, BrainFailureStage, BrainInput, BrainProviderError, BrainProviderFailure,
    BrainProviderFailureParts, BrainUsage, ConceptStatus, PortError, RealtimeBrain,
    RealtimeBrainCapabilities, RealtimeSession, RealtimeSessionTaskGuard, ReviewOutcomeV1,
    ReviewSchedulingContextV1, SessionConfig, SessionId, SessionTokenNonceClaim, StudyMemoryStore,
    StudyMode, StudyQuestion, StudySessionRecap, StudySetIngestionStatus, StudySourceReference,
    StudyStoreBackend, StudyStoreCapabilities, StudyStoreWriteCounts, TerminalSessionReason,
    VoiceUsageRecord, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
use agent_service::{
    begin_drain_and_wait, build_router, verify_session_token_at, AppState, ClientFrame,
    ClientTurnIntent, DrainOutcome, ExpectedSessionBinding, FailureControlConfig,
    FailureControlScenario, OperatorAccess, ProjectionReadAccess, RecorderLimits, RedactedSecret,
    ServerFrame, VivaServerEvent, VoiceDrainSignal, VoiceEvidenceRecorder, VoiceLimitConfig,
    VoiceRuntimeSnapshot, VoiceServerErrorCode, VoiceUsageRecorder, VoiceWsAccess, WsTimeouts,
    VIVA_VOICE_PROTOCOL_VERSION,
};
use axum::{
    body::Body,
    http::{HeaderValue, Request, StatusCode},
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use observe::{VoiceEvidenceEvent, VoiceEvidenceEventKind, VoiceUsageEvent};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::ErrorKind;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::{
    net::TcpListener,
    sync::{mpsc, Notify, Semaphore},
    task::JoinHandle,
    time::{Duration, Instant},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest, protocol::frame::coding::CloseCode, Message as WsMessage,
    },
    MaybeTlsStream, WebSocketStream,
};
use tower::ServiceExt;

/// A missing provider credential is a `ProviderAuthFailure` observed at the
/// provider-auth stage; the former stringly `MissingApiKey` variant is gone.
fn missing_api_key_error() -> BrainError {
    BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::ProviderAuthFailure,
        stage: BrainFailureStage::ProviderAuth,
        retry_eligible: false,
        latency_ms: 0,
        provider: "cartesia_gemini".to_owned(),
        model: String::new(),
        metadata: "error_kind=missing_api_key".to_owned(),
    }))
}

/// A store write that failed while opening a session. The `PortErrorKind` token is
/// carried as metadata; nothing classifies on it.
fn store_stage_error(error_kind: &str) -> BrainError {
    BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::DurabilityDegraded,
        stage: BrainFailureStage::Store,
        retry_eligible: false,
        latency_ms: 0,
        provider: "fake-provider-store".to_owned(),
        model: String::new(),
        metadata: format!("error_kind={error_kind}"),
    }))
}

/// A session config that cannot supply a required bound identity.
fn session_config_error(error_kind: &str) -> BrainError {
    BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::Rollback,
        stage: BrainFailureStage::Session,
        retry_eligible: false,
        latency_ms: 0,
        provider: "fake-provider".to_owned(),
        model: String::new(),
        metadata: format!("error_kind={error_kind}"),
    }))
}

fn test_state(max_sessions: usize) -> AppState {
    test_state_with_store(
        max_sessions,
        Arc::new(data::InMemoryStudyStore::seeded_fixture()),
    )
}

fn test_state_with_store(max_sessions: usize, store: Arc<data::InMemoryStudyStore>) -> AppState {
    AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess::default(),
        max_sessions,
        store,
    )
}

fn provider_limiter_test_store() -> Arc<data::InMemoryStudyStore> {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    store
}

fn provider_limiter_test_state(
    brain: Arc<dyn RealtimeBrain>,
    provider: &str,
    voice_limits: VoiceLimitConfig,
) -> AppState {
    AppState::with_study_store(
        brain,
        provider,
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        provider_limiter_test_store(),
    )
    .with_voice_limits(voice_limits)
}

fn test_state_with_rest_auth(
    max_sessions: usize,
    store: Arc<data::InMemoryStudyStore>,
) -> AppState {
    AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: Some("rest-secret".into()),
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        max_sessions,
        store,
    )
}

fn test_state_with_session_token(secret: &str) -> AppState {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    test_state_with_session_token_and_store(secret, store)
}

fn test_state_with_session_token_and_store(
    secret: &str,
    store: Arc<data::InMemoryStudyStore>,
) -> AppState {
    AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some(secret.into()),
            allowed_origins: vec![],
        },
        1,
        store,
    )
}

#[derive(Clone, Copy)]
enum FailingStudyStoreMode {
    ClaimNonce,
    StudyContext,
}

struct FailingStudyStore {
    inner: data::InMemoryStudyStore,
    mode: FailingStudyStoreMode,
}

impl FailingStudyStore {
    fn new(mode: FailingStudyStoreMode) -> Self {
        Self {
            inner: data::InMemoryStudyStore::seeded_fixture(),
            mode,
        }
    }
}

#[async_trait::async_trait]
impl StudyMemoryStore for FailingStudyStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn claim_session_token_nonce(
        &self,
        claim: agent_domain::SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        if matches!(self.mode, FailingStudyStoreMode::ClaimNonce) {
            return Err(PortError::unavailable(
                "test_store",
                "nonce",
                "nonce write failed",
            ));
        }
        self.inner.claim_session_token_nonce(claim).await
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        if matches!(self.mode, FailingStudyStoreMode::StudyContext) {
            return Err(PortError::unavailable(
                "test_store",
                "study-context",
                "study context failed",
            ));
        }
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
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
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<agent_domain::ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .persist_review_schedule_decision(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                decision,
            )
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }
}

/// D-01 Branch A library seeding.
///
/// The legacy `schedule_review_item(..., "2026-06-19T09:00:00Z")` seed is gone: the
/// authenticated read model now selects only valid v1 decisions, so the snapshot is
/// seeded through the authoritative persistence seam at the conformance fixture's
/// grading instant. `LIBRARY_SEED_*` are literals copied from
/// `packages/core/src/review-scheduling-conformance-v1.json`
/// (`new-shaky-hinted-one-miss-no-exam`), not from this code's own output.
const LIBRARY_SEED_GRADED_AT: &str = "2031-04-05T12:00:00.000Z";
const LIBRARY_SEED_DUE_AT: &str = "2031-04-07T12:00:00.000Z";

async fn seed_authoritative_review_schedule(store: &Arc<data::InMemoryStudyStore>) {
    let now = parse_utc_instant(LIBRARY_SEED_GRADED_AT).expect("fixture grading instant parses");
    let decision = decide_review_schedule(
        now,
        &ReviewOutcomeV1 {
            status: ConceptStatus::Shaky,
            hint_count: Some(2),
            miss_count: Some(1),
        },
        &ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at: None,
            card: None,
        },
    )
    .expect("authoritative decision");
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
        .unwrap();
}

async fn seed_completed_library_session(store: &Arc<data::InMemoryStudyStore>) {
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
    store
        .record_concept_status(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-concept",
            "nadh",
            ConceptStatus::Shaky,
        )
        .await
        .unwrap();
    seed_authoritative_review_schedule(store).await;
    store
        .record_recap(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-recap",
            StudySessionRecap {
                schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
                deferred_turns: 0,
                voice_session_id: "voice-session-1".to_owned(),
                headline: "Completed session".to_owned(),
                summary: "NADH needs one more recall pass.".to_owned(),
                concepts: vec![
                    agent_domain::RecapConceptOutcome {
                        concept_id: "oxidative-phosphorylation".to_owned(),
                        label: "oxidative-phosphorylation".to_owned(),
                        status: agent_domain::ConceptStatus::Strong,
                    },
                    agent_domain::RecapConceptOutcome {
                        concept_id: "nadh".to_owned(),
                        label: "nadh".to_owned(),
                        status: agent_domain::ConceptStatus::Shaky,
                    },
                ],
                review_schedule: vec![],
                next_action: "Review NADH tomorrow.".to_owned(),
                source_moments: vec![agent_domain::learning_recap::RecapSourceMoment {
                    response_id: "response-recap".to_owned(),
                    source_id: agent_domain::fixture_source_reference().source_id.clone(),
                }],
            },
        )
        .await
        .unwrap();
    store
        .close_voice_session("voice-session-1", "completed")
        .await
        .unwrap();
}

fn fake_cartesia_gemini_state_with_store(
    max_sessions: usize,
    store: Arc<data::InMemoryStudyStore>,
) -> AppState {
    AppState::with_study_store(
        Arc::new(FakeCartesiaGeminiRuntime::new(store.clone())),
        "fake_cartesia_gemini",
        VoiceWsAccess::default(),
        max_sessions,
        store,
    )
}

#[tokio::test]
async fn ready_and_brain_health_routes_report_configured_synthetic_provider() {
    let app = build_router(test_state(4).with_voice_limits(VoiceLimitConfig {
        max_session_cost_usd: Some(0.25),
        ..VoiceLimitConfig::default()
    }));

    let ready = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(ready.status().is_success());
    let ready_body = ready.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ready_body).unwrap()["ready"],
        true
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ready_body).unwrap()["store"]["durable"],
        false
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ready_body).unwrap()["voice_limits"]
            ["max_session_cost_usd"],
        0.25
    );

    let brain = app
        .oneshot(
            Request::builder()
                .uri("/health/brain")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let brain_body = brain.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&brain_body).unwrap()["provider"],
        "synthetic"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&brain_body).unwrap()["brain"]["selectable"],
        true
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&brain_body).unwrap()["voice_limits"]
            ["max_session_cost_usd"],
        0.25
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&brain_body).unwrap()["usage"]["events"],
        0
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&brain_body).unwrap()["usage"]["total_tokens"],
        0
    );
}

/// Fake, non-secret credentials for the operator route tests. They authenticate
/// nothing outside this test binary.
const FIXTURE_OPERATOR_CREDENTIAL: &str = "viva-fixture-operator-credential-0001";
const FIXTURE_LIBRARY_READ_CREDENTIAL: &str = "viva-fixture-library-read-cred-000001";

/// A public deployment under `D-07 TOKEN_ONLY_REFRESH`: there is no WebSocket
/// bearer at all, so the absent-permissive WebSocket bearer check would leave
/// readiness wide open. Readiness therefore carries its own operator credential.
fn operator_auth_test_state() -> AppState {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_operator_access(OperatorAccess::new(Some(
        FIXTURE_OPERATOR_CREDENTIAL.into(),
    )))
}

async fn operator_route_response(
    app: &axum::Router,
    path: &str,
    authorization: Option<&str>,
) -> (StatusCode, String) {
    let mut request = Request::builder().uri(path);
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn readiness_operator_auth_denies_absent_and_wrong_credentials() {
    let app = build_router(operator_auth_test_state());

    for path in ["/ready", "/health/brain"] {
        let (status, body) = operator_route_response(&app, path, None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} admitted a request with no operator credential"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["access"]["status"],
            "denied"
        );

        let (status, body) = operator_route_response(
            &app,
            path,
            Some(&format!("Bearer {FIXTURE_LIBRARY_READ_CREDENTIAL}")),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} admitted a request with the wrong operator credential"
        );
        assert!(!body.contains(FIXTURE_LIBRARY_READ_CREDENTIAL));
        assert!(!body.contains(FIXTURE_OPERATOR_CREDENTIAL));
        assert!(!body.contains("session-secret"));

        let (status, body) = operator_route_response(
            &app,
            path,
            Some(&format!("Bearer {FIXTURE_OPERATOR_CREDENTIAL}")),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{path} rejected the configured operator credential"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["access"]["status"],
            "allowed"
        );
        assert!(!body.contains(FIXTURE_OPERATOR_CREDENTIAL));
        assert!(!body.contains("session-secret"));
    }
}

#[tokio::test]
async fn readiness_operator_auth_keeps_live_public_and_minimal() {
    let app = build_router(operator_auth_test_state());

    let (status, body) = operator_route_response(&app, "/live", None).await;

    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed, serde_json::json!({ "live": true }));
    assert!(!body.contains(FIXTURE_OPERATOR_CREDENTIAL));
    assert!(!body.contains("session-secret"));
}

/// `SERVICE-005`: a long-lived process must not accumulate telemetry forever. The
/// recorders keep at most `capacity` newest sanitized events while their counters
/// and aggregates keep counting every event that was ever recorded.
#[test]
fn recorder_retention_is_bounded() {
    const CAPACITY: usize = 257;
    const RECORDED: u64 = 1_000_000;

    let evidence = VoiceEvidenceRecorder::with_capacity(CAPACITY);
    let usage = VoiceUsageRecorder::with_capacity(CAPACITY);
    let per_event_usage = BrainUsage {
        audio_input_tokens: 3,
        text_input_tokens: 1,
        audio_output_tokens: 4,
        text_output_tokens: 2,
        ..BrainUsage::default()
    };
    let per_event_cost = observe::CostModel::default().estimate_usd(&per_event_usage);

    for index in 0..RECORDED {
        evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::StoreCounts,
            None,
            format!("deterministic_event_{index}"),
        ));
        usage.record(
            None,
            "synthetic",
            "synthetic-viva",
            per_event_usage.clone(),
            1,
            None,
        );
    }

    let evidence_stats = evidence.stats();
    assert_eq!(evidence_stats.capacity, CAPACITY);
    assert_eq!(evidence_stats.retained, CAPACITY);
    assert_eq!(evidence_stats.total_recorded, RECORDED);
    assert_eq!(evidence_stats.dropped, RECORDED - CAPACITY as u64);
    assert_eq!(evidence_stats.dropped, 999_743);

    let retained = evidence.snapshot();
    assert_eq!(retained.len(), CAPACITY);
    assert_eq!(
        retained.first().expect("oldest retained event").detail,
        format!("deterministic_event_{}", RECORDED - CAPACITY as u64)
    );
    assert_eq!(
        retained.last().expect("newest retained event").detail,
        format!("deterministic_event_{}", RECORDED - 1)
    );

    let usage_stats = usage.stats();
    assert_eq!(usage_stats.capacity, CAPACITY);
    assert_eq!(usage_stats.retained, CAPACITY);
    assert_eq!(usage_stats.total_recorded, RECORDED);
    assert_eq!(usage_stats.dropped, 999_743);
    assert_eq!(usage.snapshot().len(), CAPACITY);

    // The aggregate counted every event, including the 999,743 already evicted.
    let aggregate = usage.aggregate();
    assert_eq!(aggregate.prompt_tokens, RECORDED * 4);
    assert_eq!(aggregate.completion_tokens, RECORDED * 6);
    assert_eq!(aggregate.total_tokens, RECORDED * 10);
    assert_eq!(aggregate.invalid_cost_events, 0);
    let expected_cost = per_event_cost * RECORDED as f64;
    assert!(
        (aggregate.estimated_cost_usd - expected_cost).abs() <= expected_cost * 1e-9,
        "estimated cost {} drifted from {expected_cost}",
        aggregate.estimated_cost_usd
    );
}

/// The zero-capacity negative control: retention is off, accounting is not.
#[test]
fn recorder_zero_capacity_retains_nothing_and_keeps_counting() {
    let evidence = VoiceEvidenceRecorder::with_capacity(0);
    let usage = VoiceUsageRecorder::with_capacity(0);

    for index in 0..8_u64 {
        evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::StoreCounts,
            None,
            format!("zero_capacity_event_{index}"),
        ));
        usage.record(
            None,
            "synthetic",
            "synthetic-viva",
            BrainUsage {
                text_input_tokens: 5,
                text_output_tokens: 7,
                ..BrainUsage::default()
            },
            1,
            None,
        );
    }

    assert!(evidence.snapshot().is_empty());
    assert!(usage.snapshot().is_empty());
    assert_eq!(
        (
            evidence.stats().capacity,
            evidence.stats().retained,
            evidence.stats().total_recorded,
            evidence.stats().dropped
        ),
        (0, 0, 8, 8)
    );
    assert_eq!(
        (
            usage.stats().capacity,
            usage.stats().retained,
            usage.stats().total_recorded,
            usage.stats().dropped
        ),
        (0, 0, 8, 8)
    );
    let aggregate = usage.aggregate();
    assert_eq!(aggregate.prompt_tokens, 40);
    assert_eq!(aggregate.completion_tokens, 56);
    assert_eq!(aggregate.total_tokens, 96);
}

/// Hostile strings never reach retention. `provider` and `model` are server-chosen
/// identifiers; a signed credential, a bearer header, transcript prose, or a base64
/// audio blob offered in their place is replaced before it can be retained.
const HOSTILE_SIGNED_CREDENTIAL: &str = "viva1.eyJ1c2VyX2lkIjoidXNlci0xIn0.c2ln";
const HOSTILE_AUTHORIZATION_VALUE: &str = "Bearer viva-fixture-hostile-credential";
const HOSTILE_TRANSCRIPT_TEXT: &str = "the mitochondria is the powerhouse of the cell";
const HOSTILE_BASE64_AUDIO: &str =
    "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAAAAAAAAAAAAAAA";

fn hostile_recorder_values() -> [&'static str; 4] {
    [
        HOSTILE_SIGNED_CREDENTIAL,
        HOSTILE_AUTHORIZATION_VALUE,
        HOSTILE_TRANSCRIPT_TEXT,
        HOSTILE_BASE64_AUDIO,
    ]
}

/// The two retention boundaries make different guarantees, and each is asserted
/// where it holds. `provider` and `model` are server-chosen identifiers, so every
/// hostile class is replaced before retention. An evidence `detail` is
/// server-authored prose that the shared sanitizing constructor scans for
/// credential markers, so the credential-shaped classes are redacted there.
/// Readiness JSON carries only counts, so none of the four ever reaches it — that
/// half is asserted by `readiness_recorder_aggregates_carry_no_subject_material`.
#[test]
fn recorder_sanitizes_hostile_event_provider_and_model_values() {
    let evidence = VoiceEvidenceRecorder::with_capacity(64);
    let usage = VoiceUsageRecorder::with_capacity(64);

    for hostile in hostile_recorder_values() {
        evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::StoreCounts,
            None,
            hostile,
        ));
        usage.record(None, hostile, hostile, BrainUsage::default(), 1, None);
    }

    let evidence_json = serde_json::to_string(&evidence.snapshot()).unwrap();
    let usage_json = serde_json::to_string(&usage.snapshot()).unwrap();
    for hostile in [HOSTILE_SIGNED_CREDENTIAL, HOSTILE_AUTHORIZATION_VALUE] {
        assert!(
            !evidence_json.contains(hostile),
            "evidence retention leaked credential-shaped material"
        );
    }
    for hostile in hostile_recorder_values() {
        assert!(
            !usage_json.contains(hostile),
            "usage retention leaked a hostile value"
        );
    }
    for retained in usage.snapshot() {
        assert_eq!(retained.provider, "redacted_usage_label");
        assert_eq!(retained.model, "redacted_usage_label");
    }
    assert_eq!(
        evidence
            .snapshot()
            .iter()
            .filter(|event| event.detail == "redacted_evidence_detail")
            .count(),
        2,
        "both credential-shaped details must be redacted before retention"
    );
}

#[tokio::test]
async fn readiness_recorder_aggregates_carry_no_subject_material() {
    let state = operator_auth_test_state().with_recorder_limits(RecorderLimits {
        evidence_events: 8,
        usage_events: 4,
    });
    for hostile in hostile_recorder_values() {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::StoreCounts,
            Some(hostile.to_owned()),
            hostile,
        ));
        state.usage.record(
            Some(hostile),
            hostile,
            hostile,
            BrainUsage {
                text_input_tokens: 2,
                text_output_tokens: 3,
                ..BrainUsage::default()
            },
            1,
            None,
        );
    }
    let app = build_router(state);

    let (status, body) = operator_route_response(
        &app,
        "/health/brain",
        Some(&format!("Bearer {FIXTURE_OPERATOR_CREDENTIAL}")),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(payload["usage"]["events"], 4);
    assert_eq!(payload["usage"]["prompt_tokens"], 8);
    assert_eq!(payload["usage"]["completion_tokens"], 12);
    assert_eq!(payload["usage"]["total_tokens"], 20);
    assert_eq!(payload["usage"]["invalid_cost_events"], 0);
    assert_eq!(payload["usage"]["retention"]["capacity"], 4);
    assert_eq!(payload["usage"]["retention"]["retained"], 4);
    assert_eq!(payload["usage"]["retention"]["total_recorded"], 4);
    assert_eq!(payload["usage"]["retention"]["dropped"], 0);
    assert_eq!(payload["evidence"]["capacity"], 8);
    assert_eq!(payload["evidence"]["retained"], 4);
    assert_eq!(payload["evidence"]["total_recorded"], 4);
    assert_eq!(payload["evidence"]["dropped"], 0);

    for forbidden in hostile_recorder_values() {
        assert!(
            !body.contains(forbidden),
            "readiness JSON leaked a forbidden value"
        );
    }
    for forbidden in [
        "user-1",
        "voice-session-1",
        "biology-midterm",
        "session-secret",
        FIXTURE_OPERATOR_CREDENTIAL,
    ] {
        assert!(
            !body.contains(forbidden),
            "readiness JSON leaked subject or credential material"
        );
    }
}

/// Plan 05's immutable session-token vectors. The secret, the clock, the expected
/// binding, and every rejection code are read from the file at test time; nothing
/// here is minted by the verifier under test.
const SESSION_TOKEN_VECTORS_JSON: &str =
    include_str!("../../../fixtures/session-token/v1/vectors.json");

#[derive(Deserialize)]
struct SessionTokenVectors {
    version: u32,
    fake_secret_base64: String,
    clock_unix_seconds: u64,
    cases: Vec<SessionTokenVectorCase>,
}

#[derive(Deserialize)]
struct SessionTokenVectorCase {
    id: String,
    token: String,
    claims: Option<serde_json::Value>,
    valid: bool,
    rejection: Option<String>,
}

fn session_token_vectors() -> SessionTokenVectors {
    serde_json::from_str(SESSION_TOKEN_VECTORS_JSON).expect("session-token vectors parse")
}

/// `SERVICE-004`: one strict verifier, proven against every published vector.
#[test]
fn session_token_v1_vectors() {
    let vectors = session_token_vectors();
    assert_eq!(vectors.version, 1);

    let secret: RedactedSecret = String::from_utf8(
        STANDARD
            .decode(&vectors.fake_secret_base64)
            .expect("fixture secret is base64"),
    )
    .expect("fixture secret is textual")
    .into();

    // The expected binding is the canonical vector's own identity, read from the
    // file rather than restated here.
    let canonical = vectors
        .cases
        .iter()
        .find(|case| case.id == "VOICE-TOKEN-VALID-CANONICAL")
        .and_then(|case| case.claims.as_ref())
        .expect("canonical vector carries its claims");
    let expected_user_id = canonical["user_id"].as_str().expect("user_id").to_owned();
    let expected_study_set_id = canonical["study_set_id"]
        .as_str()
        .expect("study_set_id")
        .to_owned();
    let expected_session_id = canonical["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned();
    let expected = ExpectedSessionBinding {
        user_id: &expected_user_id,
        study_set_id: &expected_study_set_id,
        session_id: &expected_session_id,
    };

    for case in &vectors.cases {
        let outcome = verify_session_token_at(
            &case.token,
            &secret,
            vectors.clock_unix_seconds,
            Some(expected),
        );
        match (case.valid, outcome) {
            (true, Ok(claims)) => {
                assert_eq!(
                    serde_json::to_value(&claims).expect("claims serialize"),
                    *case.claims.as_ref().expect("valid vector carries claims"),
                    "{} returned different claims",
                    case.id
                );
                assert_eq!(
                    format!("{claims:?}"),
                    "SessionTokenClaims([REDACTED])",
                    "{} rendered claim values in Debug",
                    case.id
                );
            }
            (false, Err(error)) => {
                assert_eq!(
                    error.code(),
                    case.rejection.as_deref().expect("rejection code"),
                    "{} returned the wrong rejection code",
                    case.id
                );
                let rendered = format!("{error:?} {error}");
                assert!(
                    !rendered.contains(&case.token) && !rendered.contains(&expected_user_id),
                    "{} leaked encoded input or claim values",
                    case.id
                );
            }
            (true, Err(error)) => {
                panic!("{} should verify, got {}", case.id, error.code())
            }
            (false, Ok(_)) => panic!("{} must be rejected", case.id),
        }
    }

    // The 60-second expiry grace the old verifier applied is gone: expiry is exact.
    let canonical_token = &vectors
        .cases
        .iter()
        .find(|case| case.id == "VOICE-TOKEN-VALID-CANONICAL")
        .expect("canonical vector")
        .token;
    let expires_at = canonical["expires_at"].as_u64().expect("expires_at");
    assert!(verify_session_token_at(canonical_token, &secret, expires_at - 1, None).is_ok());
    assert_eq!(
        verify_session_token_at(canonical_token, &secret, expires_at, None)
            .expect_err("expiry is exclusive")
            .code(),
        "expired"
    );
    assert_eq!(
        verify_session_token_at(canonical_token, &secret, expires_at + 59, None)
            .expect_err("there is no expiry grace window")
            .code(),
        "expired"
    );

    // A wrong secret never reveals more than the coarse signature rejection.
    assert_eq!(
        verify_session_token_at(
            canonical_token,
            &"viva-fixture-not-the-signing-secret-1".into(),
            vectors.clock_unix_seconds,
            None,
        )
        .expect_err("a wrong secret cannot verify")
        .code(),
        "invalid_signature"
    );
}

/// `SERVICE-004`: server-owned observation of the admission ordering. The log
/// records store operations in the order the socket performed them, so the test
/// reads the server's own sequence rather than a client-visible side effect.
#[derive(Default)]
struct NonceAuditLog {
    operations: Mutex<Vec<&'static str>>,
    nonce_calls: AtomicUsize,
    nonce_successes: AtomicUsize,
}

impl NonceAuditLog {
    fn record(&self, operation: &'static str) {
        self.operations.lock().unwrap().push(operation);
    }

    fn operations(&self) -> Vec<&'static str> {
        self.operations.lock().unwrap().clone()
    }
}

struct NonceAuditStudyStore {
    inner: Arc<data::InMemoryStudyStore>,
    audit: Arc<NonceAuditLog>,
}

#[async_trait::async_trait]
impl StudyMemoryStore for NonceAuditStudyStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        self.audit.record("claim_session_token_nonce");
        self.audit.nonce_calls.fetch_add(1, Ordering::SeqCst);
        let outcome = self.inner.claim_session_token_nonce(claim).await;
        if outcome.is_ok() {
            self.audit.nonce_successes.fetch_add(1, Ordering::SeqCst);
        }
        outcome
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        self.audit.record("study_context");
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
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
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .persist_review_schedule_decision(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                decision,
            )
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }
}

const NONCE_AUDIT_SECRET: &str = "viva-fixture-session-signing-secret01";

fn nonce_audit_state() -> (AppState, Arc<NonceAuditLog>) {
    let inner = provider_limiter_test_store();
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner: inner.clone(),
        audit: audit.clone(),
    });
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(inner)),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some(NONCE_AUDIT_SECRET.into()),
            allowed_origins: vec![],
        },
        4,
        store,
    );
    (state, audit)
}

fn nonce_audit_backoff_state(opens: Arc<AtomicUsize>) -> (AppState, Arc<NonceAuditLog>) {
    let inner = provider_limiter_test_store();
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner,
        audit: audit.clone(),
    });
    let state = AppState::with_study_store(
        Arc::new(OpenRateLimitFailureBrain { opens }),
        "cartesia_gemini",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some(NONCE_AUDIT_SECRET.into()),
            allowed_origins: vec![],
        },
        4,
        store,
    );
    (state, audit)
}

fn nonce_audit_token(session_id: &str, nonce: &str) -> String {
    nonce_audit_token_for("biology-midterm", session_id, nonce)
}

fn nonce_audit_token_for(study_set_id: &str, session_id: &str, nonce: &str) -> String {
    signed_session_token(
        NONCE_AUDIT_SECRET,
        "user-1",
        study_set_id,
        session_id,
        unix_timestamp_now() + 60,
        nonce,
    )
}

/// The upgrade request the token-only browser client makes: the signed credential
/// rides in the `bearer.<base64url(token)>` subprotocol entry.
fn token_only_request(
    url: &str,
    token: &str,
) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&format!(
            "viva-voice, bearer.{}",
            URL_SAFE_NO_PAD.encode(token)
        ))
        .expect("subprotocol header is valid"),
    );
    request
}

/// `SERVICE-004`: the preflight never touches the nonce store; the one atomic
/// claim happens after admission and before any study lookup; and it succeeds at
/// most once for a given credential.
#[tokio::test]
async fn signed_session_nonce_is_claimed_after_admission_and_once_only() {
    let (state, audit) = nonce_audit_state();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = nonce_audit_token("voice-session-1", "nonce-audit-order-1");

    let (mut socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .expect("a verified token opens the socket");
    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    assert_eq!(
        audit.nonce_calls.load(Ordering::SeqCst),
        0,
        "the HTTP upgrade must never call the nonce store"
    );

    socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token("biology-midterm", "voice-session-1", &token)
                .into(),
        ))
        .await
        .unwrap();
    let question = read_server_frame(&mut socket).await;
    assert!(
        matches!(question, ServerFrame::Event { .. }),
        "the bound config opens the session, got {question:?}"
    );

    let operations = audit.operations();
    let claim_index = operations
        .iter()
        .position(|operation| *operation == "claim_session_token_nonce")
        .expect("the bound config claims the nonce exactly once");
    assert_eq!(
        operations
            .iter()
            .filter(|operation| **operation == "claim_session_token_nonce")
            .count(),
        1
    );
    if let Some(study_index) = operations
        .iter()
        .position(|operation| *operation == "study_context")
    {
        assert!(
            claim_index < study_index,
            "the nonce claim must precede any study lookup, got {operations:?}"
        );
    }
    assert_eq!(audit.nonce_successes.load(Ordering::SeqCst), 1);

    socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut socket).await;

    // Replaying the same credential is refused, and the store still records one
    // successful claim in total.
    let (mut replay, _) = connect_async(token_only_request(&url, &token))
        .await
        .expect("the upgrade still verifies the signature");
    assert_eq!(read_server_frame(&mut replay).await, ServerFrame::ready());
    replay
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token("biology-midterm", "voice-session-1", &token)
                .into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frames_until_close(&mut replay).await;
    assert_eq!(
        audit.nonce_successes.load(Ordering::SeqCst),
        1,
        "a replayed credential must not produce a second successful claim"
    );
}

/// A provider-backoff denial closes the socket without consuming the nonce, so the
/// same credential still opens a session once the backoff window has passed. This
/// is the explicit lease-denial case beside the baseline
/// `websocket_provider_backoff_denial_does_not_consume_signed_nonce`, which stays.
#[tokio::test]
async fn signed_session_nonce_survives_capacity_and_backoff_denial() {
    let opens = Arc::new(AtomicUsize::new(0));
    let (state, audit) = nonce_audit_backoff_state(opens.clone());
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let first_token = nonce_audit_token_for(
        "biology-midterm",
        "voice-session-1",
        "nonce-audit-backoff-first",
    );
    let denied_token = nonce_audit_token_for(
        "chemistry-final",
        "voice-session-2",
        "nonce-audit-backoff-denied",
    );

    let (mut first, _) = connect_async(token_only_request(&url, &first_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first, "cartesia_gemini").await;
    first
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut first).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    let _ = read_server_frames_until_close(&mut first).await;
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(
        audit.nonce_successes.load(Ordering::SeqCst),
        1,
        "an admitted connection claims its own nonce once"
    );

    // Inside the backoff window admission is denied before the nonce is touched.
    let (mut denied, _) = connect_async(token_only_request(&url, &denied_token))
        .await
        .unwrap();
    assert_ready_provider(&mut denied, "cartesia_gemini").await;
    denied
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &denied_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut denied).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut denied, CloseCode::Policy).await;
    assert_eq!(
        opens.load(Ordering::SeqCst),
        1,
        "an active backoff denies before reopening the provider"
    );
    assert_eq!(
        audit.nonce_successes.load(Ordering::SeqCst),
        1,
        "a backoff denial must not consume the nonce"
    );

    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut retry, _) = connect_async(token_only_request(&url, &denied_token))
        .await
        .unwrap();
    assert_ready_provider(&mut retry, "cartesia_gemini").await;
    retry
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &denied_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut retry).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    let _ = read_server_frames_until_close(&mut retry).await;
    assert_eq!(
        opens.load(Ordering::SeqCst),
        2,
        "the denied credential still opens a provider turn after the backoff"
    );
    assert_eq!(
        audit.nonce_successes.load(Ordering::SeqCst),
        2,
        "the denied credential was still claimable on the later attempt"
    );
}

fn token_only_preflight_state() -> (AppState, Arc<NonceAuditLog>, Arc<Semaphore>) {
    let (state, audit) = nonce_audit_state();
    let state = state.with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(4),
        ..VoiceLimitConfig::default()
    });
    let slots = state.session_slots.clone();
    (state, audit, slots)
}

/// The upgrade request a trusted service makes: a shared bearer in `Authorization`.
/// The first bound frame still carries its own signed credential.
fn service_bearer_request(
    url: &str,
    bearer: &str,
) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {bearer}")).expect("authorization header is valid"),
    );
    request
}

fn token_only_request_with_protocol(
    url: &str,
    protocol: &str,
) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(protocol).expect("subprotocol header is valid"),
    );
    request
}

/// `SERVICE-004` / `D-07 TOKEN_ONLY_REFRESH` branch `retain-token-only`: in public
/// token-only mode the signed credential is verified during the HTTP upgrade, so
/// an unverified upgrade never reaches `Ready`, never takes a session slot or an
/// IP lease, and never touches the nonce store.
#[tokio::test]
async fn token_only_preflight_rejects_unverified_upgrades() {
    let (state, audit, slots) = token_only_preflight_state();
    let limits = state.limit_state.clone();
    let total_slots = slots.available_permits();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let valid = nonce_audit_token("voice-session-1", "nonce-token-only-valid");
    let expired = signed_session_token(
        NONCE_AUDIT_SECRET,
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now().saturating_sub(120),
        "nonce-token-only-expired",
    );
    let wrong_secret_token = signed_session_token(
        "viva-fixture-not-the-signing-secret-1",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-token-only-bad-signature",
    );

    let rejected: Vec<(&str, String)> = vec![
        ("missing token", "viva-voice".to_owned()),
        (
            "wrong subprotocol",
            format!("viva-audio, session.{}", URL_SAFE_NO_PAD.encode(&valid)),
        ),
        (
            "malformed token",
            "viva-voice, bearer.not-a-canonical-token".to_owned(),
        ),
        (
            "bad signature",
            format!(
                "viva-voice, bearer.{}",
                URL_SAFE_NO_PAD.encode(&wrong_secret_token)
            ),
        ),
        (
            "expired token",
            format!("viva-voice, bearer.{}", URL_SAFE_NO_PAD.encode(&expired)),
        ),
    ];

    for (name, protocol) in rejected {
        match connect_async(token_only_request_with_protocol(&url, &protocol)).await {
            Ok(_) => panic!("{name} must not upgrade"),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{name} was not rejected with 401"
            ),
            Err(other) => panic!("{name} expected HTTP 401, got {other:?}"),
        }
        assert_eq!(
            slots.available_permits(),
            total_slots,
            "{name} consumed a session slot"
        );
        assert_eq!(
            limits.ip_lease_count("127.0.0.1"),
            None,
            "{name} took an IP lease"
        );
        assert_eq!(
            audit.nonce_calls.load(Ordering::SeqCst),
            0,
            "{name} reached the nonce store"
        );
    }

    let (mut socket, _) = connect_async(token_only_request(&url, &valid))
        .await
        .expect("a verified token upgrades");
    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    assert_eq!(audit.nonce_calls.load(Ordering::SeqCst), 0);
    socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut socket).await;
}

/// The verified preflight does not consume the nonce: a socket that disconnects
/// before its bound `session_config` leaves the credential usable exactly once
/// more, and the attempt after that is refused.
#[tokio::test]
async fn token_only_preflight_nonce_is_consumed_once_across_reconnects() {
    let (state, audit, _slots) = token_only_preflight_state();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = nonce_audit_token("voice-session-1", "nonce-token-only-reconnect");
    let config =
        session_config_json_with_ids_and_token("biology-midterm", "voice-session-1", &token);

    // 1. Verified upgrade, then disconnect before any bound config.
    let (mut first, _) = connect_async(token_only_request(&url, &token))
        .await
        .expect("a verified token upgrades");
    assert_eq!(read_server_frame(&mut first).await, ServerFrame::ready());
    first.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first).await;
    assert_eq!(
        audit.nonce_calls.load(Ordering::SeqCst),
        0,
        "an upgrade that never bound a config must not touch the nonce store"
    );

    // 2. The same credential still opens a session.
    let (mut second, _) = connect_async(token_only_request(&url, &token))
        .await
        .expect("the credential is still usable");
    assert_eq!(read_server_frame(&mut second).await, ServerFrame::ready());
    second
        .send(WsMessage::Text(config.clone().into()))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut second).await,
        ServerFrame::Event { .. }
    ));
    assert_eq!(audit.nonce_successes.load(Ordering::SeqCst), 1);
    second.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut second).await;

    // 3. A third attempt with the same credential is a replay.
    let (mut third, _) = connect_async(token_only_request(&url, &token))
        .await
        .expect("the signature still verifies at the upgrade");
    assert_eq!(read_server_frame(&mut third).await, ServerFrame::ready());
    third.send(WsMessage::Text(config.into())).await.unwrap();
    let _ = read_server_frames_until_close(&mut third).await;
    assert_eq!(
        audit.nonce_successes.load(Ordering::SeqCst),
        1,
        "the nonce store must record exactly one successful claim in total"
    );
}

#[tokio::test]
async fn readiness_routes_are_browser_readable_from_allowed_origin() {
    let origin = "http://127.0.0.1:3007";
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: None,
            allowed_origins: vec![origin.to_owned()],
        },
        4,
        store,
    );
    let app = build_router(state);

    for path in ["/health", "/live", "/ready", "/health/brain"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert!(
            response.status().is_success(),
            "{path} returned {}",
            response.status()
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            origin,
            "{path} did not expose browser-readable CORS"
        );
        assert!(
            response
                .headers()
                .get("access-control-allow-methods")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("GET"),
            "{path} did not advertise GET as an allowed method"
        );
    }
}

#[tokio::test]
async fn ready_route_reports_unavailable_during_voice_drain() {
    let state = test_state(4);
    state.drain_signal.begin_drain();
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["ready"], false);
    assert_eq!(payload["brain"]["selectable"], true);
    assert_eq!(payload["store"]["available"], true);
}

#[tokio::test]
async fn ready_route_distinguishes_dependency_failure_from_access_denial() {
    let origin = "https://viva.example";
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(CapabilityProbeBrain {
            capabilities: RealtimeBrainCapabilities {
                provider: "cartesia_gemini".to_owned(),
                configured: false,
                selectable: false,
                live_runtime: false,
            },
        }),
        "cartesia_gemini",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: None,
            allowed_origins: vec![origin.to_owned()],
        },
        4,
        store,
    );
    let app = build_router(state);

    let dependency_failure = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .header("origin", origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(dependency_failure.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = dependency_failure
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["ready"], false);
    assert_eq!(payload["readiness_status"], "provider_unconfigured");
    assert_eq!(payload["failure_kind"], "dependency_unavailable");
    assert_eq!(payload["access"]["status"], "allowed");

    let access_denied = app
        .oneshot(
            Request::builder()
                .uri("/ready")
                .header("origin", "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(access_denied.status(), StatusCode::FORBIDDEN);
    let body = access_denied
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["readiness_status"], "access_denied");
    assert_eq!(payload["failure_kind"], "access_denied");
    assert_eq!(payload["access"]["status"], "denied");
    assert_eq!(payload["access"]["reason"], "origin_denied");

    // `SERVICE-010`: readiness denial is keyed on the operator credential, not on
    // the WebSocket bearer, which is legitimately absent under token-only access.
    let bearer_state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(Arc::new(
            data::InMemoryStudyStore::seeded_fixture(),
        ))),
        "synthetic",
        VoiceWsAccess {
            required_bearer: Some("rest-secret".into()),
            session_token_secret: None,
            allowed_origins: vec![],
        },
        4,
        Arc::new(data::InMemoryStudyStore::seeded_fixture()),
    )
    .with_operator_access(OperatorAccess::new(Some(
        FIXTURE_OPERATOR_CREDENTIAL.into(),
    )));
    let bearer_app = build_router(bearer_state);
    let missing_bearer = bearer_app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(missing_bearer.status(), StatusCode::UNAUTHORIZED);
    let body = missing_bearer
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["readiness_status"], "access_denied");
    assert_eq!(payload["failure_kind"], "access_denied");
    assert_eq!(payload["access"]["reason"], "missing_bearer");

    let invalid_bearer = bearer_app
        .oneshot(
            Request::builder()
                .uri("/ready")
                .header("authorization", "Bearer wrong-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(invalid_bearer.status(), StatusCode::UNAUTHORIZED);
    let body = invalid_bearer
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["access"]["reason"], "invalid_bearer");
}

// --- `SERVICE-015` / `SERVICE-016` / `COR-04` ingestion contract ------------------

/// The exact body every ingestion route returns for a request that does not match
/// its contract.
const INVALID_INGESTION_BODY: &str = r#"{"error":"invalid_ingestion_request","message":"request body does not match the ingestion contract"}"#;

/// The fixed public message every sanitized `InvalidInput` upload refusal carries.
const UNSUPPORTED_UPLOAD_MESSAGE: &str = "uploaded content is invalid or unsupported";

#[derive(Default)]
struct IngestionCallCounts {
    paste: AtomicUsize,
    create_file: AtomicUsize,
    retry_file: AtomicUsize,
}

impl IngestionCallCounts {
    fn total(&self) -> usize {
        self.paste.load(Ordering::SeqCst)
            + self.create_file.load(Ordering::SeqCst)
            + self.retry_file.load(Ordering::SeqCst)
    }
}

/// A real store that additionally records every ingestion call, so a rejected body
/// can be proven never to have reached it.
struct RecordingIngestionStore {
    inner: Arc<data::InMemoryStudyStore>,
    counts: Arc<IngestionCallCounts>,
}

#[async_trait::async_trait]
impl StudyMemoryStore for RecordingIngestionStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
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
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }

    async fn create_paste_study_set(
        &self,
        input: agent_domain::CreatePasteStudySet,
    ) -> Result<agent_domain::StudySetIngestionRecord, PortError> {
        self.counts.paste.fetch_add(1, Ordering::SeqCst);
        self.inner.create_paste_study_set(input).await
    }

    async fn create_file_study_set(
        &self,
        input: agent_domain::CreateFileStudySet,
    ) -> Result<agent_domain::StudySetIngestionRecord, PortError> {
        self.counts.create_file.fetch_add(1, Ordering::SeqCst);
        self.inner.create_file_study_set(input).await
    }

    async fn retry_file_study_set(
        &self,
        input: agent_domain::CreateFileStudySet,
    ) -> Result<agent_domain::StudySetIngestionRecord, PortError> {
        self.counts.retry_file.fetch_add(1, Ordering::SeqCst);
        self.inner.retry_file_study_set(input).await
    }

    async fn library_snapshot(
        &self,
        user_id: &str,
    ) -> Result<agent_domain::StudyLibrarySnapshot, PortError> {
        self.inner.library_snapshot(user_id).await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        self.inner
            .authenticated_study_projection(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }
}

fn ingestion_app() -> (
    axum::Router,
    Arc<IngestionCallCounts>,
    Arc<data::InMemoryStudyStore>,
) {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let counts = Arc::new(IngestionCallCounts::default());
    let store = Arc::new(RecordingIngestionStore {
        inner: inner.clone(),
        counts: counts.clone(),
    });
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(inner.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: Some("rest-secret".into()),
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    );
    (build_router(state), counts, inner)
}

fn ingestion_request(uri: &str, body: String) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("origin", "http://localhost:3000")
        .header("authorization", "Bearer rest-secret")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap()
}

/// `SERVICE-015`: an authority-shaped member is a rejected request, never a silently
/// discarded field, and it never reaches the store.
#[tokio::test]
async fn ingestion_request_shape_rejects_authority_and_unknown_members() {
    let valid_paste = serde_json::json!({
        "title": "Cell Division",
        "course": "Biology 201",
        "exam_date": null,
        "pasted_text": "mitosis chromosome spindle metaphase cytokinesis",
    });
    let valid_file = serde_json::json!({
        "title": "Lecture Notes",
        "course": null,
        "exam_date": null,
        "file_name": "notes.txt",
        "content_type": "text/plain",
        "file_base64": STANDARD.encode(b"Mitosis separates chromosomes into two daughter cells."),
    });
    let valid_retry = serde_json::json!({
        "file_name": "notes.txt",
        "content_type": "text/plain",
        "file_base64": STANDARD.encode(b"Replacement study notes for the failed upload."),
    });

    let routes = [
        ("/study-sets/paste", valid_paste),
        ("/study-sets/files", valid_file),
        (
            "/study-sets/biology-midterm/files/retry?user_id=user-1",
            valid_retry,
        ),
    ];
    let forbidden_members = [
        ("user_id", serde_json::json!("attacker-user")),
        ("session_id", serde_json::json!("attacker-session")),
        (
            "source_spans",
            serde_json::json!([{ "id": "browser-span" }]),
        ),
        (
            "questions",
            serde_json::json!([{ "question_id": "browser-question" }]),
        ),
        ("viva_arbitrary_key", serde_json::json!("browser-supplied")),
    ];

    for (uri, valid) in &routes {
        for (key, value) in &forbidden_members {
            let (app, counts, _inner) = ingestion_app();
            let mut body = valid.clone();
            body[*key] = value.clone();
            let response = app
                .oneshot(ingestion_request(uri, body.to_string()))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{uri} accepted {key}"
            );
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            assert_eq!(text, INVALID_INGESTION_BODY, "{uri} / {key}");
            assert!(!text.contains(*key), "{uri} echoed the rejected key");
            assert!(
                !text.contains(&value.to_string()),
                "{uri} echoed the rejected value"
            );
            assert_eq!(counts.total(), 0, "{uri} / {key} reached the store");
        }
    }

    // Duplicate JSON keys and malformed JSON are the same fixed rejection.
    for (uri, raw) in [
        (
            "/study-sets/paste",
            r#"{"title":"A","title":"B","course":null,"exam_date":null,"pasted_text":"x"}"#
                .to_owned(),
        ),
        ("/study-sets/paste", r#"{"title":"A","#.to_owned()),
        (
            "/study-sets/files",
            r#"{"title":"A","title":"B","course":null,"exam_date":null,"file_name":"a.txt","content_type":"text/plain","file_base64":"QQ=="}"#
                .to_owned(),
        ),
        ("/study-sets/files", "not json at all".to_owned()),
        (
            "/study-sets/biology-midterm/files/retry?user_id=user-1",
            r#"{"file_name":"a.txt","file_name":"b.txt","content_type":"text/plain","file_base64":"QQ=="}"#
                .to_owned(),
        ),
    ] {
        let (app, counts, _inner) = ingestion_app();
        let response = app.oneshot(ingestion_request(uri, raw.clone())).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}: {raw}");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(String::from_utf8(bytes.to_vec()).unwrap(), INVALID_INGESTION_BODY);
        assert_eq!(counts.total(), 0, "{uri}: {raw} reached the store");
    }
}

/// `SERVICE-015`: the accepted contract still works, and every returned fact is
/// server-derived. `A-02`: the ingestion `exam_date` input becomes the authoritative
/// exam instant with no calendar-day rounding.
#[tokio::test]
async fn ingestion_request_shape_accepts_the_contract_and_binds_the_exam_instant() {
    let (app, counts, inner) = ingestion_app();
    let response = app
        .oneshot(ingestion_request(
            "/study-sets/paste",
            serde_json::json!({
                "title": "Cell Division",
                "course": "Biology 201",
                "exam_date": "2031-06-01T09:30:00.000Z",
                "pasted_text": "mitosis chromosome spindle metaphase cytokinesis",
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(counts.paste.load(Ordering::SeqCst), 1);
    // Identity is server state, never a caller-authored fact.
    assert_eq!(payload["study_set"]["user_id"], "user-1");
    assert!(payload["session_id"].as_str().unwrap().len() > 20);

    let study_set_id = payload["study_set"]["id"].as_str().unwrap();
    let concept_id = payload["concepts"][0]["public_id"]
        .as_str()
        .expect("ingestion derives at least one server-owned concept");
    let context = inner
        .review_scheduling_context("user-1", study_set_id, concept_id)
        .await
        .expect("scheduling context reads");
    assert_eq!(
        context.exam_at,
        agent_domain::parse_utc_instant("2031-06-01T09:30:00.000Z"),
        "A-02: the exam instant is the exact UTC input, not a rounded calendar day"
    );
}

// --- `COR-04` generated PDF matrix ----------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GeneratedPdfCase {
    TextUncompressed,
    TextFlateCompressed,
    ScannedImageOnly,
    Encrypted,
    MalformedXref,
    MagicHeaderPlaintext,
}

impl GeneratedPdfCase {
    const ALL: [Self; 6] = [
        Self::TextUncompressed,
        Self::TextFlateCompressed,
        Self::ScannedImageOnly,
        Self::Encrypted,
        Self::MalformedXref,
        Self::MagicHeaderPlaintext,
    ];

    fn file_name(self) -> &'static str {
        match self {
            Self::TextUncompressed => "Lecture 9.pdf",
            Self::TextFlateCompressed => "Lecture 9 compressed.pdf",
            Self::ScannedImageOnly => "Scan 2026-08-24.pdf",
            Self::Encrypted => "Protected.pdf",
            Self::MalformedXref => "Truncated.PDF",
            Self::MagicHeaderPlaintext => "notes.pdf",
        }
    }
}

const PDF_TEXT_STREAM: &[u8] =
    b"BT /F1 12 Tf 72 720 Td (Mitosis chromosome spindle metaphase cytokinesis) Tj ET";

const PDF_FLATE_TEXT_STREAM: [u8; 83] = [
    120, 156, 13, 202, 49, 14, 128, 32, 12, 5, 208, 171, 252, 81, 39, 133, 197, 221, 68, 55, 183,
    94, 128, 64, 13, 168, 80, 98, 89, 188, 189, 36, 111, 124, 43, 97, 218, 13, 140, 5, 157, 88,
    108, 55, 131, 2, 134, 35, 53, 209, 164, 240, 241, 149, 44, 42, 153, 161, 53, 149, 240, 48, 50,
    55, 87, 163, 83, 134, 255, 154, 220, 169, 112, 143, 35, 232, 194, 70, 63, 178, 209, 25, 220,
];

/// The plaintext study prose the magic-header case carries. It is deliberately not a
/// PDF: only its first line pretends to be one.
const PDF_MAGIC_HEADER_PLAINTEXT: &str = "%PDF-1.7\nMitosis separates duplicated chromosomes. \
The spindle attaches at kinetochores and cytokinesis divides the cytoplasm.";

fn pdf_find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn pdf_rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn pdf_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

const MD5_SINE: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

const MD5_SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// Test-only MD5, required by the PDF Standard Security Handler. No production
/// crypto or PDF dependency is added for the fixture factory.
fn pdf_md5(input: &[u8]) -> [u8; 16] {
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

/// Test-only RC4, required by the revision-2 security handler.
fn pdf_rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    assert!(!key.is_empty(), "RC4 needs a key");
    let mut permutation: [u8; 256] = core::array::from_fn(|index| index as u8);
    let mut swap_index = 0usize;
    for index in 0..256usize {
        swap_index =
            (swap_index + usize::from(permutation[index]) + usize::from(key[index % key.len()]))
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

const PDF_PASSWORD_PADDING: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

fn pdf_padded_password(password: &[u8]) -> [u8; 32] {
    let mut padded = [0u8; 32];
    let taken = password.len().min(32);
    padded[..taken].copy_from_slice(&password[..taken]);
    padded[taken..].copy_from_slice(&PDF_PASSWORD_PADDING[..32 - taken]);
    padded
}

/// Builds numbered indirect objects and computes every xref byte offset plus
/// `startxref` from the generated buffer itself.
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
        assert_generated_pdf_is_valid(&self.bytes, count, xref_offset, root);
        self.bytes
    }
}

/// Every builder proves its own output before the HTTP request sees it: header,
/// object offsets, xref, `startxref`, trailer/root, and the EOF marker.
fn assert_generated_pdf_is_valid(bytes: &[u8], count: usize, xref_offset: usize, root: usize) {
    assert!(bytes.starts_with(b"%PDF-1.7"), "PDF header");
    assert_eq!(
        &bytes[xref_offset..xref_offset + 4],
        b"xref",
        "xref keyword"
    );
    let marker = b"startxref\n";
    let marker_start = pdf_rfind(bytes, marker).expect("startxref present");
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
        pdf_find(bytes, format!("/Root {root} 0 R").as_bytes()).is_some(),
        "trailer root"
    );
    assert!(bytes.ends_with(b"%%EOF\n"), "EOF marker");

    let table_start = xref_offset + format!("xref\n0 {count}\n").len();
    for object_number in 1..count {
        let entry_start = table_start + object_number * 20;
        let offset: usize = std::str::from_utf8(&bytes[entry_start..entry_start + 10])
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

/// A test-only fixture factory, never a production parser. Each case is a real file
/// of its declared kind; only `MagicHeaderPlaintext` is deliberately not a PDF.
fn generated_pdf(case: GeneratedPdfCase) -> Vec<u8> {
    match case {
        GeneratedPdfCase::TextUncompressed => {
            let mut pdf = PdfBuilder::new();
            let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
            pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
            pdf.object(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                  /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            );
            pdf.object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
            pdf.stream_object("", PDF_TEXT_STREAM);
            let bytes = pdf.finish(catalog, "");
            assert!(
                pdf_find(&bytes, b" Tj").is_some(),
                "the text page carries a real text-showing operator"
            );
            bytes
        }
        GeneratedPdfCase::TextFlateCompressed => {
            let mut pdf = PdfBuilder::new();
            let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
            pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
            pdf.object(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                  /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            );
            pdf.object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
            pdf.stream_object(" /Filter /FlateDecode", &PDF_FLATE_TEXT_STREAM);
            let bytes = pdf.finish(catalog, "");
            assert!(
                pdf_find(&bytes, b"/FlateDecode").is_some(),
                "declared filter"
            );
            let stream_start = pdf_find(&bytes, b"stream\n").expect("content stream") + 7;
            assert_eq!(
                &bytes[stream_start..stream_start + 2],
                &[0x78, 0x9C],
                "the stream begins with the zlib header"
            );
            assert!(
                pdf_find(&bytes, b" Tj").is_none(),
                "no text operator exists outside the compressed stream"
            );
            bytes
        }
        GeneratedPdfCase::ScannedImageOnly => {
            let mut pdf = PdfBuilder::new();
            let catalog = pdf.object(b"<< /Type /Catalog /Pages 2 0 R >>");
            pdf.object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
            pdf.object(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                  /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
            );
            pdf.stream_object(
                " /Type /XObject /Subtype /Image /Width 1 /Height 1 \
                 /ColorSpace /DeviceGray /BitsPerComponent 8",
                &[0x7F],
            );
            pdf.stream_object("", b"q 612 0 0 792 0 0 cm /Im0 Do Q");
            let bytes = pdf.finish(catalog, "");
            assert!(
                pdf_find(&bytes, b"/Subtype /Image").is_some(),
                "image xobject"
            );
            assert!(
                pdf_find(&bytes, b" Tj").is_none() && pdf_find(&bytes, b" TJ").is_none(),
                "a scanned page carries no text-showing operator"
            );
            bytes
        }
        GeneratedPdfCase::Encrypted => {
            const USER_PASSWORD: &[u8] = b"viva-user";
            const OWNER_PASSWORD: &[u8] = b"viva-owner";
            const PERMISSIONS: i32 = -1;
            let document_id: [u8; 16] = [
                0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
                0xFF, 0x00,
            ];
            // Algorithm 3: /O.
            let owner_digest = pdf_md5(&pdf_padded_password(OWNER_PASSWORD));
            let owner_entry = pdf_rc4(&owner_digest[..5], &pdf_padded_password(USER_PASSWORD));
            assert_eq!(owner_entry.len(), 32, "/O is 32 bytes");
            // Algorithm 2: the file encryption key.
            let mut key_input = Vec::new();
            key_input.extend_from_slice(&pdf_padded_password(USER_PASSWORD));
            key_input.extend_from_slice(&owner_entry);
            key_input.extend_from_slice(&PERMISSIONS.to_le_bytes());
            key_input.extend_from_slice(&document_id);
            let encryption_key = pdf_md5(&key_input)[..5].to_vec();
            // Algorithm 4: /U for revision 2.
            let user_entry = pdf_rc4(&encryption_key, &PDF_PASSWORD_PADDING);
            assert_eq!(user_entry.len(), 32, "/U is 32 bytes");
            // Algorithm 1: the per-object key for the content stream (object 5).
            let mut object_key_input = encryption_key.clone();
            object_key_input.extend_from_slice(&5u32.to_le_bytes()[..3]);
            object_key_input.extend_from_slice(&0u32.to_le_bytes()[..2]);
            let object_key =
                pdf_md5(&object_key_input)[..(encryption_key.len() + 5).min(16)].to_vec();
            let encrypted_content = pdf_rc4(&object_key, PDF_TEXT_STREAM);
            assert_ne!(
                encrypted_content.as_slice(),
                PDF_TEXT_STREAM,
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
                pdf_hex(&owner_entry),
                pdf_hex(&user_entry)
            );
            let encrypt = pdf.object(encrypt_dictionary.as_bytes());
            let trailer_extra = format!(
                " /Encrypt {encrypt} 0 R /ID [<{}> <{}>]",
                pdf_hex(&document_id),
                pdf_hex(&document_id)
            );
            let bytes = pdf.finish(catalog, &trailer_extra);
            assert!(
                pdf_find(&bytes, b"/Filter /Standard").is_some(),
                "std handler"
            );
            assert!(pdf_find(&bytes, b"/R 2").is_some(), "revision 2");
            assert!(
                pdf_find(&bytes, format!("/Encrypt {encrypt} 0 R").as_bytes()).is_some(),
                "the trailer references the encrypt dictionary"
            );
            assert!(
                pdf_find(&bytes, b"Mitosis chromosome").is_none(),
                "no plaintext survives in the encrypted file"
            );
            bytes
        }
        GeneratedPdfCase::MalformedXref => {
            let complete = generated_pdf(GeneratedPdfCase::TextUncompressed);
            let xref_start = pdf_find(&complete, b"xref\n").expect("xref keyword present");
            let mut truncated = complete[..xref_start + 12].to_vec();
            truncated.extend_from_slice(b"000000");
            assert!(
                truncated.starts_with(b"%PDF-1.7"),
                "still claims to be a PDF"
            );
            assert!(
                pdf_find(&truncated, b"trailer").is_none()
                    && pdf_find(&truncated, b"startxref").is_none(),
                "the xref and trailer really are gone"
            );
            truncated
        }
        GeneratedPdfCase::MagicHeaderPlaintext => {
            let bytes = PDF_MAGIC_HEADER_PLAINTEXT.as_bytes().to_vec();
            assert!(bytes.starts_with(b"%PDF"), "carries the magic prefix");
            assert!(pdf_find(&bytes, b" obj").is_none(), "carries no PDF object");
            assert!(pdf_find(&bytes, b"xref").is_none(), "carries no xref table");
            assert!(std::str::from_utf8(&bytes).is_ok(), "is valid UTF-8 prose");
            bytes
        }
    }
}

/// The store facts a refused upload must never create.
fn ingestion_artifact_counts(store: &data::InMemoryStudyStore) -> serde_json::Value {
    serde_json::to_value(store.snapshot()).expect("store snapshot serializes")
}

fn assert_sanitized_upload_refusal(text: &str, expected_code: &str) {
    let payload: serde_json::Value = serde_json::from_str(text).expect("refusal is JSON");
    assert_eq!(payload["error"], expected_code, "{text}");
    assert_eq!(payload["message"], UNSUPPORTED_UPLOAD_MESSAGE, "{text}");
    for forbidden in [
        "session_token",
        "viva1.",
        "study_set",
        "session_id",
        "documents",
        "source_spans",
        "concepts",
        "questions",
        "%PDF",
        "unsupported_pdf",
        "page-aware",
        "Mitosis",
    ] {
        assert!(
            !text.contains(forbidden),
            "refusal leaked {forbidden}: {text}"
        );
    }
}

/// `COR-04` / `SERVICE-016`: every generated PDF category fails closed at the
/// ingestion route with one sanitized `400`, and the store is byte-identical after.
#[tokio::test]
async fn ingestion_unsupported_pdf_fails_closed_on_create() {
    for case in GeneratedPdfCase::ALL {
        let (app, counts, inner) = ingestion_app();
        let before = ingestion_artifact_counts(&inner);
        let response = app
            .oneshot(ingestion_request(
                "/study-sets/files",
                serde_json::json!({
                    "title": "Bio PDF",
                    "course": "Biology 201",
                    "exam_date": null,
                    "file_name": case.file_name(),
                    "content_type": "application/pdf",
                    "file_base64": STANDARD.encode(generated_pdf(case)),
                })
                .to_string(),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{case:?}");
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "no-store",
            "{case:?}"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert_sanitized_upload_refusal(&text, "file_ingestion_failed");
        assert_eq!(counts.create_file.load(Ordering::SeqCst), 1, "{case:?}");
        assert_eq!(
            ingestion_artifact_counts(&inner),
            before,
            "{case:?} changed durable state"
        );
    }
}

/// `COR-04`: the retry route fails closed identically, and a legitimate pre-existing
/// failed record is left byte-for-byte unchanged — it never becomes `retry` or `ready`.
#[tokio::test]
async fn ingestion_unsupported_pdf_fails_closed_on_retry() {
    let (app, counts, inner) = ingestion_app();
    let seeded = app
        .clone()
        .oneshot(ingestion_request(
            "/study-sets/files",
            serde_json::json!({
                "title": "Bad Upload",
                "course": null,
                "exam_date": null,
                "file_name": "empty.txt",
                "content_type": "text/plain",
                "file_base64": STANDARD.encode(b"!!! ??? ---"),
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(seeded.status(), StatusCode::CREATED);
    let seeded_bytes = seeded.into_body().collect().await.unwrap().to_bytes();
    let seeded_payload: serde_json::Value = serde_json::from_slice(&seeded_bytes).unwrap();
    assert_eq!(seeded_payload["study_set"]["ingestion_status"], "failed");
    let study_set_id = seeded_payload["study_set"]["id"]
        .as_str()
        .expect("failed study set id")
        .to_owned();
    let before = ingestion_artifact_counts(&inner);

    for case in GeneratedPdfCase::ALL {
        let response = app
            .clone()
            .oneshot(ingestion_request(
                &format!("/study-sets/{study_set_id}/files/retry?user_id=user-1"),
                serde_json::json!({
                    "file_name": case.file_name(),
                    "content_type": "application/pdf",
                    "file_base64": STANDARD.encode(generated_pdf(case)),
                })
                .to_string(),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{case:?}");
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "no-store",
            "{case:?}"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert_sanitized_upload_refusal(&text, "file_retry_failed");
        assert_eq!(
            ingestion_artifact_counts(&inner),
            before,
            "{case:?} mutated the pre-existing failed record"
        );
    }
    assert_eq!(counts.retry_file.load(Ordering::SeqCst), 6);
}

#[tokio::test]
async fn paste_study_set_route_creates_server_owned_ready_set_with_session_token() {
    let store = Arc::new(data::InMemoryStudyStore::new());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store.clone(),
    );
    let app = build_router(state);
    let pasted_text = "mitosis chromosome spindle metaphase cytokinesis";

    // `SERVICE-015`: an authority-shaped member is no longer silently discarded, it
    // is rejected outright — see `ingestion_request_shape_rejects_authority_and_unknown_members`.
    // What remains provable here is the other half: a contract-shaped request returns
    // only server-derived facts.
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/study-sets/paste")
                .header("origin", "http://localhost:3000")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Cell Division",
                        "course": "Biology 201",
                        "exam_date": null,
                        "pasted_text": pasted_text,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::CREATED);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "http://localhost:3000"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["study_set"]["ingestion_status"], "ready");
    assert_eq!(payload["study_set"]["user_id"], "user-1");
    assert_eq!(payload["documents"][0]["processing_status"], "ready");
    let locator = &payload["source_spans"][0]["locator"];
    assert!(locator["span"].as_str().unwrap().starts_with("chars:"));
    assert!(locator.get("page").is_none());
    assert!(locator.get("bbox").is_none());
    let excerpt = payload["source_spans"][0]["excerpt"].as_str().unwrap();
    assert!(excerpt.contains("mitosis"));
    assert_ne!(excerpt, pasted_text);
    let payload_json = payload.to_string();
    assert!(!payload_json.contains(pasted_text));
    assert!(excerpt.chars().count() <= 360);
    assert_eq!(
        payload["source_spans"][0]["id"],
        payload["questions"][0]["source"]["source_id"]
    );
    assert!(payload["session_id"].as_str().unwrap().len() > 20);
    assert!(payload["session_token"]
        .as_str()
        .expect("session token")
        .starts_with("viva1."));

    let study_set_id = payload["study_set"]["id"].as_str().unwrap();
    let active_question = store
        .active_question("user-1", study_set_id)
        .await
        .unwrap()
        .expect("active generated question");
    assert_eq!(
        active_question.question_id,
        payload["questions"][0]["question_id"]
    );
    assert_ne!(
        active_question.question_id,
        "q-oxidative-phosphorylation-nadh"
    );
}

#[tokio::test]
async fn file_study_set_route_creates_server_owned_ready_document_without_exact_region_claims() {
    let store = Arc::new(data::InMemoryStudyStore::new());
    let app = build_router(test_state_with_session_token_and_store(
        "session-secret",
        store.clone(),
    ));
    // `COR-04`: a PDF of any shape now fails closed at ingestion, proven by
    // `ingestion_unsupported_pdf_fails_closed_on_create`. The property this test owns
    // is the supported-upload lifecycle: server-owned spans with document-level
    // locators and no exact page or bounding-box claim.
    let file_text = [
        "Mitochondria electron transport builds a proton gradient for ATP synthase.",
        "NADH carries electrons to Complex I and oxygen accepts electrons at the chain end.",
        "Chemiosmosis connects proton movement with ATP production.",
    ]
    .join("\n");

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/study-sets/files")
                .header("origin", "http://localhost:3000")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Bio Notes",
                        "course": "Biology 201",
                        "exam_date": null,
                        "file_name": "Lecture 9.txt",
                        "content_type": "text/plain",
                        "file_base64": STANDARD.encode(file_text.as_bytes()),
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::CREATED);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["study_set"]["ingestion_status"], "ready");
    assert_eq!(payload["documents"][0]["display_name"], "Lecture 9.txt");
    assert_eq!(payload["documents"][0]["source_kind"], "file");
    assert_eq!(payload["documents"][0]["processing_status"], "ready");
    assert!(payload["session_token"]
        .as_str()
        .expect("ready file ingestion gets token")
        .starts_with("viva1."));
    assert!(!payload["source_spans"].as_array().unwrap().is_empty());
    for source in payload["source_spans"].as_array().unwrap() {
        assert!(source["locator"]["span"]
            .as_str()
            .expect("document-level span")
            .starts_with("document:chars:"));
        assert!(source["locator"].get("page").is_none());
        assert!(source["locator"].get("bbox").is_none());
        assert_ne!(source["excerpt"], file_text);
    }
    assert!(!String::from_utf8(body.to_vec())
        .unwrap()
        .contains("file_base64"));

    let library = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(library.status(), axum::http::StatusCode::OK);
    let library_body = library.into_body().collect().await.unwrap().to_bytes();
    let library_payload: serde_json::Value = serde_json::from_slice(&library_body).unwrap();
    let file_set = library_payload["study_sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["title"] == "Bio Notes")
        .expect("file study set in library");
    assert_eq!(file_set["ingestion_status"], "ready");
    assert_eq!(file_set["actions"]["start"]["available"], true);
    assert_eq!(file_set["documents"][0]["source_kind"], "file");

    let snapshot_json = serde_json::to_string(&store.snapshot()).unwrap();
    assert!(!snapshot_json.contains(&file_text));
    assert!(!snapshot_json.contains(&STANDARD.encode(file_text.as_bytes())));
}

#[tokio::test]
async fn file_study_set_route_blocks_failed_upload_and_retries_to_ready() {
    // `COR-04`: PDF uploads never reach this lifecycle at all — they fail closed, and
    // `ingestion_unsupported_pdf_fails_closed_on_retry` proves a pre-existing failed
    // record survives a PDF retry unchanged. This test keeps the supported-upload
    // failed / retry / ready progression.
    let app = build_router(test_state_with_rest_auth(
        4,
        Arc::new(data::InMemoryStudyStore::seeded_fixture()),
    ));
    let failed = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/study-sets/files")
                .header("origin", "http://localhost:3000")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Bad Upload",
                        "course": null,
                        "exam_date": null,
                        "file_name": "empty.txt",
                        "content_type": "text/plain",
                        "file_base64": STANDARD.encode(b"!!! ??? ---"),
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(failed.status(), axum::http::StatusCode::CREATED);
    let failed_body = failed.into_body().collect().await.unwrap().to_bytes();
    let failed_payload: serde_json::Value = serde_json::from_slice(&failed_body).unwrap();
    let study_set_id = failed_payload["study_set"]["id"]
        .as_str()
        .expect("failed file study set id")
        .to_owned();
    assert_eq!(failed_payload["study_set"]["ingestion_status"], "failed");
    assert_eq!(failed_payload["session_token"], serde_json::Value::Null);
    assert!(failed_payload["questions"].as_array().unwrap().is_empty());

    let library = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let library_body = library.into_body().collect().await.unwrap().to_bytes();
    let library_payload: serde_json::Value = serde_json::from_slice(&library_body).unwrap();
    let failed_set = library_payload["study_sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["id"] == study_set_id)
        .expect("failed study set in library");
    assert_eq!(failed_set["actions"]["start"]["available"], false);
    assert_eq!(
        failed_set["actions"]["start"]["unavailable_reason"],
        "ingestion_failed"
    );

    let still_bad = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/study-sets/{study_set_id}/files/retry?user_id=user-1"
                ))
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "file_name": "still-empty.txt",
                        "content_type": "text/plain",
                        "file_base64": STANDARD.encode(b"??? --- !!!"),
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(still_bad.status(), axum::http::StatusCode::OK);
    let still_bad_body = still_bad.into_body().collect().await.unwrap().to_bytes();
    let still_bad_payload: serde_json::Value = serde_json::from_slice(&still_bad_body).unwrap();
    assert_eq!(still_bad_payload["study_set"]["ingestion_status"], "retry");
    assert_eq!(still_bad_payload["session_token"], serde_json::Value::Null);

    let retry_library = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let retry_library_body = retry_library
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let retry_library_payload: serde_json::Value =
        serde_json::from_slice(&retry_library_body).unwrap();
    let retry_set = retry_library_payload["study_sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["id"] == study_set_id)
        .expect("retry study set in library");
    assert_eq!(retry_set["ingestion_status"], "retry");
    assert_eq!(
        retry_set["actions"]["start"]["unavailable_reason"],
        "ingestion_retry"
    );

    let retry_text = [
        "Photosynthesis chloroplast thylakoid membranes split water.",
        "Carbon fixation stores energy in glucose after the light reactions.",
    ]
    .join(" ");
    let retried = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/study-sets/{study_set_id}/files/retry?user_id=user-1"
                ))
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "file_name": "replacement.txt",
                        "content_type": "text/plain",
                        "file_base64": STANDARD.encode(retry_text.as_bytes()),
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(retried.status(), axum::http::StatusCode::OK);
    let retried_body = retried.into_body().collect().await.unwrap().to_bytes();
    let retried_payload: serde_json::Value = serde_json::from_slice(&retried_body).unwrap();
    assert_eq!(retried_payload["study_set"]["id"], study_set_id);
    assert_eq!(retried_payload["study_set"]["ingestion_status"], "ready");
    assert!(retried_payload["session_token"]
        .as_str()
        .expect("retry ready token")
        .starts_with("viva1."));
    assert!(!retried_payload["questions"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn paste_study_set_route_does_not_mint_session_token_for_failed_ingestion() {
    let store = Arc::new(data::InMemoryStudyStore::new());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store.clone(),
    );
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/study-sets/paste")
                .header("origin", "http://localhost:3000")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Empty paste",
                        "course": "Biology 201",
                        "pasted_text": "!!! ??? ... ---"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::CREATED);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["study_set"]["ingestion_status"], "failed");
    assert_eq!(payload["documents"][0]["processing_status"], "failed");
    assert!(payload["source_spans"].as_array().unwrap().is_empty());
    assert!(payload["concepts"].as_array().unwrap().is_empty());
    assert!(payload["questions"].as_array().unwrap().is_empty());
    assert!(payload["session_token"].is_null());
}

#[tokio::test]
async fn library_route_projects_server_owned_sets_and_completed_session_history() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "pending-set".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Pending Set".to_owned(),
        course: Some("Biology 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Pending,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "failed-set".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Failed Set".to_owned(),
        course: Some("Biology 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Failed,
        ingestion_error: Some("No usable source span".to_owned()),
        concept_ids: vec![],
        question_ids: vec![],
    });
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "deleted-document-set".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Deleted Document Set".to_owned(),
        course: None,
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    store.upsert_document(data::StudyDocumentRecord {
        study_set_id: "deleted-document-set".to_owned(),
        document_id: "deleted-doc".to_owned(),
        title: "Archived lecture".to_owned(),
        source_kind: "pdf".to_owned(),
        processing_status: StudySetIngestionStatus::Ready,
        tombstoned: true,
    });
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "partial-deleted-source-set".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Partial Deleted Source Set".to_owned(),
        course: None,
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec!["q-deleted-source".to_owned()],
    });
    store.upsert_document(data::StudyDocumentRecord {
        study_set_id: "partial-deleted-source-set".to_owned(),
        document_id: "active-doc".to_owned(),
        title: "Active lecture".to_owned(),
        source_kind: "pdf".to_owned(),
        processing_status: StudySetIngestionStatus::Ready,
        tombstoned: false,
    });
    store.upsert_document(data::StudyDocumentRecord {
        study_set_id: "partial-deleted-source-set".to_owned(),
        document_id: "deleted-source-doc".to_owned(),
        title: "Archived source lecture".to_owned(),
        source_kind: "pdf".to_owned(),
        processing_status: StudySetIngestionStatus::Ready,
        tombstoned: true,
    });
    let mut deleted_source = agent_domain::fixture_source_reference();
    deleted_source.source_id = "deleted-source-span".to_owned();
    deleted_source.document_id = "deleted-source-doc".to_owned();
    store.upsert_source_span(data::SourceSpanRecord {
        study_set_id: "partial-deleted-source-set".to_owned(),
        source: deleted_source.clone(),
        tombstoned: false,
    });
    let mut deleted_source_question = agent_domain::fixture_question();
    deleted_source_question.question_id = "q-deleted-source".to_owned();
    deleted_source_question.source = deleted_source;
    store.upsert_question(data::StudyQuestionRecord {
        study_set_id: "partial-deleted-source-set".to_owned(),
        question: deleted_source_question,
        active: true,
    });

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
    store
        .record_concept_status(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-concept",
            "nadh",
            ConceptStatus::Shaky,
        )
        .await
        .unwrap();
    seed_authoritative_review_schedule(&store).await;
    store
        .record_recap(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-recap",
            StudySessionRecap {
                schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
                deferred_turns: 0,
                voice_session_id: "voice-session-1".to_owned(),
                headline: "Completed session".to_owned(),
                summary: "NADH needs one more recall pass.".to_owned(),
                concepts: vec![
                    agent_domain::RecapConceptOutcome {
                        concept_id: "oxidative-phosphorylation".to_owned(),
                        label: "oxidative-phosphorylation".to_owned(),
                        status: agent_domain::ConceptStatus::Strong,
                    },
                    agent_domain::RecapConceptOutcome {
                        concept_id: "nadh".to_owned(),
                        label: "nadh".to_owned(),
                        status: agent_domain::ConceptStatus::Shaky,
                    },
                ],
                review_schedule: vec![],
                next_action: "Review NADH tomorrow.".to_owned(),
                source_moments: vec![agent_domain::learning_recap::RecapSourceMoment {
                    response_id: "response-recap".to_owned(),
                    source_id: agent_domain::fixture_source_reference().source_id.clone(),
                }],
            },
        )
        .await
        .unwrap();
    store
        .close_voice_session("voice-session-1", "completed")
        .await
        .unwrap();
    let _outcome = store
        .record_voice_session(&SessionConfig {
            session_id: Some(SessionId::new("open-session-1")),
            user_id: Some("user-1".to_owned()),
            study_set_id: Some("biology-midterm".to_owned()),
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        })
        .await
        .unwrap();

    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    );
    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "http://localhost:3000"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["user_id"], "user-1");
    assert_eq!(payload["privacy"]["export"]["available"], false);
    assert_eq!(
        payload["privacy"]["export"]["unavailable_reason"],
        "mutation_auth_required"
    );

    let study_sets = payload["study_sets"].as_array().unwrap();
    let find_set = |id: &str| {
        study_sets
            .iter()
            .find(|set| set["id"] == id)
            .unwrap_or_else(|| panic!("{id} missing from library snapshot"))
    };
    let ready = find_set("biology-midterm");
    assert_eq!(ready["ingestion_status"], "ready");
    assert_eq!(ready["server_owned"], true);
    assert_eq!(ready["actions"]["delete"]["available"], false);
    assert_eq!(
        ready["actions"]["delete"]["unavailable_reason"],
        "mutation_auth_required"
    );
    assert_eq!(ready["actions"]["start"]["available"], true);
    assert!(ready["actions"]["start"]["session_token"]
        .as_str()
        .expect("start token")
        .starts_with("viva1."));
    assert!(
        ready["actions"]["start"]["session_id"]
            .as_str()
            .expect("start session id")
            .len()
            > 20
    );
    assert_eq!(
        find_set("pending-set")["actions"]["start"]["available"],
        false
    );
    assert_eq!(
        find_set("failed-set")["actions"]["start"]["unavailable_reason"],
        "ingestion_failed"
    );
    assert_eq!(
        find_set("deleted-document-set")["documents"][0]["deleted"],
        true
    );
    assert_eq!(
        find_set("deleted-document-set")["actions"]["delete"]["available"],
        false
    );
    assert_eq!(
        find_set("partial-deleted-source-set")["actions"]["start"]["available"],
        false
    );
    assert_eq!(
        find_set("partial-deleted-source-set")["actions"]["start"]["unavailable_reason"],
        "no_active_questions"
    );

    let sessions = payload["sessions"].as_array().unwrap();
    assert!(
        sessions
            .iter()
            .all(|session| session["voice_session_id"] != "open-session-1"),
        "open sessions belong to the library Resume action, not completed history"
    );
    let completed = sessions
        .iter()
        .find(|session| session["voice_session_id"] == "voice-session-1")
        .expect("completed session row");
    assert_eq!(completed["status"], "closed");
    assert_eq!(completed["terminal_reason"], "completed");
    assert_eq!(
        completed["recap"]["shaky_concepts"].as_array().unwrap(),
        &vec![serde_json::Value::String("nadh".to_owned())]
    );
    assert_eq!(completed["next_review"]["concept_id"], "nadh");
    assert_eq!(
        completed["next_review"]["persisted_due_at"],
        LIBRARY_SEED_DUE_AT
    );
    assert_eq!(
        completed["next_review"]["source"],
        "review_schedule_decision_v1"
    );
    assert_eq!(completed["next_review"]["status"], "shaky");
}

#[tokio::test]
async fn library_export_returns_sanitized_user_visible_state_and_privacy_facts() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let app = build_router(test_state_with_rest_auth(4, store));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/export?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["user_id"], "user-1");
    assert_eq!(payload["privacy"]["voice_recordings_saved"], false);
    assert_eq!(payload["privacy"]["transcripts_saved"], false);
    assert_eq!(payload["privacy"]["raw_audio_persistence"], false);
    assert_eq!(payload["privacy"]["transcript_persistence"], false);
    assert_eq!(
        payload["privacy"]["export_contains_raw_provider_payloads"],
        false
    );
    assert_eq!(payload["privacy"]["export"]["available"], true);
    assert!(payload["privacy"]["copy"]
        .as_str()
        .unwrap()
        .contains("Voice recordings and transcripts are not saved"));
    assert!(!payload["study_sets"].as_array().unwrap().is_empty());

    let exported = String::from_utf8(body.to_vec()).unwrap();
    assert!(!exported.contains("session_token"));
    assert!(!exported.contains("viva1."));
    assert!(!exported.contains("pasted_text"));
    assert!(!exported.contains("transcript_final"));
    assert!(!exported.contains("\"raw_provider_payload\""));
}

#[tokio::test]
async fn library_export_and_delete_reject_browser_session_token_authorization() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    seed_completed_library_session(&store).await;
    let app = build_router(test_state_with_rest_auth(4, store));
    let session_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-rest-control",
    );
    let authorization = format!("Bearer {session_token}");

    let export = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/export?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", &authorization)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(export.status(), axum::http::StatusCode::UNAUTHORIZED);

    let session_delete = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", &authorization)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        session_delete.status(),
        axum::http::StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn library_export_and_delete_reject_public_trusted_user_without_rest_auth() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    seed_completed_library_session(&store).await;
    let app = build_router(test_state_with_store(4, store));

    let export = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/export?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(export.status(), axum::http::StatusCode::FORBIDDEN);

    let study_set_delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(study_set_delete.status(), axum::http::StatusCode::FORBIDDEN);

    let session_delete = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(session_delete.status(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn library_control_token_authorizes_browser_controls_without_proxy_bearer() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    seed_completed_library_session(&store).await;
    let app = build_router(test_state_with_rest_auth(4, store));

    let snapshot = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.status(), axum::http::StatusCode::OK);
    let snapshot_body = snapshot.into_body().collect().await.unwrap().to_bytes();
    let snapshot_payload: serde_json::Value = serde_json::from_slice(&snapshot_body).unwrap();
    let control_token = snapshot_payload["privacy"]["export"]["control_token"]
        .as_str()
        .expect("authenticated snapshot should mint a control token")
        .to_owned();
    assert!(control_token.starts_with("viva1."));

    let export = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/export?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("x-viva-library-control-token", &control_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(export.status(), axum::http::StatusCode::OK);

    let cross_user = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/export?user_id=user-2")
                .header("origin", "http://localhost:3000")
                .header("x-viva-library-control-token", &control_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cross_user.status(), axum::http::StatusCode::UNAUTHORIZED);

    let delete = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("x-viva-library-control-token", &control_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn library_control_preflights_advertise_required_methods_and_headers() {
    let app = build_router(test_state_with_store(
        4,
        Arc::new(data::InMemoryStudyStore::seeded_fixture()),
    ));

    for (path, expected_method) in [
        ("/study-sets/export", "GET"),
        ("/study-sets/biology-midterm", "DELETE"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri(path)
                    .header("origin", "http://localhost:3000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);
        let methods = response
            .headers()
            .get("access-control-allow-methods")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            methods
                .split(',')
                .map(str::trim)
                .any(|method| method == expected_method),
            "{path} did not advertise {expected_method}"
        );
        assert!(response
            .headers()
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .split(',')
            .map(str::trim)
            .any(|header| header.eq_ignore_ascii_case("authorization")));
        assert!(response
            .headers()
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .split(',')
            .map(str::trim)
            .any(|header| header.eq_ignore_ascii_case("x-viva-library-control-token")));
    }
}

#[tokio::test]
async fn delete_study_set_tombstones_sources_hides_history_and_is_idempotent() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    seed_completed_library_session(&store).await;
    let app = build_router(test_state_with_rest_auth(4, store.clone()));

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), axum::http::StatusCode::OK);
    let first_body = first.into_body().collect().await.unwrap().to_bytes();
    let first_payload: serde_json::Value = serde_json::from_slice(&first_body).unwrap();
    // `D-05 HARD_PURGE_TEXT`: Plan 09's receipt is content-free and derivable from
    // the tombstone alone, so it carries no per-request counts. The pre-D-05
    // `deleted_documents` / `hidden_sessions` counters are gone, and a replay must
    // return byte-identical bytes rather than a second set of zeroed counters.
    assert_eq!(
        first_payload
            .as_object()
            .expect("deletion receipt is an object")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            "deleted_at".to_owned(),
            "policy".to_owned(),
            "status".to_owned(),
            "study_set_id".to_owned(),
        ]
    );
    assert_eq!(first_payload["study_set_id"], "biology-midterm");
    assert_eq!(first_payload["status"], "deleted");
    assert_eq!(first_payload["policy"], "hard_purge_text");
    assert!(first_payload["deleted_at"].as_str().is_some_and(|value| {
        value.ends_with('Z') && agent_domain::parse_utc_instant(value).is_some()
    }));

    let second = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second.status(), axum::http::StatusCode::OK);
    let second_body = second.into_body().collect().await.unwrap().to_bytes();
    let second_payload: serde_json::Value = serde_json::from_slice(&second_body).unwrap();
    assert_eq!(
        second_payload, first_payload,
        "an idempotent delete replays the original receipt byte for byte"
    );

    let library = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(library.status(), axum::http::StatusCode::OK);
    let library_body = library.into_body().collect().await.unwrap().to_bytes();
    let library_payload: serde_json::Value = serde_json::from_slice(&library_body).unwrap();
    // `D-05 HARD_PURGE_TEXT`: the tombstone is the one place a read path asks
    // "is this deleted?", and every projection excludes it. There is no residual
    // soft-deleted row carrying document flags, counts, or disabled actions.
    assert!(
        !library_payload["study_sets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|set| set["id"] == "biology-midterm"),
        "a hard-purged set is not projected back to the library"
    );
    assert!(library_payload["sessions"].as_array().unwrap().is_empty());

    let cross_user = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm?user_id=user-2")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // `SERVICE-016` / `DATA-014`: status is selected only from `PortErrorKind`, and
    // the closed taxonomy has no "not found" kind. A cross-user target answers with
    // the same coarse `Unavailable` status and fixed prose as any other set this
    // caller cannot read, so the response distinguishes "not yours" from "does not
    // exist" no more than the old 404 did.
    assert_eq!(
        cross_user.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    let cross_user_body = cross_user.into_body().collect().await.unwrap().to_bytes();
    let cross_user_payload: serde_json::Value = serde_json::from_slice(&cross_user_body).unwrap();
    assert_eq!(cross_user_payload["error"], "study_set_delete_failed");
    assert_eq!(
        cross_user_payload["message"],
        "the requested resource is unavailable"
    );
}

// --- `SERVICE-011` authenticated study projection --------------------------------

const PROJECTION_SESSION_SECRET: &str = "viva-fixture-projection-signing-secret";
const PROJECTION_ORIGIN: &str = "http://localhost:3000";

/// Counts every projection read and the exact tuple it was asked for, so a
/// confused-deputy request can be proven never to reach the store.
type PortErrorFactory = Box<dyn Fn() -> PortError + Send + Sync>;

struct ProjectionAuditStore {
    inner: Arc<data::InMemoryStudyStore>,
    reads: Mutex<Vec<(String, String, String)>>,
    fail: Option<PortErrorFactory>,
}

#[async_trait::async_trait]
impl StudyMemoryStore for ProjectionAuditStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
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
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }

    async fn delete_study_set(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner.delete_study_set(user_id, study_set_id).await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        self.reads.lock().expect("read log").push((
            user_id.to_owned(),
            study_set_id.to_owned(),
            voice_session_id.to_owned(),
        ));
        if let Some(fail) = &self.fail {
            return Err(fail());
        }
        self.inner
            .authenticated_study_projection(user_id, study_set_id, voice_session_id)
            .await
    }
}

async fn projection_app(
    fail: Option<PortErrorFactory>,
) -> (
    axum::Router,
    Arc<ProjectionAuditStore>,
    Arc<data::InMemoryStudyStore>,
) {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    seed_completed_library_session(&inner).await;
    let store = Arc::new(ProjectionAuditStore {
        inner: inner.clone(),
        reads: Mutex::new(Vec::new()),
        fail,
    });
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(inner.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some(PROJECTION_SESSION_SECRET.into()),
            allowed_origins: vec![PROJECTION_ORIGIN.to_owned()],
        },
        4,
        store.clone(),
    )
    .with_operator_access(OperatorAccess::new(Some(
        FIXTURE_OPERATOR_CREDENTIAL.into(),
    )))
    .with_projection_read_access(ProjectionReadAccess::new(
        FIXTURE_LIBRARY_READ_CREDENTIAL.into(),
        PROJECTION_SESSION_SECRET.into(),
        vec![PROJECTION_ORIGIN.to_owned()],
    ));
    (build_router(state), store, inner)
}

fn projection_token(user_id: &str, study_set_id: &str, session_id: &str, nonce: &str) -> String {
    signed_session_token(
        PROJECTION_SESSION_SECRET,
        user_id,
        study_set_id,
        session_id,
        unix_timestamp_now() + 60,
        nonce,
    )
}

struct ProjectionRequest<'a> {
    uri: &'a str,
    bearer: Option<&'a str>,
    session_token: Option<&'a str>,
    origin: Option<&'a str>,
}

fn projection_request(request: ProjectionRequest<'_>) -> Request<Body> {
    let mut builder = Request::builder().method("GET").uri(request.uri);
    if let Some(bearer) = request.bearer {
        builder = builder.header("authorization", format!("Bearer {bearer}"));
    }
    if let Some(token) = request.session_token {
        builder = builder.header("x-viva-session-token", token);
    }
    if let Some(origin) = request.origin {
        builder = builder.header("origin", origin);
    }
    builder.body(Body::empty()).unwrap()
}

const VALID_PROJECTION_URI: &str =
    "/v1/study-sets/biology-midterm/projection?voice_session_id=voice-session-1";

/// `SERVICE-011`: the projection route is authorized by the Plan 11 scoped read
/// credential plus a signed access credential, and its identity comes only from the
/// verified claims. Every rejection is coarse and echoes no credential.
#[tokio::test]
async fn authenticated_projection_requires_both_scoped_credentials() {
    let (app, store, _inner) = projection_app(None).await;
    let token = projection_token("user-1", "biology-midterm", "voice-session-1", "proj-1");

    let cases: Vec<(&str, ProjectionRequest<'_>, StatusCode)> = vec![
        (
            "no scoped bearer",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: None,
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::UNAUTHORIZED,
        ),
        (
            "wrong scoped bearer",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some("viva-fixture-not-the-read-credential-1"),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::UNAUTHORIZED,
        ),
        (
            "operator bearer must not authorize a projection read",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_OPERATOR_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::UNAUTHORIZED,
        ),
        (
            "session token alone must not authorize",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: None,
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::UNAUTHORIZED,
        ),
        (
            "scoped bearer alone must not authorize",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: None,
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::UNAUTHORIZED,
        ),
        (
            "malformed session token",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some("viva1.not-a-token"),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::UNAUTHORIZED,
        ),
        (
            "missing origin",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: None,
            },
            StatusCode::FORBIDDEN,
        ),
        (
            "wrong origin",
            ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some("https://evil.example"),
            },
            StatusCode::FORBIDDEN,
        ),
        (
            "duplicate query key",
            ProjectionRequest {
                uri: "/v1/study-sets/biology-midterm/projection?voice_session_id=voice-session-1&voice_session_id=voice-session-1",
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "extra query key",
            ProjectionRequest {
                uri: "/v1/study-sets/biology-midterm/projection?voice_session_id=voice-session-1&user_id=user-1",
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "missing query key",
            ProjectionRequest {
                uri: "/v1/study-sets/biology-midterm/projection",
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "path study set does not match the claim",
            ProjectionRequest {
                uri: "/v1/study-sets/chemistry-final/projection?voice_session_id=voice-session-1",
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::FORBIDDEN,
        ),
        (
            "query session does not match the claim",
            ProjectionRequest {
                uri: "/v1/study-sets/biology-midterm/projection?voice_session_id=voice-session-9",
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            },
            StatusCode::FORBIDDEN,
        ),
    ];

    for (label, request, expected) in cases {
        let response = app
            .clone()
            .oneshot(projection_request(request))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{label}");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        for forbidden in [
            FIXTURE_LIBRARY_READ_CREDENTIAL,
            FIXTURE_OPERATOR_CREDENTIAL,
            PROJECTION_SESSION_SECRET,
            token.as_str(),
            "user-1",
            "proj-1",
        ] {
            assert!(
                !text.contains(forbidden),
                "{label} leaked credential or subject material: {text}"
            );
        }
        // Every denial body is one of exactly three fixed public shapes. Serde and
        // extractor diagnostics never reach the caller.
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let (code, message) = match expected {
            StatusCode::UNAUTHORIZED => (
                "projection_unauthorized",
                "projection access is not authorized",
            ),
            StatusCode::FORBIDDEN => ("projection_forbidden", "projection access is forbidden"),
            StatusCode::BAD_REQUEST => ("projection_invalid", "projection request is invalid"),
            other => panic!("{label} produced an unclassified status {other}"),
        };
        assert_eq!(payload["error"], code, "{label}");
        assert_eq!(payload["message"], message, "{label}");
    }

    assert!(
        store.reads.lock().expect("read log").is_empty(),
        "no rejected request may reach the store"
    );
}

/// `SERVICE-011`: an expired or wrongly signed access credential is refused with the
/// same coarse status, and neither reaches the store.
#[tokio::test]
async fn authenticated_projection_rejects_expired_and_forged_tokens() {
    let (app, store, _inner) = projection_app(None).await;
    let expired = signed_session_token(
        PROJECTION_SESSION_SECRET,
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() - 1,
        "proj-expired",
    );
    let forged = signed_session_token(
        "viva-fixture-not-the-projection-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "proj-forged",
    );

    for token in [expired, forged] {
        let response = app
            .clone()
            .oneshot(projection_request(ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            }))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert!(store.reads.lock().expect("read log").is_empty());
}

/// `SERVICE-011`: a credential for user A plus a path and query naming user B's live
/// study set and session is refused before any store read for B.
#[tokio::test]
async fn authenticated_projection_refuses_the_confused_deputy() {
    let (app, store, inner) = projection_app(None).await;
    inner.upsert_study_set(data::StudySetRecord {
        study_set_id: "victim-set".to_owned(),
        user_id: "user-2".to_owned(),
        title: "Victim Set".to_owned(),
        course: None,
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let attacker = projection_token("user-1", "biology-midterm", "voice-session-1", "proj-cd");

    let response = app
        .oneshot(projection_request(ProjectionRequest {
            uri: "/v1/study-sets/victim-set/projection?voice_session_id=voice-session-2",
            bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
            session_token: Some(&attacker),
            origin: Some(PROJECTION_ORIGIN),
        }))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!text.contains("victim-set") && !text.contains("user-2"));
    assert!(
        store.reads.lock().expect("read log").is_empty(),
        "the store is never asked about another user's set"
    );
}

/// `SERVICE-011`: the authorized read returns Plan 04's exact type, keyed only by the
/// verified claims, with no-store caching and nosniff.
#[tokio::test]
async fn authenticated_projection_returns_the_claim_bound_projection() {
    let (app, store, inner) = projection_app(None).await;
    let token = projection_token("user-1", "biology-midterm", "voice-session-1", "proj-ok");

    let response = app
        .clone()
        .oneshot(projection_request(ProjectionRequest {
            uri: VALID_PROJECTION_URI,
            bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
            session_token: Some(&token),
            origin: Some(PROJECTION_ORIGIN),
        }))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    assert_eq!(
        response.headers().get("x-content-type-options").unwrap(),
        "nosniff"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let returned: agent_domain::AuthenticatedStudyProjectionV1 =
        serde_json::from_slice(&body).expect("the route returns Plan 04's exact type");
    let expected = inner
        .authenticated_study_projection("user-1", "biology-midterm", "voice-session-1")
        .await
        .expect("store projection");
    assert_eq!(returned, expected, "the route must not reshape the type");
    assert_eq!(
        store.reads.lock().expect("read log").as_slice(),
        [(
            "user-1".to_owned(),
            "biology-midterm".to_owned(),
            "voice-session-1".to_owned(),
        )],
        "identity comes only from the verified claims"
    );
}

/// `SERVICE-011`: a store failure is reported through the shared coarse taxonomy
/// mapping under this route's own error code, and never leaks the scoped credential.
///
/// The exact `PortErrorKind` to status matrix and the removal of store prose from the
/// public message are `SERVICE-016`'s remediation of `store_json_error` (Task 7); this
/// test pins the route code and the credential boundary that hold either way.
#[tokio::test]
async fn authenticated_projection_sanitizes_store_failures() {
    let hostile = format!(
        "Bearer {FIXTURE_LIBRARY_READ_CREDENTIAL} user-1 voice-session-1 {HOSTILE_TRANSCRIPT_TEXT}"
    );
    let unavailable = hostile.clone();
    let durability = hostile.clone();
    let factories: Vec<PortErrorFactory> = vec![
        Box::new(move || PortError::unavailable("memory", "projection-read", unavailable.clone())),
        Box::new(move || PortError::durability("postgres", "durable-read", durability.clone())),
    ];
    for error in factories {
        let (app, _store, _inner) = projection_app(Some(error)).await;
        let token = projection_token("user-1", "biology-midterm", "voice-session-1", "proj-fail");
        let response = app
            .oneshot(projection_request(ProjectionRequest {
                uri: VALID_PROJECTION_URI,
                bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                session_token: Some(&token),
                origin: Some(PROJECTION_ORIGIN),
            }))
            .await
            .unwrap();
        assert!(
            response.status().is_client_error() || response.status().is_server_error(),
            "a failed store read is never a success"
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload["error"], "projection_failed",
            "the caller learns only this route's coarse code"
        );
    }
}

/// `D-04 CONFIRM_DELETE`: no restore route exists. This characterization is the guard
/// that a later half-implementation cannot land silently.
#[tokio::test]
async fn restore_route_absent_when_confirm_delete_selected() {
    let (app, _store, _inner) = projection_app(None).await;
    for method in ["POST", "GET"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/v1/study-sets/biology-midterm/restore")
                    .header("origin", PROJECTION_ORIGIN)
                    .header(
                        "authorization",
                        format!("Bearer {FIXTURE_LIBRARY_READ_CREDENTIAL}"),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{method} /v1/study-sets/{{id}}/restore must not exist under CONFIRM_DELETE"
        );
    }
}

#[tokio::test]
async fn delete_session_history_hides_completed_recap_without_deleting_study_set() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    seed_completed_library_session(&store).await;
    let app = build_router(test_state_with_rest_auth(4, store.clone()));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["voice_session_id"], "voice-session-1");
    assert_eq!(payload["status"], "deleted");

    let repeat = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(repeat.status(), axum::http::StatusCode::OK);

    let close_after_delete = store
        .close_voice_session("voice-session-1", "completed")
        .await
        .expect("deleted session close is idempotent");
    assert_eq!(close_after_delete["status"], "deleted");
    assert_eq!(close_after_delete["terminal_reason"], "deleted");

    let library = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-1")
                .header("origin", "http://localhost:3000")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(library.status(), axum::http::StatusCode::OK);
    let library_body = library.into_body().collect().await.unwrap().to_bytes();
    let library_payload: serde_json::Value = serde_json::from_slice(&library_body).unwrap();
    assert!(library_payload["sessions"].as_array().unwrap().is_empty());
    let biology = library_payload["study_sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["id"] == "biology-midterm")
        .expect("biology study set");
    assert_eq!(biology["documents"][0]["deleted"], false);
    assert_eq!(biology["question_count"], 1);
    assert_eq!(biology["actions"]["delete"]["available"], true);
}

#[tokio::test]
async fn library_route_rejects_cross_user_token_minting_without_rest_auth() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "private-user-2-set".to_owned(),
        user_id: "user-2".to_owned(),
        title: "Private User 2 Set".to_owned(),
        course: None,
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let brain_store = store.clone();
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(brain_store)),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    );
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library?user_id=user-2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn library_route_rejects_public_unauthenticated_token_minting() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec!["https://viva.example".to_owned()],
        },
        4,
        store,
    )
    .with_unauthenticated_paste_allowed(false);
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library")
                .header("origin", "https://viva.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn library_route_mints_session_tokens_with_public_bearer_auth() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: Some("rest-secret".into()),
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec!["https://viva.example".to_owned()],
        },
        4,
        store,
    )
    .with_unauthenticated_paste_allowed(false);
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/study-sets/library")
                .header("origin", "https://viva.example")
                .header("authorization", "Bearer rest-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ready = payload["study_sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["id"] == "biology-midterm")
        .expect("ready study set");
    assert_eq!(ready["actions"]["start"]["available"], true);
    assert!(ready["actions"]["start"]["session_token"]
        .as_str()
        .expect("server-issued session token")
        .starts_with("viva1."));
}

#[tokio::test]
async fn paste_study_set_route_rejects_public_unauthenticated_token_minting() {
    let store = Arc::new(data::InMemoryStudyStore::new());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec!["https://viva.example".to_owned()],
        },
        4,
        store,
    )
    .with_unauthenticated_paste_allowed(false);
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/study-sets/paste")
                .header("origin", "https://viva.example")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "user_id": "attacker-user",
                        "title": "Unauthorized",
                        "pasted_text": "attacker notes should not mint a token"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);

    let denied_origin = build_router(
        AppState::new(
            Arc::new(SyntheticBrain::with_study_store(Arc::new(
                data::InMemoryStudyStore::seeded_fixture(),
            ))),
            "synthetic",
            VoiceWsAccess {
                required_bearer: None,
                session_token_secret: Some("session-secret".into()),
                allowed_origins: vec!["https://viva.example".to_owned()],
            },
            4,
        )
        .with_unauthenticated_paste_allowed(true),
    )
    .oneshot(
        Request::builder()
            .method("OPTIONS")
            .uri("/study-sets/paste")
            .header("origin", "https://evil.example")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(denied_origin.status(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ready_and_brain_health_routes_report_configured_fake_cartesia_gemini_provider() {
    let app = build_router(fake_cartesia_gemini_state_with_store(
        4,
        Arc::new(data::InMemoryStudyStore::seeded_fixture()),
    ));

    let ready = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(ready.status().is_success());

    let brain = app
        .oneshot(
            Request::builder()
                .uri("/health/brain")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let brain_body = brain.into_body().collect().await.unwrap().to_bytes();
    let brain_json: serde_json::Value = serde_json::from_slice(&brain_body).unwrap();

    assert_eq!(brain_json["provider"], "fake_cartesia_gemini");
    assert_eq!(brain_json["brain"]["provider"], "fake_cartesia_gemini");
    assert_eq!(brain_json["brain"]["configured"], true);
    assert_eq!(brain_json["brain"]["selectable"], true);
    assert_eq!(brain_json["brain"]["live_runtime"], false);
}

#[tokio::test]
async fn shared_audio_fixture_matches_client_frame_contract() {
    let audio: ClientFrame = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/client-audio.json"
    ))
    .unwrap();

    assert_eq!(audio.version(), VIVA_VOICE_PROTOCOL_VERSION);
    assert_eq!(
        serde_json::to_value(audio).unwrap(),
        serde_json::json!({
            "type": "audio_chunk",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": "1",
            "turn_id": "turn-1",
            "sequence": 0,
            "frame": { "pcm16_base64": "AQIDBA==" }
        })
    );
}

#[tokio::test]
async fn state_session_slots_enforce_configured_capacity() {
    let state = test_state(1);
    let _permit = state.session_slots.clone().try_acquire_owned().unwrap();

    assert!(state.session_slots.clone().try_acquire_owned().is_err());
}

#[test]
fn ready_fixture_matches_server_frame_shape() {
    let frame: ServerFrame = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/server-ready.json"
    ))
    .unwrap();

    assert_eq!(frame, ServerFrame::ready());
}

#[tokio::test]
async fn real_websocket_replays_synthetic_fixture_and_evidence_pack() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = test_state_with_store(4, store.clone());
    let evidence = state.evidence.clone();
    let usage = state.usage.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let mut actual = vec![read_server_frame(&mut socket).await];
    send_client_frame(&mut socket, &fixture.client[0]).await;
    for _ in 0..2 {
        actual.push(read_server_frame(&mut socket).await);
    }
    send_client_frame(&mut socket, &fixture.client[1]).await;
    for _ in 0..12 {
        actual.push(read_server_frame(&mut socket).await);
    }
    send_client_frame(&mut socket, &fixture.client[2]).await;
    actual.push(read_server_frame(&mut socket).await);
    send_client_frame(&mut socket, &fixture.client[3]).await;
    for _ in 0..2 {
        actual.push(read_server_frame(&mut socket).await);
    }
    wait_for_socket_close(&mut socket).await;

    assert_eq!(
        normalized_fixture_value(&actual),
        normalized_fixture_value(&fixture.server)
    );
    let expected_pack: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-evidence-pack.json"
    ))
    .unwrap();
    let snapshot = store.snapshot();
    let session = snapshot.sessions.first().expect("session is recorded");
    assert_eq!(session.status, "closed");
    assert_eq!(session.terminal_reason.as_deref(), Some("client_stop"));
    assert!(session.ended_at.is_some());
    assert_eq!(
        serde_json::json!({
            "sessions": snapshot.sessions.len(),
            "answer_attempts": snapshot.answer_attempts.len(),
            "concept_statuses": snapshot.concept_statuses.len(),
            "review_items": snapshot.review_items.len(),
            "recaps": snapshot.recaps.len(),
            "durable": store.capabilities().durable,
        }),
        expected_pack["store_snapshot"]
    );
    assert_usage_summary(&usage.snapshot(), &expected_pack["usage"]);
    assert_eq!(
        normalized_fixture_value(&evidence.snapshot()),
        expected_pack["evidence_events"]
    );
    assert_eq!(
        evidence
            .snapshot()
            .last()
            .map(|event| event.detail.as_str()),
        Some(expected_pack["terminal_close_reason"].as_str().unwrap())
    );
}

#[tokio::test]
async fn optional_postgres_replays_synthetic_fixture_when_database_url_is_set() {
    let Some(pool) = optional_postgres_pool().await else {
        return;
    };
    data::run_migrations(&pool)
        .await
        .expect("postgres migrations apply");
    data::seed_postgres_fixture(&pool)
        .await
        .expect("postgres fixture seed applies");
    let verify_pool = pool.clone();
    let store: Arc<dyn StudyMemoryStore> = Arc::new(data::PostgresStudyStore::new(pool));
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess::default(),
        4,
        store.clone(),
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let mut actual = vec![read_server_frame(&mut socket).await];
    send_client_frame(&mut socket, &fixture.client[0]).await;
    for _ in 0..2 {
        actual.push(read_server_frame(&mut socket).await);
    }
    send_client_frame(&mut socket, &fixture.client[1]).await;
    for _ in 0..12 {
        actual.push(read_server_frame(&mut socket).await);
    }
    send_client_frame(&mut socket, &fixture.client[2]).await;
    actual.push(read_server_frame(&mut socket).await);
    send_client_frame(&mut socket, &fixture.client[3]).await;
    for _ in 0..2 {
        actual.push(read_server_frame(&mut socket).await);
    }
    wait_for_socket_close(&mut socket).await;

    assert_eq!(
        normalized_fixture_value(&actual),
        normalized_fixture_value(&fixture.server)
    );
    assert!(store.capabilities().durable);
    let counts = store.write_counts();
    assert_eq!(counts.sessions, 1);
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.concept_statuses, 1);
    assert_eq!(counts.review_items, 1);
    assert_eq!(counts.recaps, 1);
    let closed: (String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, terminal_reason, ended_at IS NOT NULL
         FROM voice_sessions
         ORDER BY started_at DESC
         LIMIT 1",
    )
    .fetch_one(&verify_pool)
    .await
    .expect("voice session terminal row exists");
    assert_eq!(
        closed,
        ("closed".to_owned(), Some("client_stop".to_owned()), true)
    );
}

#[tokio::test]
async fn real_websocket_replays_fake_cartesia_gemini_fixture_and_evidence_pack() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = fake_cartesia_gemini_state_with_store(4, store.clone());
    let evidence = state.evidence.clone();
    let usage = state.usage.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/fake-cartesia-gemini-study-session.json"
    ))
    .unwrap();

    let mut actual = vec![read_server_frame(&mut socket).await];
    send_client_frame(&mut socket, &fixture.client[0]).await;
    for _ in 0..2 {
        actual.push(read_server_frame(&mut socket).await);
    }
    // The bounded chunk is retained locally; only the explicit end admits a turn.
    send_client_frame(&mut socket, &fixture.client[1]).await;
    send_client_frame(&mut socket, &fixture.client[2]).await;
    for _ in 0..14 {
        actual.push(read_server_frame(&mut socket).await);
    }
    send_client_frame(&mut socket, &fixture.client[3]).await;
    actual.push(read_server_frame(&mut socket).await);
    send_client_frame(&mut socket, &fixture.client[4]).await;
    wait_for_socket_close(&mut socket).await;

    assert_eq!(
        normalized_fixture_value(&actual),
        normalized_fixture_value(&fixture.server)
    );
    let expected_pack: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/fake-cartesia-gemini-evidence-pack.json"
    ))
    .unwrap();
    assert_eq!(
        expected_pack["client_frame_count"].as_u64(),
        Some(fixture.client.len() as u64)
    );
    assert_eq!(
        expected_pack["server_frame_count"].as_u64(),
        Some(fixture.server.len() as u64)
    );
    let snapshot = store.snapshot();
    let session = snapshot.sessions.first().expect("session is recorded");
    assert_eq!(session.status, "closed");
    assert_eq!(session.terminal_reason.as_deref(), Some("client_stop"));
    assert!(session.ended_at.is_some());
    assert_eq!(
        serde_json::json!({
            "sessions": snapshot.sessions.len(),
            "answer_attempts": snapshot.answer_attempts.len(),
            "concept_statuses": snapshot.concept_statuses.len(),
            "review_items": snapshot.review_items.len(),
            "recaps": snapshot.recaps.len(),
            "durable": store.capabilities().durable,
        }),
        expected_pack["store_snapshot"]
    );
    let usage_snapshot = usage.snapshot();
    assert_usage_summary(&usage_snapshot, &expected_pack["usage"]);
    assert_eq!(
        normalized_fixture_value(&evidence.snapshot()),
        expected_pack["evidence_events"]
    );
    assert_eq!(
        evidence
            .snapshot()
            .last()
            .map(|event| event.detail.as_str()),
        Some(expected_pack["terminal_close_reason"].as_str().unwrap())
    );
}

fn normalized_fixture_value<T: Serialize>(value: &T) -> serde_json::Value {
    let mut value = serde_json::to_value(value).expect("fixture value serializes");
    normalize_voice_session_ids(&mut value);
    value
}

fn normalize_voice_session_ids(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, nested) in object.iter_mut() {
                if key == "voice_session_id" && nested.as_str().is_some() {
                    *nested = serde_json::Value::String("voice-session-1".to_owned());
                } else {
                    normalize_voice_session_ids(nested);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for nested in values {
                normalize_voice_session_ids(nested);
            }
        }
        _ => {}
    }
}

fn assert_usage_summary(actual: &[VoiceUsageEvent], expected: &serde_json::Value) {
    assert_eq!(actual.len(), expected["events"].as_u64().unwrap() as usize);
    let event = actual.first().expect("usage event");
    assert_eq!(event.provider, expected["provider"].as_str().unwrap());
    assert_eq!(event.model, expected["model"].as_str().unwrap());
    assert!(event.duration_seconds >= expected["duration_seconds_min"].as_u64().unwrap());
    assert_eq!(
        event.text_input_tokens,
        expected["text_input_tokens"].as_u64().unwrap()
    );
    assert_eq!(
        event.text_output_tokens,
        expected["text_output_tokens"].as_u64().unwrap()
    );
    assert_eq!(
        event.audio_input_tokens,
        expected["audio_input_tokens"].as_u64().unwrap()
    );
    assert_eq!(
        event.audio_output_tokens,
        expected["audio_output_tokens"].as_u64().unwrap()
    );
    let expected_cost = expected["cost_estimate_usd"].as_f64().unwrap();
    assert!(
        (event.cost_estimate_usd - expected_cost).abs() < f64::EPSILON,
        "cost_estimate_usd expected {expected_cost}, got {}",
        event.cost_estimate_usd
    );
    assert_eq!(
        event.answer_eval_latency_ms.is_some(),
        expected["answer_eval_latency_ms_present"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        event.source_grounded_correction_count,
        expected["source_grounded_correction_count"]
            .as_u64()
            .unwrap()
    );
}

async fn optional_postgres_pool() -> Option<sqlx::PgPool> {
    let database_url = std::env::var("DATABASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    Some(
        data::connect_pg(&data::PgConfig::new(database_url))
            .await
            .expect("DATABASE_URL should connect for optional postgres test"),
    )
}

#[tokio::test]
async fn websocket_first_frame_timeout_records_terminal_reason() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_millis(25),
        idle: Duration::from_secs(30),
        session: Duration::from_secs(30),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    let error = read_server_frame(&mut socket).await;
    assert!(matches!(
        error,
        ServerFrame::Error { error, .. } if error.message == "first client frame timeout"
    ));
    assert_close_code(&mut socket, CloseCode::Policy).await;

    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events
        .iter()
        .any(|event| event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "first_frame_timeout"));
}

#[tokio::test]
async fn websocket_malformed_frame_reports_protocol_close_code() {
    let state = test_state(1);
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;
    socket
        .send(WsMessage::Text("{not valid json".into()))
        .await
        .unwrap();

    let error = read_server_frame(&mut socket).await;
    assert!(matches!(
        error,
        ServerFrame::Error { error, .. } if error.message == "invalid client frame"
    ));
    assert_close_code(&mut socket, CloseCode::Protocol).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events
        .iter()
        .any(|event| event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "invalid_client_frame"));
}

#[tokio::test]
async fn websocket_oversized_text_frame_closes_with_size_and_terminal_reason() {
    let state = test_state(1);
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;
    socket
        .send(WsMessage::Text(
            "x".repeat(agent_service::VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1)
                .into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "text frame exceeds maximum size"
    ));
    assert_close_code(&mut socket, CloseCode::Size).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "oversized_text_frame"
    }));
}

#[tokio::test]
async fn websocket_binary_frame_closes_as_unsupported_with_terminal_reason() {
    let state = test_state(1);
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;
    // Protocol v5 carries audio as bounded JSON chunks, so no binary frame is
    // acceptable at any size.
    socket
        .send(WsMessage::Binary(vec![0_u8; 1].into()))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "binary client frames are not accepted"
    ));
    assert_close_code(&mut socket, CloseCode::Unsupported).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "unsupported_binary_frame"
    }));
}

#[tokio::test]
async fn websocket_strips_browser_source_context_before_trusted_output() {
    let state = test_state(1);
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let mut session_frame = fixture_session_config_frame();
    let ClientFrame::SessionConfig { session, .. } = &mut session_frame else {
        panic!("expected session config");
    };
    session.source_context = vec![agent_domain::SourceContext {
        source_id: "src-lecture-5-slide-18".to_owned(),
        document_id: "browser-forged-doc".to_owned(),
        span: "browser:999".to_owned(),
        excerpt: "Browser forged excerpt".to_owned(),
        confidence: agent_domain::SourceConfidence::Low,
        retrieval_reason: "browser supplied injection".to_owned(),
    }];

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    send_client_frame(&mut socket, &session_frame).await;
    let _ = read_server_frame(&mut socket).await;
    match read_server_frame(&mut socket).await {
        ServerFrame::Event { event, .. } => match event.as_ref() {
            agent_service::VivaServerEvent::QuestionStarted { question, .. } => {
                assert_eq!(question.source.document_id, "lec-5");
                assert_eq!(question.source.span, "slide:18");
                assert_eq!(
                    question.source.retrieval_reason,
                    "server fixture source for oxidative phosphorylation"
                );
                assert_ne!(question.source.excerpt, "Browser forged excerpt");
            }
            other => panic!("expected question_started event, got {other:?}"),
        },
        other => panic!("expected event frame, got {other:?}"),
    }
    socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_rejects_missing_or_forged_session_identity_before_open() {
    for session in [
        {
            let mut frame: ClientFrame = serde_json::from_str(&format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{}}}"#,
                include_str!("../../../fixtures/voice-protocol/session-config.json")
            ))
            .unwrap();
            let ClientFrame::SessionConfig { session, .. } = &mut frame else {
                panic!("expected session config");
            };
            session.session_id = None;
            frame
        },
        {
            let mut frame: ClientFrame = serde_json::from_str(&format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{}}}"#,
                include_str!("../../../fixtures/voice-protocol/session-config.json")
            ))
            .unwrap();
            let ClientFrame::SessionConfig { session, .. } = &mut frame else {
                panic!("expected session config");
            };
            session.session_id = Some(agent_domain::SessionId::new("voice-session-2"));
            frame
        },
        {
            let mut frame: ClientFrame = serde_json::from_str(&format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{}}}"#,
                include_str!("../../../fixtures/voice-protocol/session-config.json")
            ))
            .unwrap();
            let ClientFrame::SessionConfig { session, .. } = &mut frame else {
                panic!("expected session config");
            };
            session.user_id = Some("user-2".to_owned());
            frame
        },
        {
            let mut frame: ClientFrame = serde_json::from_str(&format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{}}}"#,
                include_str!("../../../fixtures/voice-protocol/session-config.json")
            ))
            .unwrap();
            let ClientFrame::SessionConfig { session, .. } = &mut frame else {
                panic!("expected session config");
            };
            session.study_set_id = None;
            frame
        },
        {
            let mut frame: ClientFrame = serde_json::from_str(&format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{}}}"#,
                include_str!("../../../fixtures/voice-protocol/session-config.json")
            ))
            .unwrap();
            let ClientFrame::SessionConfig { session, .. } = &mut frame else {
                panic!("expected session config");
            };
            session.study_set_id = Some("chemistry-final".to_owned());
            frame
        },
    ] {
        let state = test_state(1);
        let evidence = state.evidence.clone();
        let Some(url) = spawn_server(state).await else {
            return;
        };
        let (mut socket, _) = connect_async(url).await.unwrap();

        assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
        send_client_frame(&mut socket, &session).await;
        assert!(matches!(
            read_server_frame(&mut socket).await,
            ServerFrame::Error { error, .. } if error.message == "session auth failed"
        ));
        assert_close_code(&mut socket, CloseCode::Policy).await;
        let auth_events =
            wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
        assert!(auth_events.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::AuthFailure
                && event.detail.contains("code=identity_mismatch")
                && event.detail.contains("client_class=terminal")
                && event.detail.contains("retry_eligible=false")
        }));
        let events =
            wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
        assert!(events.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == "invalid_session_identity"
        }));
    }
}

#[tokio::test]
async fn websocket_accepts_signed_session_token_matching_initial_config() {
    let state = test_state_with_session_token("session-secret")
        .with_trusted_user_id("trusted-env-user")
        .with_trusted_study_set_id("trusted-env-study")
        .with_trusted_session_id("trusted-env-session");
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-valid",
    );
    let (mut socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { .. }
    ));
    socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_records_auth_failure_for_forged_config_refresh() {
    let state = test_state(1);
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    let mut forged_refresh = session.clone();
    forged_refresh["user_id"] = serde_json::Value::String("user-2".to_owned());

    assert_ready_provider(&mut socket, "synthetic").await;
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let accepted_events =
        wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::ConfigAccepted).await;
    assert!(accepted_events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ConfigAccepted
            && event.detail == "session config accepted"
    }));

    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
                "session": forged_refresh,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    for frame in frames {
        if let ServerFrame::Error { error, .. } = frame {
            assert_eq!(error.message, "session auth failed");
        }
    }
    let auth_events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
    assert!(auth_events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::AuthFailure
            && event.detail.contains("code=identity_mismatch")
            && event.detail.contains("client_class=terminal")
            && event.detail.contains("retry_eligible=false")
            && !event.detail.contains("user-2")
    }));
}

/// `SERVICE-009` / architecture recommendation R2: the service consumes exactly one
/// typed first-frame parser and one published ready shape. These are source-level
/// absence characterizations, so an accidental re-introduction of a private shadow
/// type fails here instead of drifting silently.
const WS_SOURCE: &str = include_str!("../src/ws.rs");
const PROTOCOL_SOURCE: &str = include_str!("../src/protocol.rs");
const LIB_SOURCE: &str = include_str!("../src/lib.rs");
const APP_SOURCE: &str = include_str!("../src/app.rs");
const MAIN_SOURCE: &str = include_str!("../src/main.rs");

#[test]
fn protocol_v5_fixture_shadow_types_are_absent() {
    // `SERVICE-009`: Plan 05's `VOICE-READY-001` removed the duplicate ready shape.
    assert!(
        !PROTOCOL_SOURCE.contains("ReadyFrame"),
        "protocol.rs still declares a duplicate ReadyFrame: return the defect to Plan 05"
    );
    assert!(
        !LIB_SOURCE.contains("ReadyFrame"),
        "lib.rs still re-exports ReadyFrame: return the defect to Plan 05"
    );

    // `SERVICE-007`: the private parallel first-frame struct is deleted; the initial
    // frame is Plan 05's public `ClientFrame::SessionConfig`.
    assert!(
        !WS_SOURCE.contains("InitialClientFrame"),
        "ws.rs still declares a private first-frame shadow of ClientFrame::SessionConfig"
    );

    // `SERVICE-008` overlap: no service-local wire error JSON survives; the only
    // fallback is Plan 05's published constant.
    assert!(
        WS_SOURCE.contains("VOICE_SERIALIZATION_FALLBACK_FRAME"),
        "ws.rs must serialize through Plan 05's published fallback constant"
    );
    assert!(
        !WS_SOURCE.contains("VOICE_INTERNAL_SERIALIZATION"),
        "ws.rs must not restate the fallback frame body"
    );
}

/// `SERVICE-002`: one deadline per outbound write, owned in exactly one place.
///
/// Every server frame, Ready, provider event, protocol error, Ping/Pong,
/// terminal frame, and Close frame goes through the single `BoundedSender`, so
/// the configured write deadline is read exactly once — where that sender is
/// built — and nowhere else. A second reader would mean a second, unaudited
/// write-deadline policy, which is the defect this row closes; a send that
/// wrapped itself in its own `tokio::time::timeout` would be the same defect
/// wearing a different name. This is a source-level absence characterization,
/// like its neighbour above, so a re-introduction fails here rather than
/// drifting silently.
#[test]
fn outbound_writes_have_exactly_one_deadline_owner() {
    assert_eq!(
        WS_SOURCE.matches("ws_timeouts.outbound_write").count(),
        1,
        "the outbound write deadline must be read exactly once, where BoundedSender is built"
    );
    assert_eq!(
        WS_SOURCE.matches("struct BoundedSender").count(),
        1,
        "there is exactly one bounded sender type"
    );
    // The deadline is applied by `BoundedSender::send` alone. The only other
    // `tokio::time::timeout` calls in the module are read-side or drain-side
    // waits, never a write.
    let bounded_send = WS_SOURCE
        .split_once("impl<S> BoundedSender<S>")
        .expect("BoundedSender impl block")
        .1;
    assert!(
        bounded_send.contains("tokio::time::timeout(self.timeout, self.inner.send(message))"),
        "BoundedSender::send is where the write deadline is applied"
    );
}

#[derive(Deserialize)]
struct VoiceFixtureManifest {
    protocol_version: u32,
    fixtures: Vec<VoiceFixtureManifestRow>,
}

#[derive(Deserialize)]
struct VoiceFixtureManifestRow {
    id: String,
    path: String,
}

/// `SERVICE-007`: the two exact v5 client fixtures deserialize through the imported
/// contract, and their declared version is the imported constant rather than a
/// number restated here.
#[test]
fn protocol_v5_fixture_client_frames_bind_the_imported_version() {
    assert_eq!(VIVA_VOICE_PROTOCOL_VERSION, 5);

    let signed_config: ClientFrame = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/v5/client-session-config-signed.json"
    ))
    .expect("signed session config fixture parses");
    let ClientFrame::SessionConfig {
        version,
        client_generation_id,
        session_token,
        session,
    } = &signed_config
    else {
        panic!("signed config fixture is not a session_config frame");
    };
    assert_eq!(*version, VIVA_VOICE_PROTOCOL_VERSION);
    assert_eq!(signed_config.version(), VIVA_VOICE_PROTOCOL_VERSION);
    assert_eq!(client_generation_id, "viva-session-bootstrap-1-fixture");
    assert!(session_token.starts_with("viva1."));
    assert_eq!(session.user_id.as_deref(), Some("fixture-user"));
    assert_eq!(session.study_set_id.as_deref(), Some("fixture-study-set"));
    assert_eq!(
        session.session_id.as_ref().map(ToString::to_string),
        Some("fixture-session".to_owned())
    );

    let refresh: ClientFrame = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/v5/client-session-refresh.json"
    ))
    .expect("session refresh fixture parses");
    let ClientFrame::SessionRefresh {
        version,
        client_generation_id,
        context,
    } = &refresh
    else {
        panic!("refresh fixture is not a session_refresh frame");
    };
    assert_eq!(*version, VIVA_VOICE_PROTOCOL_VERSION);
    assert_eq!(refresh.version(), VIVA_VOICE_PROTOCOL_VERSION);
    assert_eq!(client_generation_id, "viva-session-bootstrap-1-fixture");
    assert!(!context.is_empty());

    let manifest: VoiceFixtureManifest = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/v5/manifest.json"
    ))
    .expect("manifest parses");
    assert_eq!(manifest.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
    for (id, path) in [
        (
            "VOICE-CLIENT-SESSION-CONFIG-SIGNED",
            "agent/fixtures/voice-protocol/v5/client-session-config-signed.json",
        ),
        (
            "VOICE-CLIENT-SESSION-REFRESH",
            "agent/fixtures/voice-protocol/v5/client-session-refresh.json",
        ),
    ] {
        assert!(
            manifest
                .fixtures
                .iter()
                .any(|row| row.id == id && row.path == path),
            "manifest does not name {id}"
        );
    }
}

/// A provider that keeps every `BrainInput` the socket admits, so a refresh test can
/// read the server-owned session identity the provider actually received.
struct RecordingInputBrain {
    inputs: Arc<Mutex<Vec<BrainInput>>>,
}

#[async_trait::async_trait]
impl RealtimeBrain for RecordingInputBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "recording_input".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, _config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(16);
        let (event_tx, events) = mpsc::channel(16);
        let inputs = self.inputs.clone();
        tokio::spawn(async move {
            while let Some(received) = input_rx.recv().await {
                inputs.lock().expect("input log lock").push(received);
            }
            drop(event_tx);
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: None,
        })
    }
}

fn refresh_identity_state(
    store: Arc<dyn StudyMemoryStore>,
    inner: Arc<data::InMemoryStudyStore>,
    access: VoiceWsAccess,
) -> (AppState, Arc<Mutex<Vec<BrainInput>>>) {
    let inputs = Arc::new(Mutex::new(Vec::new()));
    let _ = inner;
    let state = AppState::with_study_store(
        Arc::new(RecordingInputBrain {
            inputs: inputs.clone(),
        }),
        "recording_input",
        access,
        2,
        store,
    );
    (state, inputs)
}

fn recorded_context_refreshes(inputs: &Arc<Mutex<Vec<BrainInput>>>) -> Vec<serde_json::Value> {
    inputs
        .lock()
        .expect("input log lock")
        .iter()
        .filter_map(|input| match input {
            BrainInput::SessionContextRefresh(value) => Some(value.clone()),
            _ => None,
        })
        .collect()
}

/// `SERVICE-007` (review Minor M2): the trusted socket rotates the voice session ID
/// the provider and store see, so the browser cannot know it. A context refresh must
/// therefore be validated against the identity the client is allowed to assert and
/// rewritten to the unchanged server session ID — not rejected as an identity
/// mismatch, which is what the pre-remediation binding did.
#[tokio::test]
async fn refresh_identity_trusted_context_refresh_binds_the_server_session_id() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner: inner.clone(),
        audit: audit.clone(),
    });
    let (state, inputs) = refresh_identity_state(store, inner, VoiceWsAccess::default());
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "recording_input").await;

    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();
    let opened = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::ConfigAccepted).await;
    assert!(opened
        .iter()
        .any(|event| event.detail == "session config accepted"));

    // The same bound generation and the identity the browser knows: its own.
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();

    let refreshed = wait_for_evidence_detail(
        &evidence,
        VoiceEvidenceEventKind::ConfigAccepted,
        "config refresh received",
    )
    .await;
    assert!(
        refreshed,
        "a trusted context refresh naming the client's own session must be accepted"
    );

    let contexts = recorded_context_refreshes(&inputs);
    assert_eq!(
        contexts.len(),
        1,
        "exactly one context refresh is forwarded"
    );
    let forwarded = contexts[0]["session_id"]
        .as_str()
        .expect("forwarded refresh carries a session id")
        .to_owned();
    assert_ne!(
        forwarded, "voice-session-1",
        "the provider must never be re-pointed at the browser-asserted session id"
    );
    assert_eq!(
        forwarded,
        uuid::Uuid::from_u128(1).to_string(),
        "the refresh must carry the unchanged rotated server session id"
    );
    assert_eq!(
        audit.nonce_calls.load(Ordering::SeqCst),
        0,
        "a context refresh performs zero nonce-store calls"
    );

    socket.close(None).await.unwrap();
}

/// `SERVICE-007`: the bound `client_generation_id` is the socket's generation. A
/// stale or different generation cannot refresh this socket's context.
#[tokio::test]
async fn refresh_identity_stale_generation_is_rejected() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner: inner.clone(),
        audit: audit.clone(),
    });
    let (state, inputs) = refresh_identity_state(store, inner, VoiceWsAccess::default());
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "recording_input").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();
    let _ = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::ConfigAccepted).await;

    // The bound generation is accepted, so the rejection below can only be the
    // generation comparison rather than a blanket refusal of every refresh.
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();
    assert!(
        wait_for_evidence_detail(
            &evidence,
            VoiceEvidenceEventKind::ConfigAccepted,
            "config refresh received",
        )
        .await,
        "the bound generation must be accepted"
    );

    let session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "voice-test-generation-2",
                "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(
        frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Error { error, .. } if error.code == VoiceServerErrorCode::AuthIdentityMismatch.as_str()
        )),
        "a different generation must fail the bound identity comparison, got {frames:?}"
    );
    assert_eq!(
        recorded_context_refreshes(&inputs).len(),
        1,
        "a stale generation never reaches the provider"
    );
    assert_eq!(audit.nonce_calls.load(Ordering::SeqCst), 0);
}

/// The exact recoverable policy-denial event Plan 05 publishes for `D-03B QUIZ_ONLY`.
const REFRESH_POLICY_DENIED_WIRE: &str = "{\"type\":\"event\",\"version\":5,\"event\":{\"type\":\"structured_error\",\"source\":\"agent-service\",\"code\":\"VOICE_SESSION_REFRESH_POLICY_DENIED\",\"message\":\"Session refresh is not authorized.\",\"terminality\":\"recoverable\"}}";

fn refresh_policy_denied_fixture_frame() -> String {
    #[derive(Deserialize)]
    struct TerminalSequences {
        sequences: Vec<TerminalSequence>,
    }

    #[derive(Deserialize)]
    struct TerminalSequence {
        id: String,
        terminal_reason: Option<String>,
        terminal_at_index: Option<usize>,
        wire_sequence_json: Vec<String>,
    }

    let file: TerminalSequences = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/v5/terminal-sequences.json"
    ))
    .expect("terminal sequences fixture parses");
    let case = file
        .sequences
        .into_iter()
        .find(|sequence| sequence.id == "VOICE-RECOVERABLE-SESSION-REFRESH-POLICY-DENIED")
        .expect("the recoverable refresh-denial case is published");
    assert_eq!(
        case.terminal_reason, None,
        "the denial is classified nonterminal"
    );
    assert_eq!(case.terminal_at_index, None);
    case.wire_sequence_json
        .into_iter()
        .next()
        .expect("the denial event is the first entry")
}

/// `SERVICE-007` / `D-03B QUIZ_ONLY`: the in-socket `session_refresh` frame parses,
/// but the one engine has no client-selectable context, so the service answers with
/// Plan 05's recoverable structured error, keeps the socket and its deadlines, and
/// performs no provider or store work.
#[tokio::test]
async fn refresh_identity_session_refresh_is_recoverable_policy_denial() {
    assert_eq!(
        refresh_policy_denied_fixture_frame(),
        REFRESH_POLICY_DENIED_WIRE
    );

    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner: inner.clone(),
        audit: audit.clone(),
    });
    let (state, inputs) = refresh_identity_state(store, inner, VoiceWsAccess::default());
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "recording_input").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();
    let _ = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::ConfigAccepted).await;

    for _ in 0..2 {
        socket
            .send(WsMessage::Text(
                serde_json::json!({
                    "type": "session_refresh",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                    "context": { "mode": "quiz", "initial_goal": "Review the fixture source." },
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let raw = read_server_text_frame(&mut socket).await;
        assert_eq!(
            raw, REFRESH_POLICY_DENIED_WIRE,
            "the denial must match Plan 05's published bytes exactly"
        );
    }

    // The socket is still live: a valid context refresh still works afterwards.
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();
    assert!(
        wait_for_evidence_detail(
            &evidence,
            VoiceEvidenceEventKind::ConfigAccepted,
            "config refresh received",
        )
        .await,
        "a recoverable denial must not end the session"
    );

    assert_eq!(
        recorded_context_refreshes(&inputs).len(),
        1,
        "the denied refreshes performed no provider work"
    );
    assert_eq!(audit.nonce_calls.load(Ordering::SeqCst), 0);
    socket.close(None).await.unwrap();
}

/// `SERVICE-007`: token renewal and identity rebinding never happen inside an open
/// socket. Plan 05's strict parser refuses every authority member on `session_refresh`,
/// and a second `session_config` presenting a different credential is refused before
/// any nonce, provider, or store work.
#[tokio::test]
async fn refresh_identity_new_access_token_requires_a_new_socket() {
    for forbidden in [
        serde_json::json!({ "session_token": "viva1.aaa.bbb" }),
        serde_json::json!({ "user_id": "user-2" }),
        serde_json::json!({ "study_set_id": "other-set" }),
        serde_json::json!({ "session_id": "voice-session-2" }),
        serde_json::json!({ "source_context": [] }),
        serde_json::json!({ "active_concepts": [] }),
    ] {
        let mut frame = serde_json::json!({
            "type": "session_refresh",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
            "context": { "mode": "quiz" },
        });
        for (key, value) in forbidden.as_object().expect("object") {
            frame[key] = value.clone();
        }
        assert!(
            agent_service::parse_client_frame_json(&frame.to_string()).is_err(),
            "session_refresh must not carry {forbidden}"
        );
    }

    let inner = provider_limiter_test_store();
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner: inner.clone(),
        audit: audit.clone(),
    });
    let (state, inputs) = refresh_identity_state(
        store,
        inner,
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some(NONCE_AUDIT_SECRET.into()),
            allowed_origins: vec![],
        },
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let first = nonce_audit_token("voice-session-1", "refresh-nonce-1");
    let second = nonce_audit_token("voice-session-1", "refresh-nonce-2");

    let (mut socket, _) = connect_async(token_only_request(&url, &first))
        .await
        .unwrap();
    assert_ready_provider(&mut socket, "recording_input").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&first).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        audit.nonce_successes.load(Ordering::SeqCst) == 1
    })
    .await;

    // A different credential cannot be presented on the open socket.
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&second).into(),
        ))
        .await
        .unwrap();
    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(
        frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Error { error, .. } if error.code == VoiceServerErrorCode::AuthIdentityMismatch.as_str()
        )),
        "a renewed credential must not rebind an open socket, got {frames:?}"
    );
    assert!(
        recorded_context_refreshes(&inputs).is_empty(),
        "a renewed credential never reaches the provider"
    );
    assert_eq!(
        audit.nonce_successes.load(Ordering::SeqCst),
        1,
        "the second credential's nonce is never consumed in the old socket"
    );

    // It succeeds only as the initial config of a new socket and generation.
    let (mut renewed, _) = connect_async(token_only_request(&url, &second))
        .await
        .unwrap();
    assert_ready_provider(&mut renewed, "recording_input").await;
    renewed
        .send(WsMessage::Text(
            session_config_json_with_token(&second).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        audit.nonce_successes.load(Ordering::SeqCst) == 2
    })
    .await;
    renewed.close(None).await.unwrap();
}

/// `SERVICE-007`: the absolute socket deadline is server configuration. Recoverable
/// refresh denials neither reset nor extend it.
#[tokio::test]
async fn refresh_identity_absolute_deadline_survives_context_refreshes() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let audit = Arc::new(NonceAuditLog::default());
    let store = Arc::new(NonceAuditStudyStore {
        inner: inner.clone(),
        audit,
    });
    let (state, _inputs) = refresh_identity_state(store, inner, VoiceWsAccess::default());
    let state = state.with_ws_timeouts(WsTimeouts {
        session: Duration::from_millis(900),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "recording_input").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(VOICE_TEST_PLACEHOLDER_CREDENTIAL).into(),
        ))
        .await
        .unwrap();

    let started = Instant::now();
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        socket
            .send(WsMessage::Text(
                serde_json::json!({
                    "type": "session_refresh",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                    "context": { "mode": "quiz" },
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    }

    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the original absolute deadline must not be reset by context refreshes"
    );
    assert!(
        frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::StructuredError { code, .. }
                        if code == "VOICE_SESSION_REFRESH_POLICY_DENIED"
                )
        )),
        "the socket answered at least one refresh before its deadline, got {frames:?}"
    );
}

#[tokio::test]
async fn websocket_failure_control_claim_forces_sanitized_provider_terminal_path() {
    let origin = "https://control.example";
    let state = test_state_with_session_token("session-secret").with_failure_control(
        FailureControlConfig::enabled_for_synthetic_identities(
            FailureControlScenario::ProviderRateLimited,
            "control-secret",
            vec!["user-1".to_owned()],
            vec!["biology-midterm".to_owned()],
            vec![origin.to_owned()],
            1,
        )
        .unwrap(),
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "biology-midterm",
        session_id: "voice-session-1",
        origin,
        scenario: FailureControlScenario::ProviderRateLimited,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-control-session",
        run_id: "run-control-1",
        control_nonce: "nonce-control-claim",
    });
    let mut request = token_only_request(&url, &token);
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());

    let (mut socket, _) = connect_async(request).await.unwrap();
    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();
    let ready = read_server_frame(&mut socket).await;
    assert!(matches!(
        ready,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
    ));

    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "v5-answer-1".to_owned(),
            turn_id: "v5-turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "synthetic answer".to_owned(),
            },
        },
    )
    .await;

    let terminal = loop {
        let frame = read_server_frame(&mut socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::ProviderRateLimited) {
            break frame;
        }
    };
    assert_terminal_session_phase(terminal, TerminalSessionReason::ProviderRateLimited);
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "provider_rate_limited"
    }));
}

#[tokio::test]
async fn websocket_failure_control_provider_error_does_not_backoff_normal_sessions() {
    let origin = "https://control.example";
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        2,
        store,
    )
    .with_failure_control(
        FailureControlConfig::enabled_for_synthetic_identities(
            FailureControlScenario::ProviderRateLimited,
            "control-secret",
            vec!["user-1".to_owned()],
            vec!["biology-midterm".to_owned()],
            vec![origin.to_owned()],
            1,
        )
        .unwrap(),
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let control_token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "biology-midterm",
        session_id: "voice-session-1",
        origin,
        scenario: FailureControlScenario::ProviderRateLimited,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-control-session-backoff",
        run_id: "run-control-backoff-1",
        control_nonce: "nonce-control-claim-backoff",
    });
    let mut control_request = token_only_request(&url, &control_token);
    control_request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());
    let (mut control_socket, _) = connect_async(control_request).await.unwrap();
    assert_ready_provider(&mut control_socket, "cartesia_gemini").await;
    control_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&control_token).into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut control_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-failure-control-backoff".to_owned(),
            turn_id: "v5-turn-2".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "control probe".to_owned(),
            },
        },
    )
    .await;
    let terminal = loop {
        let frame = read_server_frame(&mut control_socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::ProviderRateLimited) {
            break frame;
        }
    };
    assert_terminal_session_phase(terminal, TerminalSessionReason::ProviderRateLimited);
    assert_close_code(&mut control_socket, CloseCode::Error).await;

    let normal_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-normal-after-failure-control",
    );
    let (mut normal_socket, _) = connect_async(token_only_request(&url, &normal_token))
        .await
        .unwrap();
    assert_ready_provider(&mut normal_socket, "cartesia_gemini").await;
    normal_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&normal_token).into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut normal_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut normal_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-normal-after-failure-control".to_owned(),
            turn_id: "v5-turn-3".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "normal probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;
    normal_socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_provider_rate_limit_after_answer_emits_deterministic_partial_recap() {
    let Some((frames, evidence, store)) =
        run_partial_recap_provider_failure_probe(TerminalSessionReason::ProviderRateLimited, false)
            .await
    else {
        return;
    };
    let (recap_index, recap, partial_reason) = frames
        .iter()
        .enumerate()
        .find_map(|(index, frame)| match frame {
            ServerFrame::Event { event, .. } => match event.as_ref() {
                VivaServerEvent::RecapReady {
                    recap,
                    partial_reason,
                    ..
                } => Some((index, recap, *partial_reason)),
                _ => None,
            },
            _ => None,
        })
        .expect("partial recap frame");
    let terminal_index = frames
        .iter()
        .position(|frame| {
            terminal_session_reason(frame) == Some(TerminalSessionReason::ProviderRateLimited)
        })
        .expect("provider-rate terminal phase");

    assert!(
        recap_index < terminal_index,
        "partial recap must be visible before the terminal provider phase"
    );
    assert_eq!(
        partial_reason,
        Some(TerminalSessionReason::ProviderRateLimited)
    );
    assert_eq!(
        recap.voice_session_id,
        "00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(recap.headline, "Partial recap: your answer was preserved.");
    assert!(recap
        .summary
        .contains("terminal_reason=provider_rate_limited"));
    assert!(recap.summary.contains("answer_attempts=1"));
    assert!(recap.summary.contains("source_id=src-lecture-5-slide-18"));
    assert!(recap.source_moments.is_empty());
    assert!(recap.next_action.contains("Retry this question"));

    let recap_json = serde_json::to_string(recap).expect("serialize recap");
    assert!(!recap_json.contains("raw learner answer"));
    assert!(!recap_json.contains(&agent_domain::fixture_source_reference().excerpt));
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.recaps, 1);
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PartialRecap
            && event
                .detail
                .contains("terminal_reason=provider_rate_limited")
            && event.detail.contains("answer_attempts=1")
            && event.detail.contains("source_id=src-lecture-5-slide-18")
    }));
}

#[tokio::test]
async fn websocket_provider_timeout_after_partial_stage_success_records_partial_recap_evidence() {
    let Some((frames, evidence, store)) =
        run_partial_recap_provider_failure_probe(TerminalSessionReason::ProviderTimeout, true)
            .await
    else {
        return;
    };
    let recap = frames
        .iter()
        .find_map(|frame| match frame {
            ServerFrame::Event { event, .. } => match event.as_ref() {
                VivaServerEvent::RecapReady {
                    recap,
                    partial_reason,
                    ..
                } if *partial_reason == Some(TerminalSessionReason::ProviderTimeout) => Some(recap),
                _ => None,
            },
            _ => None,
        })
        .expect("partial recap frame");

    assert!(recap.summary.contains("terminal_reason=provider_timeout"));
    assert!(recap.summary.contains("concept_statuses=1"));
    assert!(recap.source_moments.is_empty());
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.concept_statuses, 1);
    assert_eq!(counts.recaps, 1);
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PartialRecap
            && event.detail.contains("terminal_reason=provider_timeout")
            && event.detail.contains("concept_statuses=1")
    }));
}

#[tokio::test]
async fn websocket_provider_failure_after_cancelled_turn_skips_partial_recap() {
    let Some((frames, evidence, store)) =
        run_partial_recap_provider_failure_probe_cancelled(TerminalSessionReason::ProviderTimeout)
            .await
    else {
        return;
    };

    assert!(!frames.iter().any(|frame| {
        matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::RecapReady {
                        partial_reason: Some(TerminalSessionReason::ProviderTimeout),
                        ..
                    }
                )
        )
    }));
    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::ProviderTimeout)
    }));
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.recaps, 0);
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PartialRecap
            && event.detail.contains("reason=no_durable_response_id")
    }));
}

#[tokio::test]
async fn websocket_provider_failure_requires_current_response_answer_attempt() {
    let Some((frames, evidence, store)) =
        run_partial_recap_provider_failure_probe_with_prior_attempt_only(
            TerminalSessionReason::ProviderRateLimited,
        )
        .await
    else {
        return;
    };

    assert!(!frames.iter().any(|frame| {
        matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::RecapReady {
                        partial_reason: Some(TerminalSessionReason::ProviderRateLimited),
                        ..
                    }
                )
        )
    }));
    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::ProviderRateLimited)
    }));
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.recaps, 0);
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PartialRecap
            && event
                .detail
                .contains("reason=response_answer_attempt_missing")
            && event
                .detail
                .contains("response_id=response-partial-provider-failure")
    }));
}

#[tokio::test]
async fn websocket_stop_drain_provider_failure_emits_deterministic_partial_recap() {
    let Some((frames, evidence, store)) =
        run_partial_recap_provider_failure_probe_after_stop(TerminalSessionReason::ProviderTimeout)
            .await
    else {
        return;
    };
    let recap_index = frames
        .iter()
        .position(|frame| {
            matches!(
                frame,
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        VivaServerEvent::RecapReady {
                            partial_reason: Some(TerminalSessionReason::ProviderTimeout),
                            ..
                        }
                    )
            )
        })
        .expect("partial recap frame");
    let terminal_index = frames
        .iter()
        .position(|frame| {
            terminal_session_reason(frame) == Some(TerminalSessionReason::ProviderTimeout)
        })
        .expect("provider-timeout terminal phase");

    assert!(
        recap_index < terminal_index,
        "stop-drain partial recap must be visible before the terminal provider phase"
    );
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.recaps, 1);
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PartialRecap
            && event.detail.contains("terminal_reason=provider_timeout")
            && event.detail.contains("answer_attempts=1")
    }));
}

#[tokio::test]
async fn websocket_stop_drain_provider_failure_does_not_replace_existing_recap() {
    let Some((frames, evidence, store)) =
        run_partial_recap_provider_failure_probe_after_stop_with_existing_recap(
            TerminalSessionReason::ProviderTimeout,
        )
        .await
    else {
        return;
    };
    let recap_frames = frames
        .iter()
        .filter(|frame| {
            matches!(
                frame,
                ServerFrame::Event { event, .. }
                    if matches!(event.as_ref(), VivaServerEvent::RecapReady { .. })
            )
        })
        .count();

    assert_eq!(recap_frames, 1);
    assert!(frames.iter().any(|frame| {
        matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::RecapReady {
                        partial_reason: None,
                        ..
                    }
                )
        )
    }));
    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::ProviderTimeout)
    }));
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert_eq!(counts.recaps, 1);
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PartialRecap
            && event.detail.contains("reason=prior_recap_exists")
            && event.detail.contains("prior_recaps=1")
    }));
}

#[tokio::test]
async fn websocket_provider_backoff_denies_next_answer_before_brain_input() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = AppState::new(
        Arc::new(StructuredRateLimitProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut first_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-backoff-first".to_owned(),
            turn_id: "v5-turn-4".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    let first_terminal = loop {
        let frame = read_server_frame(&mut first_socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::ProviderRateLimited) {
            break frame;
        }
    };
    assert_terminal_session_phase(first_terminal, TerminalSessionReason::ProviderRateLimited);
    assert_close_code(&mut first_socket, CloseCode::Error).await;
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);
    let provider_events =
        wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::ProviderStageFailure).await;
    assert!(provider_events.iter().any(|event| {
        event.detail.contains("failure_class=quota_rate_failure")
            && event.detail.contains("retry_after_ms=250")
    }));

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    let second_terminal = loop {
        let frame = read_server_frame(&mut second_socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::ProviderRateLimited) {
            break frame;
        }
    };
    assert_terminal_session_phase(second_terminal, TerminalSessionReason::ProviderRateLimited);
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert_eq!(
        text_inputs.load(Ordering::SeqCst),
        1,
        "provider limiter must reject the backed-off attempt before forwarding it to the brain"
    );
    assert!(evidence.snapshot().iter().any(|event| {
        event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=provider_backoff")
            && event
                .detail
                .contains("terminal_reason=provider_rate_limited")
            && event.detail.contains("retry_after_ms=250")
            && event.detail.contains("reset_hint=2030-01-01T00:00:00Z")
            && event.detail.contains("budget_state=within_limit")
    }));
}

#[tokio::test]
async fn websocket_unstructured_provider_rate_limit_sets_default_backoff() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = AppState::new(
        Arc::new(UnstructuredRateLimitProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut first_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-unstructured-backoff-first".to_owned(),
            turn_id: "v5-turn-5".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    let first_terminal = loop {
        let frame = read_server_frame(&mut first_socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::ProviderRateLimited) {
            break frame;
        }
    };
    assert_terminal_session_phase(first_terminal, TerminalSessionReason::ProviderRateLimited);
    assert_close_code(&mut first_socket, CloseCode::Error).await;
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    let second_terminal = loop {
        let frame = read_server_frame(&mut second_socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::ProviderRateLimited) {
            break frame;
        }
    };
    assert_terminal_session_phase(second_terminal, TerminalSessionReason::ProviderRateLimited);
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert_eq!(
        text_inputs.load(Ordering::SeqCst),
        1,
        "provider limiter must reject unstructured backed-off attempts before brain input"
    );
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=provider_backoff")
            && event.detail.contains("retry_after_ms=1000")
            && event.detail.contains("reset_hint=none")
    }));
}

#[tokio::test]
async fn websocket_open_rate_limit_backoff_denies_next_socket_before_brain_open() {
    let opens = Arc::new(AtomicUsize::new(0));
    let state = AppState::new(
        Arc::new(OpenRateLimitFailureBrain {
            opens: opens.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut first_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut first_socket).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut first_socket, CloseCode::Error).await;
    assert_eq!(opens.load(Ordering::SeqCst), 1);

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut second_socket).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert_eq!(
        opens.load(Ordering::SeqCst),
        1,
        "active provider open backoff must deny before reopening the provider"
    );
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=provider_backoff")
            && event.detail.contains("retry_after_ms=250")
            && event.detail.contains("reset_hint=2030-01-01T00:00:00Z")
    }));
}

#[tokio::test]
async fn websocket_provider_backoff_denial_does_not_consume_signed_nonce() {
    let opens = Arc::new(AtomicUsize::new(0));
    let state = provider_limiter_test_state(
        Arc::new(OpenRateLimitFailureBrain {
            opens: opens.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig::default(),
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-open-backoff-first",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut first_socket).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut first_socket, CloseCode::Error).await;
    assert_eq!(opens.load(Ordering::SeqCst), 1);

    let retry_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-open-backoff-retry",
    );
    let retry_session =
        session_config_json_with_ids_and_token("chemistry-final", "voice-session-2", &retry_token);
    let (mut second_socket, _) = connect_async(token_only_request(&url, &retry_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(retry_session.clone().into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut second_socket).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert_eq!(
        opens.load(Ordering::SeqCst),
        1,
        "active provider backoff should deny before reopening the provider"
    );

    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut retry_socket, _) = connect_async(token_only_request(&url, &retry_token))
        .await
        .unwrap();
    assert_ready_provider(&mut retry_socket, "cartesia_gemini").await;
    retry_socket
        .send(WsMessage::Text(retry_session.into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut retry_socket).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut retry_socket, CloseCode::Error).await;
    assert_eq!(
        opens.load(Ordering::SeqCst),
        2,
        "backoff-only denial consumed the signed nonce before the retry window"
    );
}

#[tokio::test]
async fn websocket_provider_global_turn_limit_denies_queue_overflow() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = provider_limiter_test_state(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(0),
            ..VoiceLimitConfig::default()
        },
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-first".to_owned(),
            turn_id: "v5-turn-6".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        evidence.snapshot().iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::ProviderAdmission
                && event.detail.contains("admission_decision=admitted")
                && event.detail.contains("queue_depth=0")
        })
    })
    .await;

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-limiter-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    let second_ready_frame = read_server_frame(&mut second_socket).await;
    assert!(
        matches!(
            second_ready_frame,
            ServerFrame::Event { ref event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase {
                        phase: agent_domain::StudySessionPhase::Ready,
                        terminal_reason: None,
                    }
                )
        ),
        "unexpected second ready frame: {second_ready_frame:?}"
    );
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-second".to_owned(),
            turn_id: "v5-turn-7".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;

    assert_terminal_session_phase(
        read_server_frame(&mut second_socket).await,
        TerminalSessionReason::ProviderRateLimited,
    );
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert!(
        text_inputs.load(Ordering::SeqCst) <= 1,
        "provider queue limiter must not forward the overflow answer to the brain"
    );
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=provider_queue_full")
            && event.detail.contains("queue_depth=1")
            && event.detail.contains("budget_state=within_limit")
    }));

    first_socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_provider_queue_rejects_overlapping_same_socket_turn_without_deadlock() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = AppState::new(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-overlap-first".to_owned(),
            turn_id: "v5-turn-8".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-overlap-second".to_owned(),
            turn_id: "v5-turn-9".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    let terminal = tokio::time::timeout(Duration::from_millis(250), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                return frame;
            }
        }
    })
    .await
    .expect("overlapping same-socket provider turn queued indefinitely");
    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    assert_close_code(&mut socket, CloseCode::Policy).await;
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=overlapping_provider_turn")
            && event.detail.contains("terminal_reason=slow_client")
            && event.detail.contains("queue_depth=1")
    }));
}

#[tokio::test]
async fn websocket_provider_queue_depth_waits_for_slot_before_forwarding() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = provider_limiter_test_state(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-wait-first".to_owned(),
            turn_id: "v5-turn-10".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-limiter-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    let second_ready_frame = read_server_frame(&mut second_socket).await;
    assert!(
        matches!(
            second_ready_frame,
            ServerFrame::Event { ref event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase {
                        phase: agent_domain::StudySessionPhase::Ready,
                        terminal_reason: None,
                    }
                )
        ),
        "unexpected second ready frame: {second_ready_frame:?}"
    );
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-wait-second".to_owned(),
            turn_id: "v5-turn-11".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            read_server_frame(&mut second_socket)
        )
        .await
        .is_err(),
        "queued provider turn must wait instead of closing immediately"
    );
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 2
    })
    .await;
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=admitted")
            && event.detail.contains("queue_depth=1")
    }));

    second_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut second_socket).await;
}

#[tokio::test]
async fn websocket_provider_admission_rejects_audio_continuation_without_second_lease() {
    let audio_inputs = Arc::new(AtomicUsize::new(0));
    let state = AppState::new(
        Arc::new(AudioContinuationResolutionProbeBrain {
            audio_inputs: audio_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(0),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));

    send_v5_audio_turn(&mut socket, "audio-turn-1", &[1_u8, 2]).await;
    wait_until(Duration::from_secs(2), || {
        audio_inputs.load(Ordering::SeqCst) == 1
    })
    .await;
    send_v5_audio_turn(&mut socket, "audio-turn-2", &[3_u8, 4]).await;

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                return frame;
            }
        }
    })
    .await
    .expect("audio continuation without a second provider lease should be denied");
    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let provider_events = evidence
        .snapshot()
        .into_iter()
        .filter(|event| event.kind == VoiceEvidenceEventKind::ProviderAdmission)
        .collect::<Vec<_>>();
    assert_eq!(
        audio_inputs.load(Ordering::SeqCst),
        1,
        "second audio frame must not reach the provider without its own lease"
    );
    assert!(provider_events.iter().any(|event| {
        event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=overlapping_provider_turn")
    }));
}

#[tokio::test]
async fn websocket_provider_queue_cancel_drops_pending_admission_before_forwarding() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = provider_limiter_test_state(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-cancel-holder".to_owned(),
            turn_id: "v5-turn-12".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-limiter-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-cancel-pending".to_owned(),
            turn_id: "v5-turn-13".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "queued probe".to_owned(),
            },
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    send_client_frame(
        &mut second_socket,
        &ClientFrame::Cancel {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "v5-cancel".to_owned(),
            turn_id: None,
        },
    )
    .await;

    // The cancel and the first socket's close travel on two separate loopback
    // connections, so "sent" is not "processed". The server's own CancelReceived
    // evidence is the ordering the assertion below depends on: the queued
    // admission must already be dropped when the provider slot opens.
    wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::CancelReceived).await;
    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;
    let forwarded_after_cancel = tokio::time::timeout(Duration::from_millis(250), async {
        loop {
            if text_inputs.load(Ordering::SeqCst) == 2 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        forwarded_after_cancel.is_err(),
        "cancelled queued provider answer was forwarded after admission opened"
    );
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    second_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut second_socket).await;
}

#[tokio::test]
async fn websocket_provider_queue_cancel_rearms_pre_answer_idle() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = provider_limiter_test_state(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        // `SERVICE-001`: the deadline a cancelled queued submission returns to is
        // the between-turn one. The in-turn deadline stays long so the socket
        // holding the only provider slot survives the probe.
        idle: Duration::from_secs(5),
        between_turn_idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-cancel-idle-holder".to_owned(),
            turn_id: "v5-turn-14".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission holder".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-limiter-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-cancel-idle-pending".to_owned(),
            turn_id: "v5-turn-15".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "queued probe".to_owned(),
            },
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    send_client_frame(
        &mut second_socket,
        &ClientFrame::Cancel {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "v5-cancel".to_owned(),
            turn_id: None,
        },
    )
    .await;

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut second_socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                return frame;
            }
        }
    })
    .await
    .expect("cancelled queued first answer should re-arm pre-answer idle timeout");
    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;
}

#[tokio::test]
async fn websocket_provider_queue_arms_turn_cap_while_waiting_for_admission() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = provider_limiter_test_state(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-turn-cap-holder".to_owned(),
            turn_id: "v5-turn-16".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission holder".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-limiter-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut second_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queue-turn-cap-pending".to_owned(),
            turn_id: "v5-turn-17".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "queued admission should time out".to_owned(),
            },
        },
    )
    .await;

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut second_socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                break frame;
            }
        }
    })
    .await
    .expect("queued provider admission did not arm the BAC-510 turn cap");
    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
    assert_close_code(&mut second_socket, CloseCode::Policy).await;

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;
}

#[tokio::test]
async fn websocket_provider_queue_rejects_audio_continuation_without_second_lease() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let audio_inputs = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let state = provider_limiter_test_state(
        Arc::new(QueuedAudioProviderProbeBrain {
            text_inputs: text_inputs.clone(),
            audio_inputs: audio_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(200),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "cartesia_gemini").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queued-audio-holder".to_owned(),
            turn_id: "v5-turn-18".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-limiter-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "cartesia_gemini").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut second_socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_v5_audio_turn(&mut second_socket, "audio-turn-3", &[1_u8, 2]).await;
    send_v5_audio_turn(&mut second_socket, "audio-turn-4", &[3_u8, 4]).await;
    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut second_socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                return frame;
            }
        }
    })
    .await
    .expect("queued audio continuation without a second lease should be denied");
    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    assert_close_code(&mut second_socket, CloseCode::Policy).await;
    assert!(audio_inputs.lock().unwrap().is_empty());
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=overlapping_provider_turn")
            && event.detail.contains("terminal_reason=slow_client")
    }));

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;
}

#[tokio::test]
async fn websocket_provider_active_audio_rejects_later_frame_without_second_lease() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let audio_inputs = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let state = provider_limiter_test_state(
        Arc::new(QueuedAudioProviderProbeBrain {
            text_inputs: text_inputs.clone(),
            audio_inputs: audio_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-limiter-biology",
    );
    let (mut socket, _) = connect_async(token_only_request(&url, &socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    send_v5_audio_turn(&mut socket, "audio-turn-5", &[1_u8]).await;
    wait_until(Duration::from_secs(2), || {
        audio_inputs.lock().unwrap().len() == 1
    })
    .await;
    send_v5_audio_turn(&mut socket, "audio-turn-6", &[2_u8]).await;

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                return frame;
            }
        }
    })
    .await
    .expect("active audio continuation without a second lease should be denied");
    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    assert_close_code(&mut socket, CloseCode::Policy).await;
    // v5 PCM16 payloads are a whole number of samples, so the bounded assembler
    // admits the even-length turn the helper actually sent.
    assert_eq!(*audio_inputs.lock().unwrap(), vec![vec![1_u8, 2]]);
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=overlapping_provider_turn")
            && event.detail.contains("terminal_reason=slow_client")
    }));
}

#[tokio::test]
async fn websocket_failure_control_cap_is_identity_scoped_across_study_sets() {
    let origin = "https://control.example";
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_failure_control(
        FailureControlConfig::enabled_for_synthetic_identities(
            FailureControlScenario::SilentStall,
            "control-secret",
            vec!["user-1".to_owned()],
            vec!["biology-midterm".to_owned(), "chemistry-final".to_owned()],
            vec![origin.to_owned()],
            1,
        )
        .unwrap(),
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let biology_token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "biology-midterm",
        session_id: "voice-session-1",
        origin,
        scenario: FailureControlScenario::SilentStall,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-control-biology-session",
        run_id: "run-control-biology",
        control_nonce: "nonce-control-biology-claim",
    });
    let chemistry_token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "chemistry-final",
        session_id: "voice-session-2",
        origin,
        scenario: FailureControlScenario::SilentStall,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-control-chemistry-session",
        run_id: "run-control-chemistry",
        control_nonce: "nonce-control-chemistry-claim",
    });

    let mut biology_request = token_only_request(&url, &biology_token);
    biology_request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());
    let (mut biology_socket, _) = connect_async(biology_request).await.unwrap();
    assert_ready_provider(&mut biology_socket, "synthetic").await;
    biology_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&biology_token).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let mut chemistry_request = token_only_request(&url, &chemistry_token);
    chemistry_request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());
    let (mut chemistry_socket, _) = connect_async(chemistry_request).await.unwrap();
    assert_ready_provider(&mut chemistry_socket, "synthetic").await;
    chemistry_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &chemistry_token,
            )
            .into(),
        ))
        .await
        .unwrap();

    assert_terminal_session_phase(
        read_server_frame(&mut chemistry_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut chemistry_socket, CloseCode::Policy).await;
    biology_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut biology_socket).await;
}

#[tokio::test]
async fn websocket_failure_control_still_honors_user_total_session_cap() {
    let origin = "https://control.example";
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_user_sessions: Some(1),
        ..VoiceLimitConfig::default()
    })
    .with_failure_control(
        FailureControlConfig::enabled_for_synthetic_identities(
            FailureControlScenario::SilentStall,
            "control-secret",
            vec!["user-1".to_owned()],
            vec!["biology-midterm".to_owned(), "chemistry-final".to_owned()],
            vec![origin.to_owned()],
            2,
        )
        .unwrap(),
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let biology_token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "biology-midterm",
        session_id: "voice-session-1",
        origin,
        scenario: FailureControlScenario::SilentStall,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-control-user-total-biology-session",
        run_id: "run-control-user-total-biology",
        control_nonce: "nonce-control-user-total-biology-claim",
    });
    let chemistry_token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "chemistry-final",
        session_id: "voice-session-2",
        origin,
        scenario: FailureControlScenario::SilentStall,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-control-user-total-chemistry-session",
        run_id: "run-control-user-total-chemistry",
        control_nonce: "nonce-control-user-total-chemistry-claim",
    });

    let mut biology_request = token_only_request(&url, &biology_token);
    biology_request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());
    let (mut biology_socket, _) = connect_async(biology_request).await.unwrap();
    assert_ready_provider(&mut biology_socket, "synthetic").await;
    biology_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&biology_token).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let mut chemistry_request = token_only_request(&url, &chemistry_token);
    chemistry_request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());
    let (mut chemistry_socket, _) = connect_async(chemistry_request).await.unwrap();
    assert_ready_provider(&mut chemistry_socket, "synthetic").await;
    chemistry_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &chemistry_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut chemistry_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut chemistry_socket, CloseCode::Policy).await;

    biology_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut biology_socket).await;
}

#[tokio::test]
async fn websocket_rejects_failure_control_claim_from_wrong_origin_before_brain_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let allowed_origin = "https://control.example";
    let state = AppState::new(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "open_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        1,
    )
    .with_failure_control(
        FailureControlConfig::enabled_for_synthetic_identities(
            FailureControlScenario::ProviderRateLimited,
            "control-secret",
            vec!["user-1".to_owned()],
            vec!["biology-midterm".to_owned()],
            vec![allowed_origin.to_owned()],
            1,
        )
        .unwrap(),
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token_with_failure_control(FailureControlTokenFixture {
        session_secret: "session-secret",
        control_secret: "control-secret",
        user_id: "user-1",
        study_set_id: "biology-midterm",
        session_id: "voice-session-1",
        origin: allowed_origin,
        scenario: FailureControlScenario::ProviderRateLimited,
        expires_at: unix_timestamp_now() + 60,
        nonce: "nonce-origin-session",
        run_id: "run-origin-1",
        control_nonce: "nonce-origin-claim",
    });
    let mut request = token_only_request(&url, &token);
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_static("https://evil.example"));

    let (mut socket, _) = connect_async(request).await.unwrap();
    assert_ready_provider(&mut socket, "open_probe").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "session auth failed"
    ));
    assert_close_code(&mut socket, CloseCode::Policy).await;
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_rejects_replayed_session_token_before_brain_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let state = AppState::new(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        2,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-replay",
    );

    let (mut first_socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "open_probe").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();
    wait_for_socket_close(&mut first_socket).await;
    assert!(opened.load(Ordering::SeqCst));

    opened.store(false, Ordering::SeqCst);
    let (mut replay_socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();
    assert_ready_provider(&mut replay_socket, "open_probe").await;
    replay_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut replay_socket).await,
        ServerFrame::Error { error, .. } if error.message == "session auth failed"
    ));
    assert_close_code(&mut replay_socket, CloseCode::Policy).await;
    let auth_events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
    assert!(auth_events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::AuthFailure
            && event.detail.contains("code=replayed")
            && event.detail.contains("client_class=terminal")
            && event.detail.contains("retry_eligible=false")
    }));
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_records_nonce_store_errors_without_replay_auth_evidence() {
    let opened = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn StudyMemoryStore> =
        Arc::new(FailingStudyStore::new(FailingStudyStoreMode::ClaimNonce));
    let state = AppState::with_study_store(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        1,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-store-outage",
    );
    let (mut socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();

    assert_ready_provider(&mut socket, "open_probe").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "session token nonce store unavailable"
    ));
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "session_token_nonce_store_unavailable"
    }));
    assert!(!evidence
        .snapshot()
        .iter()
        .any(|event| event.kind == VoiceEvidenceEventKind::AuthFailure));
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_durable_store_replay_still_reports_session_auth_failure() {
    let opened = Arc::new(AtomicBool::new(false));
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::NoFailure,
    });
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "open_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        2,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-durable-replay",
    );

    let (mut first_socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut first_socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();
    wait_for_socket_close(&mut first_socket).await;
    assert!(opened.load(Ordering::SeqCst));

    opened.store(false, Ordering::SeqCst);
    let (mut replay_socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut replay_socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    replay_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut replay_socket).await,
        ServerFrame::Error { error, .. } if error.message == "session auth failed"
    ));
    assert_close_code(&mut replay_socket, CloseCode::Policy).await;
    let auth_events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
    assert!(auth_events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::AuthFailure
            && event.detail.contains("code=replayed")
            && event.detail.contains("client_class=terminal")
            && event.detail.contains("retry_eligible=false")
    }));
    let terminal_events =
        wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(terminal_events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "invalid_session_token"
    }));
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_nonce_store_failure_emits_durability_degraded_before_brain_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::NonceClaim,
    });
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "open_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        2,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-store-failure",
    );

    let (mut socket, _) = connect_async(token_only_request(&url, &token))
        .await
        .unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::DurabilityDegraded,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_study_context_store_failure_emits_durability_degraded_before_brain_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::StudyContext,
    });
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "open_probe",
        VoiceWsAccess::default(),
        2,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::DurabilityDegraded,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
/// `D-07` branch `retain-token-only` moved the token-only rejection to the HTTP
/// upgrade (`token_only_preflight_rejects_unverified_upgrades`). The per-code
/// first-frame classification stays reachable behind a service-authenticated
/// boundary, which is what this probe now exercises.
async fn websocket_rejects_invalid_session_token_before_brain_open() {
    for (token, expected_code) in [
        (
            signed_session_token(
                "session-secret",
                "user-1",
                "biology-midterm",
                "voice-session-1",
                unix_timestamp_now().saturating_sub(120),
                "nonce-expired",
            ),
            "expired",
        ),
        (
            signed_session_token(
                "wrong-secret",
                "user-1",
                "biology-midterm",
                "voice-session-1",
                unix_timestamp_now() + 60,
                "nonce-forged-signature",
            ),
            "invalid_signature",
        ),
        ("viva1.malformed.signature".to_owned(), "malformed"),
    ] {
        let opened = Arc::new(AtomicBool::new(false));
        let state = AppState::new(
            Arc::new(OpenProbeBrain {
                opened: opened.clone(),
                captured_config: None,
            }),
            "synthetic",
            VoiceWsAccess {
                required_bearer: Some("rest-secret".into()),
                session_token_secret: Some("session-secret".into()),
                allowed_origins: vec![],
            },
            1,
        );
        let evidence = state.evidence.clone();
        let Some(url) = spawn_server(state).await else {
            return;
        };
        let (mut socket, _) = connect_async(service_bearer_request(&url, "rest-secret"))
            .await
            .unwrap();

        assert_ready_provider(&mut socket, "open_probe").await;
        socket
            .send(WsMessage::Text(
                session_config_json_with_token(&token).into(),
            ))
            .await
            .unwrap();

        assert!(matches!(
            read_server_frame(&mut socket).await,
            ServerFrame::Error { error, .. } if error.message == "session auth failed"
        ));
        assert_close_code(&mut socket, CloseCode::Policy).await;
        let auth_events =
            wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
        assert!(auth_events.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::AuthFailure
                && event.detail.contains(&format!("code={expected_code}"))
                && event.detail.contains("client_class=")
                && event.detail.contains("stage=session")
                && !event.detail.contains("nonce-")
        }));
        assert!(!opened.load(Ordering::SeqCst));
    }
}

#[tokio::test]
async fn websocket_rejects_token_claim_mismatch_before_brain_open() {
    for token in [
        signed_session_token(
            "session-secret",
            "user-2",
            "biology-midterm",
            "voice-session-1",
            unix_timestamp_now() + 60,
            "nonce-wrong-user",
        ),
        signed_session_token(
            "session-secret",
            "user-1",
            "biology-midterm",
            "voice-session-2",
            unix_timestamp_now() + 60,
            "nonce-wrong-session",
        ),
        signed_session_token(
            "session-secret",
            "user-1",
            "chemistry-final",
            "voice-session-1",
            unix_timestamp_now() + 60,
            "nonce-wrong-study-set",
        ),
    ] {
        let opened = Arc::new(AtomicBool::new(false));
        let state = AppState::new(
            Arc::new(OpenProbeBrain {
                opened: opened.clone(),
                captured_config: None,
            }),
            "synthetic",
            VoiceWsAccess {
                required_bearer: None,
                session_token_secret: Some("session-secret".into()),
                allowed_origins: vec![],
            },
            1,
        );
        let evidence = state.evidence.clone();
        let Some(url) = spawn_server(state).await else {
            return;
        };
        let (mut socket, _) = connect_async(token_only_request(&url, &token))
            .await
            .unwrap();

        assert_ready_provider(&mut socket, "open_probe").await;
        socket
            .send(WsMessage::Text(
                session_config_json_with_token(&token).into(),
            ))
            .await
            .unwrap();

        assert!(matches!(
            read_server_frame(&mut socket).await,
            ServerFrame::Error { error, .. } if error.message == "session auth failed"
        ));
        assert_close_code(&mut socket, CloseCode::Policy).await;
        let auth_events =
            wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
        assert!(auth_events.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::AuthFailure
                && event.detail.contains("code=identity_mismatch")
                && event.detail.contains("client_class=terminal")
        }));
        assert!(!opened.load(Ordering::SeqCst));
    }
}

#[tokio::test]
async fn websocket_checks_study_set_access_before_brain_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let state = AppState::new(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "synthetic",
        VoiceWsAccess::default(),
        1,
    )
    .with_trusted_study_set_id("missing-set");
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = serde_json::json!({
        "session_id": "voice-session-1",
        "user_id": "user-1",
        "study_set_id": "missing-set",
        "mode": "quiz",
        "initial_goal": null,
        "source_context": [],
        "active_concepts": []
    });

    assert_ready_provider(&mut socket, "open_probe").await;
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "session auth failed"
    ));
    assert_close_code(&mut socket, CloseCode::Policy).await;
    assert!(!opened.load(Ordering::SeqCst));
    let auth_events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AuthFailure).await;
    assert!(auth_events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::AuthFailure
            && event.detail.contains("code=access_denied")
            && event.detail.contains("client_class=terminal")
    }));
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events
        .iter()
        .any(|event| event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "study_set_access_denied"));
}

#[tokio::test]
async fn websocket_records_study_context_store_errors_without_access_denied_auth_evidence() {
    let opened = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn StudyMemoryStore> =
        Arc::new(FailingStudyStore::new(FailingStudyStoreMode::StudyContext));
    let state = AppState::with_study_store(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: None,
        }),
        "synthetic",
        VoiceWsAccess::default(),
        1,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();

    assert_ready_provider(&mut socket, "open_probe").await;
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "study store unavailable"
    ));
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "study_store_unavailable"
    }));
    assert!(!evidence
        .snapshot()
        .iter()
        .any(|event| event.kind == VoiceEvidenceEventKind::AuthFailure));
    assert!(!opened.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_brain_open_auth_failure_emits_terminal_phase_without_raw_error() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(OpenAuthFailureBrain),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let _ = read_server_frame(&mut socket).await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::ProviderAuthFailed,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "provider_auth_failed"
    }));
}

#[tokio::test]
async fn websocket_brain_open_failure_with_missing_session_close_keeps_provider_terminal_reason() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::SessionCloseMissing,
    });
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(OpenAuthFailureBrain),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::ProviderAuthFailed,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "provider_auth_failed"
    }));
    assert!(events.iter().all(|event| {
        event.kind != VoiceEvidenceEventKind::TerminalReason
            || event.detail != "durability_degraded"
    }));
}

/// CHARACTERIZATION OF AN OPEN DEFECT — `ADAPTER-06`, owned by Plan 07.
///
/// This test pins what the service *does*, not what an operator *should* see. A
/// durable store read failure at session open is reported to operators as
/// `tool_executor_failure`, which is the wrong label for a durability incident.
/// The service is not where that is wrong: it reports the typed reason the brain
/// handed it, and it must keep doing so — see the misclassification controls
/// named below. The signal is lost one layer down, in
/// `agent-adapters/src/cartesia_gemini`, where `select_session_question` maps
/// *any* executor error to `outcome_contract_failure("select_next_question_failed")`
/// and discards `PortErrorKind::Durability`. Recovering it there is Plan 07's
/// `ADAPTER-06` row and is outside this lane's file ownership; this lane routed
/// it to the coordinator rather than reclassifying at the socket, because a
/// service-side guess at the failure's real class is exactly the defect
/// `DOMAIN-009` closes.
///
/// When `ADAPTER-06` lands, this test flips back to
/// `TerminalSessionReason::DurabilityDegraded` and regains its old name.
/// Controls that must stay green either way:
/// `websocket_protocol_wrapped_open_store_failure_emits_durability_degraded_terminal_phase`
/// (a brain that *does* report durability degradation reaches the wire as
/// `durability_degraded`) and
/// `websocket_untyped_provider_error_cannot_be_classified_from_its_message`.
#[tokio::test]
async fn websocket_brain_open_store_failure_reports_the_brains_typed_terminal_reason() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::ActiveQuestion,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(brain_store)),
        "synthetic",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    // `DOMAIN-009` / `SERVICE-006`: the service reports the typed terminal reason
    // the brain handed it and derives nothing from the store's prose. The
    // synthetic adapter classifies a failed durable progression read as a
    // tool-executor failure at its own tool stage, so that is what the socket
    // truthfully reports. Recovering the durability signal across that adapter
    // boundary is Plan 07's `ADAPTER-06` row, not a service-side
    // reclassification; the protocol-wrapped test below is the companion proof
    // that a brain which *does* report durability degradation reaches the wire as
    // `durability_degraded`.
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::ToolExecutorFailure,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "tool_executor_failure"
    }));
    assert!(events
        .iter()
        .all(|event| !event.detail.contains("durable store read failed")));
}

#[tokio::test]
async fn websocket_protocol_wrapped_open_store_failure_emits_durability_degraded_terminal_phase() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::NoFailure,
    });
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(OpenProtocolStoreFailureBrain),
        "open_protocol_store_failure",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "open_protocol_store_failure");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::DurabilityDegraded,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
}

/// `DOMAIN-009`: the terminal reason comes from the typed failure the provider
/// error carries. The diagnostic `message` beside it is never parsed and never
/// reaches the wire, however suggestive its prose is.
#[tokio::test]
async fn websocket_provider_error_event_emits_terminal_phase_without_raw_message() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let mut provider_error =
        BrainProviderError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::ProviderAuthFailure,
            stage: BrainFailureStage::ProviderAuth,
            retry_eligible: false,
            latency_ms: 0,
            provider: "cartesia_gemini".to_owned(),
            model: String::new(),
            metadata: "error_kind=missing_api_key".to_owned(),
        }));
    provider_error.message =
        "raw answer transcript with CARTESIA_API_KEY must not surface".to_owned();
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: None,
            events: vec![BrainEvent::Error(provider_error)],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        store,
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "event_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let terminal = read_server_frame(&mut socket).await;
    assert!(
        !serde_json::to_string(&terminal)
            .unwrap()
            .contains("CARTESIA_API_KEY"),
        "the provider diagnostic must never reach the wire"
    );
    assert_terminal_session_phase(terminal, TerminalSessionReason::ProviderAuthFailed);
    assert_close_code(&mut socket, CloseCode::Error).await;
}

/// `DOMAIN-009` misclassification control: a provider error that arrives without
/// its typed failure is an invariant breach, not an invitation to read its
/// prose. Its message names an auth failure and a durable-store failure at once;
/// the service refuses to derive either and reports the explicit rollback.
#[tokio::test]
async fn websocket_untyped_provider_error_cannot_be_classified_from_its_message() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: None,
            events: vec![BrainEvent::Error(BrainProviderError {
                source: "cartesia_gemini".to_owned(),
                message: "CARTESIA_API_KEY rejected; postgres adapter error: durable store write failed; rate limit"
                    .to_owned(),
                failure: None,
            })],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "event_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let terminal = read_server_frame(&mut socket).await;
    let rendered = serde_json::to_string(&terminal).unwrap();
    assert!(!rendered.contains("CARTESIA_API_KEY"), "{rendered}");
    assert!(!rendered.contains("postgres"), "{rendered}");
    assert_terminal_session_phase(terminal, TerminalSessionReason::Rollback);
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "rollback"
    }));
    assert!(events.iter().all(|event| {
        !event.detail.contains("CARTESIA_API_KEY") && !event.detail.contains("postgres")
    }));
}

#[tokio::test]
async fn websocket_runtime_store_error_event_emits_durability_degraded_terminal_phase() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::NoFailure,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: Some(brain_store),
            // `DOMAIN-009`: the durability classification is read from the typed
            // failure, never from the adapter prose beside it.
            events: vec![BrainEvent::Error(BrainProviderError::from_failure(
                BrainProviderFailure::new(BrainProviderFailureParts {
                    failure_class: BrainFailureClass::DurabilityDegraded,
                    stage: BrainFailureStage::Store,
                    retry_eligible: false,
                    latency_ms: 0,
                    provider: "synthetic-memory".to_owned(),
                    model: String::new(),
                    metadata: "error_kind=store_write_failed".to_owned(),
                }),
            ))],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "event_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let frames = read_server_frames_until_terminal_reason(
        &mut socket,
        TerminalSessionReason::DurabilityDegraded,
    )
    .await;

    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::DurabilityDegraded)
    }));
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
}

#[tokio::test]
async fn websocket_durable_store_failure_mid_turn_emits_durability_degraded_terminal_phase() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::QuestionAuthorizationWriteFailure,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: Some(brain_store),
            events: vec![
                BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                },
                BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: agent_domain::fixture_question(),
                },
            ],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "event_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let frames = read_server_frames_until_terminal_reason(
        &mut socket,
        TerminalSessionReason::DurabilityDegraded,
    )
    .await;

    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::DurabilityDegraded)
    }));
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
}

#[tokio::test]
async fn websocket_durable_semantic_authority_miss_remains_provider_source_rejected() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::QuestionAuthorizationSemanticMiss,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: Some(brain_store),
            events: vec![BrainEvent::QuestionStarted {
                response_id: "response-1".to_owned(),
                question: agent_domain::fixture_question(),
            }],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let frames = read_server_frames_until_close(&mut socket).await;

    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Error { error, .. } if error.message == "provider source authority rejected"
    )));
    assert!(frames.iter().all(|frame| {
        terminal_session_reason(frame) != Some(TerminalSessionReason::DurabilityDegraded)
    }));
}

#[tokio::test]
async fn websocket_durable_terminal_close_failure_emits_durability_degraded_terminal_phase() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::SessionClose,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(IdleProbeBrain {
            study_store: Some(brain_store),
        }),
        "idle_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let drain = state.drain_signal.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "idle_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event {
            event,
            ..
        } if matches!(event.as_ref(), VivaServerEvent::SessionPhase { .. })
    ));

    drain.begin_drain();
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::DurabilityDegraded,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
    assert!(events.iter().all(|event| {
        event.kind != VoiceEvidenceEventKind::TerminalReason || event.detail != "client_disconnect"
    }));
}

#[tokio::test]
async fn websocket_client_stop_close_failure_emits_durability_degraded_terminal_phase() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::SessionClose,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(IdleProbeBrain {
            study_store: Some(brain_store),
        }),
        "idle_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "idle_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event {
            event,
            ..
        } if matches!(event.as_ref(), VivaServerEvent::SessionPhase { .. })
    ));
    // The frozen fixture's `stop` frame predates the v5 generation binding (`W-06`),
    // so the stop this test needs is built here rather than read from it.
    send_client_frame(
        &mut socket,
        &ClientFrame::Stop {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: VOICE_TEST_CLIENT_GENERATION.to_owned(),
        },
    )
    .await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::DurabilityDegraded,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
}

#[tokio::test]
async fn websocket_peer_close_failure_records_durability_degraded_terminal_reason() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::SessionClose,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(IdleProbeBrain {
            study_store: Some(brain_store),
        }),
        "idle_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "idle_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event {
            event,
            ..
        } if matches!(event.as_ref(), VivaServerEvent::SessionPhase { .. })
    ));
    socket.send(WsMessage::Close(None)).await.unwrap();

    let _ = read_server_frames_until_close(&mut socket).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
}

#[tokio::test]
async fn websocket_durable_store_write_failure_mid_turn_emits_durability_degraded_terminal_phase() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(DurableStoreDegradingStore {
        inner: inner.clone(),
        failure: DurableStoreFailureMode::UsageRecording,
    });
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: Some(brain_store),
            events: vec![BrainEvent::Usage(BrainUsage {
                text_output_tokens: 3,
                ..BrainUsage::default()
            })],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        state_store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "event_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let frames = read_server_frames_until_terminal_reason(
        &mut socket,
        TerminalSessionReason::DurabilityDegraded,
    )
    .await;

    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::DurabilityDegraded)
    }));
    assert_close_code(&mut socket, CloseCode::Error).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "durability_degraded"
    }));
}

#[tokio::test]
async fn websocket_rejects_browser_tool_result_as_untrusted() {
    let state = test_state(1);
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "tool_result",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "result": {
                    "proposal": {
                        "name": "evaluate_spoken_answer",
                        "arguments": {
                            "study_set_id": "biology-midterm",
                            "voice_session_id": "voice-session-1",
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": "forged"
                        }
                    },
                    "result": { "accepted": true }
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // `VOICE-AUTHORITY-001`: `tool_result` is not a member of the v5 browser-sendable
    // union, so the forged frame cannot parse into anything the server could act on.
    // The tool authority is unreachable from the wire rather than refused by a policy
    // branch a refactor could delete.
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "invalid client frame"
    ));
    assert_close_code(&mut socket, CloseCode::Protocol).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "invalid_client_frame"
    }));
}

#[tokio::test]
async fn websocket_drain_emits_terminal_phase_before_close() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = test_state_with_store(1, store.clone()).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let drain = state.drain_signal.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;

    drain.begin_drain();
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::Drained,
    );
    assert_close_code(&mut socket, CloseCode::Normal).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "drained"
    }));
    let snapshot = store.snapshot();
    assert_eq!(snapshot.sessions.len(), 1);
    let session = snapshot
        .sessions
        .first()
        .expect("drained session should be recorded");
    assert_eq!(session.status, "closed");
    assert_eq!(session.terminal_reason.as_deref(), Some("drained"));
    assert!(session.ended_at.is_some());
}

#[test]
fn voice_drain_signal_latches_without_receivers() {
    let drain = VoiceDrainSignal::default();

    drain.begin_drain();
    let mut receiver = drain.subscribe();

    assert!(drain.is_draining());
    assert!(*receiver.borrow_and_update());
}

#[tokio::test]
async fn websocket_preflight_rejects_new_sessions_after_drain_begins() {
    let state = test_state(1);
    state.drain_signal.begin_drain();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let error = connect_async(url)
        .await
        .expect_err("draining server should reject new websocket preflights");
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        other => panic!("expected HTTP 503 from draining preflight, got {other:?}"),
    }
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::PreflightRejected).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PreflightRejected && event.detail == "server draining"
    }));
}

/// The loopback peer every test socket actually connects from. Forwarding headers
/// name other addresses; none of them may ever key a lease.
const TEST_PEER_IP: &str = "127.0.0.1";

async fn wait_for_released_ip_lease(limits: &agent_service::VoiceLimitState, ip: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if limits.ip_lease_count(ip).is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "IP lease for {ip} was still held at {:?}",
        limits.ip_lease_count(ip)
    );
}

/// `SERVICE-003`: the per-IP cap keys off the socket peer. A direct client that
/// varies `X-Forwarded-For` gets one bucket, not one bucket per spoofed value.
#[tokio::test]
async fn ip_cap_holds_when_forwarded_headers_vary() {
    let state = test_state(8).with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        ..VoiceLimitConfig::default()
    });
    let limits = state.limit_state.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let mut sockets = Vec::new();
    for spoofed in ["198.51.100.1", "198.51.100.2"] {
        let mut request = url.as_str().into_client_request().unwrap();
        request.headers_mut().insert(
            "x-forwarded-for",
            HeaderValue::from_str(spoofed).expect("header value is valid"),
        );
        let (mut socket, _) = connect_async(request)
            .await
            .expect("the direct peer is under its cap");
        assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
        sockets.push(socket);
    }

    let mut over_cap = url.as_str().into_client_request().unwrap();
    over_cap
        .headers_mut()
        .insert("x-forwarded-for", HeaderValue::from_static("198.51.100.3"));
    let error = connect_async(over_cap)
        .await
        .expect_err("a forwarding header must not buy a third lease for one peer");
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        }
        other => panic!("expected HTTP 429 from the per-IP cap, got {other:?}"),
    }

    assert_eq!(limits.ip_lease_count(TEST_PEER_IP), Some(2));
    for spoofed in ["198.51.100.1", "198.51.100.2", "198.51.100.3", "unknown"] {
        assert_eq!(
            limits.ip_lease_count(spoofed),
            None,
            "a forwarding header must never key a per-IP lease"
        );
    }

    for mut socket in sockets {
        socket.close(None).await.unwrap();
        let _ = read_server_frames_until_close(&mut socket).await;
    }
    wait_for_released_ip_lease(&limits, TEST_PEER_IP).await;
}

/// Every server-owned exit releases the peer's lease and removes its entry.
#[tokio::test]
async fn ip_cap_releases_peer_lease_on_every_exit() {
    // 1. Ordinary disconnect.
    let state = test_state(4).with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        ..VoiceLimitConfig::default()
    });
    let limits = state.limit_state.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    assert_eq!(limits.ip_lease_count(TEST_PEER_IP), Some(1));
    socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut socket).await;
    wait_for_released_ip_lease(&limits, TEST_PEER_IP).await;

    // 2. Preflight rejection takes no lease at all.
    let capacity_state = test_state(1).with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(1),
        ..VoiceLimitConfig::default()
    });
    let capacity_limits = capacity_state.limit_state.clone();
    let Some(capacity_url) = spawn_server(capacity_state).await else {
        return;
    };
    let (mut held, _) = connect_async(capacity_url.as_str()).await.unwrap();
    assert_eq!(read_server_frame(&mut held).await, ServerFrame::ready());
    let rejected = connect_async(capacity_url.as_str())
        .await
        .expect_err("the peer is at its cap");
    assert!(matches!(
        rejected,
        tokio_tungstenite::tungstenite::Error::Http(_)
    ));
    assert_eq!(capacity_limits.ip_lease_count(TEST_PEER_IP), Some(1));
    held.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut held).await;
    wait_for_released_ip_lease(&capacity_limits, TEST_PEER_IP).await;

    // 3. A server-owned first-frame timeout.
    let timeout_state = test_state(4)
        .with_voice_limits(VoiceLimitConfig {
            max_ip_sessions: Some(2),
            ..VoiceLimitConfig::default()
        })
        .with_ws_timeouts(WsTimeouts {
            first_frame: Duration::from_millis(25),
            ..WsTimeouts::default()
        });
    let timeout_limits = timeout_state.limit_state.clone();
    let Some(timeout_url) = spawn_server(timeout_state).await else {
        return;
    };
    let (mut silent, _) = connect_async(timeout_url.as_str()).await.unwrap();
    assert_eq!(read_server_frame(&mut silent).await, ServerFrame::ready());
    let _ = read_server_frames_until_close(&mut silent).await;
    wait_for_released_ip_lease(&timeout_limits, TEST_PEER_IP).await;

    // 4. Drain.
    let drain_state = test_state(4).with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        ..VoiceLimitConfig::default()
    });
    let drain_limits = drain_state.limit_state.clone();
    let drain_signal = drain_state.drain_signal.clone();
    let Some(drain_url) = spawn_server(drain_state).await else {
        return;
    };
    let (mut draining, _) = connect_async(drain_url.as_str()).await.unwrap();
    assert_eq!(read_server_frame(&mut draining).await, ServerFrame::ready());
    assert_eq!(drain_limits.ip_lease_count(TEST_PEER_IP), Some(1));
    drain_signal.begin_drain();
    // The drained terminal phase is observed at the next client frame today; the
    // lease must be gone once the socket ends, whatever ends it.
    send_client_frame(&mut draining, &fixture_session_config_frame()).await;
    let _ = read_server_frames_until_close(&mut draining).await;
    wait_for_released_ip_lease(&drain_limits, TEST_PEER_IP).await;
}

#[tokio::test]
async fn websocket_preflight_enforces_ip_session_cap_and_releases_after_close() {
    let state = test_state(4).with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(1),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let mut first_request = url.as_str().into_client_request().unwrap();
    first_request
        .headers_mut()
        .insert("x-forwarded-for", HeaderValue::from_static("203.0.113.10"));
    let (mut first_socket, _) = connect_async(first_request).await.unwrap();
    assert_eq!(
        read_server_frame(&mut first_socket).await,
        ServerFrame::ready()
    );

    let mut second_request = url.as_str().into_client_request().unwrap();
    second_request
        .headers_mut()
        .insert("x-forwarded-for", HeaderValue::from_static("203.0.113.10"));
    let error = connect_async(second_request)
        .await
        .expect_err("same IP should be rejected while first socket holds the lease");
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        }
        other => panic!("expected HTTP 429 from IP capacity preflight, got {other:?}"),
    }
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::PreflightRejected).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::PreflightRejected
            && event.detail == "ip capacity exceeded"
    }));

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;

    let mut third_request = url.as_str().into_client_request().unwrap();
    third_request
        .headers_mut()
        .insert("x-forwarded-for", HeaderValue::from_static("203.0.113.10"));
    let (mut third_socket, _) = connect_async(third_request)
        .await
        .expect("IP lease should be released after the first socket closes");
    assert_eq!(
        read_server_frame(&mut third_socket).await,
        ServerFrame::ready()
    );
    third_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut third_socket).await;
}

#[tokio::test]
async fn websocket_drain_latches_before_socket_subscribes() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let drain = state.drain_signal.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    drain.begin_drain();
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::Drained,
    );
    assert_close_code(&mut socket, CloseCode::Normal).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "drained"
    }));
}

#[tokio::test]
async fn websocket_session_cap_emits_terminal_phase_before_close() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_millis(25),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "session_cap"
    }));
}

#[tokio::test]
async fn websocket_user_study_set_cap_stays_one_when_user_session_knob_is_above_one() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_user_sessions: Some(2),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut first_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut first_socket, "backpressured_input_probe").await;
    first_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "backpressured_input_probe").await;
    second_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut second_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut second_socket, CloseCode::Policy).await;

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;

    let (mut third_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut third_socket, "backpressured_input_probe").await;
    third_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .filter(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
            .count()
            >= 2
    })
    .await;
    third_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut third_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_user_study_set_rejection_releases_user_total_lease() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_user_sessions: Some(2),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let biology_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-biology-live-session",
    );
    let duplicate_biology_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-duplicate",
        unix_timestamp_now() + 60,
        "nonce-biology-duplicate-session",
    );
    let chemistry_token = signed_session_token(
        "session-secret",
        "user-1",
        "chemistry-final",
        "voice-session-2",
        unix_timestamp_now() + 60,
        "nonce-chemistry-after-duplicate-session",
    );
    let biology_session = session_config_json_with_token(&biology_token);
    let duplicate_biology_session = session_config_json_with_ids_and_token(
        "biology-midterm",
        "voice-session-duplicate",
        &duplicate_biology_token,
    );
    let chemistry_session = session_config_json_with_ids_and_token(
        "chemistry-final",
        "voice-session-2",
        &chemistry_token,
    );

    let (mut biology_socket, _) = connect_async(token_only_request(&url, &biology_token))
        .await
        .unwrap();
    assert_ready_provider(&mut biology_socket, "backpressured_input_probe").await;
    biology_socket
        .send(WsMessage::Text(biology_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let (mut duplicate_socket, _) =
        connect_async(token_only_request(&url, &duplicate_biology_token))
            .await
            .unwrap();
    assert_ready_provider(&mut duplicate_socket, "backpressured_input_probe").await;
    duplicate_socket
        .send(WsMessage::Text(duplicate_biology_session.into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut duplicate_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut duplicate_socket, CloseCode::Policy).await;

    let (mut chemistry_socket, _) = connect_async(token_only_request(&url, &chemistry_token))
        .await
        .unwrap();
    assert_ready_provider(&mut chemistry_socket, "backpressured_input_probe").await;
    chemistry_socket
        .send(WsMessage::Text(chemistry_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .filter(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
            .count()
            >= 2
    })
    .await;

    biology_socket.close(None).await.unwrap();
    chemistry_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut biology_socket).await;
    let _ = read_server_frames_until_close(&mut chemistry_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_user_study_set_cap_still_rejects_duplicate_when_user_total_limit_disabled() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_user_sessions: None,
        ..VoiceLimitConfig::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut first_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut first_socket, "backpressured_input_probe").await;
    first_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "backpressured_input_probe").await;
    second_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut second_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut second_socket, CloseCode::Policy).await;

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_default_study_set_cap_rejects_duplicate_tab_and_releases() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        4,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    let (mut first_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut first_socket, "backpressured_input_probe").await;
    first_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "backpressured_input_probe").await;
    second_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let duplicate_frame = tokio::time::timeout(
        Duration::from_secs(2),
        read_server_frame(&mut second_socket),
    )
    .await
    .expect("duplicate live tab must receive a terminal session_cap frame");
    assert_terminal_session_phase(duplicate_frame, TerminalSessionReason::SessionCap);
    assert_close_code(&mut second_socket, CloseCode::Policy).await;

    first_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut first_socket).await;

    let (mut third_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut third_socket, "backpressured_input_probe").await;
    third_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .filter(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
            .count()
            >= 2
    })
    .await;
    third_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut third_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_default_limits_allow_different_study_sets_but_reject_duplicate_tabs() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let biology_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-biology-default-limit-session",
    );
    let duplicate_biology_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-duplicate",
        unix_timestamp_now() + 60,
        "nonce-biology-default-limit-duplicate",
    );
    let chemistry_token = signed_session_token(
        "session-secret",
        "user-1",
        "chemistry-final",
        "voice-session-2",
        unix_timestamp_now() + 60,
        "nonce-chemistry-default-limit-session",
    );
    let biology_session = session_config_json_with_token(&biology_token);
    let duplicate_biology_session = session_config_json_with_ids_and_token(
        "biology-midterm",
        "voice-session-duplicate",
        &duplicate_biology_token,
    );
    let chemistry_session = session_config_json_with_ids_and_token(
        "chemistry-final",
        "voice-session-2",
        &chemistry_token,
    );

    let (mut biology_socket, _) = connect_async(token_only_request(&url, &biology_token))
        .await
        .unwrap();
    assert_ready_provider(&mut biology_socket, "backpressured_input_probe").await;
    biology_socket
        .send(WsMessage::Text(biology_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let (mut chemistry_socket, _) = connect_async(token_only_request(&url, &chemistry_token))
        .await
        .unwrap();
    assert_ready_provider(&mut chemistry_socket, "backpressured_input_probe").await;
    chemistry_socket
        .send(WsMessage::Text(chemistry_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .filter(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
            .count()
            >= 2
    })
    .await;

    let (mut duplicate_socket, _) =
        connect_async(token_only_request(&url, &duplicate_biology_token))
            .await
            .unwrap();
    assert_ready_provider(&mut duplicate_socket, "backpressured_input_probe").await;
    duplicate_socket
        .send(WsMessage::Text(duplicate_biology_session.into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut duplicate_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut duplicate_socket, CloseCode::Policy).await;

    biology_socket.close(None).await.unwrap();
    chemistry_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut biology_socket).await;
    let _ = read_server_frames_until_close(&mut chemistry_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_user_session_cap_allows_different_study_sets_until_user_total_limit() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "physics-quiz".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Physics Quiz".to_owned(),
        course: Some("Physics 101".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_user_sessions: Some(2),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let biology_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-biology-live-session",
    );
    let chemistry_token = signed_session_token(
        "session-secret",
        "user-1",
        "chemistry-final",
        "voice-session-2",
        unix_timestamp_now() + 60,
        "nonce-chemistry-live-session",
    );
    let physics_token = signed_session_token(
        "session-secret",
        "user-1",
        "physics-quiz",
        "voice-session-3",
        unix_timestamp_now() + 60,
        "nonce-physics-live-session",
    );
    let biology_session = session_config_json_with_token(&biology_token);
    let chemistry_session = session_config_json_with_ids_and_token(
        "chemistry-final",
        "voice-session-2",
        &chemistry_token,
    );
    let physics_session =
        session_config_json_with_ids_and_token("physics-quiz", "voice-session-3", &physics_token);

    let (mut biology_socket, _) = connect_async(token_only_request(&url, &biology_token))
        .await
        .unwrap();
    assert_ready_provider(&mut biology_socket, "backpressured_input_probe").await;
    biology_socket
        .send(WsMessage::Text(biology_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let (mut chemistry_socket, _) = connect_async(token_only_request(&url, &chemistry_token))
        .await
        .unwrap();
    assert_ready_provider(&mut chemistry_socket, "backpressured_input_probe").await;
    chemistry_socket
        .send(WsMessage::Text(chemistry_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .filter(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
            .count()
            >= 2
    })
    .await;

    let (mut physics_socket, _) = connect_async(token_only_request(&url, &physics_token))
        .await
        .unwrap();
    assert_ready_provider(&mut physics_socket, "backpressured_input_probe").await;
    physics_socket
        .send(WsMessage::Text(physics_session.into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut physics_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut physics_socket, CloseCode::Policy).await;

    biology_socket.close(None).await.unwrap();
    chemistry_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut biology_socket).await;
    let _ = read_server_frames_until_close(&mut chemistry_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_user_session_cap_rejects_different_study_set_above_user_total_limit() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "chemistry-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Chemistry Final".to_owned(),
        course: Some("Chemistry 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_user_sessions: Some(1),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let biology_token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-biology-user-total-live-session",
    );
    let chemistry_token = signed_session_token(
        "session-secret",
        "user-1",
        "chemistry-final",
        "voice-session-2",
        unix_timestamp_now() + 60,
        "nonce-chemistry-user-total-live-session",
    );
    let biology_session = session_config_json_with_token(&biology_token);
    let chemistry_session = session_config_json_with_ids_and_token(
        "chemistry-final",
        "voice-session-2",
        &chemistry_token,
    );

    let (mut biology_socket, _) = connect_async(token_only_request(&url, &biology_token))
        .await
        .unwrap();
    assert_ready_provider(&mut biology_socket, "backpressured_input_probe").await;
    biology_socket
        .send(WsMessage::Text(biology_session.into()))
        .await
        .unwrap();
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::SessionOpened)
    })
    .await;

    let (mut chemistry_socket, _) = connect_async(token_only_request(&url, &chemistry_token))
        .await
        .unwrap();
    assert_ready_provider(&mut chemistry_socket, "backpressured_input_probe").await;
    chemistry_socket
        .send(WsMessage::Text(chemistry_session.into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut chemistry_socket).await,
        TerminalSessionReason::SessionCap,
    );
    assert_close_code(&mut chemistry_socket, CloseCode::Policy).await;

    biology_socket.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut biology_socket).await;
    wait_until(Duration::from_secs(2), || dropped.load(Ordering::SeqCst)).await;
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn websocket_audio_byte_cap_emits_rate_limit_terminal_phase() {
    let dropped = Arc::new(AtomicBool::new(false));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_audio_bytes_per_minute: Some(3),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "backpressured_input_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-7", &[1_u8, 2, 3, 4]).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::RateLimit,
    );
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "rate_limit"
    }));
}

#[tokio::test]
async fn websocket_cost_budget_emits_cost_budget_terminal_phase() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: Some(brain_store),
            events: vec![BrainEvent::Usage(BrainUsage {
                text_output_tokens: 1,
                ..BrainUsage::default()
            })],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_session_cost_usd: Some(0.000_001),
        ..VoiceLimitConfig::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "event_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::CostBudget,
    );
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "cost_budget"
    }));
}

#[tokio::test]
async fn websocket_turn_cap_emits_terminal_phase_before_close() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    // v5 has no binary client surface: an answer-bearing frame is one bounded
    // audio turn.
    send_v5_audio_turn(&mut socket, "turn-cap-arm", &[1_u8, 2]).await;
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::TurnCap,
    );
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "turn_cap"
    }));
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::StoreCounts
            && event.detail
                == "sessions=1 answer_attempts=0 concept_statuses=0 review_items=0 recaps=0"
    }));
}

#[tokio::test]
async fn websocket_records_configured_turn_cap_evidence() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    wait_until(Duration::from_secs(2), || {
        evidence.snapshot().iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::ConfigAccepted
                && event.detail == "turn_cap_ms=25 source=explicit_override contract_max_ms=45000"
        })
    })
    .await;
    socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_turn_cap_waits_for_answer_frame() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(200),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let pre_answer_turn_cap = tokio::time::timeout(Duration::from_millis(60), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!("unexpected close before answer frame: {other:?}"),
            }
        }
    })
    .await;
    assert!(
        pre_answer_turn_cap.is_err(),
        "turn cap fired before an answer-bearing frame"
    );

    // v5 has no binary client surface: an answer-bearing frame is one bounded
    // audio turn.
    send_v5_audio_turn(&mut socket, "turn-cap-arm", &[1_u8, 2]).await;
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::TurnCap,
    );
}

#[tokio::test]
async fn websocket_post_config_idle_timeout_closes_without_answer_frame() {
    // `SERVICE-001`: a socket that never submits an answer is a sleeping client,
    // so the deadline that ends it is the between-turn one, not the in-turn
    // progress deadline.
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        between_turn_idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!("expected pre-answer idle timeout, got {other:?}"),
            }
        }
    })
    .await
    .expect("post-config idle socket remained open without an answer frame");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
}

#[tokio::test]
async fn websocket_turn_cap_disarms_after_answer_resolution() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let completion_gate = Arc::new(Notify::new());
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(GatedCompletionProviderProbeBrain {
            text_inputs: text_inputs.clone(),
            study_store: store.clone(),
            completion_gate: completion_gate.clone(),
        }),
        "gated_completion_provider_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(250),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "gated_completion_provider_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "turn-cap-resolution".to_owned(),
            turn_id: "v5-turn-19".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "resolved answer".to_owned(),
            },
        },
    )
    .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if matches!(
                &frame,
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        VivaServerEvent::AnswerEvaluated { .. }
                    )
            ) {
                break;
            }
        }
    })
    .await
    .expect("answer evaluation should arrive before the turn cap");
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    let post_resolution_turn_cap = tokio::time::timeout(Duration::from_millis(60), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!("unexpected close after answer resolution: {other:?}"),
            }
        }
    })
    .await;
    assert!(
        post_resolution_turn_cap.is_err(),
        "turn cap fired after the submitted answer resolved"
    );
    completion_gate.notify_waiters();
    socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_provider_slot_releases_on_answer_evaluated() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let completion_gate = Arc::new(Notify::new());
    let store = provider_limiter_test_store();
    let state = AppState::with_study_store(
        Arc::new(GatedCompletionProviderProbeBrain {
            text_inputs: text_inputs.clone(),
            study_store: store.clone(),
            completion_gate: completion_gate.clone(),
        }),
        "gated_completion_provider_probe",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        4,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let first_socket_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-1",
        "nonce-provider-slot-biology",
    );
    let (mut first_socket, _) = connect_async(token_only_request(&url, &first_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut first_socket, "gated_completion_provider_probe").await;
    first_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "biology-midterm",
                "voice-session-1",
                &first_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut first_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-answer-evaluated-held-1".to_owned(),
            turn_id: "v5-turn-20".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "first provider turn".to_owned(),
            },
        },
    )
    .await;

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut first_socket).await;
            if matches!(
                &frame,
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        VivaServerEvent::AnswerEvaluated { .. }
                    )
            ) {
                break;
            }
        }
    })
    .await
    .expect("first answer evaluation should arrive");
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    let second_socket_token = provider_limiter_token(
        "chemistry-final",
        "voice-session-2",
        "nonce-provider-slot-chemistry",
    );
    let (mut second_socket, _) = connect_async(token_only_request(&url, &second_socket_token))
        .await
        .unwrap();
    assert_ready_provider(&mut second_socket, "gated_completion_provider_probe").await;
    second_socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(
                "chemistry-final",
                "voice-session-2",
                &second_socket_token,
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-answer-evaluated-held-2".to_owned(),
            turn_id: "v5-turn-21".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "second provider turn".to_owned(),
            },
        },
    )
    .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if text_inputs.load(Ordering::SeqCst) == 2 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("normal AnswerEvaluated completion should release the provider slot");

    completion_gate.notify_waiters();
    first_socket.close(None).await.unwrap();
    second_socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_provider_slot_prefers_queued_completion_before_same_socket_overlap() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(AnswerEvaluatedProviderProbeBrain {
            text_inputs: text_inputs.clone(),
            study_store: store.clone(),
            usage_after_evaluation: None,
        }),
        "answer_evaluated_provider_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(0),
        ..VoiceLimitConfig::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "answer_evaluated_provider_probe").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queued-completion-release-1".to_owned(),
            turn_id: "v5-turn-22".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "first provider turn".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(10)).await;

    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queued-completion-release-2".to_owned(),
            turn_id: "v5-turn-23".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "second provider turn".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 2
    })
    .await;

    socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_provider_drains_queued_usage_before_next_admission() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let usage_gate = Arc::new(Notify::new());
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(AnswerEvaluatedProviderProbeBrain {
            text_inputs: text_inputs.clone(),
            study_store: store.clone(),
            usage_after_evaluation: Some((
                BrainUsage {
                    text_output_tokens: 1,
                    ..BrainUsage::default()
                },
                usage_gate.clone(),
            )),
        }),
        "answer_evaluated_provider_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(0),
        max_session_cost_usd: Some(0.000_001),
        ..VoiceLimitConfig::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "answer_evaluated_provider_probe").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queued-usage-release-1".to_owned(),
            turn_id: "v5-turn-24".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "first provider turn".to_owned(),
            },
        },
    )
    .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if matches!(
                &frame,
                ServerFrame::Event { event, .. }
                    if matches!(event.as_ref(), VivaServerEvent::AnswerEvaluated { .. })
            ) {
                break;
            }
        }
    })
    .await
    .expect("first answer evaluation should arrive");
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    usage_gate.notify_waiters();
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac519-queued-usage-release-2".to_owned(),
            turn_id: "v5-turn-25".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "second provider turn".to_owned(),
            },
        },
    )
    .await;
    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::CostBudget) {
                return frame;
            }
        }
    })
    .await
    .expect("queued usage should close the session before admitting another provider turn");
    assert_terminal_session_phase(terminal, TerminalSessionReason::CostBudget);
    assert_close_code(&mut socket, CloseCode::Policy).await;
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn websocket_audio_continuation_requires_second_lease_when_limiter_enabled() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let audio_inputs = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let state = AppState::new(
        Arc::new(QueuedAudioProviderProbeBrain {
            text_inputs,
            audio_inputs: audio_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        1,
    )
    // The subject here is the provider lease, not a deadline: the in-turn
    // progress deadline stays well clear of the first turn's admission so the
    // second audio turn is denied for the overlap it is, rather than racing the
    // turn cap.
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(4),
        session: Duration::from_secs(8),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-8", &[1_u8, 2]).await;
    wait_until(Duration::from_secs(2), || {
        audio_inputs.lock().unwrap().len() == 1
    })
    .await;
    send_v5_audio_turn(&mut socket, "audio-turn-9", &[3_u8, 4]).await;

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                return frame;
            }
        }
    })
    .await
    .expect("audio continuation without another provider lease should be denied");
    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    assert_close_code(&mut socket, CloseCode::Policy).await;
    assert_eq!(*audio_inputs.lock().unwrap(), vec![vec![1_u8, 2]]);
}

#[tokio::test]
async fn websocket_audio_continuations_keep_turn_cap_when_limiter_disabled() {
    websocket_audio_continuations_keep_turn_cap_with_limits(VoiceLimitConfig {
        provider_limiter_enabled: false,
        ..VoiceLimitConfig::default()
    })
    .await;
}

async fn websocket_audio_continuations_keep_turn_cap_with_limits(voice_limits: VoiceLimitConfig) {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let audio_inputs = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let state = AppState::new(
        Arc::new(QueuedAudioProviderProbeBrain {
            text_inputs,
            audio_inputs: audio_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        1,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(250),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    })
    .with_voice_limits(voice_limits);
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-10", &[1_u8, 2]).await;
    wait_until(Duration::from_secs(2), || {
        audio_inputs.lock().unwrap().len() == 1
    })
    .await;
    send_v5_audio_turn(&mut socket, "audio-turn-11", &[3_u8, 4]).await;
    wait_until(Duration::from_secs(2), || {
        audio_inputs.lock().unwrap().len() == 2
    })
    .await;

    let terminal = tokio::time::timeout(Duration::from_millis(350), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!("unexpected close after audio continuation completion: {other:?}"),
            }
        }
    })
    .await
    .expect("accepted extra audio frames should keep the submitted-turn cap armed");
    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
    assert_close_code(&mut socket, CloseCode::Policy).await;
}

#[tokio::test]
async fn websocket_turn_cap_stays_armed_for_newer_submission_after_one_resolution() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(FirstAnswerOnlyProbeBrain {
            text_inputs: text_inputs.clone(),
            study_store: store.clone(),
        }),
        "first_answer_only_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(250),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    })
    .with_voice_limits(VoiceLimitConfig {
        provider_limiter_enabled: false,
        ..VoiceLimitConfig::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "first_answer_only_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "turn-cap-newer-submission-1".to_owned(),
            turn_id: "v5-turn-26".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "first pending answer".to_owned(),
            },
        },
    )
    .await;
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "turn-cap-newer-submission-2".to_owned(),
            turn_id: "v5-turn-27".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "second pending answer".to_owned(),
            },
        },
    )
    .await;

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if matches!(
                &frame,
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        VivaServerEvent::AnswerEvaluated { .. }
                    )
            ) {
                break;
            }
        }
    })
    .await
    .expect("first answer resolution should arrive before the turn cap");
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 2
    })
    .await;

    let terminal = tokio::time::timeout(Duration::from_millis(350), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!(
                    "expected terminal turn cap for unresolved newer submission, got {other:?}"
                ),
            }
        }
    })
    .await
    .expect("first answer resolution cleared the newer pending submission cap");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
}

#[tokio::test]
async fn websocket_turn_cap_dedupes_duplicate_response_resolution_ids() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(DuplicateResolutionProbeBrain),
        "duplicate_resolution_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    })
    .with_voice_limits(VoiceLimitConfig {
        provider_limiter_enabled: false,
        ..VoiceLimitConfig::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "duplicate_resolution_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "turn-cap-duplicate-resolution-1".to_owned(),
            turn_id: "v5-turn-28".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "first duplicate-resolution answer".to_owned(),
            },
        },
    )
    .await;
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "turn-cap-duplicate-resolution-2".to_owned(),
            turn_id: "v5-turn-29".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "second duplicate-resolution answer".to_owned(),
            },
        },
    )
    .await;

    let terminal = tokio::time::timeout(Duration::from_millis(100), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!("expected turn cap for unresolved second answer, got {other:?}"),
            }
        }
    })
    .await
    .expect("duplicate response resolution IDs cleared multiple pending answers");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
}

#[tokio::test]
async fn websocket_turn_cap_ignores_response_less_phase_after_new_submission() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(ResponseThenPhaseProbeBrain),
        "response_then_phase_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "response_then_phase_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-12", &[1_u8, 2]).await;

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if matches!(
                &frame,
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        VivaServerEvent::SessionPhase {
                            phase: agent_domain::StudySessionPhase::Feedback,
                            terminal_reason: None,
                        }
                    )
            ) {
                break;
            }
        }
    })
    .await
    .expect("first answer resolution should arrive before the second submission");

    send_v5_audio_turn(&mut socket, "audio-turn-13", &[3_u8, 4]).await;

    let terminal = tokio::time::timeout(Duration::from_millis(100), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => {
                    panic!("expected terminal turn cap after response-less phase, got {other:?}")
                }
            }
        }
    })
    .await
    .expect("response-less feedback phase cleared the newer pending submission cap");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
}

#[tokio::test]
async fn websocket_turn_cap_ignores_suppressed_stale_resolution_after_new_submission() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(CancelledThenStaleResolutionProbeBrain),
        "cancelled_then_stale_resolution_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "cancelled_then_stale_resolution_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-14", &[1_u8, 2]).await;

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if matches!(
                &frame,
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        VivaServerEvent::Cancellation {
                            response_id: Some(response_id),
                        } if response_id == "response-a"
                    )
            ) {
                break;
            }
        }
    })
    .await
    .expect("first answer cancellation should arrive before the second submission");

    send_v5_audio_turn(&mut socket, "audio-turn-15", &[3_u8, 4]).await;

    let terminal = tokio::time::timeout(Duration::from_millis(100), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => {
                    panic!("expected terminal turn cap after stale suppressed event, got {other:?}")
                }
            }
        }
    })
    .await
    .expect("suppressed stale completion cleared the newer pending submission cap");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
}

#[tokio::test]
async fn websocket_turn_cap_is_not_postponed_by_provider_events() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(ChattyPhaseProbeBrain),
        "chatty_phase_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "chatty_phase_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    // v5 has no binary client surface: an answer-bearing frame is one bounded
    // audio turn.
    send_v5_audio_turn(&mut socket, "turn-cap-arm", &[1_u8, 2]).await;

    let mut saw_provider_phase = false;
    for _ in 0..50 {
        let frame = read_server_frame(&mut socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
            assert!(
                saw_provider_phase,
                "test should prove provider events were flowing before the cap fired"
            );
            assert_close_code(&mut socket, CloseCode::Policy).await;
            let events =
                wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
            assert!(events.iter().any(|event| {
                event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "turn_cap"
            }));
            return;
        }
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase {
                        terminal_reason: None,
                        ..
                    }
                )
        ) {
            saw_provider_phase = true;
        }
    }

    panic!("provider events postponed the terminal turn_cap phase");
}

#[tokio::test]
async fn websocket_extra_audio_frame_without_second_lease_closes_slow_client() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-16", &[1_u8, 2]).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    send_v5_audio_turn(&mut socket, "audio-turn-17", &[3_u8, 4]).await;

    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => {
                    panic!("expected slow-client terminal for extra audio frame, got {other:?}")
                }
            }
        }
    })
    .await
    .expect("extra audio frame without a second provider lease did not close");

    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    assert_close_code(&mut socket, CloseCode::Policy).await;
}

#[tokio::test]
async fn websocket_turn_cap_includes_backpressured_answer_send() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BackpressuredInputBrain {
            dropped: Arc::new(AtomicBool::new(false)),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "backpressured_input_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-18", &[1_u8, 2]).await;

    assert_terminal_session_phase(
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = read_server_frame(&mut socket).await;
                if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                    return frame;
                }
            }
        })
        .await
        .expect("back-pressured answer send escaped the submitted-answer cap"),
        TerminalSessionReason::TurnCap,
    );
}

#[tokio::test]
async fn websocket_turn_cap_aborts_provider_before_stop_can_write_late_answer() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let stop_write_attempted = Arc::new(AtomicBool::new(false));
    let state = AppState::with_study_store(
        Arc::new(StopWritesAnswerProbeBrain {
            study_store: brain_store,
            stop_write_attempted: stop_write_attempted.clone(),
        }),
        "stop_writes_answer_probe",
        VoiceWsAccess::default(),
        1,
        store.clone(),
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "stop_writes_answer_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-19", &[1_u8, 2, 3, 4]).await;

    assert_terminal_session_phase(
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = read_server_frame(&mut socket).await;
                if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                    return frame;
                }
            }
        })
        .await
        .expect("watchdog did not emit turn_cap"),
        TerminalSessionReason::TurnCap,
    );
    assert_close_code(&mut socket, CloseCode::Policy).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(
        !stop_write_attempted.load(Ordering::SeqCst),
        "watchdog sent Stop to a provider task that then attempted a late durable answer write"
    );
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 0);
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::StoreCounts).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::StoreCounts
            && event.detail
                == "sessions=1 answer_attempts=0 concept_statuses=0 review_items=0 recaps=0"
    }));
}

#[tokio::test]
async fn websocket_turn_cap_is_not_postponed_by_client_keepalives() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    // v5 has no binary client surface: an answer-bearing frame is one bounded
    // audio turn.
    send_v5_audio_turn(&mut socket, "turn-cap-arm", &[1_u8, 2]).await;

    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(80) {
        let _ = socket.send(WsMessage::Ping(Vec::new().into())).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let terminal = tokio::time::timeout(Duration::from_millis(20), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                WsMessage::Text(text) => {
                    let frame = serde_json::from_str::<ServerFrame>(&text).unwrap();
                    if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                        return frame;
                    }
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
                other => panic!("expected terminal turn cap frame before close, got {other:?}"),
            }
        }
    })
    .await
    .expect("client keepalives postponed the terminal turn_cap phase");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
}

#[tokio::test]
async fn websocket_drain_interrupts_active_provider_response() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(ChattyPhaseProbeBrain),
        "chatty_phase_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let drain = state.drain_signal.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "chatty_phase_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let mut saw_provider_phase = false;
    for _ in 0..50 {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase {
                        terminal_reason: None,
                        ..
                    }
                )
        ) {
            saw_provider_phase = true;
            break;
        }
    }
    assert!(saw_provider_phase);

    drain.begin_drain();
    for _ in 0..50 {
        let frame = read_server_frame(&mut socket).await;
        if terminal_session_reason(&frame) == Some(TerminalSessionReason::Drained) {
            assert_close_code(&mut socket, CloseCode::Normal).await;
            let events =
                wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
            assert!(events.iter().any(|event| {
                event.kind == VoiceEvidenceEventKind::TerminalReason && event.detail == "drained"
            }));
            return;
        }
    }

    panic!("provider events postponed the terminal drained phase");
}

#[tokio::test]
async fn websocket_capacity_releases_after_session_close() {
    let state = test_state(1);
    let slots = state.session_slots.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.clone()).await.unwrap();

    assert_eq!(slots.available_permits(), 0);
    socket.close(None).await.unwrap();
    wait_until(Duration::from_secs(2), || slots.available_permits() == 1).await;
    assert_eq!(slots.available_permits(), 1);

    let (mut next_socket, _) = connect_async(url).await.unwrap();
    assert_eq!(
        read_server_frame(&mut next_socket).await,
        ServerFrame::ready()
    );
    next_socket.close(None).await.unwrap();
}

#[tokio::test]
async fn websocket_default_trusted_mode_rotates_internal_session_for_reconnect() {
    let state = test_state(1);
    let slots = state.session_slots.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    for _ in 0..2 {
        let (mut socket, _) = connect_async(url.clone()).await.unwrap();
        assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
        socket
            .send(WsMessage::Text(
                format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
            ))
            .await
            .unwrap();

        let mut saw_question = false;
        for _ in 0..3 {
            match read_server_frame(&mut socket).await {
                ServerFrame::Event { event, .. }
                    if matches!(
                        event.as_ref(),
                        agent_service::VivaServerEvent::QuestionStarted { .. }
                    ) =>
                {
                    saw_question = true;
                    break;
                }
                ServerFrame::Error { error, .. } => {
                    panic!("unexpected websocket error: {}", error.message)
                }
                _ => {}
            }
        }
        assert!(saw_question);
        socket.close(None).await.unwrap();
        wait_until(Duration::from_secs(2), || slots.available_permits() == 1).await;
    }
}

#[tokio::test]
async fn websocket_disconnect_aborts_provider_tasks_and_releases_capacity() {
    let dropped = Arc::new(AtomicBool::new(false));
    let state = AppState::new(
        Arc::new(AbortProbeBrain {
            dropped: dropped.clone(),
        }),
        "synthetic",
        VoiceWsAccess::default(),
        1,
    );
    let slots = state.session_slots.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "abort_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket.close(None).await.unwrap();

    wait_until(Duration::from_secs(2), || {
        dropped.load(Ordering::SeqCst) && slots.available_permits() == 1
    })
    .await;
}

#[tokio::test]
async fn websocket_drain_aborts_provider_tasks_and_releases_capacity() {
    let dropped = Arc::new(AtomicBool::new(false));
    let state = AppState::new(
        Arc::new(AbortProbeBrain {
            dropped: dropped.clone(),
        }),
        "synthetic",
        VoiceWsAccess::default(),
        1,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let drain = state.drain_signal.clone();
    let slots = state.session_slots.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "abort_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    drain.begin_drain();
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::Drained,
    );
    assert_close_code(&mut socket, CloseCode::Normal).await;
    wait_until(Duration::from_secs(2), || {
        dropped.load(Ordering::SeqCst) && slots.available_permits() == 1
    })
    .await;
}

#[tokio::test]
async fn websocket_drain_interrupts_backpressured_provider_input() {
    let dropped = Arc::new(AtomicBool::new(false));
    let state = AppState::new(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        1,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    })
    .with_voice_limits(VoiceLimitConfig {
        provider_limiter_enabled: false,
        ..VoiceLimitConfig::default()
    });
    let drain = state.drain_signal.clone();
    let slots = state.session_slots.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "backpressured_input_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-20", &[1_u8, 2, 3, 4]).await;
    wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AnswerReceived).await;
    send_v5_audio_turn(&mut socket, "audio-turn-21", &[5_u8, 6, 7, 8]).await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    drain.begin_drain();
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::Drained,
    );
    assert_close_code(&mut socket, CloseCode::Normal).await;
    wait_until(Duration::from_secs(2), || slots.available_permits() == 1).await;
}

#[tokio::test]
async fn websocket_disconnect_releases_backpressured_provider_input() {
    let dropped = Arc::new(AtomicBool::new(false));
    let state = AppState::new(
        Arc::new(BackpressuredInputBrain {
            dropped: dropped.clone(),
        }),
        "backpressured_input_probe",
        VoiceWsAccess::default(),
        1,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
        ..WsTimeouts::default()
    });
    let slots = state.session_slots.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "backpressured_input_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    send_v5_audio_turn(&mut socket, "audio-turn-22", &[1_u8, 2, 3, 4]).await;
    wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AnswerReceived).await;
    drop(socket);

    wait_until(Duration::from_secs(2), || slots.available_permits() == 1).await;
}

#[tokio::test]
async fn websocket_hydrates_active_concepts_from_server_context_before_brain_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let captured_config = Arc::new(Mutex::new(None));
    let state = AppState::new(
        Arc::new(OpenProbeBrain {
            opened: opened.clone(),
            captured_config: Some(captured_config.clone()),
        }),
        "open_probe",
        VoiceWsAccess::default(),
        1,
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let mut session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    session["active_concepts"] = serde_json::json!([
        "wrong-concept",
        "wrong-review-concept",
        "wrong-third-concept"
    ]);

    assert_ready_provider(&mut socket, "open_probe").await;
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    for _ in 0..20 {
        if opened.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(opened.load(Ordering::SeqCst));
    let opened_config = captured_config
        .lock()
        .expect("captured config lock poisoned")
        .clone()
        .expect("brain opened with config");
    assert_eq!(
        opened_config.active_concepts,
        vec![
            "oxidative-phosphorylation".to_owned(),
            "nadh".to_owned(),
            "atp-synthase".to_owned(),
            "cellular-respiration".to_owned(),
        ]
    );
}

#[tokio::test]
async fn websocket_suppresses_stale_events_after_cancelled_response() {
    let state = AppState::new(
        Arc::new(StaleEventProbeBrain),
        "synthetic",
        VoiceWsAccess::default(),
        1,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "stale_event_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::Cancellation { response_id }
                if response_id.as_deref() == Some("stale-response"))
    )));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::AudioDelta { response_id, .. }
                if response_id == "stale-response")
    )));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::ConceptStatus { response_id, .. }
                if response_id == "stale-response")
    )));
    let events = evidence.snapshot();
    assert!(events.iter().all(|event| {
        !matches!(
            event.kind,
            VoiceEvidenceEventKind::EvaluationEmitted | VoiceEvidenceEventKind::SourceEmitted
        ) || event.detail != "stale-response"
    }));
}

#[tokio::test]
async fn websocket_global_cancellation_suppresses_active_response_events() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(GlobalCancellationProbeBrain {
            store: store.clone(),
        }),
        "synthetic",
        VoiceWsAccess::default(),
        1,
        store,
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "global_cancel_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::Cancellation { response_id }
                if response_id.is_none())
    )));
    assert!(frames
        .iter()
        .all(|frame| !matches!(frame, ServerFrame::Error { .. })));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::AnswerEvaluated { response_id, .. }
                if response_id == "response-1")
    )));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::SourceReference { response_id, .. }
                if response_id == "response-1")
    )));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::RecapReady { response_id, .. }
                if response_id == "response-1")
    )));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::AudioDelta { response_id, .. }
                if response_id == "response-1")
    )));
    let events = evidence.snapshot();
    assert!(events.iter().all(|event| {
        !matches!(
            event.kind,
            VoiceEvidenceEventKind::EvaluationEmitted | VoiceEvidenceEventKind::SourceEmitted
        ) || event.detail != "response-1"
    }));
}

#[tokio::test]
async fn websocket_rejects_forged_provider_source_tuples_without_leaks_or_writes() {
    let forged_excerpt = "provider forged source excerpt should not leak";
    let mut forged_source = agent_domain::fixture_source_reference();
    forged_source.document_id = "wrong-doc".to_owned();
    forged_source.span = "slide:99".to_owned();
    forged_source.excerpt = forged_excerpt.to_owned();
    let forged_question = agent_domain::StudyQuestion {
        source: forged_source.clone(),
        ..agent_domain::fixture_question()
    };
    let forged_evaluation = agent_domain::AnswerEvaluation {
        question_id: "wrong-question".to_owned(),
        answer_text: "forged answer".to_owned(),
        label: "mostly correct".to_owned(),
        concise_feedback: "forged feedback".to_owned(),
        retry_prompt: "forged retry".to_owned(),
        source: forged_source.clone(),
        concept_status: agent_domain::ConceptStatus::Strong,
        confidence_score: 0.84,
    };
    let fixture_question = agent_domain::fixture_question();
    let unpersisted_evaluation = agent_domain::AnswerEvaluation {
        question_id: fixture_question.question_id.clone(),
        answer_text: "unpersisted answer should not leak".to_owned(),
        label: "mostly correct".to_owned(),
        concise_feedback: "unpersisted feedback should not leak".to_owned(),
        retry_prompt: fixture_question.follow_up.clone(),
        source: fixture_question.source.clone(),
        concept_status: agent_domain::ConceptStatus::Strong,
        confidence_score: 0.84,
    };
    let unpersisted_recap = agent_domain::StudySessionRecap {
        schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
        deferred_turns: 0,
        voice_session_id: "voice-session-1".to_owned(),
        headline: "Unpersisted recap should not leak".to_owned(),
        summary: "Unpersisted recap summary should not leak".to_owned(),
        concepts: vec![agent_domain::RecapConceptOutcome {
            concept_id: "nadh".to_owned(),
            label: "nadh".to_owned(),
            status: agent_domain::ConceptStatus::Strong,
        }],
        review_schedule: vec![],
        next_action: "Stop".to_owned(),
        source_moments: vec![agent_domain::learning_recap::RecapSourceMoment {
            response_id: "response-recap".to_owned(),
            source_id: fixture_question.source.clone().source_id.clone(),
        }],
    };
    let cases = vec![
        (
            BrowserEventKind::QuestionStarted,
            BrainEvent::QuestionStarted {
                response_id: "forged-response".to_owned(),
                question: forged_question,
            },
        ),
        (
            BrowserEventKind::AnswerEvaluated,
            BrainEvent::AnswerEvaluated {
                response_id: "forged-response".to_owned(),
                evaluation: forged_evaluation,
            },
        ),
        (
            BrowserEventKind::SourceReference,
            BrainEvent::SourceReference {
                response_id: "forged-response".to_owned(),
                source: forged_source.clone(),
            },
        ),
        (
            BrowserEventKind::AnswerEvaluated,
            BrainEvent::AnswerEvaluated {
                response_id: "forged-response".to_owned(),
                evaluation: unpersisted_evaluation,
            },
        ),
        (
            BrowserEventKind::ConceptStatus,
            BrainEvent::ConceptStatus {
                response_id: "forged-response".to_owned(),
                concept_id: "wrong-concept".to_owned(),
                status: agent_domain::ConceptStatus::Strong,
            },
        ),
        (
            BrowserEventKind::ConceptStatus,
            BrainEvent::ConceptStatus {
                response_id: "forged-response".to_owned(),
                concept_id: "nadh".to_owned(),
                status: agent_domain::ConceptStatus::Review,
            },
        ),
        (
            BrowserEventKind::ManuscriptIntent,
            BrainEvent::ManuscriptIntent {
                response_id: "forged-response".to_owned(),
                intent: agent_domain::ManuscriptIntent::Entity {
                    entity_id: "wrong-concept".to_owned(),
                    entity_kind: agent_domain::ManuscriptEntityKind::Concept,
                    register: agent_domain::ManuscriptRegister::Correcting,
                    emphasis: agent_domain::ManuscriptEmphasis::Marked,
                },
            },
        ),
        (
            BrowserEventKind::ManuscriptIntent,
            BrainEvent::ManuscriptIntent {
                response_id: "forged-response".to_owned(),
                intent: agent_domain::ManuscriptIntent::Entity {
                    entity_id: "wrong-source".to_owned(),
                    entity_kind: agent_domain::ManuscriptEntityKind::Source,
                    register: agent_domain::ManuscriptRegister::Sourcing,
                    emphasis: agent_domain::ManuscriptEmphasis::Marked,
                },
            },
        ),
        (
            BrowserEventKind::ManuscriptIntent,
            BrainEvent::ManuscriptIntent {
                response_id: "forged-response".to_owned(),
                intent: agent_domain::ManuscriptIntent::Marginalia {
                    marginalia_id: "source-folio".to_owned(),
                    anchor_entity_id: "wrong-source".to_owned(),
                    register: agent_domain::ManuscriptRegister::Sourcing,
                    emphasis: agent_domain::ManuscriptEmphasis::Marked,
                },
            },
        ),
        (
            BrowserEventKind::RecapReady,
            BrainEvent::RecapReady {
                response_id: "forged-response".to_owned(),
                recap: agent_domain::StudySessionRecap {
                    schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA
                        .to_owned(),
                    deferred_turns: 0,
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Forged recap".to_owned(),
                    summary: "Forged recap".to_owned(),
                    concepts: vec![agent_domain::RecapConceptOutcome {
                        concept_id: "nadh".to_owned(),
                        label: "nadh".to_owned(),
                        status: agent_domain::ConceptStatus::Strong,
                    }],
                    review_schedule: vec![],
                    next_action: "Stop".to_owned(),
                    source_moments: vec![agent_domain::learning_recap::RecapSourceMoment {
                        response_id: "response-recap".to_owned(),
                        source_id: forged_source.source_id.clone(),
                    }],
                },
            },
        ),
        (
            BrowserEventKind::RecapReady,
            BrainEvent::RecapReady {
                response_id: "forged-response".to_owned(),
                recap: unpersisted_recap,
            },
        ),
    ];

    for (forbidden_kind, forged_event) in cases {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
        let state = AppState::with_study_store(
            Arc::new(EventProbeBrain {
                study_store: Some(brain_store),
                events: vec![
                    forged_event,
                    BrainEvent::Usage(BrainUsage {
                        text_input_tokens: 9,
                        text_output_tokens: 3,
                        ..BrainUsage::default()
                    }),
                ],
            }),
            "forged_event_probe",
            VoiceWsAccess::default(),
            1,
            store.clone(),
        );
        let evidence = state.evidence.clone();
        let usage = state.usage.clone();
        let Some(url) = spawn_server(state).await else {
            return;
        };
        let (mut socket, _) = connect_async(url).await.unwrap();
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

        assert_ready_provider(&mut socket, "event_probe").await;
        socket
            .send(WsMessage::Text(
                format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
            ))
            .await
            .unwrap();

        let frames = read_server_frames_until_close(&mut socket).await;
        let payload = serde_json::to_string(&frames).unwrap();
        assert!(frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Error { error, .. } if error.message == "provider source authority rejected"
        )));
        assert!(!payload.contains(forged_excerpt));
        assert!(!payload.contains("wrong-doc"));
        assert!(!payload.contains("wrong-question"));
        assert!(!payload.contains("wrong-concept"));
        assert!(!payload.contains("wrong-source"));
        assert!(!payload.contains("unpersisted"));
        assert!(frames.iter().all(|frame| !matches!(
            frame,
            ServerFrame::Event { event, .. } if forbidden_kind.matches(event.as_ref())
        )));
        let counts = store.write_counts();
        assert_eq!(counts.answer_attempts, 0);
        assert_eq!(counts.concept_statuses, 0);
        assert_eq!(counts.review_items, 0);
        assert_eq!(counts.recaps, 0);
        assert!(usage.snapshot().is_empty());
        assert!(evidence.snapshot().iter().all(|event| {
            !matches!(
                event.kind,
                VoiceEvidenceEventKind::QuestionEmitted
                    | VoiceEvidenceEventKind::EvaluationEmitted
                    | VoiceEvidenceEventKind::SourceEmitted
            )
        }));
    }
}

#[tokio::test]
async fn websocket_rejects_authorized_payload_replayed_under_wrong_response_id() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(ResponseReplayProbeBrain {
            study_store: brain_store,
        }),
        "response_replay_probe",
        VoiceWsAccess::default(),
        1,
        store.clone(),
    );
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "response_replay_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Error { error, .. } if error.message == "provider source authority rejected"
    )));
    assert!(frames.iter().all(|frame| !matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(event.as_ref(), agent_service::VivaServerEvent::AnswerEvaluated { .. })
    )));
    let counts = store.write_counts();
    assert_eq!(counts.answer_attempts, 1);
    assert!(evidence.snapshot().iter().all(|event| {
        event.kind != VoiceEvidenceEventKind::EvaluationEmitted || event.detail != "response-2"
    }));
}

const STREAMED_AUDIO_GENERATION: &str = "streamed-generation-1";
/// One production capture callback: 20 ms of mono `pcm_s16le` at 24 kHz.
const STREAMED_AUDIO_CHUNK_BYTES: usize = 960;
const STREAMED_AUDIO_CHUNKS_PER_SECOND: u32 = 50;
const STREAMED_AUDIO_MAX_CHUNK_BYTES: usize = 8_192;
const STREAMED_AUDIO_MAX_TURN_BYTES: usize = 2_160_000;
/// Every streamed chunk carries this byte, so `q6ur` is the base64 fingerprint a
/// sanitized protocol error must never echo back to the browser.
const STREAMED_AUDIO_PCM_BYTE: u8 = 0xAB;
const STREAMED_AUDIO_PCM_BASE64_PREFIX: &str = "q6ur";

fn streamed_audio_chunk_json(turn_id: &str, sequence: u32, pcm16: &[u8]) -> String {
    serde_json::json!({
        "type": "audio_chunk",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": STREAMED_AUDIO_GENERATION,
        "turn_id": turn_id,
        "sequence": sequence,
        "frame": { "pcm16_base64": STANDARD.encode(pcm16) },
    })
    .to_string()
}

fn streamed_audio_chunk_of(turn_id: &str, sequence: u32, bytes: usize) -> String {
    streamed_audio_chunk_json(turn_id, sequence, &vec![STREAMED_AUDIO_PCM_BYTE; bytes])
}

fn streamed_audio_end_json(turn_id: &str, final_sequence: u32) -> String {
    serde_json::json!({
        "type": "audio_end",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": STREAMED_AUDIO_GENERATION,
        "turn_id": turn_id,
        "final_sequence": final_sequence,
    })
    .to_string()
}

fn streamed_audio_cancel_json(turn_id: &str) -> String {
    serde_json::json!({
        "type": "cancel",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": STREAMED_AUDIO_GENERATION,
        "turn_id": turn_id,
    })
    .to_string()
}

async fn open_streamed_audio_session(state: AppState) -> Option<TestWebSocket> {
    let url = spawn_server(state).await?;
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();
    // session_phase ready, then the first question.
    for _ in 0..2 {
        read_server_frame(&mut socket).await;
    }
    Some(socket)
}

async fn send_streamed_audio_chunks(socket: &mut TestWebSocket, turn_id: &str, chunks: u32) {
    let pcm16 = vec![STREAMED_AUDIO_PCM_BYTE; STREAMED_AUDIO_CHUNK_BYTES];
    for sequence in 0..chunks {
        socket
            .send(WsMessage::Text(
                streamed_audio_chunk_json(turn_id, sequence, &pcm16).into(),
            ))
            .await
            .unwrap();
    }
}

async fn assert_no_server_frame(socket: &mut TestWebSocket, within: Duration) {
    assert!(
        tokio::time::timeout(within, socket.next()).await.is_err(),
        "the server must stay silent and open"
    );
}

async fn read_server_text(socket: &mut TestWebSocket) -> String {
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMessage::Text(text) => text.as_str().to_owned(),
        other => panic!("expected text server frame, got {other:?}"),
    }
}

async fn read_server_frames_until_session_phase(
    socket: &mut TestWebSocket,
    expected: agent_domain::StudySessionPhase,
) -> Vec<ServerFrame> {
    let mut frames = Vec::new();
    loop {
        let frame = read_server_frame(socket).await;
        let reached = matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase { phase, terminal_reason: None }
                        if *phase == expected
                )
        );
        frames.push(frame);
        if reached {
            return frames;
        }
    }
}

fn count_events(frames: &[ServerFrame], kind: BrowserEventKind) -> usize {
    frames
        .iter()
        .filter(|frame| match frame {
            ServerFrame::Event { event, .. } => kind.matches(event.as_ref()),
            _ => false,
        })
        .count()
}

async fn assert_streamed_audio_turn_admits_one_provider_turn(seconds: u32) {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let Some(mut socket) =
        open_streamed_audio_session(test_state_with_store(1, store.clone())).await
    else {
        return;
    };
    let turn_id = format!("turn-{seconds}s");
    let chunks = seconds * STREAMED_AUDIO_CHUNKS_PER_SECOND;
    let final_sequence = chunks - 1;

    send_streamed_audio_chunks(&mut socket, &turn_id, chunks).await;
    assert_no_server_frame(&mut socket, Duration::from_millis(200)).await;

    socket
        .send(WsMessage::Text(
            streamed_audio_end_json(&turn_id, final_sequence).into(),
        ))
        .await
        .unwrap();

    assert_eq!(
        read_server_frame_exact(&mut socket).await,
        ServerFrame::AudioTurnAccepted {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: STREAMED_AUDIO_GENERATION.to_owned(),
            turn_id: turn_id.clone(),
            final_sequence,
        }
    );

    let frames = read_server_frames_until_session_phase(
        &mut socket,
        agent_domain::StudySessionPhase::Correction,
    )
    .await;
    let raw_bytes = u64::from(seconds) * 48_000;
    assert!(
        frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::TranscriptFinal { text, .. }
                        if text == &format!("received {raw_bytes} PCM16 bytes")
                )
        )),
        "the synthetic provider must transcribe exactly one assembled {seconds}s turn"
    );
    // `A-19.3`: the assembled turn produces exactly one durable outcome, and on this
    // path that outcome is a retryable deferral. The synthetic runtime injects a
    // corpus-bound evaluator that replays one checked-in `learning-core` case chosen
    // by the response identity — it never reads the transcript at all — and this
    // session's response id selects `deferred_insufficient_semantic_evidence`. The
    // pin is therefore "one outcome, and it is that deferral", not a claim that the
    // byte-count placeholder was semantically judged. A deferred turn records the
    // attempt but writes no mastery.
    assert_eq!(count_events(&frames, BrowserEventKind::AnswerEvaluated), 0);
    assert_eq!(count_events(&frames, BrowserEventKind::TurnDeferred), 1);
    assert_eq!(count_events(&frames, BrowserEventKind::ConceptStatus), 0);
    assert!(store.snapshot().concept_statuses.is_empty());
    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                agent_service::VivaServerEvent::TurnDeferred {
                    reason: agent_domain::learning_outcome::EvaluationDeferralReason::InsufficientSemanticEvidence,
                    can_retry_same_question: true,
                    ..
                }
            )
    )));
    assert_eq!(
        frames
            .iter()
            .filter(|frame| matches!(frame, ServerFrame::AudioTurnAccepted { .. }))
            .count(),
        0,
        "exactly one acceptance frame per completed turn"
    );
    assert_eq!(store.snapshot().answer_attempts.len(), 1);
    assert_no_server_frame(&mut socket, Duration::from_millis(150)).await;
}

#[tokio::test]
async fn streamed_audio_turns_complete_a_two_second_turn() {
    assert_streamed_audio_turn_admits_one_provider_turn(2).await;
}

#[tokio::test]
async fn streamed_audio_turns_complete_a_ten_second_turn() {
    assert_streamed_audio_turn_admits_one_provider_turn(10).await;
}

#[tokio::test]
async fn streamed_audio_turns_complete_a_forty_five_second_turn() {
    assert_streamed_audio_turn_admits_one_provider_turn(45).await;
}

async fn assert_streamed_audio_protocol_error(
    client_frames: Vec<String>,
    expected_code: VoiceServerErrorCode,
    expected_message: &str,
    expected_close: CloseCode,
) {
    let Some(mut socket) = open_streamed_audio_session(test_state(1)).await else {
        return;
    };
    for text in client_frames {
        socket.send(WsMessage::Text(text.into())).await.unwrap();
    }

    let raw = read_server_text(&mut socket).await;
    assert!(
        !raw.contains(STREAMED_AUDIO_PCM_BASE64_PREFIX) && !raw.contains("pcm16"),
        "protocol errors must not echo base64 or PCM data"
    );
    assert_eq!(
        serde_json::from_str::<ServerFrame>(&raw).unwrap(),
        ServerFrame::error(expected_code, expected_message)
    );
    assert_close_code(&mut socket, expected_close).await;
}

#[tokio::test]
async fn streamed_audio_turns_reject_invalid_sequences_and_identities() {
    let cases: Vec<(&str, Vec<String>)> = vec![
        (
            "duplicate sequence",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
            ],
        ),
        (
            "sequence gap",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_chunk_of("turn-a", 2, STREAMED_AUDIO_CHUNK_BYTES),
            ],
        ),
        (
            "out of order sequence",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_chunk_of("turn-a", 1, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_chunk_of("turn-a", 1, STREAMED_AUDIO_CHUNK_BYTES),
            ],
        ),
        (
            "second turn while the first is active",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_chunk_of("turn-b", 0, STREAMED_AUDIO_CHUNK_BYTES),
            ],
        ),
        (
            "mismatched turn on end",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_end_json("turn-b", 0),
            ],
        ),
        (
            "final sequence that was never accepted",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_end_json("turn-a", 1),
            ],
        ),
        ("empty chunk", vec![streamed_audio_chunk_of("turn-a", 0, 0)]),
        ("odd chunk", vec![streamed_audio_chunk_of("turn-a", 0, 1)]),
        (
            "mismatched scoped cancel",
            vec![
                streamed_audio_chunk_of("turn-a", 0, STREAMED_AUDIO_CHUNK_BYTES),
                streamed_audio_cancel_json("turn-b"),
            ],
        ),
    ];

    for (label, frames) in cases {
        println!("streamed audio negative case: {label}");
        assert_streamed_audio_protocol_error(
            frames,
            VoiceServerErrorCode::ClientFrameMalformed,
            "invalid audio frame",
            CloseCode::Protocol,
        )
        .await;
    }
}

#[tokio::test]
async fn streamed_audio_turns_reject_an_oversized_chunk() {
    assert_streamed_audio_protocol_error(
        vec![streamed_audio_chunk_of(
            "turn-a",
            0,
            STREAMED_AUDIO_MAX_CHUNK_BYTES + 2,
        )],
        VoiceServerErrorCode::ClientFrameTooLarge,
        "audio chunk exceeds maximum size",
        CloseCode::Size,
    )
    .await;
}

#[tokio::test]
async fn streamed_audio_turns_reject_an_over_limit_tail() {
    let full_chunks = STREAMED_AUDIO_MAX_TURN_BYTES / STREAMED_AUDIO_MAX_CHUNK_BYTES;
    let tail = STREAMED_AUDIO_MAX_TURN_BYTES - full_chunks * STREAMED_AUDIO_MAX_CHUNK_BYTES;
    let mut frames: Vec<String> = (0..full_chunks)
        .map(|sequence| {
            streamed_audio_chunk_of("turn-a", sequence as u32, STREAMED_AUDIO_MAX_CHUNK_BYTES)
        })
        .collect();
    frames.push(streamed_audio_chunk_of("turn-a", full_chunks as u32, tail));
    frames.push(streamed_audio_chunk_of("turn-a", full_chunks as u32 + 1, 2));

    assert_streamed_audio_protocol_error(
        frames,
        VoiceServerErrorCode::ClientTurnTooLarge,
        "audio turn exceeds maximum size",
        CloseCode::Size,
    )
    .await;
}

#[tokio::test]
async fn streamed_audio_turns_cancel_halfway_creates_no_provider_work() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let Some(mut socket) =
        open_streamed_audio_session(test_state_with_store(1, store.clone())).await
    else {
        return;
    };

    send_streamed_audio_chunks(&mut socket, "turn-cancelled", 1_125).await;
    socket
        .send(WsMessage::Text(
            streamed_audio_cancel_json("turn-cancelled").into(),
        ))
        .await
        .unwrap();

    assert_no_server_frame(&mut socket, Duration::from_millis(400)).await;
    assert!(store.snapshot().answer_attempts.is_empty());
    assert!(store.snapshot().concept_statuses.is_empty());

    // The connection stays usable: a fresh bounded turn still completes exactly once.
    send_streamed_audio_chunks(&mut socket, "turn-after-cancel", 100).await;
    socket
        .send(WsMessage::Text(
            streamed_audio_end_json("turn-after-cancel", 99).into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        read_server_frame_exact(&mut socket).await,
        ServerFrame::AudioTurnAccepted {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: STREAMED_AUDIO_GENERATION.to_owned(),
            turn_id: "turn-after-cancel".to_owned(),
            final_sequence: 99,
        }
    );
    let frames = read_server_frames_until_session_phase(
        &mut socket,
        agent_domain::StudySessionPhase::Correction,
    )
    .await;
    // As above (`A-19.3`): the corpus-bound evaluator resolves this response identity
    // to a deferral, and the point of this case is that the post-cancel turn still
    // produces exactly one outcome.
    assert_eq!(count_events(&frames, BrowserEventKind::AnswerEvaluated), 0);
    assert_eq!(count_events(&frames, BrowserEventKind::TurnDeferred), 1);
    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::TranscriptFinal { text, .. }
                    if text == "received 96000 PCM16 bytes"
            )
    )));
}

#[derive(Clone, Copy)]
enum BrowserEventKind {
    QuestionStarted,
    AnswerEvaluated,
    TurnDeferred,
    SourceReference,
    ConceptStatus,
    ManuscriptIntent,
    RecapReady,
}

impl BrowserEventKind {
    fn matches(self, event: &agent_service::VivaServerEvent) -> bool {
        match self {
            Self::QuestionStarted => matches!(
                event,
                agent_service::VivaServerEvent::QuestionStarted { .. }
            ),
            Self::AnswerEvaluated => matches!(
                event,
                agent_service::VivaServerEvent::AnswerEvaluated { .. }
            ),
            Self::TurnDeferred => {
                matches!(event, agent_service::VivaServerEvent::TurnDeferred { .. })
            }
            Self::SourceReference => matches!(
                event,
                agent_service::VivaServerEvent::SourceReference { .. }
            ),
            Self::ConceptStatus => {
                matches!(event, agent_service::VivaServerEvent::ConceptStatus { .. })
            }
            Self::ManuscriptIntent => matches!(
                event,
                agent_service::VivaServerEvent::ManuscriptIntent { .. }
            ),
            Self::RecapReady => matches!(event, agent_service::VivaServerEvent::RecapReady { .. }),
        }
    }
}

#[derive(Deserialize)]
struct FullSessionFixture {
    client: Vec<ClientFrame>,
    server: Vec<ServerFrame>,
}

/// `VOICE-AUTH-001`: protocol v5 makes the client generation and the signed
/// credential required members of `session_config`, so every test socket names
/// this one generation. The value is a fixed test literal, never a credential.
const VOICE_TEST_CLIENT_GENERATION: &str = "voice-test-generation-1";

/// A placeholder in the signed-credential position for the sockets whose access
/// mode is trusted loopback: those tests assert runtime behaviour, not token
/// verification, and the server never reads this value on that path.
const VOICE_TEST_PLACEHOLDER_CREDENTIAL: &str = "placeholder-session-material";

type TestWebSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn spawn_server(state: AppState) -> Option<String> {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            if std::env::var("VIVA_ALLOW_LOOPBACK_TEST_SKIP").as_deref() == Ok("1") {
                return None;
            }
            panic!("local websocket tests require loopback bind permission: {error}");
        }
        Err(error) => panic!("failed to bind local websocket test server: {error}"),
    };
    let addr = listener.local_addr().unwrap();
    let app = build_router(state);
    let handle: JoinHandle<()> = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    drop(handle);
    Some(format!("ws://{addr}/ws"))
}

/// Protocol v5 removed the raw binary client surface, so an answer that used to be
/// one WebSocket binary frame is now exactly one bounded audio turn: a single
/// `audio_chunk` plus its explicit `audio_end`.
async fn send_v5_audio_turn(socket: &mut TestWebSocket, turn_id: &str, pcm16: &[u8]) {
    let pcm16 = if pcm16.len() < 2 || !pcm16.len().is_multiple_of(2) {
        vec![1_u8, 2]
    } else {
        pcm16.to_vec()
    };
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "audio_chunk",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "turn_id": turn_id,
                "sequence": 0,
                "frame": { "pcm16_base64": STANDARD.encode(&pcm16) },
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "audio_end",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
                "turn_id": turn_id,
                "final_sequence": 0,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn send_client_frame(socket: &mut TestWebSocket, frame: &ClientFrame) {
    socket
        .send(WsMessage::Text(
            serde_json::to_string(frame).unwrap().into(),
        ))
        .await
        .unwrap();
}

/// The v5 initial `session_config` frame, built from Plan 05's session fixture.
///
/// The frozen unversioned full-session fixtures still carry v4 client frames (`W-06`),
/// so a test that only needs to open a session builds the frame here instead of
/// reading `fixture.client[0]`; the session payload itself is still the shared
/// fixture, and only the v5 envelope the frozen file lacks is supplied locally.
fn fixture_session_config_frame() -> ClientFrame {
    serde_json::from_str(&session_config_json_with_token(
        VOICE_TEST_PLACEHOLDER_CREDENTIAL,
    ))
    .expect("v5 session config frame parses")
}

fn session_config_json_with_token(token: &str) -> String {
    let session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    serde_json::json!({
        "type": "session_config",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
        "session": session,
        "session_token": token,
    })
    .to_string()
}

fn session_config_json_with_ids_and_token(
    study_set_id: &str,
    session_id: &str,
    token: &str,
) -> String {
    let mut session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    session["study_set_id"] = serde_json::json!(study_set_id);
    session["session_id"] = serde_json::json!(session_id);
    serde_json::json!({
        "type": "session_config",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": VOICE_TEST_CLIENT_GENERATION,
        "session": session,
        "session_token": token,
    })
    .to_string()
}

/// `SERVICE-004`: the provider-limiter sockets are token-only deployments, so the
/// same signed credential is presented at the HTTP upgrade and in the first bound
/// frame. Minting it once keeps the two identical.
fn provider_limiter_token(study_set_id: &str, session_id: &str, nonce: &str) -> String {
    signed_session_token(
        "session-secret",
        "user-1",
        study_set_id,
        session_id,
        unix_timestamp_now() + 60,
        nonce,
    )
}

fn signed_session_token(
    secret: &str,
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    expires_at: u64,
    nonce: &str,
) -> String {
    let issued_at = expires_at.saturating_sub(900);
    let claims = serde_json::json!({
        "user_id": user_id,
        "study_set_id": study_set_id,
        "session_id": session_id,
        "issued_at": issued_at,
        "not_before": issued_at,
        "expires_at": expires_at,
        "nonce": nonce,
    });
    signed_session_token_claims(secret, claims)
}

struct FailureControlTokenFixture<'a> {
    session_secret: &'a str,
    control_secret: &'a str,
    user_id: &'a str,
    study_set_id: &'a str,
    session_id: &'a str,
    origin: &'a str,
    scenario: FailureControlScenario,
    expires_at: u64,
    nonce: &'a str,
    run_id: &'a str,
    control_nonce: &'a str,
}

fn signed_session_token_with_failure_control(fixture: FailureControlTokenFixture<'_>) -> String {
    let failure_control = serde_json::json!({
        "scenario": fixture.scenario.as_str(),
        "run_id": fixture.run_id,
        "expires_at": fixture.expires_at,
        "nonce": fixture.control_nonce,
        "signature": failure_control_signature(
            fixture.control_secret,
            fixture.scenario,
            fixture.user_id,
            fixture.study_set_id,
            fixture.session_id,
            fixture.origin,
            fixture.run_id,
            fixture.expires_at,
            fixture.control_nonce,
        ),
    });
    let issued_at = fixture.expires_at.saturating_sub(900);
    let claims = serde_json::json!({
        "user_id": fixture.user_id,
        "study_set_id": fixture.study_set_id,
        "session_id": fixture.session_id,
        "issued_at": issued_at,
        "not_before": issued_at,
        "expires_at": fixture.expires_at,
        "nonce": fixture.nonce,
        "failure_control": failure_control,
    });
    signed_session_token_claims(fixture.session_secret, claims)
}

fn signed_session_token_claims(secret: &str, claims: serde_json::Value) -> String {
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let payload = format!("viva1.{claims}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

#[allow(clippy::too_many_arguments)]
fn failure_control_signature(
    secret: &str,
    scenario: FailureControlScenario,
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    origin: &str,
    run_id: &str,
    expires_at: u64,
    nonce: &str,
) -> String {
    let payload = format!(
        "viva-failure-control.v1\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        scenario.as_str(),
        user_id,
        study_set_id,
        session_id,
        origin,
        run_id,
        expires_at,
        nonce
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn unix_timestamp_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_secs()
}

/// The next server frame, exactly as sent, with no filtering.
async fn read_server_frame_exact(socket: &mut TestWebSocket) -> ServerFrame {
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMessage::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected text server frame, got {other:?}"),
    }
}

/// The next server frame a browser would act on. Protocol v5 acknowledges every
/// admitted audio turn with `audio_turn_accepted`; that acknowledgment is turn
/// bookkeeping rather than session progress, so tests asserting a sequence of
/// session frames read past it. Tests that assert the acknowledgment itself use
/// [`read_server_frame_exact`].
async fn read_server_frame(socket: &mut TestWebSocket) -> ServerFrame {
    loop {
        let frame = read_server_frame_exact(socket).await;
        if !matches!(frame, ServerFrame::AudioTurnAccepted { .. }) {
            return frame;
        }
    }
}

async fn assert_ready_provider(socket: &mut TestWebSocket, expected_provider: &str) {
    let frame = read_server_frame(socket).await;
    let ServerFrame::Ready {
        sample_rate_hz,
        input_encoding,
        brain,
        store,
        ..
    } = frame
    else {
        panic!("expected ready frame, got {frame:?}");
    };
    assert_eq!(sample_rate_hz, 24_000);
    assert_eq!(input_encoding, "pcm_s16le");
    assert_eq!(brain.provider, expected_provider);
    assert!(brain.configured);
    assert!(brain.selectable);
    assert!(!brain.live_runtime);
    assert_eq!(store.backend.as_str(), "in_memory");
    assert!(store.available);
}

async fn wait_for_socket_close(socket: &mut TestWebSocket) {
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
    {
        Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => {}
        other => panic!("expected close frame, got {other:?}"),
    }
}

async fn read_server_frames_until_close(socket: &mut TestWebSocket) -> Vec<ServerFrame> {
    let mut frames = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
        {
            Some(Ok(WsMessage::Text(text))) => frames.push(serde_json::from_str(&text).unwrap()),
            Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => return frames,
            Some(Ok(_)) => {}
        }
    }
}

async fn read_server_frames_until_terminal_reason(
    socket: &mut TestWebSocket,
    expected: TerminalSessionReason,
) -> Vec<ServerFrame> {
    let mut frames = Vec::new();
    loop {
        let frame = read_server_frame(socket).await;
        let terminal = terminal_session_reason(&frame);
        frames.push(frame);
        if terminal == Some(expected) {
            return frames;
        }
    }
}

async fn assert_close_code(socket: &mut TestWebSocket, expected: CloseCode) {
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMessage::Close(Some(frame)) => assert_eq!(frame.code, expected),
        other => panic!("expected close frame, got {other:?}"),
    }
}

fn assert_terminal_session_phase(frame: ServerFrame, expected_reason: TerminalSessionReason) {
    let ServerFrame::Event { event, .. } = frame else {
        panic!("expected terminal session phase event, got {frame:?}");
    };
    let VivaServerEvent::SessionPhase {
        phase,
        terminal_reason,
    } = *event
    else {
        panic!("expected session_phase event, got {event:?}");
    };
    assert_eq!(phase, agent_domain::StudySessionPhase::Recap);
    assert_eq!(terminal_reason, Some(expected_reason));
}

fn terminal_session_reason(frame: &ServerFrame) -> Option<TerminalSessionReason> {
    let ServerFrame::Event { event, .. } = frame else {
        return None;
    };
    let VivaServerEvent::SessionPhase {
        terminal_reason, ..
    } = event.as_ref()
    else {
        return None;
    };
    *terminal_reason
}

async fn wait_for_evidence_kind(
    evidence: &VoiceEvidenceRecorder,
    kind: VoiceEvidenceEventKind,
) -> Vec<observe::VoiceEvidenceEvent> {
    wait_until(Duration::from_secs(2), || {
        evidence.snapshot().iter().any(|event| event.kind == kind)
    })
    .await;
    evidence.snapshot()
}

/// Waits for one exact sanitized evidence detail under a kind, without asserting on
/// a timeout: the caller decides whether its absence is the failure.
async fn wait_for_evidence_detail(
    evidence: &VoiceEvidenceRecorder,
    kind: VoiceEvidenceEventKind,
    detail: &str,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == kind && event.detail == detail)
        {
            return true;
        }
        tokio::task::yield_now().await;
    }
    false
}

/// The next server frame as raw wire bytes, for byte-for-byte fixture comparison.
async fn read_server_text_frame(socket: &mut TestWebSocket) -> String {
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMessage::Text(text) => text.to_string(),
        other => panic!("expected text server frame, got {other:?}"),
    }
}

async fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    assert!(condition(), "condition was not met before timeout");
}

async fn run_partial_recap_provider_failure_probe(
    terminal_reason: TerminalSessionReason,
    record_concept_status: bool,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_stop(
        terminal_reason,
        record_concept_status,
        false,
    )
    .await
}

async fn run_partial_recap_provider_failure_probe_after_stop(
    terminal_reason: TerminalSessionReason,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_stop(terminal_reason, false, true).await
}

async fn run_partial_recap_provider_failure_probe_after_stop_with_existing_recap(
    terminal_reason: TerminalSessionReason,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_options(terminal_reason, false, true, true).await
}

async fn run_partial_recap_provider_failure_probe_cancelled(
    terminal_reason: TerminalSessionReason,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_extended_options(
        terminal_reason,
        false,
        false,
        false,
        true,
        false,
        true,
    )
    .await
}

async fn run_partial_recap_provider_failure_probe_with_prior_attempt_only(
    terminal_reason: TerminalSessionReason,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_extended_options(
        terminal_reason,
        false,
        false,
        false,
        false,
        true,
        false,
    )
    .await
}

async fn run_partial_recap_provider_failure_probe_with_stop(
    terminal_reason: TerminalSessionReason,
    record_concept_status: bool,
    failure_after_stop: bool,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_options(
        terminal_reason,
        record_concept_status,
        failure_after_stop,
        false,
    )
    .await
}

async fn run_partial_recap_provider_failure_probe_with_options(
    terminal_reason: TerminalSessionReason,
    record_concept_status: bool,
    failure_after_stop: bool,
    recap_before_failure: bool,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    run_partial_recap_provider_failure_probe_with_extended_options(
        terminal_reason,
        record_concept_status,
        failure_after_stop,
        recap_before_failure,
        true,
        false,
        false,
    )
    .await
}

async fn run_partial_recap_provider_failure_probe_with_extended_options(
    terminal_reason: TerminalSessionReason,
    record_concept_status: bool,
    failure_after_stop: bool,
    recap_before_failure: bool,
    record_current_answer_attempt: bool,
    record_prior_answer_attempt: bool,
    cancel_before_failure: bool,
) -> Option<(
    Vec<ServerFrame>,
    Vec<observe::VoiceEvidenceEvent>,
    Arc<data::InMemoryStudyStore>,
)> {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(PartialRecapProviderFailureProbeBrain {
            study_store: store.clone(),
            terminal_reason,
            record_concept_status,
            failure_after_stop,
            recap_before_failure,
            record_current_answer_attempt,
            record_prior_answer_attempt,
            cancel_before_failure,
        }),
        "partial_recap_probe",
        VoiceWsAccess::default(),
        1,
        store.clone(),
    );
    let evidence = state.evidence.clone();
    let url = spawn_server(state).await?;
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "partial_recap_probe").await;
    socket
        .send(WsMessage::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"{VOICE_TEST_CLIENT_GENERATION}","session_token":"{VOICE_TEST_PLACEHOLDER_CREDENTIAL}","session":{session}}}"#
            )
            .into(),
        ))
        .await
        .unwrap();

    let mut frames = Vec::new();
    loop {
        let frame = read_server_frame(&mut socket).await;
        let saw_question = matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        );
        frames.push(frame);
        if saw_question {
            break;
        }
    }
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-partial-recap".to_owned(),
            turn_id: "v5-turn-30".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "raw learner answer should not be persisted or recapped".to_owned(),
            },
        },
    )
    .await;
    if failure_after_stop {
        wait_until(Duration::from_secs(2), || {
            store.write_counts().answer_attempts == 1
        })
        .await;
        send_client_frame(
            &mut socket,
            &ClientFrame::Stop {
                version: VIVA_VOICE_PROTOCOL_VERSION,
                client_generation_id: "v5-stop".to_owned(),
            },
        )
        .await;
    }
    frames.extend(read_server_frames_until_close(&mut socket).await);
    Some((frames, evidence.snapshot(), store))
}

struct CapabilityProbeBrain {
    capabilities: RealtimeBrainCapabilities,
}

#[async_trait::async_trait]
impl RealtimeBrain for CapabilityProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        self.capabilities.clone()
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        Err(missing_api_key_error())
    }
}

struct OpenAuthFailureBrain;

#[async_trait::async_trait]
impl RealtimeBrain for OpenAuthFailureBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: true,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        Err(missing_api_key_error())
    }
}

struct OpenProtocolStoreFailureBrain;

#[async_trait::async_trait]
impl RealtimeBrain for OpenProtocolStoreFailureBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "open_protocol_store_failure".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        Err(BrainError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::DurabilityDegraded,
                stage: BrainFailureStage::Store,
                retry_eligible: false,
                latency_ms: 0,
                provider: "open_protocol_store_failure".to_owned(),
                model: String::new(),
                metadata: "error_kind=durable_store_read_failed".to_owned(),
            },
        )))
    }
}

struct OpenRateLimitFailureBrain {
    opens: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RealtimeBrain for OpenRateLimitFailureBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        Err(BrainError::from_failure(
            BrainProviderFailure::new(BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 17,
                provider: "gemini".to_owned(),
                model: "gemini-3.5-flash".to_owned(),
                metadata: "http_status=429 retry_after_ms=250 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=within_limit deploy_sha=test-sha".to_owned(),
            }),
        ))
    }
}

struct AbortProbeBrain {
    dropped: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl RealtimeBrain for AbortProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "abort_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (_event_tx, events) = mpsc::channel(8);
        let dropped = self.dropped.clone();
        let provider_task = tokio::spawn(DropFlagFuture { dropped });
        let input_task = tokio::spawn(async move { while input_rx.recv().await.is_some() {} });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![
                provider_task.abort_handle(),
                input_task.abort_handle(),
            ])),
        })
    }
}

struct BackpressuredInputBrain {
    dropped: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl RealtimeBrain for BackpressuredInputBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "backpressured_input_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, input_rx) = mpsc::channel::<BrainInput>(1);
        let (event_tx, events) = mpsc::channel(1);
        let dropped = self.dropped.clone();
        let input_task = tokio::spawn(async move {
            let _input_rx = input_rx;
            let _event_tx = event_tx;
            DropFlagFuture { dropped }.await;
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![
                input_task.abort_handle()
            ])),
        })
    }
}

struct StopWritesAnswerProbeBrain {
    study_store: Arc<dyn StudyMemoryStore>,
    stop_write_attempted: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl RealtimeBrain for StopWritesAnswerProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "stop_writes_answer_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_user_id"))?
            .to_owned();
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_study_set_id"))?
            .to_owned();
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_session_id"))?
            .to_owned();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let study_store = self.study_store.clone();
        let stop_write_attempted = self.stop_write_attempted.clone();
        let task = tokio::spawn(async move {
            let _event_tx = event_tx;
            let mut accepted_answer = false;
            while let Some(input) = input_rx.recv().await {
                match input {
                    BrainInput::Audio(_)
                    | BrainInput::AudioWithMetadata { .. }
                    | BrainInput::Text(_)
                    | BrainInput::TextWithMetadata { .. } => {
                        accepted_answer = true;
                    }
                    BrainInput::Stop if accepted_answer => {
                        stop_write_attempted.store(true, Ordering::SeqCst);
                        let question = agent_domain::fixture_question();
                        let evaluation = agent_domain::AnswerEvaluation {
                            question_id: question.question_id.clone(),
                            answer_text: "late provider answer".to_owned(),
                            label: "mostly correct".to_owned(),
                            concise_feedback: "Late feedback should not persist.".to_owned(),
                            retry_prompt: question.follow_up.clone(),
                            source: question.source,
                            concept_status: agent_domain::ConceptStatus::Strong,
                            confidence_score: 0.84,
                        };
                        let _ = study_store
                            .record_answer_evaluation(
                                &user_id,
                                &study_set_id,
                                &voice_session_id,
                                "late-response",
                                evaluation,
                            )
                            .await;
                        break;
                    }
                    BrainInput::Stop => break,
                    _ => {}
                }
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct DropFlagFuture {
    dropped: Arc<AtomicBool>,
}

impl Future for DropFlagFuture {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Pending
    }
}

impl Drop for DropFlagFuture {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

struct OpenProbeBrain {
    opened: Arc<AtomicBool>,
    captured_config: Option<Arc<Mutex<Option<agent_domain::SessionConfig>>>>,
}

#[async_trait::async_trait]
impl RealtimeBrain for OpenProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "open_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        self.opened.store(true, Ordering::SeqCst);
        if let Some(captured_config) = &self.captured_config {
            *captured_config
                .lock()
                .expect("captured config lock poisoned") = Some(config);
        }
        let (input, _input_rx) = mpsc::channel::<BrainInput>(8);
        let (_event_tx, events) = mpsc::channel(8);
        Ok(RealtimeSession {
            input,
            events,
            task_guard: None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DurableStoreFailureMode {
    ActiveQuestion,
    NoFailure,
    NonceClaim,
    QuestionAuthorizationSemanticMiss,
    QuestionAuthorizationWriteFailure,
    SessionClose,
    SessionCloseMissing,
    StudyContext,
    UsageRecording,
}

struct DurableStoreDegradingStore {
    inner: Arc<data::InMemoryStudyStore>,
    failure: DurableStoreFailureMode,
}

#[async_trait::async_trait]
impl StudyMemoryStore for DurableStoreDegradingStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        StudyStoreCapabilities {
            backend: StudyStoreBackend::Postgres,
            available: true,
            durable: true,
            nonce_replay_protection: true,
            raw_audio_persistence: false,
            transcript_persistence: false,
            uuid_schema_translation: true,
        }
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        if self.failure == DurableStoreFailureMode::NonceClaim {
            return Err(PortError::durability(
                "postgres",
                "durable-write",
                "durable store write failed",
            ));
        }
        self.inner.claim_session_token_nonce(claim).await
    }

    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<agent_domain::StudyStoreWriteOutcome, PortError> {
        self.inner.record_voice_session(config).await
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<serde_json::Value, PortError> {
        if self.failure == DurableStoreFailureMode::SessionClose {
            return Err(PortError::durability(
                "postgres",
                "durable-write",
                "durable store write failed",
            ));
        }
        if self.failure == DurableStoreFailureMode::SessionCloseMissing {
            return Err(PortError::unavailable(
                "postgres",
                voice_session_id,
                "voice session does not exist",
            ));
        }
        self.inner
            .close_voice_session(voice_session_id, terminal_reason)
            .await
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        if self.failure == DurableStoreFailureMode::StudyContext {
            return Err(PortError::durability(
                "postgres",
                "durable-read",
                "durable store read failed",
            ));
        }
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        if self.failure == DurableStoreFailureMode::ActiveQuestion {
            return Err(PortError::durability(
                "postgres",
                "durable-read",
                "durable store read failed",
            ));
        }
        self.inner.active_question(user_id, study_set_id).await
    }

    async fn authorize_question_started(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        if self.failure != DurableStoreFailureMode::QuestionAuthorizationSemanticMiss
            && self.failure != DurableStoreFailureMode::QuestionAuthorizationWriteFailure
        {
            return self
                .inner
                .authorize_question_started(user_id, study_set_id, voice_session_id, question)
                .await;
        }
        match self.failure {
            DurableStoreFailureMode::QuestionAuthorizationSemanticMiss => {
                Err(PortError::invalid_input(
                    "postgres",
                    question.question_id.clone(),
                    format!(
                        "question tuple does not match deterministic retrieval for {}",
                        question.question_id
                    ),
                ))
            }
            DurableStoreFailureMode::QuestionAuthorizationWriteFailure => Err(
                PortError::durability("postgres", "durable-read", "durable store read failed"),
            ),
            DurableStoreFailureMode::ActiveQuestion
            | DurableStoreFailureMode::NoFailure
            | DurableStoreFailureMode::NonceClaim
            | DurableStoreFailureMode::SessionClose
            | DurableStoreFailureMode::SessionCloseMissing
            | DurableStoreFailureMode::StudyContext
            | DurableStoreFailureMode::UsageRecording => unreachable!(),
        }
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
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
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<agent_domain::ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .persist_review_schedule_decision(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                decision,
            )
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: agent_domain::ProgressionPolicyId,
    ) -> Result<agent_domain::QuestionProgressionResult, PortError> {
        // `LEARN-004B` moved question selection onto a per-session progression
        // cursor, so this — not `active_question` — is the durable read a session
        // open actually performs.
        if self.failure == DurableStoreFailureMode::ActiveQuestion {
            return Err(PortError::durability(
                "postgres",
                "durable-read",
                "durable store read failed",
            ));
        }
        self.inner
            .select_next_question(user_id, study_set_id, voice_session_id, response_id, policy)
            .await
    }

    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::SessionLearningEvidence, PortError> {
        self.inner
            .session_learning_evidence(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        self.inner
            .authenticated_study_projection(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn record_answer_attempt_envelope(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_attempt_envelope(user_id, study_set_id, voice_session_id, envelope)
            .await
    }

    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: agent_domain::TurnOutcome,
    ) -> Result<agent_domain::PersistedTurnOutcome, PortError> {
        self.inner
            .record_turn_outcome(user_id, study_set_id, voice_session_id, outcome)
            .await
    }

    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<agent_domain::StudyStoreWriteOutcome, PortError> {
        if self.failure != DurableStoreFailureMode::UsageRecording {
            return self.inner.record_voice_usage(event).await;
        }
        drop(event);
        Err(PortError::durability(
            "postgres",
            "durable-write",
            "durable store write failed",
        ))
    }
}

struct PartialRecapProviderFailureProbeBrain {
    study_store: Arc<dyn StudyMemoryStore>,
    terminal_reason: TerminalSessionReason,
    record_concept_status: bool,
    failure_after_stop: bool,
    recap_before_failure: bool,
    record_current_answer_attempt: bool,
    record_prior_answer_attempt: bool,
    cancel_before_failure: bool,
}

#[async_trait::async_trait]
impl RealtimeBrain for PartialRecapProviderFailureProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "partial_recap_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_user_id"))?
            .to_owned();
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_study_set_id"))?
            .to_owned();
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_session_id"))?
            .to_owned();
        let study_store = self.study_store.clone();
        let terminal_reason = self.terminal_reason;
        let record_concept_status = self.record_concept_status;
        let failure_after_stop = self.failure_after_stop;
        let recap_before_failure = self.recap_before_failure;
        let record_current_answer_attempt = self.record_current_answer_attempt;
        let record_prior_answer_attempt = self.record_prior_answer_attempt;
        let cancel_before_failure = self.cancel_before_failure;
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let question = agent_domain::fixture_question();
            let response_id = "response-partial-provider-failure";
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: response_id.to_owned(),
                    question: question.clone(),
                })
                .await;
            while let Some(input) = input_rx.recv().await {
                // `DOMAIN-003` emission boundary: a typed answer envelope carries
                // both the byte count every capture mode records and the char
                // count typed capture requires. Omitting either is what the
                // upstream `validate_fail_closed` refuses, so this probe supplies
                // the same pair the production runtimes do.
                let (byte_count, char_count, client_generation_id) = match input {
                    BrainInput::Text(text) => (
                        Some(text.len() as u64),
                        Some(text.chars().count() as u64),
                        None,
                    ),
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => (
                        Some(text.len() as u64),
                        Some(text.chars().count() as u64),
                        client_generation_id,
                    ),
                    BrainInput::Audio(frame) => (
                        Some(frame.pcm16_bytes().len() as u64),
                        Some(frame.pcm16_bytes().len() as u64),
                        None,
                    ),
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => (
                        Some(frame.pcm16_bytes().len() as u64),
                        Some(frame.pcm16_bytes().len() as u64),
                        client_generation_id,
                    ),
                    BrainInput::Stop => break,
                    _ => continue,
                };
                if record_current_answer_attempt {
                    let _ = study_store
                        .record_answer_attempt_envelope(
                            &user_id,
                            &study_set_id,
                            &voice_session_id,
                            AnswerAttemptEnvelope {
                                response_id: response_id.to_owned(),
                                question_id: question.question_id.clone(),
                                submission_sequence: 1,
                                idempotency_key: format!(
                                    "{voice_session_id}:{}:1",
                                    question.question_id
                                ),
                                capture_mode: AnswerCaptureMode::Typed,
                                byte_count,
                                char_count,
                                duration_ms: None,
                                client_generation_id: client_generation_id.clone(),
                                locale: Some("en-US".to_owned()),
                                capture_status: AnswerCaptureStatus::Accepted,
                                content_policy: AnswerContentPolicy::None,
                                answer_digest_hmac: None,
                                transcript_status: None,
                                transcript_confidence_bucket: None,
                                pre_provider_state: "accepted_before_provider".to_owned(),
                            },
                        )
                        .await;
                }
                if record_prior_answer_attempt {
                    let _ = study_store
                        .record_answer_attempt_envelope(
                            &user_id,
                            &study_set_id,
                            &voice_session_id,
                            AnswerAttemptEnvelope {
                                response_id: "response-prior-provider-failure".to_owned(),
                                question_id: question.question_id.clone(),
                                submission_sequence: 1,
                                idempotency_key: format!(
                                    "{voice_session_id}:{}:prior",
                                    question.question_id
                                ),
                                capture_mode: AnswerCaptureMode::Typed,
                                byte_count,
                                char_count,
                                duration_ms: None,
                                client_generation_id,
                                locale: Some("en-US".to_owned()),
                                capture_status: AnswerCaptureStatus::Accepted,
                                content_policy: AnswerContentPolicy::None,
                                answer_digest_hmac: None,
                                transcript_status: None,
                                transcript_confidence_bucket: None,
                                pre_provider_state: "accepted_before_provider".to_owned(),
                            },
                        )
                        .await;
                }
                if record_concept_status {
                    let _ = study_store
                        .record_concept_status(
                            &user_id,
                            &study_set_id,
                            &voice_session_id,
                            response_id,
                            "nadh",
                            ConceptStatus::Review,
                        )
                        .await;
                    let _ = event_tx
                        .send(BrainEvent::ConceptStatus {
                            response_id: response_id.to_owned(),
                            concept_id: "nadh".to_owned(),
                            status: ConceptStatus::Review,
                        })
                        .await;
                }
                if failure_after_stop {
                    while let Some(input) = input_rx.recv().await {
                        if matches!(input, BrainInput::Stop) {
                            break;
                        }
                    }
                }
                if recap_before_failure {
                    let recap = StudySessionRecap {
                        schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA
                            .to_owned(),
                        deferred_turns: 0,
                        voice_session_id: voice_session_id.clone(),
                        headline: "Full recap".to_owned(),
                        summary: "Durable model recap already exists.".to_owned(),
                        concepts: vec![agent_domain::RecapConceptOutcome {
                            concept_id: "NADH".to_owned(),
                            label: "NADH".to_owned(),
                            status: agent_domain::ConceptStatus::Strong,
                        }],
                        review_schedule: vec![],
                        next_action: "Continue".to_owned(),
                        source_moments: vec![],
                    };
                    let response_id = "response-normal-recap";
                    let _ = study_store
                        .record_recap(
                            &user_id,
                            &study_set_id,
                            &voice_session_id,
                            response_id,
                            recap.clone(),
                        )
                        .await;
                    let _ = event_tx
                        .send(BrainEvent::RecapReady {
                            response_id: response_id.to_owned(),
                            recap,
                        })
                        .await;
                }
                if cancel_before_failure {
                    let _ = event_tx
                        .send(BrainEvent::ResponseCancelledFor {
                            response_id: response_id.to_owned(),
                        })
                        .await;
                }
                // The class is the single authority for the terminal reason, so the
                // scenario picks a class rather than asserting a reason beside it.
                let failure_class = match terminal_reason {
                    TerminalSessionReason::ProviderRateLimited => {
                        BrainFailureClass::QuotaRateFailure
                    }
                    TerminalSessionReason::ProviderTimeout => BrainFailureClass::Timeout,
                    TerminalSessionReason::ProviderAuthFailed => {
                        BrainFailureClass::ProviderAuthFailure
                    }
                    TerminalSessionReason::ProviderMalformedStream => {
                        BrainFailureClass::MalformedStream
                    }
                    TerminalSessionReason::ProviderNetworkDisconnect => {
                        BrainFailureClass::NetworkDisconnect
                    }
                    other => panic!("unmapped provider terminal reason {}", other.as_str()),
                };
                let failure = BrainProviderFailure::new(BrainProviderFailureParts {
                    failure_class,
                    stage: BrainFailureStage::Gemini,
                    retry_eligible: true,
                    latency_ms: 29,
                    provider: "gemini".to_owned(),
                    model: "gemini-3.5-flash".to_owned(),
                    metadata: "http_status=429 retry_after_ms=250 deploy_sha=test-sha".to_owned(),
                });
                let _ = event_tx
                    .send(BrainEvent::Error(BrainProviderError::from_failure(failure)))
                    .await;
                break;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct StructuredRateLimitProbeBrain {
    text_inputs: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RealtimeBrain for StructuredRateLimitProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                if matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    text_inputs.fetch_add(1, Ordering::SeqCst);
                    let failure = BrainProviderFailure::new(BrainProviderFailureParts {
                        failure_class: BrainFailureClass::QuotaRateFailure,
                        stage: BrainFailureStage::Gemini,
                        retry_eligible: true,
                        latency_ms: 17,
                        provider: "gemini".to_owned(),
                        model: "gemini-3.5-flash".to_owned(),
                        metadata: "http_status=429 retry_after_ms=250 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=within_limit deploy_sha=test-sha".to_owned(),
                    });
                    let _ = event_tx
                        .send(BrainEvent::Error(BrainProviderError::from_failure(failure)))
                        .await;
                    break;
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct UnstructuredRateLimitProbeBrain {
    text_inputs: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RealtimeBrain for UnstructuredRateLimitProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                if matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    text_inputs.fetch_add(1, Ordering::SeqCst);
                    let _ = event_tx
                        .send(BrainEvent::Error(BrainProviderError::from_failure(
                            BrainProviderFailure::new(BrainProviderFailureParts {
                                failure_class: BrainFailureClass::QuotaRateFailure,
                                stage: BrainFailureStage::Gemini,
                                retry_eligible: true,
                                latency_ms: 0,
                                provider: "cartesia_gemini".to_owned(),
                                model: "gemini-3.5-flash".to_owned(),
                                metadata: "http_status=429".to_owned(),
                            }),
                        )))
                        .await;
                    break;
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct BlockingProviderProbeBrain {
    text_inputs: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RealtimeBrain for BlockingProviderProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            while let Some(input) = input_rx.recv().await {
                if matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    text_inputs.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct QueuedAudioProviderProbeBrain {
    text_inputs: Arc<AtomicUsize>,
    audio_inputs: Arc<Mutex<Vec<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl RealtimeBrain for QueuedAudioProviderProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let audio_inputs = self.audio_inputs.clone();
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            let mut completed_audio_turn = false;
            while let Some(input) = input_rx.recv().await {
                match input {
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. } => {
                        text_inputs.fetch_add(1, Ordering::SeqCst);
                    }
                    BrainInput::Audio(frame) => {
                        let audio_count = {
                            let mut audio_inputs = audio_inputs.lock().unwrap();
                            audio_inputs.push(frame.pcm16_bytes().to_vec());
                            audio_inputs.len()
                        };
                        if audio_count == 2 && !completed_audio_turn {
                            completed_audio_turn = true;
                            let _ = event_tx
                                .send(BrainEvent::ResponseCompleted {
                                    response_id: "audio-response".to_owned(),
                                })
                                .await;
                        }
                    }
                    BrainInput::AudioWithMetadata { frame, .. } => {
                        let audio_count = {
                            let mut audio_inputs = audio_inputs.lock().unwrap();
                            audio_inputs.push(frame.pcm16_bytes().to_vec());
                            audio_inputs.len()
                        };
                        if audio_count == 2 && !completed_audio_turn {
                            completed_audio_turn = true;
                            let _ = event_tx
                                .send(BrainEvent::ResponseCompleted {
                                    response_id: "audio-response".to_owned(),
                                })
                                .await;
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct AudioContinuationResolutionProbeBrain {
    audio_inputs: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RealtimeBrain for AudioContinuationResolutionProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let audio_inputs = self.audio_inputs.clone();
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            let mut completed = false;
            while let Some(input) = input_rx.recv().await {
                if matches!(
                    input,
                    BrainInput::Audio(_) | BrainInput::AudioWithMetadata { .. }
                ) {
                    let audio_count = audio_inputs.fetch_add(1, Ordering::SeqCst) + 1;
                    if audio_count == 2 && !completed {
                        completed = true;
                        let _ = event_tx
                            .send(BrainEvent::ResponseCompleted {
                                response_id: "audio-continuation-response".to_owned(),
                            })
                            .await;
                    }
                }
            }
        });
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct StaleEventProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for StaleEventProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "stale_event_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, _input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let source = agent_domain::fixture_source_reference();
            let evaluation = agent_domain::AnswerEvaluation {
                question_id: "q-oxidative-phosphorylation-nadh".to_owned(),
                answer_text: "stale answer".to_owned(),
                label: "mostly correct".to_owned(),
                concise_feedback: "stale feedback".to_owned(),
                retry_prompt: "stale retry".to_owned(),
                source: source.clone(),
                concept_status: agent_domain::ConceptStatus::Strong,
                confidence_score: 0.84,
            };
            let _ = event_tx
                .send(BrainEvent::ResponseCancelledFor {
                    response_id: "stale-response".to_owned(),
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::AnswerEvaluated {
                    response_id: "stale-response".to_owned(),
                    evaluation,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::SourceReference {
                    response_id: "stale-response".to_owned(),
                    source,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::ConceptStatus {
                    response_id: "stale-response".to_owned(),
                    concept_id: "oxidative-phosphorylation".to_owned(),
                    status: agent_domain::ConceptStatus::Strong,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::AudioDelta {
                    response_id: "stale-response".to_owned(),
                    frame: AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
                })
                .await;
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct GlobalCancellationProbeBrain {
    store: Arc<data::InMemoryStudyStore>,
}

#[async_trait::async_trait]
impl RealtimeBrain for GlobalCancellationProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "global_cancel_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let (input, _input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let question = agent_domain::fixture_question();
            let source = question.source.clone();
            let evaluation = agent_domain::AnswerEvaluation {
                question_id: question.question_id.clone(),
                answer_text: "stale answer".to_owned(),
                label: "mostly correct".to_owned(),
                concise_feedback: "stale feedback".to_owned(),
                retry_prompt: question.follow_up.clone(),
                source: source.clone(),
                concept_status: agent_domain::ConceptStatus::Strong,
                confidence_score: 0.84,
            };
            let recap = StudySessionRecap {
                schema: agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
                deferred_turns: 0,
                voice_session_id: "voice-session-1".to_owned(),
                headline: "Stale recap".to_owned(),
                summary: "Stale recap summary".to_owned(),
                concepts: vec![agent_domain::RecapConceptOutcome {
                    concept_id: "NADH".to_owned(),
                    label: "NADH".to_owned(),
                    status: agent_domain::ConceptStatus::Strong,
                }],
                review_schedule: vec![],
                next_action: "Do not surface stale recap.".to_owned(),
                source_moments: vec![agent_domain::learning_recap::RecapSourceMoment {
                    response_id: "response-recap".to_owned(),
                    source_id: source.clone().source_id.clone(),
                }],
            };
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question,
                })
                .await;
            let _ = event_tx.send(BrainEvent::ResponseCancelled).await;
            let _ = event_tx
                .send(BrainEvent::AnswerEvaluated {
                    response_id: "response-1".to_owned(),
                    evaluation,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::SourceReference {
                    response_id: "response-1".to_owned(),
                    source,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::RecapReady {
                    response_id: "response-1".to_owned(),
                    recap,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::AudioDelta {
                    response_id: "response-1".to_owned(),
                    frame: AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
                })
                .await;
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct EventProbeBrain {
    study_store: Option<Arc<dyn StudyMemoryStore>>,
    events: Vec<BrainEvent>,
}

struct IdleProbeBrain {
    study_store: Option<Arc<dyn StudyMemoryStore>>,
}

struct ResponseReplayProbeBrain {
    study_store: Arc<dyn StudyMemoryStore>,
}

#[async_trait::async_trait]
impl RealtimeBrain for ResponseReplayProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "response_replay_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_user_id"))?;
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_study_set_id"))?;
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_session_id"))?;
        let question = agent_domain::fixture_question();
        let evaluation = agent_domain::AnswerEvaluation {
            question_id: question.question_id.clone(),
            answer_text: "NADH gives electrons.".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "Connect this to the proton gradient.".to_owned(),
            retry_prompt: question.follow_up,
            source: question.source,
            concept_status: agent_domain::ConceptStatus::Strong,
            confidence_score: 0.84,
        };
        self.study_store
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                "response-1",
                evaluation.clone(),
            )
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;

        let (input, _input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::AnswerEvaluated {
                    response_id: "response-2".to_owned(),
                    evaluation,
                })
                .await;
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

#[async_trait::async_trait]
impl RealtimeBrain for EventProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "event_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        if let Some(store) = &self.study_store {
            let _outcome = store
                .record_voice_session(&config)
                .await
                .map_err(|error| store_stage_error(error.kind().as_str()))?;
        }
        let (input, _input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let events_to_send = self.events.clone();
        let task = tokio::spawn(async move {
            for event in events_to_send {
                let _ = event_tx.send(event).await;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

#[async_trait::async_trait]
impl RealtimeBrain for IdleProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "idle_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        if let Some(store) = &self.study_store {
            let _outcome = store
                .record_voice_session(&config)
                .await
                .map_err(|error| store_stage_error(error.kind().as_str()))?;
        }
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            while let Some(input) = input_rx.recv().await {
                if matches!(input, BrainInput::Stop) {
                    break;
                }
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct ChattyPhaseProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for ChattyPhaseProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "chatty_phase_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let event_task = tokio::spawn(async move {
            loop {
                if event_tx
                    .send(BrainEvent::SessionPhase {
                        phase: agent_domain::StudySessionPhase::Thinking,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let input_task = tokio::spawn(async move { while input_rx.recv().await.is_some() {} });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![
                event_task.abort_handle(),
                input_task.abort_handle(),
            ])),
        })
    }
}

struct FirstAnswerOnlyProbeBrain {
    text_inputs: Arc<AtomicUsize>,
    study_store: Arc<dyn StudyMemoryStore>,
}

#[async_trait::async_trait]
impl RealtimeBrain for FirstAnswerOnlyProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "first_answer_only_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_user_id"))?
            .to_owned();
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_study_set_id"))?
            .to_owned();
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_session_id"))?
            .to_owned();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let study_store = self.study_store.clone();
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    continue;
                }
                let turn_index = text_inputs.fetch_add(1, Ordering::SeqCst) + 1;
                if turn_index != 1 {
                    continue;
                }
                let question = agent_domain::fixture_question();
                let evaluation = agent_domain::AnswerEvaluation {
                    question_id: question.question_id,
                    answer_text: "first provider turn evaluated".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Review the next step.".to_owned(),
                    retry_prompt: question.follow_up,
                    source: question.source,
                    concept_status: agent_domain::ConceptStatus::Strong,
                    confidence_score: 0.84,
                };
                let response_id = "first-answer-only-1".to_owned();
                if study_store
                    .record_answer_evaluation(
                        &user_id,
                        &study_set_id,
                        &voice_session_id,
                        &response_id,
                        evaluation.clone(),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
                let _ = event_tx
                    .send(BrainEvent::AnswerEvaluated {
                        response_id,
                        evaluation,
                    })
                    .await;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct GatedCompletionProviderProbeBrain {
    text_inputs: Arc<AtomicUsize>,
    study_store: Arc<dyn StudyMemoryStore>,
    completion_gate: Arc<Notify>,
}

#[async_trait::async_trait]
impl RealtimeBrain for GatedCompletionProviderProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "gated_completion_provider_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_user_id"))?
            .to_owned();
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_study_set_id"))?
            .to_owned();
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_session_id"))?
            .to_owned();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let study_store = self.study_store.clone();
        let completion_gate = self.completion_gate.clone();
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    continue;
                }
                let turn_index = text_inputs.fetch_add(1, Ordering::SeqCst) + 1;
                let question = agent_domain::fixture_question();
                let evaluation = agent_domain::AnswerEvaluation {
                    question_id: question.question_id,
                    answer_text: "provider turn evaluated".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Review the next step.".to_owned(),
                    retry_prompt: question.follow_up,
                    source: question.source,
                    concept_status: agent_domain::ConceptStatus::Strong,
                    confidence_score: 0.84,
                };
                let response_id = format!("answer-evaluated-{turn_index}");
                if study_store
                    .record_answer_evaluation(
                        &user_id,
                        &study_set_id,
                        &voice_session_id,
                        &response_id,
                        evaluation.clone(),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
                let _ = event_tx
                    .send(BrainEvent::AnswerEvaluated {
                        response_id: response_id.clone(),
                        evaluation,
                    })
                    .await;
                completion_gate.notified().await;
                let _ = event_tx
                    .send(BrainEvent::ResponseCompleted { response_id })
                    .await;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct AnswerEvaluatedProviderProbeBrain {
    text_inputs: Arc<AtomicUsize>,
    study_store: Arc<dyn StudyMemoryStore>,
    usage_after_evaluation: Option<(BrainUsage, Arc<Notify>)>,
}

#[async_trait::async_trait]
impl RealtimeBrain for AnswerEvaluatedProviderProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "answer_evaluated_provider_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_user_id"))?
            .to_owned();
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_study_set_id"))?
            .to_owned();
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| session_config_error("missing_session_id"))?
            .to_owned();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let text_inputs = self.text_inputs.clone();
        let study_store = self.study_store.clone();
        let usage_after_evaluation = self.usage_after_evaluation.clone();
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    continue;
                }
                let turn_index = text_inputs.fetch_add(1, Ordering::SeqCst) + 1;
                let question = agent_domain::fixture_question();
                let evaluation = agent_domain::AnswerEvaluation {
                    question_id: question.question_id,
                    answer_text: "provider turn evaluated".to_owned(),
                    label: "mostly correct".to_owned(),
                    concise_feedback: "Review the next step.".to_owned(),
                    retry_prompt: question.follow_up,
                    source: question.source,
                    concept_status: agent_domain::ConceptStatus::Strong,
                    confidence_score: 0.84,
                };
                let response_id = format!("answer-evaluated-{turn_index}");
                if study_store
                    .record_answer_evaluation(
                        &user_id,
                        &study_set_id,
                        &voice_session_id,
                        &response_id,
                        evaluation.clone(),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
                let _ = event_tx
                    .send(BrainEvent::AnswerEvaluated {
                        response_id: response_id.clone(),
                        evaluation,
                    })
                    .await;
                if let Some((usage, usage_gate)) = usage_after_evaluation.clone() {
                    usage_gate.notified().await;
                    let _ = event_tx.send(BrainEvent::Usage(usage)).await;
                }
                let _ = event_tx
                    .send(BrainEvent::ResponseCompleted { response_id })
                    .await;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct DuplicateResolutionProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for DuplicateResolutionProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "duplicate_resolution_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let mut answer_count = 0_u8;
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Audio(_)
                        | BrainInput::AudioWithMetadata { .. }
                        | BrainInput::Text(_)
                        | BrainInput::TextWithMetadata { .. }
                ) {
                    continue;
                }
                answer_count = answer_count.saturating_add(1);
                if answer_count == 2 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    for _ in 0..2 {
                        let _ = event_tx
                            .send(BrainEvent::ResponseCompleted {
                                response_id: "response-a".to_owned(),
                            })
                            .await;
                    }
                }
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct ResponseThenPhaseProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for ResponseThenPhaseProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "response_then_phase_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let mut sent = false;
            while let Some(input) = input_rx.recv().await {
                if sent {
                    continue;
                }
                if matches!(
                    input,
                    BrainInput::Audio(_)
                        | BrainInput::AudioWithMetadata { .. }
                        | BrainInput::Text(_)
                        | BrainInput::TextWithMetadata { .. }
                ) {
                    let _ = event_tx
                        .send(BrainEvent::ResponseCompleted {
                            response_id: "response-1".to_owned(),
                        })
                        .await;
                    tokio::time::sleep(Duration::from_millis(15)).await;
                    let _ = event_tx
                        .send(BrainEvent::SessionPhase {
                            phase: agent_domain::StudySessionPhase::Feedback,
                        })
                        .await;
                    sent = true;
                }
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

struct CancelledThenStaleResolutionProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for CancelledThenStaleResolutionProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "cancelled_then_stale_resolution_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(
        &self,
        _config: agent_domain::SessionConfig,
    ) -> Result<RealtimeSession, BrainError> {
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let mut answer_count = 0_u8;
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Audio(_)
                        | BrainInput::AudioWithMetadata { .. }
                        | BrainInput::Text(_)
                        | BrainInput::TextWithMetadata { .. }
                ) {
                    continue;
                }
                answer_count = answer_count.saturating_add(1);
                if answer_count == 1 {
                    let _ = event_tx
                        .send(BrainEvent::ResponseCancelledFor {
                            response_id: "response-a".to_owned(),
                        })
                        .await;
                } else if answer_count == 2 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    let _ = event_tx
                        .send(BrainEvent::ResponseCompleted {
                            response_id: "response-a".to_owned(),
                        })
                        .await;
                }
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

// -------------------------------------------------------------------------
// Task 8 (SERVICE-001, SERVICE-006, SERVICE-014): durable deferred turns and
// the between-turn idle deadline, proved on a real socket.
// -------------------------------------------------------------------------

/// Every store call the synthetic (Plan 07) outcome path makes, in order, with a
/// single injectable `record_turn_outcome` failure. Nothing is simulated: each
/// call is delegated to the real in-memory store, so a durable read after a wire
/// frame observes the same rows the runtime wrote.
struct TurnOutcomeAuditStore {
    inner: Arc<data::InMemoryStudyStore>,
    fail_turn_outcome: bool,
    calls: Mutex<Vec<&'static str>>,
}

impl TurnOutcomeAuditStore {
    fn new(inner: Arc<data::InMemoryStudyStore>, fail_turn_outcome: bool) -> Self {
        Self {
            inner,
            fail_turn_outcome,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn record(&self, call: &'static str) {
        self.calls
            .lock()
            .expect("turn outcome audit lock poisoned")
            .push(call);
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls
            .lock()
            .expect("turn outcome audit lock poisoned")
            .clone()
    }
}

#[async_trait::async_trait]
impl StudyMemoryStore for TurnOutcomeAuditStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn pending_answer_attempts_for_session(
        &self,
        voice_session_id: &str,
    ) -> Result<usize, PortError> {
        self.inner
            .pending_answer_attempts_for_session(voice_session_id)
            .await
    }

    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<agent_domain::StudyStoreWriteOutcome, PortError> {
        self.inner.record_voice_session(config).await
    }

    async fn study_session_durable_counts(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::StudySessionDurableCounts, PortError> {
        self.inner
            .study_session_durable_counts(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn answer_attempt_was_recorded(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
    ) -> Result<bool, PortError> {
        self.inner
            .answer_attempt_was_recorded(user_id, study_set_id, voice_session_id, response_id)
            .await
    }

    async fn claim_session_token_nonce(
        &self,
        claim: SessionTokenNonceClaim,
    ) -> Result<(), PortError> {
        self.inner.claim_session_token_nonce(claim).await
    }

    async fn close_voice_session(
        &self,
        voice_session_id: &str,
        terminal_reason: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .close_voice_session(voice_session_id, terminal_reason)
            .await
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        self.inner.active_question(user_id, study_set_id).await
    }

    async fn authorize_question_started(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        question: &StudyQuestion,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_question_started(user_id, study_set_id, voice_session_id, question)
            .await
    }

    async fn authorize_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: &AnswerEvaluation,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn authorize_source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        source: &StudySourceReference,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_source_reference(user_id, study_set_id, voice_session_id, source)
            .await
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
        self.inner
            .authorize_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &agent_domain::ManuscriptIntent,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_manuscript_intent(user_id, study_set_id, voice_session_id, intent)
            .await
    }

    async fn authorize_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: &StudySessionRecap,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }

    async fn record_answer_attempt_envelope(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<serde_json::Value, PortError> {
        self.record("record_answer_attempt_envelope");
        self.inner
            .record_answer_attempt_envelope(user_id, study_set_id, voice_session_id, envelope)
            .await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.record("record_answer_evaluation");
        self.inner
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
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
        self.record("record_concept_status");
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.record("schedule_review_item");
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.record("persist_review_schedule_decision");
        self.inner
            .persist_review_schedule_decision(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                decision,
            )
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.record("record_recap");
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }

    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<agent_domain::StudyStoreWriteOutcome, PortError> {
        self.inner.record_voice_usage(event).await
    }

    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: agent_domain::TurnOutcome,
    ) -> Result<agent_domain::PersistedTurnOutcome, PortError> {
        self.record("record_turn_outcome");
        if self.fail_turn_outcome {
            return Err(PortError::durability(
                "postgres",
                voice_session_id,
                "durable store write failed",
            ));
        }
        self.inner
            .record_turn_outcome(user_id, study_set_id, voice_session_id, outcome)
            .await
    }

    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::SessionLearningEvidence, PortError> {
        self.inner
            .session_learning_evidence(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: agent_domain::ProgressionPolicyId,
    ) -> Result<agent_domain::QuestionProgressionResult, PortError> {
        self.inner
            .select_next_question(user_id, study_set_id, voice_session_id, response_id, policy)
            .await
    }

    async fn record_challenge_resolution(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        resolution: agent_domain::ChallengeResolution,
    ) -> Result<agent_domain::ChallengeResolution, PortError> {
        self.inner
            .record_challenge_resolution(user_id, study_set_id, voice_session_id, resolution)
            .await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        self.inner
            .authenticated_study_projection(user_id, study_set_id, voice_session_id)
            .await
    }
}

/// `bac522-deferred-2` is chosen so the synthetic fixture evaluator's
/// response-identity cursor lands on `deferred_insufficient_semantic_evidence`.
/// The assertion on the wire reason keeps a drift in that cursor loud instead of
/// silently turning this into an evaluated-turn test.
const TURN_DEFERRED_GENERATION_ID: &str = "bac522-deferred-2";

fn turn_deferred_session_config_json(generation_id: &str) -> String {
    let session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    serde_json::json!({
        "type": "session_config",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": generation_id,
        "session": session,
        "session_token": VOICE_TEST_PLACEHOLDER_CREDENTIAL,
    })
    .to_string()
}

async fn run_turn_deferred_probe(
    fail_turn_outcome: bool,
) -> Option<(Vec<ServerFrame>, Arc<TurnOutcomeAuditStore>)> {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(TurnOutcomeAuditStore::new(inner, fail_turn_outcome));
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(brain_store)),
        "synthetic",
        VoiceWsAccess::default(),
        2,
        state_store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(10),
        between_turn_idle: Duration::from_secs(10),
        session: Duration::from_secs(20),
        ..WsTimeouts::default()
    });
    let url = spawn_server(state).await?;
    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "synthetic").await;
    socket
        .send(WsMessage::Text(
            turn_deferred_session_config_json(TURN_DEFERRED_GENERATION_ID).into(),
        ))
        .await
        .unwrap();

    let mut frames = Vec::new();
    loop {
        let frame = read_server_frame(&mut socket).await;
        let saw_question = matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        );
        frames.push(frame);
        if saw_question {
            break;
        }
    }
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: TURN_DEFERRED_GENERATION_ID.to_owned(),
            turn_id: "turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "electrons move through the chain".to_owned(),
            },
        },
    )
    .await;

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let frame = tokio::time::timeout(Duration::from_secs(4), socket.next()).await;
        let Ok(Some(Ok(message))) = frame else {
            break;
        };
        match message {
            WsMessage::Text(text) => {
                let frame: ServerFrame = serde_json::from_str(&text).unwrap();
                let stop = matches!(
                    &frame,
                    ServerFrame::Event { event, .. }
                        if matches!(event.as_ref(), VivaServerEvent::TurnDeferred { .. })
                ) || terminal_session_reason(&frame).is_some();
                frames.push(frame);
                if stop {
                    break;
                }
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }
    Some((frames, store))
}

/// `SERVICE-014`: the deferral the learner sees is the one Plan 07 already
/// persisted. The durable outcome is readable at the instant the nonterminal
/// frame arrives, and the frame carries the persisted turn binding.
#[tokio::test]
async fn turn_deferred_frame_follows_the_persisted_outcome() {
    let Some((frames, store)) = run_turn_deferred_probe(false).await else {
        return;
    };

    let (turn_id, response_id, question_id, reason, can_retry_same_question) = frames
        .iter()
        .find_map(|frame| match frame {
            ServerFrame::Event { event, .. } => match event.as_ref() {
                VivaServerEvent::TurnDeferred {
                    turn_id,
                    response_id,
                    question_id,
                    reason,
                    can_retry_same_question,
                } => Some((
                    turn_id.clone(),
                    response_id.clone(),
                    question_id.clone(),
                    reason.clone(),
                    *can_retry_same_question,
                )),
                _ => None,
            },
            _ => None,
        })
        .expect("turn_deferred frame");

    let question_turn_id = frames
        .iter()
        .find_map(|frame| match frame {
            ServerFrame::Event { event, .. } => match event.as_ref() {
                VivaServerEvent::QuestionStarted {
                    turn_id,
                    response_id: question_response_id,
                    ..
                } if *question_response_id == response_id => Some(turn_id.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("question_started that opened the deferred turn");
    assert_eq!(
        turn_id, question_turn_id,
        "the deferral must name the turn its question opened"
    );
    assert_eq!(
        reason,
        agent_domain::EvaluationDeferralReason::InsufficientSemanticEvidence
    );
    assert!(can_retry_same_question);
    assert!(!question_id.trim().is_empty());

    // The deferral is nonterminal: no terminal phase precedes it.
    let deferred_index = frames
        .iter()
        .position(|frame| {
            matches!(
                frame,
                ServerFrame::Event { event, .. }
                    if matches!(event.as_ref(), VivaServerEvent::TurnDeferred { .. })
            )
        })
        .expect("deferral index");
    assert!(
        frames[..deferred_index]
            .iter()
            .all(|frame| terminal_session_reason(frame).is_none()),
        "a deferral is never preceded by a terminal phase"
    );

    let calls = store.calls();
    assert!(
        calls.contains(&"record_turn_outcome"),
        "the persisted outcome is the only source of a deferral: {calls:?}"
    );
    // A deferred outcome states no mastery: no evaluation, status, schedule, or
    // recap write is authorized by it.
    let counts = store.write_counts();
    assert_eq!(counts.concept_statuses, 0, "{calls:?}");
    assert_eq!(counts.review_items, 0, "{calls:?}");
    assert!(
        !frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::AnswerEvaluated { .. } | VivaServerEvent::ConceptStatus { .. }
                )
        )),
        "a deferral never carries a graded fact"
    );
}

/// A store that cannot persist the outcome yields no learner fact at all: no
/// deferral, no evaluation, no concept status, no review write, no graded recap.
#[tokio::test]
async fn turn_deferred_store_failure_emits_no_learner_fact() {
    let Some((frames, store)) = run_turn_deferred_probe(true).await else {
        return;
    };

    assert!(store.calls().contains(&"record_turn_outcome"));
    assert!(
        !frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::TurnDeferred { .. }
                        | VivaServerEvent::AnswerEvaluated { .. }
                        | VivaServerEvent::ConceptStatus { .. }
                )
        )),
        "a failed outcome write must not reach the learner: {frames:?}"
    );
    assert!(
        !frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::RecapReady { .. })
        )),
        "a failed outcome write must not produce a graded recap"
    );
    let counts = store.write_counts();
    assert_eq!(counts.concept_statuses, 0);
    assert_eq!(counts.review_items, 0);
    assert_eq!(counts.recaps, 0);
    let calls = store.calls();
    assert!(!calls.contains(&"record_answer_evaluation"), "{calls:?}");
    assert!(!calls.contains(&"record_concept_status"), "{calls:?}");
    assert!(
        !calls.contains(&"persist_review_schedule_decision"),
        "{calls:?}"
    );
    assert!(!calls.contains(&"record_recap"), "{calls:?}");
}

/// A provider that persists its outcome through Plan 07's durable port and then
/// resolves a response identity it never announced, while **two** client
/// submissions are open. Nothing on the wire says which of the two the deferral
/// belongs to, so the socket must refuse to name either.
struct AmbiguousDeferralProbeBrain {
    study_store: Arc<dyn StudyMemoryStore>,
}

const AMBIGUOUS_DEFERRAL_RESPONSE_ID: &str = "response-1-generation-rekeyed-by-the-provider";

#[async_trait::async_trait]
impl RealtimeBrain for AmbiguousDeferralProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "ambiguous_deferral_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let store = self.study_store.clone();
        let user_id = config.user_id.clone().unwrap_or_default();
        let study_set_id = config.study_set_id.clone().unwrap_or_default();
        let voice_session_id = config
            .session_id
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            let question = agent_domain::fixture_question();
            let question_id = question.question_id.clone();
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: question.clone(),
                })
                .await;
            let mut answers = 0_u32;
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Text(_)
                        | BrainInput::TextWithMetadata { .. }
                        | BrainInput::Audio(_)
                        | BrainInput::AudioWithMetadata { .. }
                ) {
                    continue;
                }
                answers += 1;
                // The deferral is emitted only once BOTH submissions are open,
                // so the ambiguity is a property of the test, not of a race.
                if answers < 2 {
                    // The announced question resolves, which frees the socket to
                    // admit a second submission. `response_completed` carries no
                    // browser frame of its own, so a `feedback` phase follows it
                    // as the marker the client waits on before speaking again —
                    // that keeps the second submission out of a race with the
                    // first turn's admission.
                    let _ = event_tx
                        .send(BrainEvent::ResponseCompleted {
                            response_id: "response-1".to_owned(),
                        })
                        .await;
                    let _ = event_tx
                        .send(BrainEvent::SessionPhase {
                            phase: agent_domain::StudySessionPhase::Feedback,
                        })
                        .await;
                    continue;
                }
                // Plan 07's real durable path: the outcome is persisted before
                // any learner-visible event derived from it is emitted.
                let outcome = agent_domain::TurnOutcome {
                    schema: agent_domain::learning_outcome::VIVA_TURN_OUTCOME_SCHEMA.to_owned(),
                    response_id: AMBIGUOUS_DEFERRAL_RESPONSE_ID.to_owned(),
                    question_id: question_id.clone(),
                    rubric_policy_version: "viva.rubric.v1".to_owned(),
                    recorded_at: "2026-08-24T00:00:00Z".to_owned(),
                    source_ids: vec![],
                    supersedes_response_id: None,
                    resolution: agent_domain::TurnResolution::Deferred {
                        reason: agent_domain::EvaluationDeferralReason::EvaluatorUnavailable,
                        can_retry_same_question: true,
                        disposition: agent_domain::QuestionDisposition::RetryCurrent,
                    },
                };
                if store
                    .record_turn_outcome(&user_id, &study_set_id, &voice_session_id, outcome)
                    .await
                    .is_err()
                {
                    continue;
                }
                let _ = event_tx
                    .send(BrainEvent::TurnDeferred {
                        response_id: AMBIGUOUS_DEFERRAL_RESPONSE_ID.to_owned(),
                        question_id: question_id.clone(),
                        reason: agent_domain::EvaluationDeferralReason::EvaluatorUnavailable,
                        can_retry_same_question: true,
                    })
                    .await;
                // A later announced question is the probe for what the refused
                // deferral did to the socket's ledger: it must still find the
                // oldest open submission waiting for it.
                let _ = event_tx
                    .send(BrainEvent::QuestionStarted {
                        response_id: "response-2".to_owned(),
                        question: question.clone(),
                    })
                    .await;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

/// `SERVICE-014`: missing and ambiguous turn bindings fail closed.
///
/// The provider persists a real deferred outcome and then resolves a response
/// identity this socket never announced, with two client submissions open. The
/// oldest open submission is not evidence that the deferral belongs to it, so
/// the socket must emit no `turn_deferred` frame at all rather than name a turn
/// it cannot show the deferral belongs to — and it must not consume that turn's
/// binding either, which is the harm a silent oldest-first guess causes: the
/// next announced question would then be bound to the wrong submission.
#[tokio::test]
async fn turn_deferred_ambiguous_binding_emits_no_frame_and_consumes_no_submission() {
    let inner = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let store = Arc::new(TurnOutcomeAuditStore::new(inner, false));
    let state_store: Arc<dyn StudyMemoryStore> = store.clone();
    let brain_store: Arc<dyn StudyMemoryStore> = store.clone();
    let state = AppState::with_study_store(
        Arc::new(AmbiguousDeferralProbeBrain {
            study_store: brain_store,
        }),
        "ambiguous_deferral_probe",
        VoiceWsAccess::default(),
        2,
        state_store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(10),
        between_turn_idle: Duration::from_secs(10),
        session: Duration::from_secs(20),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "ambiguous_deferral_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    let announced_turn_id = loop {
        let frame = read_server_frame(&mut socket).await;
        if let ServerFrame::Event { event, .. } = &frame {
            if let VivaServerEvent::QuestionStarted { turn_id, .. } = event.as_ref() {
                break turn_id.clone();
            }
        }
    };

    // Two open client submissions, neither of which the provider ever announced
    // a question for: the client names its own turn ids, the way a streamed
    // audio turn does. The second is sent only after the first has resolved, so
    // it is admitted rather than refused as an overlapping turn.
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-ambiguous-a".to_owned(),
            turn_id: "turn-a".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "an answer submitted as turn-a".to_owned(),
            },
        },
    )
    .await;
    loop {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase { phase, .. }
                        if *phase == agent_domain::StudySessionPhase::Feedback
                )
        ) {
            break;
        }
    }
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-ambiguous-b".to_owned(),
            turn_id: "turn-b".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "an answer submitted as turn-b".to_owned(),
            },
        },
    )
    .await;

    // Read until the provider's next announced question, which is emitted right
    // after the refused deferral, or until the socket ends.
    let mut frames = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        let Ok(Some(Ok(message))) =
            tokio::time::timeout(Duration::from_secs(2), socket.next()).await
        else {
            break;
        };
        match message {
            WsMessage::Text(text) => {
                let frame: ServerFrame = serde_json::from_str(&text).unwrap();
                let stop = matches!(
                    &frame,
                    ServerFrame::Event { event, .. }
                        if matches!(
                            event.as_ref(),
                            VivaServerEvent::QuestionStarted { response_id, .. }
                                if response_id == "response-2"
                        )
                ) || terminal_session_reason(&frame).is_some();
                frames.push(frame);
                if stop {
                    break;
                }
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }

    // The durable outcome was written: this is a binding refusal, not a missing
    // provider result.
    assert!(
        store.calls().contains(&"record_turn_outcome"),
        "the probe must have persisted its outcome: {:?}",
        store.calls()
    );
    let deferrals = frames
        .iter()
        .filter_map(|frame| match frame {
            ServerFrame::Event { event, .. } => match event.as_ref() {
                VivaServerEvent::TurnDeferred { turn_id, .. } => Some(turn_id.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(
        deferrals.is_empty(),
        "an ambiguous deferral must name no turn at all, got {deferrals:?} \
         (open submissions were turn-a and turn-b; the announced turn was {announced_turn_id})"
    );

    // Nothing was consumed: the next announced question still finds the oldest
    // open submission. A silent oldest-first guess would have spent `turn-a` on
    // the refused deferral and bound this question to `turn-b`.
    let next_question_turn_id = frames
        .iter()
        .find_map(|frame| match frame {
            ServerFrame::Event { event, .. } => match event.as_ref() {
                VivaServerEvent::QuestionStarted {
                    turn_id,
                    response_id,
                    ..
                } if response_id == "response-2" => Some(turn_id.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("the provider's next announced question");
    assert_eq!(
        next_question_turn_id, "turn-a",
        "the refused deferral must not have consumed an open submission: {frames:?}"
    );
}

/// A provider that finishes one turn and then says nothing. The socket must be
/// returned to the between-turn deadline rather than left alive until the
/// six-hour absolute session cap.
struct BetweenTurnIdleProbeBrain {
    study_store: Arc<dyn StudyMemoryStore>,
}

#[async_trait::async_trait]
impl RealtimeBrain for BetweenTurnIdleProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "between_turn_idle_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: agent_domain::fixture_question(),
                })
                .await;
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Text(_)
                        | BrainInput::TextWithMetadata { .. }
                        | BrainInput::Audio(_)
                        | BrainInput::AudioWithMetadata { .. }
                ) {
                    continue;
                }
                let _ = event_tx
                    .send(BrainEvent::ResponseCompleted {
                        response_id: "response-1".to_owned(),
                    })
                    .await;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

/// `SERVICE-001`: a completed provider turn re-arms the between-turn deadline,
/// and its expiry drops every server-owned lease.
#[tokio::test]
async fn between_turn_idle_expiry_releases_session_ip_and_provider_leases() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BetweenTurnIdleProbeBrain {
            study_store: store.clone(),
        }),
        "between_turn_idle_probe",
        VoiceWsAccess::default(),
        2,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        max_user_sessions: Some(1),
        provider_limiter_enabled: true,
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    })
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        // The in-turn deadline is deliberately long: only the between-turn
        // deadline may end a socket whose turn already resolved.
        idle: Duration::from_secs(4),
        between_turn_idle: Duration::from_millis(250),
        session: Duration::from_secs(8),
        ..WsTimeouts::default()
    });
    let limits = state.limit_state.clone();
    let slots = state.session_slots.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "between_turn_idle_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }
    assert_eq!(limits.ip_lease_count(TEST_PEER_IP), Some(1));

    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-between-turn-idle".to_owned(),
            turn_id: "turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "an answer the provider completes".to_owned(),
            },
        },
    )
    .await;

    let terminal = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame = read_server_frame(&mut socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                return frame;
            }
        }
    })
    .await
    .expect("a completed provider turn must re-arm the between-turn deadline");
    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
    assert_close_code(&mut socket, CloseCode::Policy).await;

    wait_for_released_ip_lease(&limits, TEST_PEER_IP).await;
    wait_until(Duration::from_secs(5), || slots.available_permits() == 2).await;

    // The user, study-set, and provider leases are gone too: the same identity
    // reconnects and is admitted a provider turn immediately.
    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "between_turn_idle_probe").await;
    send_client_frame(&mut second_socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut second_socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-between-turn-idle-2".to_owned(),
            turn_id: "turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "the provider slot was released".to_owned(),
            },
        },
    )
    .await;
    let second_terminal = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame = read_server_frame(&mut second_socket).await;
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                return frame;
            }
        }
    })
    .await
    .expect("the reconnecting session was admitted and re-armed");
    assert_terminal_session_phase(second_terminal, TerminalSessionReason::TurnCap);
}

/// Keepalives are not work: a Ping/Pong pair cannot postpone the between-turn
/// deadline of a socket whose turn already resolved.
#[tokio::test]
async fn between_turn_idle_is_not_postponed_by_client_keepalives() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(BetweenTurnIdleProbeBrain {
            study_store: store.clone(),
        }),
        "between_turn_idle_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(4),
        between_turn_idle: Duration::from_millis(250),
        session: Duration::from_secs(8),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "between_turn_idle_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-between-turn-keepalive".to_owned(),
            turn_id: "turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "an answer the provider completes".to_owned(),
            },
        },
    )
    .await;

    let started = Instant::now();
    let terminal = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let _ = socket.send(WsMessage::Ping(Vec::new().into())).await;
            let Some(Ok(message)) = socket.next().await else {
                panic!("socket ended without a terminal phase");
            };
            let WsMessage::Text(text) = message else {
                continue;
            };
            let frame: ServerFrame = serde_json::from_str(&text).unwrap();
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::TurnCap) {
                return frame;
            }
        }
    })
    .await
    .expect("client keepalives postponed the between-turn deadline");
    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the between-turn deadline moved with keepalives"
    );
}

// -------------------------------------------------------------------------
// Task 10 (SERVICE-001): a half-open socket expires on the server's own
// heartbeat rather than surviving to the absolute session cap.
// -------------------------------------------------------------------------

/// A provider that holds one turn open forever, so the only thing that can end
/// the socket is a server-owned deadline.
struct HalfOpenProbeBrain {
    study_store: Arc<dyn StudyMemoryStore>,
}

#[async_trait::async_trait]
impl RealtimeBrain for HalfOpenProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "half_open_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let _outcome = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| store_stage_error(error.kind().as_str()))?;
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: agent_domain::fixture_question(),
                })
                .await;
            // Consume input and never resolve the turn.
            while input_rx.recv().await.is_some() {}
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

/// `SERVICE-001`: a client that stops reading and stops writing is detected by
/// the server's own heartbeat. Every server-owned permit — session slot, IP
/// lease, user/study-set lease, provider lease — is back before one heartbeat
/// interval has passed, and a fresh client for the same identity connects.
#[tokio::test]
async fn half_open_socket_expires_and_releases_every_server_owned_lease() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(HalfOpenProbeBrain {
            study_store: store.clone(),
        }),
        "half_open_probe",
        VoiceWsAccess::default(),
        2,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        max_user_sessions: Some(1),
        provider_limiter_enabled: true,
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    })
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        // Every other deadline is far away: only the heartbeat can end this socket.
        idle: Duration::from_secs(30),
        between_turn_idle: Duration::from_secs(30),
        session: Duration::from_secs(30),
        heartbeat_interval: Duration::from_millis(120),
        pong_timeout: Duration::from_millis(60),
        ..WsTimeouts::default()
    });
    let limits = state.limit_state.clone();
    let slots = state.session_slots.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "half_open_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }
    // One admitted answer holds the only provider slot; the provider never
    // resolves it.
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-half-open".to_owned(),
            turn_id: "turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "an answer the provider never resolves".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        limits.ip_lease_count(TEST_PEER_IP) == Some(1)
    })
    .await;
    assert_eq!(slots.available_permits(), 1);

    // The client goes half-open: the socket object is kept alive, but the test
    // stops reading it and never writes again, so no Pong will ever be answered.
    let half_open = socket;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if limits.ip_lease_count(TEST_PEER_IP).is_none() && slots.available_permits() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        limits.ip_lease_count(TEST_PEER_IP),
        None,
        "the half-open socket must release its IP lease"
    );
    assert_eq!(slots.available_permits(), 2);
    // The half-open detection signal this row exists to add: the recorded label
    // is `heartbeat_timeout`, never the slow-reader label a missed outbound
    // write records. The wire still closes on Plan 05's published slow-client
    // contract — `ws::tests::heartbeat_expiry_records_heartbeat_timeout_on_the_slow_client_wire_contract`
    // pins both halves against a recording sink.
    let recorded = evidence.snapshot();
    assert!(
        recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == "heartbeat_timeout"
        }),
        "{recorded:?}"
    );
    assert!(
        !recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == TerminalSessionReason::SlowClient.as_str()
        }),
        "a half-open socket must not be recorded as a slow reader: {recorded:?}"
    );
    drop(half_open);

    // The user, study-set, and provider leases are gone too: the same identity
    // reconnects and is admitted a provider turn.
    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "half_open_probe").await;
    send_client_frame(&mut second_socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut second_socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }
    send_client_frame(
        &mut second_socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "bac522-half-open-2".to_owned(),
            turn_id: "turn-1".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "the provider slot was released".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .filter(|event| {
                event.kind == VoiceEvidenceEventKind::AnswerReceived
                    && event.detail == "text answer received"
            })
            .count()
            == 2
    })
    .await;
}

/// A client that keeps answering the server's Pings stays connected across many
/// heartbeat intervals; the keepalives never end the socket and never move any
/// other deadline.
#[tokio::test]
async fn half_open_answered_heartbeats_keep_the_socket_alive() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(HalfOpenProbeBrain {
            study_store: store.clone(),
        }),
        "half_open_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(30),
        between_turn_idle: Duration::from_secs(30),
        session: Duration::from_secs(30),
        heartbeat_interval: Duration::from_millis(60),
        pong_timeout: Duration::from_millis(30),
        ..WsTimeouts::default()
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "half_open_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;

    // Reading the socket is what answers the server's Pings: tokio-tungstenite
    // replies to a Ping while the stream is polled.
    let mut pings = 0_usize;
    let deadline = Instant::now() + Duration::from_millis(600);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), socket.next()).await {
            Ok(Some(Ok(WsMessage::Ping(_)))) => pings += 1,
            Ok(Some(Ok(WsMessage::Close(frame)))) => {
                panic!("an answered heartbeat must not close the socket: {frame:?}")
            }
            Ok(Some(Ok(_))) | Err(_) => {}
            Ok(Some(Err(error))) => panic!("socket error: {error:?}"),
            Ok(None) => panic!("an answered heartbeat must not end the socket"),
        }
    }
    assert!(
        pings >= 3,
        "the server must keep pinging across heartbeat intervals, saw {pings}"
    );
}

/// `SERVICE-002`: the last two bounded writes survive the unwind.
///
/// A client that pipelines frames still has bytes on the wire when the server
/// decides to close. Dropping a socket that holds unread client bytes resets the
/// connection, and a reset discards the error frame and the Close frame the
/// server already wrote — the learner sees a transport error instead of the
/// reason they were closed. This is the socket-level half of Task 9: the
/// deterministic sink tests are in-crate because a TCP buffer cannot simulate a
/// stalled reader, but *this* property is only observable over a real socket,
/// and only with a real backlog behind the offending frame.
#[tokio::test]
async fn bounded_writes_deliver_the_terminal_frame_and_close_with_client_bytes_in_flight() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(HalfOpenProbeBrain {
            study_store: store.clone(),
        }),
        "half_open_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(30),
        between_turn_idle: Duration::from_secs(30),
        session: Duration::from_secs(30),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "half_open_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }

    // One frame the server refuses, then a real backlog written behind it
    // without reading anything back. The server stops reading at the refusal, so
    // the filler stays unread while the error frame and the Close frame are
    // written. Each filler frame stays under the protocol's text-frame ceiling,
    // and the whole burst stays well under a socket send buffer so the client
    // itself never blocks.
    const INFLIGHT_FILLER_FRAMES: usize = 6;
    const INFLIGHT_FILLER_BYTES: usize = 32 * 1024;
    socket
        .send(WsMessage::Text(
            "x".repeat(agent_service::VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1)
                .into(),
        ))
        .await
        .unwrap();
    for index in 1..=INFLIGHT_FILLER_FRAMES {
        send_client_frame(
            &mut socket,
            &ClientFrame::TurnIntent {
                version: VIVA_VOICE_PROTOCOL_VERSION,
                client_generation_id: format!("bac522-inflight-{index}"),
                turn_id: format!("turn-inflight-{index}"),
                intent: ClientTurnIntent::AnswerText {
                    text: "x".repeat(INFLIGHT_FILLER_BYTES),
                },
            },
        )
        .await;
    }

    // Both writes reach the client rather than dying with the connection.
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { error, .. } if error.message == "text frame exceeds maximum size"
    ));
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("the close frame must arrive rather than the connection resetting")
        .expect("the socket must not end before its close frame")
        .expect("the socket must not fail before its close frame")
    {
        WsMessage::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Size),
        other => panic!("expected a close frame, got {other:?}"),
    }
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(
        events.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == "oversized_text_frame"
        }),
        "{events:?}"
    );
}

/// `A-20.2`: a `slow_client` terminal REASON is not a failed write SIDE.
///
/// `slow_client` is Plan 05's published wire reason for "this socket is not
/// keeping up", and the overlapping-provider-turn policy denial closes with it
/// while every server write is succeeding instantly. Inferring "the write side
/// failed" from that sanitized label skipped the closing handshake, so the
/// socket was dropped on top of the client's still-unread pipelined bytes and
/// the connection reset — discarding the terminal frame and the Close frame the
/// server had already written. The learner is told nothing; the browser sees a
/// transport error.
///
/// This is the same property as the test above, taken on the other branch of the
/// guard: the client is reading perfectly well, it simply has bytes in flight
/// behind the frame the server refused.
#[tokio::test]
async fn bounded_writes_deliver_the_terminal_frame_and_close_after_a_denied_overlapping_turn() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = AppState::new(
        Arc::new(BlockingProviderProbeBrain {
            text_inputs: text_inputs.clone(),
        }),
        "cartesia_gemini",
        VoiceWsAccess::default(),
        4,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    })
    // The subject is the closing handshake, not a deadline: every deadline stays
    // far clear of the denial so nothing else can end this socket.
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(30),
        between_turn_idle: Duration::from_secs(30),
        session: Duration::from_secs(30),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));

    // One answer the provider never resolves, so it keeps the only provider slot.
    send_client_frame(
        &mut socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "a20-handshake-first".to_owned(),
            turn_id: "turn-a20-first".to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "admission probe".to_owned(),
            },
        },
    )
    .await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    // The overlapping answers, written as one burst without reading anything
    // back. The server refuses the first one it cannot queue and stops reading
    // there, so the rest of the burst is still unread when the socket unwinds.
    // Each frame stays under the protocol's text-frame ceiling, and the whole
    // burst stays well under a socket send buffer so the client never blocks.
    const INFLIGHT_FILLER_FRAMES: usize = 6;
    const INFLIGHT_FILLER_BYTES: usize = 32 * 1024;
    for index in 1..=INFLIGHT_FILLER_FRAMES {
        socket
            .feed(WsMessage::Text(
                serde_json::to_string(&ClientFrame::TurnIntent {
                    version: VIVA_VOICE_PROTOCOL_VERSION,
                    client_generation_id: format!("a20-handshake-inflight-{index}"),
                    turn_id: format!("turn-a20-inflight-{index}"),
                    intent: ClientTurnIntent::AnswerText {
                        text: "x".repeat(INFLIGHT_FILLER_BYTES),
                    },
                })
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
    }
    socket.flush().await.unwrap();

    // Both writes must reach the client rather than dying with the connection.
    let terminal = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = match socket.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    serde_json::from_str::<ServerFrame>(&text).unwrap()
                }
                Some(Ok(_)) => continue,
                Some(Err(error)) => panic!(
                    "the denied overlap must deliver its terminal frame, not reset the \
                     connection: {error:?}"
                ),
                None => panic!("the socket ended before its terminal frame"),
            };
            if terminal_session_reason(&frame) == Some(TerminalSessionReason::SlowClient) {
                return frame;
            }
        }
    })
    .await
    .expect("the denied overlap must deliver its terminal frame");
    assert_terminal_session_phase(terminal, TerminalSessionReason::SlowClient);
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("the close frame must arrive rather than the connection resetting")
        .expect("the socket must not end before its close frame")
        .expect("the socket must not fail before its close frame")
    {
        WsMessage::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Policy),
        other => panic!("expected a close frame, got {other:?}"),
    }
    match tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("the socket must reach a clean end of stream")
    {
        None => {}
        Some(Ok(other)) => panic!("expected end of stream, got {other:?}"),
        Some(Err(error)) => panic!(
            "the closing handshake must complete rather than resetting the connection: {error:?}"
        ),
    }
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);
    assert!(evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderAdmission
            && event.detail.contains("admission_decision=denied")
            && event.detail.contains("reason=overlapping_provider_turn")
            && event.detail.contains("terminal_reason=slow_client")
    }));
}

/// Independent-review CRITICAL (cancel-after-submit): a scoped cancel that names
/// a turn the client has already ended must not end the session.
///
/// The browser decides to cancel while its own `audio_end` is already on the
/// wire; the server has no way to make that race disappear. Before this fix the
/// late cancel found no open assembly, was classified `invalid_audio_frame`, and
/// closed the socket with a PROTOCOL code — a learner losing their session for
/// tapping cancel a few milliseconds late. Existing coverage stopped at the
/// mid-stream cancel; this is the after-`audio_end` case.
#[tokio::test]
async fn websocket_scoped_cancel_after_audio_end_does_not_close_the_session() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(HalfOpenProbeBrain {
            study_store: store.clone(),
        }),
        "half_open_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(10),
        between_turn_idle: Duration::from_secs(10),
        session: Duration::from_secs(20),
        ..WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut socket, "half_open_probe").await;
    send_client_frame(&mut socket, &fixture_session_config_frame()).await;
    loop {
        let frame = read_server_frame(&mut socket).await;
        if matches!(
            &frame,
            ServerFrame::Event { event, .. }
                if matches!(event.as_ref(), VivaServerEvent::QuestionStarted { .. })
        ) {
            break;
        }
    }

    send_v5_audio_turn(&mut socket, "turn-late-cancel", &[1_u8, 2]).await;
    assert!(matches!(
        read_server_frame_exact(&mut socket).await,
        ServerFrame::AudioTurnAccepted { turn_id, .. } if turn_id == "turn-late-cancel"
    ));

    // The cancel the learner sent a moment too late.
    send_client_frame(
        &mut socket,
        &ClientFrame::Cancel {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: VOICE_TEST_CLIENT_GENERATION.to_owned(),
            turn_id: Some("turn-late-cancel".to_owned()),
        },
    )
    .await;

    // It is recorded as a cancel, and the socket is still open: no error frame,
    // no close, no terminal reason.
    wait_until(Duration::from_secs(2), || {
        evidence
            .snapshot()
            .iter()
            .any(|event| event.kind == VoiceEvidenceEventKind::CancelReceived)
    })
    .await;
    match tokio::time::timeout(Duration::from_millis(300), socket.next()).await {
        Err(_) => {}
        Ok(Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_)))) => {}
        Ok(other) => panic!("a late scoped cancel must not end the session, got {other:?}"),
    }
    assert!(
        evidence.snapshot().iter().all(|event| {
            event.kind != VoiceEvidenceEventKind::TerminalReason
                && event.kind != VoiceEvidenceEventKind::Close
        }),
        "{:?}",
        evidence.snapshot()
    );

    // Repeating the late cancel is still benign, and a cancel naming a turn this
    // connection never saw is still refused.
    send_client_frame(
        &mut socket,
        &ClientFrame::Cancel {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: VOICE_TEST_CLIENT_GENERATION.to_owned(),
            turn_id: Some("turn-late-cancel".to_owned()),
        },
    )
    .await;
    send_client_frame(
        &mut socket,
        &ClientFrame::Cancel {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: VOICE_TEST_CLIENT_GENERATION.to_owned(),
            turn_id: Some("turn-never-seen".to_owned()),
        },
    )
    .await;
    let error = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match socket.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    if let ServerFrame::Error { error, .. } =
                        serde_json::from_str::<ServerFrame>(&text).unwrap()
                    {
                        return error;
                    }
                }
                Some(Ok(_)) => {}
                other => panic!("expected the unknown turn to be refused, got {other:?}"),
            }
        }
    })
    .await
    .expect("a cancel for a turn this connection never saw is still refused");
    assert_eq!(
        error.code,
        VoiceServerErrorCode::ClientFrameMalformed.as_str()
    );
    assert_close_code(&mut socket, CloseCode::Protocol).await;
}

/// `SERVICE-012`: the drain's missed-wakeup guard, pinned where it actually lives.
///
/// `Notify::notify_waiters` stores no permit, so a waiter that registers *after*
/// its zero check can never be woken by the drop that made the check stale — the
/// drain would then sit out its whole grace with the runtime already at zero.
/// The ordering is a property of one function, and the window it closes is a few
/// instructions wide, so it is characterized here rather than raced for.
#[test]
fn server_owned_capacity_drain_registers_its_waiter_before_each_zero_check() {
    let body = APP_SOURCE
        .split_once("pub async fn begin_drain_and_wait")
        .expect("begin_drain_and_wait is the one drain entry point")
        .1
        .split_once("\n}\n")
        .expect("the drain function closes")
        .0;
    let enable = body
        .find(".enable();")
        .expect("the zero waiter is enabled, not merely constructed");
    let zero_check = body
        .find("state.runtime_tracker.counts() == (0, 0)")
        .expect("the drain waits on both counters");
    let wait = body
        .find("tokio::time::timeout_at(deadline, notified)")
        .expect("the wait is bounded by the absolute grace deadline");
    let notified = body
        .find("state.runtime_tracker.zero.notified()")
        .expect("the waiter is built from the tracker's zero notification");
    assert!(
        notified < enable && enable < zero_check && zero_check < wait,
        "the waiter must be constructed and enabled before the zero check,          and only then awaited"
    );
    assert_eq!(
        body.matches("state.runtime_tracker.counts()").count(),
        1,
        "one zero check, inside the loop that owns the registered waiter"
    );
    // The drain flag is closed before the accepted sessions are told to stop, so
    // no upgrade can slip in behind the wait.
    let begin_drain = body
        .find("state.runtime_tracker.begin_drain();")
        .expect("the tracker drain latches first");
    let signal_drain = body
        .find("state.drain_signal.begin_drain();")
        .expect("the accepted sessions are signalled second");
    assert!(begin_drain < signal_drain && signal_drain < notified);
}

/// `SERVICE-012`: the process no longer sleeps a fixed two seconds and hopes.
#[test]
fn server_owned_capacity_shutdown_waits_on_the_configured_drain_grace() {
    assert!(
        MAIN_SOURCE.contains("begin_drain_and_wait(&state, grace)"),
        "shutdown drains through the server-owned wait"
    );
    assert!(
        MAIN_SOURCE.contains("let grace = state.ws_timeouts.drain_grace;"),
        "the grace is the configured VIVA_VOICE_DRAIN_GRACE_SECONDS bound"
    );
    assert!(
        !MAIN_SOURCE.contains("tokio::time::sleep"),
        "no unconditional shutdown sleep survives"
    );
    // Only counts reach the log when the grace expires.
    let timed_out = MAIN_SOURCE
        .split_once("DrainOutcome::TimedOut(snapshot)")
        .expect("the timeout arm is handled")
        .1;
    for forbidden in [
        "user_id",
        "voice_session_id",
        "study_set_id",
        "ip =",
        "peer",
    ] {
        assert!(
            !timed_out.contains(forbidden),
            "the drain timeout log must carry counts only, found {forbidden}"
        );
    }
}

/// `D-04 CONFIRM_DELETE` is the recorded branch, so no deletion finalizer exists
/// to join at drain and no production path acquires a background-worker guard.
/// The counter is still waited on, so a future worker cannot be drained past.
#[test]
fn server_owned_capacity_has_no_background_worker_under_confirm_delete() {
    for source in [WS_SOURCE, APP_SOURCE, MAIN_SOURCE] {
        // Everything before the crate's first `#[cfg(test)]` is what ships.
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert_eq!(
            production.matches("enter_background_worker()").count(),
            0,
            "no production site acquires a background-worker guard under CONFIRM_DELETE"
        );
    }
    assert!(
        APP_SOURCE.contains("pub fn enter_background_worker"),
        "the guard the drain waits on still exists"
    );
    assert!(
        !LIB_SOURCE.contains("restore") && !WS_SOURCE.contains("deletion_finalizer"),
        "CONFIRM_DELETE leaves no restore or finalizer surface"
    );
}

/// `SERVICE-012`: every capacity dimension the server owns, read back through the
/// one sanitized runtime snapshot. Nothing here reads a client close frame.
fn capacity_probe_state(
    max_sessions: usize,
    text_inputs: Arc<AtomicUsize>,
    voice_limits: VoiceLimitConfig,
) -> AppState {
    // One active session per (user, study set) is a separate server-owned cap, so
    // every concurrent probe socket names a different set.
    let store = provider_limiter_test_store();
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "physics-final".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Physics Final".to_owned(),
        course: Some("Physics 201".to_owned()),
        ingestion_status: StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids: vec![],
        question_ids: vec![],
    });
    AppState::with_study_store(
        Arc::new(BlockingProviderProbeBrain { text_inputs }),
        "cartesia_gemini",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec![],
        },
        max_sessions,
        store,
    )
    .with_voice_limits(voice_limits)
}

fn empty_runtime_snapshot(session_capacity: usize) -> VoiceRuntimeSnapshot {
    VoiceRuntimeSnapshot {
        session_capacity,
        session_in_use: 0,
        user_leases: 0,
        ip_leases: 0,
        provider_inflight: 0,
        provider_waiting: 0,
        active_handlers: 0,
        background_workers: 0,
        draining: false,
    }
}

/// Opens one admitted socket, binds it, and leaves it holding whatever provider
/// capacity its turn intent claims.
async fn open_capacity_probe_socket(
    url: &str,
    study_set_id: &str,
    session_id: &str,
    nonce: &str,
) -> TestWebSocket {
    let token = provider_limiter_token(study_set_id, session_id, nonce);
    let (mut socket, _) = connect_async(token_only_request(url, &token))
        .await
        .expect("capacity probe socket upgrades");
    assert_ready_provider(&mut socket, "cartesia_gemini").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_ids_and_token(study_set_id, session_id, &token).into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Event { event, .. }
            if matches!(
                event.as_ref(),
                VivaServerEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Ready,
                    terminal_reason: None,
                }
            )
    ));
    socket
}

async fn send_capacity_probe_turn(socket: &mut TestWebSocket, generation: &str, turn_id: &str) {
    send_client_frame(
        socket,
        &ClientFrame::TurnIntent {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: generation.to_owned(),
            turn_id: turn_id.to_owned(),
            intent: ClientTurnIntent::AnswerText {
                text: "capacity probe".to_owned(),
            },
        },
    )
    .await;
}

#[tokio::test]
async fn server_owned_capacity_snapshot_moves_once_per_transition_and_returns_to_zero() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = capacity_probe_state(
        2,
        text_inputs.clone(),
        VoiceLimitConfig {
            max_user_sessions: Some(2),
            max_ip_sessions: Some(2),
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    );
    let observed = state.clone();
    let evidence = state.evidence.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };
    assert_eq!(observed.runtime_snapshot(), empty_runtime_snapshot(2));

    let mut holder = open_capacity_probe_socket(
        &url,
        "biology-midterm",
        "voice-session-1",
        "nonce-capacity-biology",
    )
    .await;
    send_capacity_probe_turn(&mut holder, "capacity-holder", "v5-capacity-1").await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;
    assert_eq!(
        observed.runtime_snapshot(),
        VoiceRuntimeSnapshot {
            session_capacity: 2,
            session_in_use: 1,
            user_leases: 1,
            ip_leases: 1,
            provider_inflight: 1,
            provider_waiting: 0,
            active_handlers: 1,
            background_workers: 0,
            draining: false,
        }
    );

    let mut queued = open_capacity_probe_socket(
        &url,
        "chemistry-final",
        "voice-session-2",
        "nonce-capacity-chemistry",
    )
    .await;
    send_capacity_probe_turn(&mut queued, "capacity-queued", "v5-capacity-2").await;
    wait_until(Duration::from_secs(2), || {
        observed.runtime_snapshot().provider_waiting == 1
    })
    .await;
    let saturated = VoiceRuntimeSnapshot {
        session_capacity: 2,
        session_in_use: 2,
        user_leases: 2,
        ip_leases: 2,
        provider_inflight: 1,
        provider_waiting: 1,
        active_handlers: 2,
        background_workers: 0,
        draining: false,
    };
    assert_eq!(observed.runtime_snapshot(), saturated);

    // Every configured cap is now exactly full and none of them was exceeded.
    assert!(saturated.session_in_use <= saturated.session_capacity);
    assert_eq!(saturated.user_leases, 2);
    assert_eq!(saturated.ip_leases, 2);
    assert_eq!(saturated.provider_inflight, 1);
    assert_eq!(saturated.provider_waiting, 1);

    // A denied upgrade takes nothing: the snapshot is byte-identical afterwards.
    let refused = connect_async(token_only_request(
        &url,
        &provider_limiter_token(
            "biology-midterm",
            "voice-session-3",
            "nonce-capacity-denied",
        ),
    ))
    .await;
    assert!(
        refused.is_err(),
        "a third upgrade must be refused at the session cap"
    );
    assert_eq!(observed.runtime_snapshot(), saturated);

    // Cancelling the queued turn decrements the waiting counter exactly once.
    send_client_frame(
        &mut queued,
        &ClientFrame::Cancel {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "capacity-queued".to_owned(),
            turn_id: None,
        },
    )
    .await;
    wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::CancelReceived).await;
    wait_until(Duration::from_secs(2), || {
        observed.runtime_snapshot().provider_waiting == 0
    })
    .await;
    assert_eq!(
        observed.runtime_snapshot(),
        VoiceRuntimeSnapshot {
            provider_waiting: 0,
            ..saturated
        }
    );

    holder.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut holder).await;
    queued.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut queued).await;

    wait_until(Duration::from_secs(5), || {
        observed.runtime_snapshot() == empty_runtime_snapshot(2)
    })
    .await;
    assert_eq!(observed.runtime_snapshot(), empty_runtime_snapshot(2));
    assert_eq!(observed.session_slots.available_permits(), 2);
}

#[tokio::test]
async fn server_owned_capacity_denial_returns_the_session_slot_it_reserved() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = capacity_probe_state(
        4,
        text_inputs.clone(),
        VoiceLimitConfig {
            max_ip_sessions: Some(1),
            ..VoiceLimitConfig::default()
        },
    );
    let observed = state.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    let mut admitted = open_capacity_probe_socket(
        &url,
        "biology-midterm",
        "voice-session-1",
        "nonce-capacity-ip-first",
    )
    .await;
    let held = observed.runtime_snapshot();
    assert_eq!(held.session_in_use, 1);
    assert_eq!(held.ip_leases, 1);

    // The per-IP refusal happens after a session permit was reserved. The permit
    // must come back, or a deployment behind one proxy leaks its whole capacity.
    let refused = connect_async(token_only_request(
        &url,
        &provider_limiter_token(
            "chemistry-final",
            "voice-session-2",
            "nonce-capacity-ip-second",
        ),
    ))
    .await;
    assert!(refused.is_err(), "the second upgrade shares the peer IP");
    wait_until(Duration::from_secs(2), || {
        observed.runtime_snapshot() == held
    })
    .await;
    assert_eq!(observed.runtime_snapshot(), held);
    assert_eq!(observed.session_slots.available_permits(), 3);

    admitted.close(None).await.unwrap();
    let _ = read_server_frames_until_close(&mut admitted).await;
    wait_until(Duration::from_secs(5), || {
        observed.runtime_snapshot() == empty_runtime_snapshot(4)
    })
    .await;
    assert_eq!(observed.runtime_snapshot(), empty_runtime_snapshot(4));
}

/// `SERVICE-012` drain race: sessions parked in first-frame wait, holding active
/// provider work, queued behind it, and one whose peer stopped reading all reach
/// zero inside the server-owned grace, and admission closes before a slot is
/// allocated. `D-04 CONFIRM_DELETE` is the selected branch, so there is no
/// deletion finalizer to join and `background_workers` stays zero throughout.
#[tokio::test]
async fn websocket_drain_releases_every_lease_and_reports_drained() {
    let text_inputs = Arc::new(AtomicUsize::new(0));
    let state = capacity_probe_state(
        4,
        text_inputs.clone(),
        VoiceLimitConfig {
            max_user_sessions: Some(4),
            max_ip_sessions: Some(4),
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        },
    );
    // A socket parked in first-frame wait is released by the server-owned
    // first-frame bound, so this state pins that bound well inside the grace
    // rather than waiting out the 10-second production default.
    let state = state.with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(2),
        ..WsTimeouts::default()
    });
    let drain_state = state.clone();
    let Some(url) = spawn_server(state).await else {
        return;
    };

    // 1. A socket parked in the first-frame wait: it owns a session slot and an
    //    active-handler guard but has bound no identity yet.
    let first_frame_token = provider_limiter_token(
        "biology-midterm",
        "voice-session-9",
        "nonce-drain-firstframe",
    );
    let (mut first_frame_wait, _) = connect_async(token_only_request(&url, &first_frame_token))
        .await
        .expect("first-frame socket upgrades");
    assert_ready_provider(&mut first_frame_wait, "cartesia_gemini").await;

    // 2. A socket holding the single provider inflight slot.
    let mut holder = open_capacity_probe_socket(
        &url,
        "biology-midterm",
        "voice-session-1",
        "nonce-drain-holder",
    )
    .await;
    send_capacity_probe_turn(&mut holder, "drain-holder", "v5-drain-1").await;
    wait_until(Duration::from_secs(2), || {
        text_inputs.load(Ordering::SeqCst) == 1
    })
    .await;

    // 3. A socket queued behind it.
    let mut queued = open_capacity_probe_socket(
        &url,
        "chemistry-final",
        "voice-session-2",
        "nonce-drain-queued",
    )
    .await;
    send_capacity_probe_turn(&mut queued, "drain-queued", "v5-drain-2").await;
    wait_until(Duration::from_secs(2), || {
        drain_state.runtime_snapshot().provider_waiting == 1
    })
    .await;

    // 4. A socket whose peer has stopped reading, so the drain's own terminal
    //    write is the last thing standing between it and zero.
    let silent = open_capacity_probe_socket(
        &url,
        "physics-final",
        "voice-session-4",
        "nonce-drain-silent",
    )
    .await;

    let before = drain_state.runtime_snapshot();
    assert_eq!(before.active_handlers, 4);
    assert_eq!(before.session_in_use, 4);
    assert_eq!(before.provider_inflight, 1);
    assert_eq!(before.provider_waiting, 1);
    assert!(!before.draining);

    let started = Instant::now();
    let outcome = begin_drain_and_wait(&drain_state, Duration::from_secs(20)).await;
    let elapsed = started.elapsed();

    assert_eq!(outcome, DrainOutcome::Drained);
    assert!(
        elapsed < Duration::from_secs(20),
        "the drain must finish inside its grace, took {elapsed:?}"
    );
    assert_eq!(
        drain_state.runtime_snapshot(),
        VoiceRuntimeSnapshot {
            draining: true,
            ..empty_runtime_snapshot(4)
        }
    );
    assert_eq!(drain_state.session_slots.available_permits(), 4);

    // The queued provider answer was never forwarded once the drain started.
    assert_eq!(text_inputs.load(Ordering::SeqCst), 1);

    // A new upgrade is refused before it can allocate a session slot.
    let refused = connect_async(token_only_request(
        &url,
        &provider_limiter_token("biology-midterm", "voice-session-5", "nonce-drain-refused"),
    ))
    .await;
    assert!(refused.is_err(), "a draining server admits no new session");
    assert_eq!(drain_state.session_slots.available_permits(), 4);
    assert_eq!(drain_state.runtime_snapshot().active_handlers, 0);

    drop(first_frame_wait);
    drop(holder);
    drop(queued);
    drop(silent);
}
