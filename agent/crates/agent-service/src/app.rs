use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_domain::{
    BrainUsage, CreatePasteStudySet, LibrarySessionSummary, LibraryStudyDocumentSummary,
    LibraryStudySetSummary, PortError, RealtimeBrain, StudyMemoryStore, StudySetIngestionRecord,
    StudySetIngestionStatus, VoiceUsageRecord,
};
use axum::{
    extract::{Path, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::{delete, get, post},
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
        .route(
            "/study-sets/export",
            get(library_export).options(paste_options),
        )
        .route("/study-sets/library", get(library_snapshot))
        .route(
            "/study-sets/{study_set_id}",
            delete(delete_study_set).options(paste_options),
        )
        .route(
            "/study-sets/{study_set_id}/sessions/{voice_session_id}",
            delete(delete_session_history).options(paste_options),
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
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    (
        StatusCode::OK,
        response_headers,
        Json(json!({
            "ok": state.is_ready(),
            "live": true,
            "ready": state.is_ready(),
        })),
    )
}

async fn live(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    (
        StatusCode::OK,
        response_headers,
        Json(json!({ "live": true })),
    )
}

async fn ready(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
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
        response_headers,
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
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();

    (
        StatusCode::OK,
        response_headers,
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
        })),
    )
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

#[derive(Clone, Debug, Deserialize)]
struct LibrarySnapshotQuery {
    user_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct LibrarySnapshotResponse {
    user_id: String,
    privacy: LibraryPrivacyResponse,
    study_sets: Vec<LibraryStudySetResponse>,
    sessions: Vec<LibrarySessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryExportResponse {
    user_id: String,
    privacy: LibraryPrivacyResponse,
    study_sets: Vec<LibraryExportStudySetResponse>,
    sessions: Vec<LibrarySessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryPrivacyResponse {
    voice_recordings_saved: bool,
    transcripts_saved: bool,
    raw_audio_persistence: bool,
    transcript_persistence: bool,
    export_contains_raw_provider_payloads: bool,
    export: LibraryAction,
    copy: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryStudySetResponse {
    id: String,
    user_id: String,
    title: String,
    course: Option<String>,
    ingestion_status: StudySetIngestionStatus,
    ingestion_error: Option<String>,
    server_owned: bool,
    documents: Vec<LibraryStudyDocumentSummary>,
    concept_count: usize,
    question_count: usize,
    actions: LibraryStudySetActions,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryExportStudySetResponse {
    id: String,
    user_id: String,
    title: String,
    course: Option<String>,
    ingestion_status: StudySetIngestionStatus,
    ingestion_error: Option<String>,
    server_owned: bool,
    documents: Vec<LibraryStudyDocumentSummary>,
    concept_count: usize,
    question_count: usize,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryStudySetActions {
    start: LibraryAction,
    resume: LibraryAction,
    archive: LibraryAction,
    delete: LibraryAction,
}

#[derive(Clone, Debug, Serialize)]
struct LibraryAction {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<&'static str>,
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

async fn library_snapshot(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = query
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.trusted_user_id);
    if !state.unauthenticated_paste_allowed || user_id != state.trusted_user_id {
        if state.ws_access.required_bearer.is_none() {
            return (
                StatusCode::FORBIDDEN,
                response_headers,
                Json(json!({
                    "error": "library_snapshot_auth_required",
                    "message": "cross-user library snapshots require authenticated REST access",
                })),
            );
        }
        if let Err(error) = state.ws_access.validate_headers(&headers) {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({
                    "error": "library_snapshot_auth_failed",
                    "message": error.to_string(),
                })),
            );
        }
    }
    let snapshot = match state.study_store.library_snapshot(user_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                response_headers,
                Json(json!({
                    "error": "library_snapshot_failed",
                    "message": error.to_string(),
                })),
            );
        }
    };
    let study_sets = snapshot
        .study_sets
        .into_iter()
        .map(|study_set| {
            let mutation_control_token = signed_library_control_token(&state, &study_set.user_id);
            let unavailable_reason = study_set_start_unavailable_reason(&study_set);
            let start = match unavailable_reason {
                Some(reason) => unavailable_action(reason),
                None => {
                    let session_id = Uuid::new_v4().to_string();
                    signed_library_action(&state, &study_set.user_id, &study_set.id, session_id)
                }
            };
            let resume = match (unavailable_reason, study_set.open_session_id.clone()) {
                (Some(reason), _) => unavailable_action(reason),
                (None, Some(session_id)) => {
                    signed_library_action(&state, &study_set.user_id, &study_set.id, session_id)
                }
                (None, None) => unavailable_action("no_open_session"),
            };
            let mutation_auth_unavailable_reason =
                library_mutation_access_unavailable_reason(&state, &headers, &study_set.user_id);
            let delete = if let Some(reason) = mutation_auth_unavailable_reason {
                unavailable_action(reason)
            } else if mutation_control_token.is_none() {
                unavailable_action("control_token_unavailable")
            } else if study_set.server_owned
                && !study_set.documents.is_empty()
                && study_set.documents.iter().any(|document| !document.deleted)
            {
                available_mutation_action(mutation_control_token.clone())
            } else {
                unavailable_action(unavailable_reason.unwrap_or("source_deleted"))
            };

            LibraryStudySetResponse {
                id: study_set.id,
                user_id: study_set.user_id,
                title: study_set.title,
                course: study_set.course,
                ingestion_status: study_set.ingestion_status,
                ingestion_error: study_set.ingestion_error,
                server_owned: study_set.server_owned,
                documents: study_set.documents,
                concept_count: study_set.concept_count,
                question_count: study_set.question_count,
                actions: LibraryStudySetActions {
                    start,
                    resume,
                    archive: unavailable_action("server_mutation_unavailable"),
                    delete,
                },
            }
        })
        .collect::<Vec<_>>();

    (
        StatusCode::OK,
        response_headers,
        Json(
            serde_json::to_value(LibrarySnapshotResponse {
                user_id: snapshot.user_id,
                privacy: privacy_response_for_headers(&state, &headers, user_id),
                study_sets,
                sessions: snapshot.sessions,
            })
            .unwrap_or_else(|error| {
                json!({
                    "error": "library_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

async fn library_export(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) = require_library_control_access(
        &state,
        &headers,
        &response_headers,
        &user_id,
        "library_export",
    ) {
        return error;
    }
    let snapshot = match state.study_store.library_snapshot(&user_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => return store_json_error(response_headers, error, "library_export_failed"),
    };
    let study_sets = snapshot
        .study_sets
        .into_iter()
        .map(|study_set| LibraryExportStudySetResponse {
            id: study_set.id,
            user_id: study_set.user_id,
            title: study_set.title,
            course: study_set.course,
            ingestion_status: study_set.ingestion_status,
            ingestion_error: study_set.ingestion_error,
            server_owned: study_set.server_owned,
            documents: study_set.documents,
            concept_count: study_set.concept_count,
            question_count: study_set.question_count,
        })
        .collect();

    (
        StatusCode::OK,
        response_headers,
        Json(
            serde_json::to_value(LibraryExportResponse {
                user_id: snapshot.user_id,
                privacy: privacy_response(&state, available_mutation_action(None)),
                study_sets,
                sessions: snapshot.sessions,
            })
            .unwrap_or_else(|error| {
                json!({
                    "error": "library_export_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

async fn delete_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(study_set_id): Path<String>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) = require_library_control_access(
        &state,
        &headers,
        &response_headers,
        &user_id,
        "study_set_delete",
    ) {
        return error;
    }

    match state
        .study_store
        .delete_study_set(&user_id, &study_set_id)
        .await
    {
        Ok(result) => (StatusCode::OK, response_headers, Json(result)),
        Err(error) => store_json_error(response_headers, error, "study_set_delete_failed"),
    }
}

async fn delete_session_history(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path((study_set_id, voice_session_id)): Path<(String, String)>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) = require_library_control_access(
        &state,
        &headers,
        &response_headers,
        &user_id,
        "session_delete",
    ) {
        return error;
    }

    match state
        .study_store
        .delete_session_history(&user_id, &study_set_id, &voice_session_id)
        .await
    {
        Ok(result) => (StatusCode::OK, response_headers, Json(result)),
        Err(error) => store_json_error(response_headers, error, "session_delete_failed"),
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

fn study_set_start_unavailable_reason(study_set: &LibraryStudySetSummary) -> Option<&'static str> {
    if !study_set.server_owned {
        return Some("not_server_owned");
    }
    match study_set.ingestion_status {
        StudySetIngestionStatus::Pending => return Some("ingestion_pending"),
        StudySetIngestionStatus::Processing => return Some("ingestion_processing"),
        StudySetIngestionStatus::Failed => return Some("ingestion_failed"),
        StudySetIngestionStatus::Ready => {}
    }
    if !study_set.documents.is_empty()
        && study_set.documents.iter().all(|document| document.deleted)
    {
        return Some("source_deleted");
    }
    if study_set.question_count == 0 {
        return Some("no_active_questions");
    }
    None
}

fn unavailable_action(reason: &'static str) -> LibraryAction {
    LibraryAction {
        available: false,
        session_id: None,
        session_token: None,
        control_token: None,
        unavailable_reason: Some(reason),
    }
}

fn available_mutation_action(control_token: Option<String>) -> LibraryAction {
    LibraryAction {
        available: true,
        session_id: None,
        session_token: None,
        control_token,
        unavailable_reason: None,
    }
}

fn signed_library_action(
    state: &AppState,
    user_id: &str,
    study_set_id: &str,
    session_id: String,
) -> LibraryAction {
    let Some(secret) = state.ws_access.session_token_secret.as_deref() else {
        return unavailable_action("session_token_unavailable");
    };
    let Ok(session_token) = signed_session_token_for(user_id, study_set_id, &session_id, secret)
    else {
        return unavailable_action("session_token_unavailable");
    };
    LibraryAction {
        available: true,
        session_id: Some(session_id),
        session_token: Some(session_token),
        control_token: None,
        unavailable_reason: None,
    }
}

fn signed_library_control_token(state: &AppState, user_id: &str) -> Option<String> {
    let secret = state.ws_access.session_token_secret.as_deref()?;
    signed_session_token_for(
        user_id,
        "__library_control__",
        &Uuid::new_v4().to_string(),
        secret,
    )
    .ok()
}

fn signed_session_token(
    record: &StudySetIngestionRecord,
    secret: &str,
) -> Result<String, crate::config::SessionTokenError> {
    signed_session_token_for(
        &record.study_set.user_id,
        &record.study_set.id,
        &record.session_id,
        secret,
    )
}

fn signed_session_token_for(
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    secret: &str,
) -> Result<String, crate::config::SessionTokenError> {
    let expires_at = unix_timestamp_now().unwrap_or(0) + 15 * 60;
    SessionTokenClaims {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        session_id: session_id.to_owned(),
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

fn requested_library_user_id(query: &LibrarySnapshotQuery, state: &AppState) -> String {
    query
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.trusted_user_id)
        .to_owned()
}

fn require_library_control_access(
    state: &AppState,
    headers: &HeaderMap,
    response_headers: &HeaderMap,
    user_id: &str,
    operation: &'static str,
) -> Option<(StatusCode, HeaderMap, Json<serde_json::Value>)> {
    if state.ws_access.required_bearer.is_none() && state.ws_access.session_token_secret.is_none() {
        return Some((
            StatusCode::FORBIDDEN,
            response_headers.clone(),
            Json(json!({
                "error": format!("{operation}_auth_required"),
                "message": "library export and deletion controls require authenticated REST access",
            })),
        ));
    }
    if state.ws_access.required_bearer.is_some()
        && state.ws_access.validate_headers(headers).is_ok()
    {
        return None;
    }
    if validate_library_control_token(state, headers, user_id).is_ok() {
        return None;
    }
    let message = if headers.get("x-viva-library-control-token").is_some() {
        "invalid library control token"
    } else {
        "missing bearer token or library control token"
    };
    Some((
        StatusCode::UNAUTHORIZED,
        response_headers.clone(),
        Json(json!({
            "error": format!("{operation}_auth_failed"),
            "message": message,
        })),
    ))
}

fn validate_library_control_token(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> Result<(), crate::config::SessionTokenError> {
    let secret = state
        .ws_access
        .session_token_secret
        .as_deref()
        .ok_or(crate::config::SessionTokenError::Invalid)?;
    let token = headers
        .get("x-viva-library-control-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(crate::config::SessionTokenError::Malformed)?;
    let claims = SessionTokenClaims::verify(token, secret)?;
    if claims.user_id != user_id || claims.study_set_id != "__library_control__" {
        return Err(crate::config::SessionTokenError::Invalid);
    }
    Ok(())
}

fn library_mutation_access_unavailable_reason(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> Option<&'static str> {
    if state.ws_access.required_bearer.is_some()
        && state.ws_access.validate_headers(headers).is_ok()
    {
        return None;
    }
    if validate_library_control_token(state, headers, user_id).is_ok() {
        return None;
    }
    Some("mutation_auth_required")
}

fn privacy_response_for_headers(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> LibraryPrivacyResponse {
    let export = match library_mutation_access_unavailable_reason(state, headers, user_id) {
        Some(reason) => unavailable_action(reason),
        None => match signed_library_control_token(state, user_id) {
            Some(token) => available_mutation_action(Some(token)),
            None => unavailable_action("control_token_unavailable"),
        },
    };
    privacy_response(state, export)
}

fn privacy_response(state: &AppState, export: LibraryAction) -> LibraryPrivacyResponse {
    let store = state.study_store.capabilities();
    LibraryPrivacyResponse {
        voice_recordings_saved: store.raw_audio_persistence,
        transcripts_saved: store.transcript_persistence,
        raw_audio_persistence: store.raw_audio_persistence,
        transcript_persistence: store.transcript_persistence,
        export_contains_raw_provider_payloads: false,
        export,
        copy: if store.raw_audio_persistence || store.transcript_persistence {
            "Voice recordings or transcripts may be persisted by this configured store."
        } else {
            "Voice recordings and transcripts are not saved; Viva stores sanitized study meaning only."
        },
    }
}

fn store_json_error(
    response_headers: HeaderMap,
    error: PortError,
    error_code: &'static str,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let status = match &error {
        PortError::Unavailable { .. } => StatusCode::NOT_FOUND,
        PortError::Adapter { .. } => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        response_headers,
        Json(json!({
            "error": error_code,
            "message": error.to_string(),
        })),
    )
}

fn optional_cors_json_headers(
    access: &VoiceWsAccess,
    request_headers: &HeaderMap,
) -> Result<HeaderMap, crate::config::VoiceWsAccessError> {
    let mut headers = request_headers.get(header::ORIGIN).map_or_else(
        || Ok(HeaderMap::new()),
        |origin| cors_headers(access, Some(origin)),
    )?;
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(headers)
}

fn cors_json_error(
    error: crate::config::VoiceWsAccessError,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    (
        StatusCode::FORBIDDEN,
        HeaderMap::new(),
        Json(json!({
            "error": "origin_denied",
            "message": error.to_string(),
        })),
    )
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
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, authorization, x-viva-library-control-token"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    Ok(headers)
}
