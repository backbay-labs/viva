//! `SERVICE-017`: root, health, live, and the two operator-authenticated readiness probes.
//!
//! Moved verbatim out of `app.rs` by the responsibility split. No route,
//! response, timer, authorization decision, store call, or error mapping
//! changed; only the file the code lives in and the visibility the move forces.

use axum::{
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde_json::json;

use crate::app::*;

pub(super) async fn root() -> Json<serde_json::Value> {
    Json(json!({
        "service": "viva-agent",
        "status": "ok",
    }))
}

pub(super) async fn health(
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

pub(super) async fn live(
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

pub(super) async fn ready(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    if let Err(error) = state.operator_access.validate(&headers) {
        return readiness_access_json_error(error, response_headers);
    }
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();
    let ready = state.is_ready();
    let readiness_status =
        readiness_status(ready, state.drain_signal.is_draining(), &brain, &store);
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
            "readiness_status": readiness_status,
            "failure_kind": readiness_failure_kind(readiness_status),
            "access": {
                "status": "allowed",
            },
            // `SERVICE-012`: capacity detail is operator-authenticated only.
            // `/live` stays public and carries none of it.
            "runtime": state.runtime_snapshot(),
            "brain": {
                "provider": brain.provider,
                "configured": brain.configured,
                "selectable": brain.selectable,
                "live_runtime": brain.live_runtime,
            },
            "voice_limits": {
                "max_session_cost_usd": state.voice_limits.max_session_cost_usd,
            },
            "store": {
                "backend": store.backend.as_str(),
                "available": store.available,
                "durable": store.durable,
                "nonce_replay_protection": store.nonce_replay_protection,
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

pub(super) async fn brain_health(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    if let Err(error) = state.operator_access.validate(&headers) {
        return readiness_access_json_error(error, response_headers);
    }
    let brain = state.brain.capabilities();
    let store = state.study_store.capabilities();
    let writes = state.study_store.write_counts();
    let ready = state.is_ready();
    let readiness_status =
        readiness_status(ready, state.drain_signal.is_draining(), &brain, &store);

    (
        StatusCode::OK,
        response_headers,
        Json(json!({
            "provider": state.provider,
            "readiness_status": readiness_status,
            "failure_kind": readiness_failure_kind(readiness_status),
            "access": {
                "status": "allowed",
            },
            "runtime": state.runtime_snapshot(),
            "brain": {
                "provider": brain.provider,
                "configured": brain.configured,
                "selectable": brain.selectable,
                "live_runtime": brain.live_runtime,
            },
            "voice_limits": {
                "max_session_cost_usd": state.voice_limits.max_session_cost_usd,
            },
            "store": {
                "backend": store.backend.as_str(),
                "available": store.available,
                "durable": store.durable,
                "nonce_replay_protection": store.nonce_replay_protection,
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
            "usage": state.usage.summary(),
            "evidence": state.evidence.stats(),
            "status": if ready {
                "configured"
            } else {
                "unavailable"
            },
        })),
    )
}

pub(super) fn readiness_status(
    ready: bool,
    draining: bool,
    brain: &agent_domain::RealtimeBrainCapabilities,
    store: &agent_domain::StudyStoreCapabilities,
) -> &'static str {
    if ready {
        return "ready";
    }
    if draining {
        return "draining";
    }
    if !brain.configured {
        return "provider_unconfigured";
    }
    if !brain.selectable {
        return "provider_unselectable";
    }
    if !store.available {
        return "store_unavailable";
    }
    "dependency_unavailable"
}

pub(crate) fn readiness_failure_kind(readiness_status: &str) -> &'static str {
    match readiness_status {
        "ready" => "none",
        "draining" => "service_draining",
        "access_denied" => "access_denied",
        _ => "dependency_unavailable",
    }
}

pub(super) fn readiness_access_json_error(
    error: crate::config::VoiceWsAccessError,
    response_headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    (
        access_error_status(&error),
        response_headers,
        Json(json!({
            "error": access_error_code(&error),
            "message": error.to_string(),
            "readiness_status": "access_denied",
            "failure_kind": readiness_failure_kind("access_denied"),
            "access": {
                "status": "denied",
                "reason": access_error_code(&error),
            },
        })),
    )
}

/// `/live` stays public and minimal; `/ready` and `/health/brain` stay
/// operator-authenticated. Registration order is unchanged.
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/live", get(live))
        .route("/ready", get(ready))
        .route("/health/brain", get(brain_health))
}
