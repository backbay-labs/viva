use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_domain::{
    BrainUsage, CreatePasteStudySet, RealtimeBrain, StudyMemoryStore, StudySetIngestionRecord,
    StudySetIngestionStatus, VoiceUsageRecord,
};
use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::{get, post},
    Json, Router,
};
use observe::{usage_event, CostModel, VoiceEvidenceEvent, VoiceUsageEvent};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    config::{SessionTokenClaims, VoiceWsAccess},
    ws::voice_ws,
};

#[derive(Clone)]
pub struct AppState {
    pub brain: Arc<dyn RealtimeBrain>,
    pub study_store: Arc<dyn StudyMemoryStore>,
    pub provider: String,
    pub trusted_user_id: String,
    pub trusted_study_set_id: String,
    pub trusted_session_id: String,
    pub trusted_session_sequence: Arc<AtomicU64>,
    pub ws_access: VoiceWsAccess,
    pub session_slots: Arc<Semaphore>,
    pub ws_timeouts: WsTimeouts,
    pub evidence: VoiceEvidenceRecorder,
    pub usage: VoiceUsageRecorder,
    pub unauthenticated_paste_allowed: bool,
}

impl AppState {
    pub fn new(
        brain: Arc<dyn RealtimeBrain>,
        provider: impl Into<String>,
        ws_access: VoiceWsAccess,
        max_sessions: usize,
    ) -> Self {
        Self::with_study_store(
            brain,
            provider,
            ws_access,
            max_sessions,
            Arc::new(data::InMemoryStudyStore::seeded_fixture()),
        )
    }

    pub fn with_study_store(
        brain: Arc<dyn RealtimeBrain>,
        provider: impl Into<String>,
        ws_access: VoiceWsAccess,
        max_sessions: usize,
        study_store: Arc<dyn StudyMemoryStore>,
    ) -> Self {
        Self {
            brain,
            study_store,
            provider: provider.into(),
            trusted_user_id: "user-1".to_owned(),
            trusted_study_set_id: "biology-midterm".to_owned(),
            trusted_session_id: "voice-session-1".to_owned(),
            trusted_session_sequence: Arc::new(AtomicU64::new(0)),
            ws_access,
            session_slots: Arc::new(Semaphore::new(max_sessions)),
            ws_timeouts: WsTimeouts::default(),
            evidence: VoiceEvidenceRecorder::default(),
            usage: VoiceUsageRecorder::default(),
            unauthenticated_paste_allowed: true,
        }
    }

    pub fn with_trusted_user_id(mut self, trusted_user_id: impl Into<String>) -> Self {
        self.trusted_user_id = trusted_user_id.into();
        self
    }

    pub fn with_trusted_study_set_id(mut self, trusted_study_set_id: impl Into<String>) -> Self {
        self.trusted_study_set_id = trusted_study_set_id.into();
        self
    }

    pub fn with_trusted_session_id(mut self, trusted_session_id: impl Into<String>) -> Self {
        self.trusted_session_id = trusted_session_id.into();
        self
    }

    pub fn next_trusted_voice_session_id(&self) -> String {
        let sequence = self
            .trusted_session_sequence
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        Uuid::from_u128(u128::from(sequence)).to_string()
    }

    pub fn with_ws_timeouts(mut self, ws_timeouts: WsTimeouts) -> Self {
        self.ws_timeouts = ws_timeouts;
        self
    }

    pub fn with_unauthenticated_paste_allowed(mut self, allowed: bool) -> Self {
        self.unauthenticated_paste_allowed = allowed;
        self
    }

