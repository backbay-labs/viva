use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
};

use agent_adapters::{cartesia_gemini::FakeCartesiaGeminiRuntime, SyntheticBrain};
use agent_domain::{
    AnswerEvaluation, AudioFrame, BrainError, BrainEvent, BrainInput, BrainProviderError,
    BrainUsage, ConceptStatus, PortError, RealtimeBrain, RealtimeBrainCapabilities,
    RealtimeSession, RealtimeSessionTaskGuard, RecapSourceMoment, SessionConfig, SessionId,
    StudyMemoryStore, StudyMode, StudyQuestion, StudySessionRecap, StudySetIngestionStatus,
    StudySourceReference, StudyStoreBackend, StudyStoreCapabilities, StudyStoreWriteCounts,
    TerminalSessionReason, VoiceUsageRecord,
};
use agent_service::{
    build_router, AppState, ClientFrame, FailureControlConfig, FailureControlScenario, ServerFrame,
    VivaServerEvent, VoiceDrainSignal, VoiceEvidenceRecorder, VoiceLimitConfig, VoiceWsAccess,
    WsTimeouts, VIVA_VOICE_PROTOCOL_VERSION,
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
use observe::{VoiceEvidenceEventKind, VoiceUsageEvent};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::ErrorKind;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::{
    net::TcpListener,
    sync::mpsc,
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

fn test_state_with_rest_auth(
    max_sessions: usize,
    store: Arc<data::InMemoryStudyStore>,
) -> AppState {
    AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: Some("rest-secret".to_owned()),
            session_token_secret: Some("session-secret".to_owned()),
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
            session_token_secret: Some(secret.to_owned()),
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
            return Err(PortError::adapter("test_store", "nonce write failed"));
        }
        self.inner.claim_session_token_nonce(claim).await
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        if matches!(self.mode, FailingStudyStoreMode::StudyContext) {
            return Err(PortError::adapter("test_store", "study context failed"));
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

async fn seed_completed_library_session(store: &Arc<data::InMemoryStudyStore>) {
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
    store
        .schedule_review_item(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "nadh",
            "2026-06-19T09:00:00Z",
        )
        .await
        .unwrap();
    store
        .record_recap(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-recap",
            StudySessionRecap {
                voice_session_id: "voice-session-1".to_owned(),
                headline: "Completed session".to_owned(),
                summary: "NADH needs one more recall pass.".to_owned(),
                strong_concepts: vec!["oxidative-phosphorylation".to_owned()],
                shaky_concepts: vec!["nadh".to_owned()],
                missed_concepts: vec![],
                review_later: vec!["nadh".to_owned()],
                next_action: "Review NADH tomorrow.".to_owned(),
                source_moments: vec![RecapSourceMoment {
                    text: "NADH needs one more recall pass.".to_owned(),
                    source: agent_domain::fixture_source_reference(),
                    status: ConceptStatus::Shaky,
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
    let app = build_router(test_state(4));

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

    let bearer_state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(Arc::new(
            data::InMemoryStudyStore::seeded_fixture(),
        ))),
        "synthetic",
        VoiceWsAccess {
            required_bearer: Some("rest-secret".to_owned()),
            session_token_secret: None,
            allowed_origins: vec![],
        },
        4,
        Arc::new(data::InMemoryStudyStore::seeded_fixture()),
    );
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

#[tokio::test]
async fn paste_study_set_route_creates_server_owned_ready_set_with_session_token() {
    let store = Arc::new(data::InMemoryStudyStore::new());
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::with_study_store(store.clone())),
        "synthetic",
        VoiceWsAccess {
            required_bearer: None,
            session_token_secret: Some("session-secret".to_owned()),
            allowed_origins: vec![],
        },
        4,
        store.clone(),
    );
    let app = build_router(state);
    let pasted_text = "mitosis chromosome spindle metaphase cytokinesis";
    let forged_excerpt = "browser forged source excerpt should never survive";

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/study-sets/paste")
                .header("origin", "http://localhost:3000")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "user_id": "attacker-user",
                        "session_id": "attacker-session",
                        "title": "Cell Division",
                        "course": "Biology 201",
                        "pasted_text": pasted_text,
                        "source_spans": [{
                            "id": "browser-span",
                            "document_id": "browser-doc",
                            "locator": { "page": 7, "bbox": [1, 2, 3, 4], "span": "page:7:bbox" },
                            "excerpt": forged_excerpt,
                            "confidence": "high",
                            "retrieval_reason": "browser supplied"
                        }],
                        "questions": [{
                            "source": {
                                "source_id": "browser-span",
                                "document_id": "browser-doc",
                                "span": "page:7:bbox",
                                "excerpt": forged_excerpt,
                                "confidence": "high",
                                "retrieval_reason": "browser supplied"
                            }
                        }]
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
    assert_ne!(payload["session_id"], "attacker-session");
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
    assert!(!payload_json.contains("browser-span"));
    assert!(!payload_json.contains("browser-doc"));
    assert!(!payload_json.contains(forged_excerpt));
    assert!(!payload_json.contains("page:7:bbox"));
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
async fn file_study_set_route_creates_server_owned_ready_pdf_without_exact_region_claims() {
    let store = Arc::new(data::InMemoryStudyStore::new());
    let app = build_router(test_state_with_session_token_and_store(
        "session-secret",
        store.clone(),
    ));
    let file_text = [
        "%PDF-1.7",
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
                        "title": "Bio PDF",
                        "course": "Biology 201",
                        "exam_date": null,
                        "file_name": "Lecture 9.pdf",
                        "content_type": "application/pdf",
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
    assert_eq!(payload["documents"][0]["display_name"], "Lecture 9.pdf");
    assert_eq!(payload["documents"][0]["source_kind"], "pdf");
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
        .find(|set| set["title"] == "Bio PDF")
        .expect("file study set in library");
    assert_eq!(file_set["ingestion_status"], "ready");
    assert_eq!(file_set["actions"]["start"]["available"], true);
    assert_eq!(file_set["documents"][0]["source_kind"], "pdf");

    let snapshot_json = serde_json::to_string(&store.snapshot()).unwrap();
    assert!(!snapshot_json.contains(&file_text));
    assert!(!snapshot_json.contains(&STANDARD.encode(file_text.as_bytes())));
}

#[tokio::test]
async fn file_study_set_route_blocks_failed_upload_and_retries_to_ready() {
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
                        "title": "Bad PDF",
                        "course": null,
                        "exam_date": null,
                        "file_name": "empty.pdf",
                        "content_type": "application/pdf",
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
                        "file_name": "still-empty.pdf",
                        "content_type": "application/pdf",
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
                        "file_name": "replacement.pdf",
                        "content_type": "application/pdf",
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
            session_token_secret: Some("session-secret".to_owned()),
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
    store
        .schedule_review_item(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "nadh",
            "2026-06-19T09:00:00Z",
        )
        .await
        .unwrap();
    store
        .record_recap(
            "user-1",
            "biology-midterm",
            "voice-session-1",
            "response-recap",
            StudySessionRecap {
                voice_session_id: "voice-session-1".to_owned(),
                headline: "Completed session".to_owned(),
                summary: "NADH needs one more recall pass.".to_owned(),
                strong_concepts: vec!["oxidative-phosphorylation".to_owned()],
                shaky_concepts: vec!["nadh".to_owned()],
                missed_concepts: vec![],
                review_later: vec!["nadh".to_owned()],
                next_action: "Review NADH tomorrow.".to_owned(),
                source_moments: vec![RecapSourceMoment {
                    text: "NADH needs one more recall pass.".to_owned(),
                    source: agent_domain::fixture_source_reference(),
                    status: ConceptStatus::Shaky,
                }],
            },
        )
        .await
        .unwrap();
    store
        .close_voice_session("voice-session-1", "completed")
        .await
        .unwrap();
    store
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
            session_token_secret: Some("session-secret".to_owned()),
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
        "2026-06-19T09:00:00Z"
    );
    assert_eq!(completed["next_review"]["source"], "persisted_review_item");
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
    assert_eq!(first_payload["study_set_id"], "biology-midterm");
    assert_eq!(first_payload["status"], "deleted");
    assert_eq!(first_payload["deleted_documents"], 1);
    assert_eq!(first_payload["hidden_sessions"], 1);

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
    assert_eq!(second_payload["deleted_documents"], 0);
    assert_eq!(second_payload["hidden_sessions"], 0);

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
    let biology = library_payload["study_sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["id"] == "biology-midterm")
        .expect("biology study set");
    assert_eq!(biology["documents"][0]["deleted"], true);
    assert_eq!(biology["question_count"], 0);
    assert_eq!(biology["actions"]["start"]["available"], false);
    assert_eq!(
        biology["actions"]["start"]["unavailable_reason"],
        "source_deleted"
    );
    assert_eq!(biology["actions"]["delete"]["available"], false);
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
    assert_eq!(cross_user.status(), axum::http::StatusCode::NOT_FOUND);
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
            session_token_secret: Some("session-secret".to_owned()),
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
            session_token_secret: Some("session-secret".to_owned()),
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
            required_bearer: Some("rest-secret".to_owned()),
            session_token_secret: Some("session-secret".to_owned()),
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
            session_token_secret: Some("session-secret".to_owned()),
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
                session_token_secret: Some("session-secret".to_owned()),
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
            "type": "audio",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
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
    send_client_frame(&mut socket, &fixture.client[1]).await;
    for _ in 0..13 {
        actual.push(read_server_frame(&mut socket).await);
    }
    send_client_frame(&mut socket, &fixture.client[2]).await;
    actual.push(read_server_frame(&mut socket).await);
    send_client_frame(&mut socket, &fixture.client[3]).await;
    wait_for_socket_close(&mut socket).await;

    assert_eq!(
        normalized_fixture_value(&actual),
        normalized_fixture_value(&fixture.server)
    );
    let expected_pack: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/fake-cartesia-gemini-evidence-pack.json"
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
        ServerFrame::Error { message, .. } if message == "first client frame timeout"
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
        ServerFrame::Error { message, .. } if message == "invalid client frame"
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
        ServerFrame::Error { message, .. } if message == "text frame exceeds maximum size"
    ));
    assert_close_code(&mut socket, CloseCode::Size).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "oversized_text_frame"
    }));
}

#[tokio::test]
async fn websocket_oversized_binary_frame_closes_with_size_and_terminal_reason() {
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    let _ = read_server_frame(&mut socket).await;
    let _ = read_server_frame(&mut socket).await;
    socket
        .send(WsMessage::Binary(
            vec![0_u8; agent_service::VIVA_VOICE_MAX_BINARY_FRAME_BYTES + 1].into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { message, .. } if message == "binary frame exceeds maximum size"
    ));
    assert_close_code(&mut socket, CloseCode::Size).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "oversized_binary_frame"
    }));
}

#[tokio::test]
async fn websocket_strips_browser_source_context_before_trusted_output() {
    let state = test_state(1);
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();
    let mut session_frame = fixture.client[0].clone();
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
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{}}}"#,
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
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{}}}"#,
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
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{}}}"#,
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
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{}}}"#,
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
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{}}}"#,
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
            ServerFrame::Error { message, .. } if message == "session auth failed"
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
    let (mut socket, _) = connect_async(url).await.unwrap();
    let token = signed_session_token(
        "session-secret",
        "user-1",
        "biology-midterm",
        "voice-session-1",
        unix_timestamp_now() + 60,
        "nonce-valid",
    );

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
                "session": forged_refresh,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    for frame in frames {
        if let ServerFrame::Error { message, .. } = frame {
            assert_eq!(message, "session auth failed");
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
    let mut request = url.as_str().into_client_request().unwrap();
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
        &ClientFrame::Text {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            text: "synthetic answer".to_owned(),
            client_generation_id: None,
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let mut biology_request = url.as_str().into_client_request().unwrap();
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

    let mut chemistry_request = url.as_str().into_client_request().unwrap();
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let mut biology_request = url.as_str().into_client_request().unwrap();
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

    let mut chemistry_request = url.as_str().into_client_request().unwrap();
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
            session_token_secret: Some("session-secret".to_owned()),
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
    let mut request = url.as_str().into_client_request().unwrap();
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
        ServerFrame::Error { message, .. } if message == "session auth failed"
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let (mut first_socket, _) = connect_async(url.clone()).await.unwrap();
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
    let (mut replay_socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut replay_socket, "open_probe").await;
    replay_socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut replay_socket).await,
        ServerFrame::Error { message, .. } if message == "session auth failed"
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
            session_token_secret: Some("session-secret".to_owned()),
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
    let (mut socket, _) = connect_async(url).await.unwrap();

    assert_ready_provider(&mut socket, "open_probe").await;
    socket
        .send(WsMessage::Text(
            session_config_json_with_token(&token).into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { message, .. } if message == "session token nonce store unavailable"
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
                required_bearer: None,
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec![],
            },
            1,
        );
        let evidence = state.evidence.clone();
        let Some(url) = spawn_server(state).await else {
            return;
        };
        let (mut socket, _) = connect_async(url).await.unwrap();

        assert_ready_provider(&mut socket, "open_probe").await;
        socket
            .send(WsMessage::Text(
                session_config_json_with_token(&token).into(),
            ))
            .await
            .unwrap();

        assert!(matches!(
            read_server_frame(&mut socket).await,
            ServerFrame::Error { message, .. } if message == "session auth failed"
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
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec![],
            },
            1,
        );
        let evidence = state.evidence.clone();
        let Some(url) = spawn_server(state).await else {
            return;
        };
        let (mut socket, _) = connect_async(url).await.unwrap();

        assert_ready_provider(&mut socket, "open_probe").await;
        socket
            .send(WsMessage::Text(
                session_config_json_with_token(&token).into(),
            ))
            .await
            .unwrap();

        assert!(matches!(
            read_server_frame(&mut socket).await,
            ServerFrame::Error { message, .. } if message == "session auth failed"
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
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { message, .. } if message == "session auth failed"
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
                "session": session,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { message, .. } if message == "study store unavailable"
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
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let (mut socket, _) = connect_async(url).await.unwrap();
    let _ = read_server_frame(&mut socket).await;
    send_client_frame(&mut socket, &fixture.client[0]).await;

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
async fn websocket_provider_error_event_emits_terminal_phase_without_raw_message() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(EventProbeBrain {
            study_store: None,
            events: vec![BrainEvent::Error(BrainProviderError {
                source: "cartesia_gemini".to_owned(),
                message: "raw answer transcript with CARTESIA_API_KEY must not surface".to_owned(),
            })],
        }),
        "event_probe",
        VoiceWsAccess::default(),
        4,
        store,
    );
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let (mut socket, _) = connect_async(url).await.unwrap();
    assert_ready_provider(&mut socket, "event_probe").await;
    send_client_frame(&mut socket, &fixture.client[0]).await;

    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::ProviderAuthFailed,
    );
    assert_close_code(&mut socket, CloseCode::Error).await;
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
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "event_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture.client[0]).await;

    let frames = read_server_frames_until_close(&mut socket).await;

    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::DurabilityDegraded)
    }));
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
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture.client[0]).await;

    let frames = read_server_frames_until_close(&mut socket).await;

    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Error { message, .. } if message == "provider source authority rejected"
    )));
    assert!(frames.iter().all(|frame| {
        terminal_session_reason(frame) != Some(TerminalSessionReason::DurabilityDegraded)
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
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    let (mut socket, _) = connect_async(url).await.unwrap();
    let ServerFrame::Ready { brain, store, .. } = read_server_frame(&mut socket).await else {
        panic!("expected ready frame");
    };
    assert_eq!(brain.provider, "event_probe");
    assert!(store.durable);
    send_client_frame(&mut socket, &fixture.client[0]).await;

    let frames = read_server_frames_until_close(&mut socket).await;

    assert!(frames.iter().any(|frame| {
        terminal_session_reason(frame) == Some(TerminalSessionReason::DurabilityDegraded)
    }));
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
    let fixture: FullSessionFixture = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/synthetic-study-session.json"
    ))
    .unwrap();

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    send_client_frame(&mut socket, &fixture.client[0]).await;
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

    assert!(matches!(
        read_server_frame(&mut socket).await,
        ServerFrame::Error { message, .. } if message == "browser tool_result frames are not trusted"
    ));
    assert_close_code(&mut socket, CloseCode::Policy).await;
    let events = wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::TerminalReason).await;
    assert!(events.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::TerminalReason
            && event.detail == "untrusted_tool_result"
    }));
}