    pub fn is_ready(&self) -> bool {
        let brain = self.brain.capabilities();
        let store = self.study_store.capabilities();
        brain.configured && brain.selectable && store.available
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/live", get(live))
        .route("/ready", get(ready))
        .route("/health/brain", get(brain_health))
        .route(
            "/study-sets/paste",
            post(create_paste_study_set).options(paste_options),
        )
        .route("/ws", get(voice_ws))
        .with_state(state)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WsTimeouts {
    pub first_frame: Duration,
    pub idle: Duration,
}

impl Default for WsTimeouts {
    fn default() -> Self {
        Self {
            first_frame: Duration::from_secs(10),
            idle: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct VoiceEvidenceRecorder {
    events: Arc<RwLock<Vec<VoiceEvidenceEvent>>>,
}

impl VoiceEvidenceRecorder {
    pub fn record(&self, event: VoiceEvidenceEvent) {
        self.events
            .write()
            .expect("evidence recorder lock poisoned")
            .push(event);
    }

    pub fn snapshot(&self) -> Vec<VoiceEvidenceEvent> {
        self.events
            .read()
            .expect("evidence recorder lock poisoned")
            .clone()
    }
}

#[derive(Clone, Debug, Default)]
pub struct VoiceUsageRecorder {
    events: Arc<RwLock<Vec<VoiceUsageEvent>>>,
}

impl VoiceUsageRecorder {
    pub fn record(
        &self,
        voice_session_id: Option<&str>,
        provider: &str,
        model: &str,
        usage: BrainUsage,
        duration_seconds: u64,
        answer_eval_latency_ms: Option<u64>,
    ) -> VoiceUsageRecord {
        let parsed_session_id = voice_session_id.and_then(|id| id.parse().ok());
        let cost_model = CostModel::default();
        let mut event = usage_event(
            parsed_session_id,
            provider,
            model,
            duration_seconds,
            usage,
            &cost_model,
        );
        event.answer_eval_latency_ms = answer_eval_latency_ms;
        let record = VoiceUsageRecord {
            voice_session_id: voice_session_id.map(ToOwned::to_owned),
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
        };
        self.events
            .write()
            .expect("usage recorder lock poisoned")
            .push(event);
        record
    }

    pub fn snapshot(&self) -> Vec<VoiceUsageEvent> {
        self.events
            .read()
            .expect("usage recorder lock poisoned")
            .clone()
    }
}

async fn root() -> Json<serde_json::Value> {
    Json(json!({
        "service": "viva-agent",
        "status": "ok",
    }))
}

async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    Json(json!({
        "ok": state.is_ready(),
        "live": true,
        "ready": state.is_ready(),
    }))
}

async fn live() -> Json<serde_json::Value> {
    Json(json!({ "live": true }))
}

async fn ready(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> (StatusCode, Json<serde_json::Value>) {
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();
    let ready = state.is_ready();
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ready": ready,
            "brain": {
                "provider": brain.provider,
                "configured": brain.configured,
                "selectable": brain.selectable,
                "live_runtime": brain.live_runtime,
            },
            "store": {
                "backend": store.backend.as_str(),
                "available": store.available,
                "durable": store.durable,
                "raw_audio_persistence": store.raw_audio_persistence,
                "transcript_persistence": store.transcript_persistence,
                "uuid_schema_translation": store.uuid_schema_translation,
                "writes": {
                    "sessions": writes.sessions,
                    "answer_attempts": writes.answer_attempts,
                    "concept_statuses": writes.concept_statuses,
                    "review_items": writes.review_items,
                    "recaps": writes.recaps,
                },
            }
        })),
    )
}

async fn brain_health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();

    Json(json!({
        "provider": state.provider,
        "brain": {
            "provider": brain.provider,
            "configured": brain.configured,
            "selectable": brain.selectable,
            "live_runtime": brain.live_runtime,
        },
        "store": {
            "backend": store.backend.as_str(),
            "available": store.available,
            "durable": store.durable,
            "raw_audio_persistence": store.raw_audio_persistence,
            "transcript_persistence": store.transcript_persistence,
            "uuid_schema_translation": store.uuid_schema_translation,
            "writes": {
                "sessions": writes.sessions,
                "answer_attempts": writes.answer_attempts,
                "concept_statuses": writes.concept_statuses,
                "review_items": writes.review_items,
                "recaps": writes.recaps,
            },
        },
        "usage": {
            "events": state.usage.snapshot().len(),
        },
        "status": if brain.configured && brain.selectable && store.available {
            "configured"
        } else {
            "unavailable"
        },
    }))
}