#[tokio::test]
async fn websocket_drain_emits_terminal_phase_before_close() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = test_state_with_store(1, store.clone()).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        session: Duration::from_secs(5),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let (mut biology_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut duplicate_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut chemistry_socket, _) = connect_async(url.as_str()).await.unwrap();
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let (mut second_socket, _) = connect_async(url.as_str()).await.unwrap();
    assert_ready_provider(&mut second_socket, "backpressured_input_probe").await;
    second_socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let (mut biology_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut chemistry_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut duplicate_socket, _) = connect_async(url.as_str()).await.unwrap();
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let (mut biology_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut chemistry_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut physics_socket, _) = connect_async(url.as_str()).await.unwrap();
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
            session_token_secret: Some("session-secret".to_owned()),
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

    let (mut biology_socket, _) = connect_async(url.as_str()).await.unwrap();
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

    let (mut chemistry_socket, _) = connect_async(url.as_str()).await.unwrap();
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2, 3, 4].into()))
        .await
        .unwrap();

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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(Vec::new().into()))
        .await
        .unwrap();
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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

    socket
        .send(WsMessage::Binary(Vec::new().into()))
        .await
        .unwrap();
    assert_terminal_session_phase(
        read_server_frame(&mut socket).await,
        TerminalSessionReason::TurnCap,
    );
}