#[derive(Clone, Debug, Deserialize)]
struct PasteStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    pasted_text: String,
}

#[derive(Clone, Debug, Serialize)]
struct PasteStudySetResponse {
    #[serde(flatten)]
    record: StudySetIngestionRecord,
}

async fn paste_options(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap) {
    match cors_headers(&state.ws_access, headers.get(header::ORIGIN)) {
        Ok(headers) => (StatusCode::NO_CONTENT, headers),
        Err(_) => (StatusCode::FORBIDDEN, HeaderMap::new()),
    }
}

async fn create_paste_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PasteStudySetRequest>,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let mut response_headers = match cors_headers(&state.ws_access, headers.get(header::ORIGIN)) {
        Ok(headers) => headers,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                HeaderMap::new(),
                Json(json!({
                    "error": "origin_denied",
                    "message": error.to_string(),
                })),
            );
        }
    };
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if !state.unauthenticated_paste_allowed {
        if state.ws_access.required_bearer.is_none() {
            return (
                StatusCode::FORBIDDEN,
                response_headers,
                Json(json!({
                    "error": "paste_ingestion_auth_required",
                    "message": "paste ingestion token minting is disabled without authenticated REST access",
                })),
            );
        }
        if let Err(error) = state.ws_access.validate_headers(&headers) {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({
                    "error": "paste_ingestion_auth_failed",
                    "message": error.to_string(),
                })),
            );
        }
    }

    let session_id = Uuid::new_v4().to_string();
    let input = CreatePasteStudySet {
        user_id: state.trusted_user_id.clone(),
        title: request.title,
        course: request.course,
        exam_date: request.exam_date,
        pasted_text: request.pasted_text,
        session_id: Some(session_id),
    };
    let mut record = match state.study_store.create_paste_study_set(input).await {
        Ok(record) => record,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                response_headers,
                Json(json!({
                    "error": "paste_ingestion_failed",
                    "message": error.to_string(),
                })),
            );
        }
    };
    if record.study_set.ingestion_status == StudySetIngestionStatus::Ready {
        if let Some(secret) = state.ws_access.session_token_secret.as_deref() {
            match signed_session_token(&record, secret) {
                Ok(token) => record.session_token = Some(token),
                Err(error) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        response_headers,
                        Json(json!({
                            "error": "session_token_failed",
                            "message": error.to_string(),
                        })),
                    );
                }
            }
        }
    }
    (
        StatusCode::CREATED,
        response_headers,
        Json(
            serde_json::to_value(PasteStudySetResponse { record }).unwrap_or_else(|error| {
                json!({
                    "error": "paste_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

fn signed_session_token(
    record: &StudySetIngestionRecord,
    secret: &str,
) -> Result<String, crate::config::SessionTokenError> {
    let expires_at = unix_timestamp_now().unwrap_or(0) + 15 * 60;
    SessionTokenClaims {
        user_id: record.study_set.user_id.clone(),
        study_set_id: record.study_set.id.clone(),
        session_id: record.session_id.clone(),
        expires_at,
        nonce: Uuid::new_v4().to_string(),
    }
    .sign(secret)
}

fn unix_timestamp_now() -> Result<u64, crate::config::SessionTokenError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| crate::config::SessionTokenError::Invalid)
}

fn cors_headers(
    access: &VoiceWsAccess,
    origin: Option<&HeaderValue>,
) -> Result<HeaderMap, crate::config::VoiceWsAccessError> {
    let mut headers = HeaderMap::new();
    let allow_origin = if access.allowed_origins.is_empty() {
        origin
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("*"))
    } else {
        let origin = origin.ok_or(crate::config::VoiceWsAccessError::OriginDenied)?;
        let origin_text = origin
            .to_str()
            .map_err(|_| crate::config::VoiceWsAccessError::OriginDenied)?;
        if !access
            .allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin_text))
        {
            return Err(crate::config::VoiceWsAccessError::OriginDenied);
        }
        origin.clone()
    };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, authorization"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    Ok(headers)
}