#[tokio::test]
async fn websocket_post_config_idle_timeout_closes_without_answer_frame() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(AnswerResolutionProbeBrain),
        "answer_resolution_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(25),
        session: Duration::from_secs(5),
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "answer_resolution_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(Vec::new().into()))
        .await
        .unwrap();

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
    .expect("answer evaluation should arrive before the turn cap");

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
}

#[tokio::test]
async fn websocket_turn_cap_stays_armed_for_newer_submission_after_one_resolution() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let state = AppState::with_study_store(
        Arc::new(DelayedSingleResolutionProbeBrain),
        "delayed_single_resolution_probe",
        VoiceWsAccess::default(),
        1,
        store,
    )
    .with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "delayed_single_resolution_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2].into()))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![3_u8, 4].into()))
        .await
        .unwrap();

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
    .expect("first answer resolution should arrive before the turn cap");

    let terminal = tokio::time::timeout(Duration::from_millis(80), async {
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
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "duplicate_resolution_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2].into()))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![3_u8, 4].into()))
        .await
        .unwrap();

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
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "response_then_phase_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2].into()))
        .await
        .unwrap();

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

    socket
        .send(WsMessage::Binary(vec![3_u8, 4].into()))
        .await
        .unwrap();

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
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "cancelled_then_stale_resolution_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2].into()))
        .await
        .unwrap();

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

    socket
        .send(WsMessage::Binary(vec![3_u8, 4].into()))
        .await
        .unwrap();

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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(Vec::new().into()))
        .await
        .unwrap();

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
async fn websocket_turn_cap_is_not_postponed_by_extra_audio_frames() {
    let state = test_state(1).with_ws_timeouts(WsTimeouts {
        first_frame: Duration::from_secs(5),
        idle: Duration::from_millis(40),
        session: Duration::from_secs(5),
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2].into()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    socket
        .send(WsMessage::Binary(vec![3_u8, 4].into()))
        .await
        .unwrap();

    let terminal = tokio::time::timeout(Duration::from_millis(30), async {
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
                    panic!("expected terminal turn cap despite extra audio frames, got {other:?}")
                }
            }
        }
    })
    .await
    .expect("extra audio frames extended the submitted-answer cap");

    assert_terminal_session_phase(terminal, TerminalSessionReason::TurnCap);
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
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_ready_provider(&mut socket, "backpressured_input_probe").await;
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2].into()))
        .await
        .unwrap();

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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2, 3, 4].into()))
        .await
        .unwrap();

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
    });
    let Some(url) = spawn_server(state).await else {
        return;
    };
    let (mut socket, _) = connect_async(url).await.unwrap();
    let session = include_str!("../../../fixtures/voice-protocol/session-config.json");

    assert_eq!(read_server_frame(&mut socket).await, ServerFrame::ready());
    socket
        .send(WsMessage::Text(
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(Vec::new().into()))
        .await
        .unwrap();

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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
                format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
                ServerFrame::Error { message, .. } => {
                    panic!("unexpected websocket error: {message}")
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2, 3, 4].into()))
        .await
        .unwrap();
    wait_for_evidence_kind(&evidence, VoiceEvidenceEventKind::AnswerReceived).await;
    socket
        .send(WsMessage::Binary(vec![5_u8, 6, 7, 8].into()))
        .await
        .unwrap();
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(vec![1_u8, 2, 3, 4].into()))
        .await
        .unwrap();
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
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
        voice_session_id: "voice-session-1".to_owned(),
        headline: "Unpersisted recap should not leak".to_owned(),
        summary: "Unpersisted recap summary should not leak".to_owned(),
        strong_concepts: vec!["nadh".to_owned()],
        shaky_concepts: vec![],
        missed_concepts: vec![],
        review_later: vec![],
        next_action: "Stop".to_owned(),
        source_moments: vec![agent_domain::RecapSourceMoment {
            text: "Unpersisted recap source should not leak".to_owned(),
            source: fixture_question.source.clone(),
            status: agent_domain::ConceptStatus::Strong,
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
                    voice_session_id: "voice-session-1".to_owned(),
                    headline: "Forged recap".to_owned(),
                    summary: "Forged recap".to_owned(),
                    strong_concepts: vec!["nadh".to_owned()],
                    shaky_concepts: vec![],
                    missed_concepts: vec![],
                    review_later: vec![],
                    next_action: "Stop".to_owned(),
                    source_moments: vec![agent_domain::RecapSourceMoment {
                        text: "Forged recap source".to_owned(),
                        source: forged_source,
                        status: agent_domain::ConceptStatus::Strong,
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
                format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
            ))
            .await
            .unwrap();

        let frames = read_server_frames_until_close(&mut socket).await;
        let payload = serde_json::to_string(&frames).unwrap();
        assert!(frames.iter().any(|frame| matches!(
            frame,
            ServerFrame::Error { message, .. } if message == "provider source authority rejected"
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
            format!(r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#).into(),
        ))
        .await
        .unwrap();

    let frames = read_server_frames_until_close(&mut socket).await;
    assert!(frames.iter().any(|frame| matches!(
        frame,
        ServerFrame::Error { message, .. } if message == "provider source authority rejected"
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

#[derive(Clone, Copy)]
enum BrowserEventKind {
    QuestionStarted,
    AnswerEvaluated,
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
        axum::serve(listener, app).await.unwrap();
    });
    drop(handle);
    Some(format!("ws://{addr}/ws"))
}

async fn send_client_frame(socket: &mut TestWebSocket, frame: &ClientFrame) {
    socket
        .send(WsMessage::Text(
            serde_json::to_string(frame).unwrap().into(),
        ))
        .await
        .unwrap();
}

fn session_config_json_with_token(token: &str) -> String {
    let session: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .unwrap();
    serde_json::json!({
        "type": "session_config",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
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
        "session": session,
        "session_token": token,
    })
    .to_string()
}

fn signed_session_token(
    secret: &str,
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    expires_at: u64,
    nonce: &str,
) -> String {
    let claims = serde_json::json!({
        "user_id": user_id,
        "study_set_id": study_set_id,
        "session_id": session_id,
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
    let claims = serde_json::json!({
        "user_id": fixture.user_id,
        "study_set_id": fixture.study_set_id,
        "session_id": fixture.session_id,
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

async fn read_server_frame(socket: &mut TestWebSocket) -> ServerFrame {
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
        Err(BrainError::MissingApiKey)
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
        Err(BrainError::MissingApiKey)
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
        self.study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| BrainError::Connection(error.to_string()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| BrainError::Connection("missing user_id".to_owned()))?
            .to_owned();
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| BrainError::Connection("missing study_set_id".to_owned()))?
            .to_owned();
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| BrainError::Connection("missing session_id".to_owned()))?
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
    QuestionAuthorizationSemanticMiss,
    QuestionAuthorizationWriteFailure,
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

    async fn record_voice_session(&self, config: &SessionConfig) -> Result<(), PortError> {
        self.inner.record_voice_session(config).await
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
                Err(PortError::unavailable(
                    "postgres",
                    &question.question_id,
                    "question is not active for this study set",
                ))
            }
            DurableStoreFailureMode::QuestionAuthorizationWriteFailure => {
                Err(PortError::adapter("postgres", "durable store read failed"))
            }
            DurableStoreFailureMode::UsageRecording => unreachable!(),
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

    async fn record_voice_usage(&self, event: VoiceUsageRecord) -> Result<(), PortError> {
        if self.failure != DurableStoreFailureMode::UsageRecording {
            return self.inner.record_voice_usage(event).await;
        }
        drop(event);
        Err(PortError::adapter("postgres", "durable store write failed"))
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
        self.store
            .record_voice_session(&config)
            .await
            .map_err(|error| BrainError::Connection(error.to_string()))?;
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
                voice_session_id: "voice-session-1".to_owned(),
                headline: "Stale recap".to_owned(),
                summary: "Stale recap summary".to_owned(),
                strong_concepts: vec!["NADH".to_owned()],
                shaky_concepts: vec![],
                missed_concepts: vec![],
                review_later: vec![],
                next_action: "Do not surface stale recap.".to_owned(),
                source_moments: vec![RecapSourceMoment {
                    text: "Stale recap source".to_owned(),
                    source: source.clone(),
                    status: agent_domain::ConceptStatus::Strong,
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
        self.study_store
            .record_voice_session(&config)
            .await
            .map_err(|error| BrainError::Connection(error.to_string()))?;
        let user_id = config
            .user_id
            .as_deref()
            .ok_or_else(|| BrainError::Connection("missing user_id".to_owned()))?;
        let study_set_id = config
            .study_set_id
            .as_deref()
            .ok_or_else(|| BrainError::Connection("missing study_set_id".to_owned()))?;
        let voice_session_id = config
            .session_id
            .as_deref()
            .ok_or_else(|| BrainError::Connection("missing session_id".to_owned()))?;
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
            .map_err(|error| BrainError::Connection(error.to_string()))?;

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
            store
                .record_voice_session(&config)
                .await
                .map_err(|error| BrainError::Connection(error.to_string()))?;
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

struct AnswerResolutionProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for AnswerResolutionProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "answer_resolution_probe".to_owned(),
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

struct DelayedSingleResolutionProbeBrain;

#[async_trait::async_trait]
impl RealtimeBrain for DelayedSingleResolutionProbeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "delayed_single_resolution_probe".to_owned(),
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
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    let _ = event_tx
                        .send(BrainEvent::ResponseCompleted {
                            response_id: "response-1".to_owned(),
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
