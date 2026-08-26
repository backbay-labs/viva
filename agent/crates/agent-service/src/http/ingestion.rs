//! `SERVICE-017`: paste/file/retry request parsing, strict-shape rejection, and store error mapping.
//!
//! Moved verbatim out of `app.rs` by the responsibility split. No route,
//! response, timer, authorization decision, store call, or error mapping
//! changed; only the file the code lives in and the visibility the move forces.

use agent_domain::{
    CreateFileStudySet, CreatePasteStudySet, PortError, PortErrorKind, StudySetIngestionRecord,
    StudySetIngestionStatus,
};
use axum::{
    extract::{rejection::JsonRejection, Path, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::app::*;
use crate::config::RedactedSecret;
use crate::http::library::{
    requested_library_user_id, require_library_control_access, LibrarySnapshotQuery,
};

/// `SERVICE-015`: the exact paste contract. `deny_unknown_fields` makes an
/// authority-shaped member such as `user_id`, `session_id`, `source_spans`, or
/// `questions` a rejected request rather than a silently discarded one, so a client
/// can never believe the server honoured a fact it discarded.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PasteStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    pasted_text: String,
}

/// `SERVICE-015`: the exact file-ingestion contract. `exam_date` stays a member
/// because `A-02` requires every `study_sets` writer to supply the exam instant input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    file_name: String,
    content_type: Option<String>,
    file_base64: String,
}

/// `SERVICE-015`: the exact retry contract. A retry replaces the uploaded bytes of a
/// study set the server already owns, so it carries no title, course, or exam input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RetryFileStudySetRequest {
    file_name: String,
    content_type: Option<String>,
    file_base64: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct PasteStudySetResponse {
    #[serde(flatten)]
    record: StudySetIngestionRecord,
}

pub(super) async fn create_paste_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    body: Result<Json<PasteStudySetRequest>, JsonRejection>,
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
    let response_headers = with_ingestion_response_guards(response_headers);
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
        if let Err(error) = state.ws_access.validate_bearer_headers(&headers) {
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

    // The contract is checked only after authorization, so an unauthenticated caller
    // cannot probe the accepted key set.
    let Ok(Json(request)) = body else {
        return invalid_ingestion_request(response_headers);
    };

    let session_id = Uuid::new_v4().to_string();
    // `A-02`: `exam_date` is the ingestion input the store turns into the
    // authoritative `study_sets.exam_at` instant, so it is forwarded verbatim and
    // never defaulted here.
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
            return store_json_error(response_headers, error, "paste_ingestion_failed");
        }
    };
    if let Err(error) = attach_ready_session_token(&state, &mut record, request_origin(&headers)) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            response_headers,
            Json(json!({
                "error": "session_token_failed",
                "message": error.to_string(),
            })),
        );
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

pub(super) async fn create_file_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    body: Result<Json<FileStudySetRequest>, JsonRejection>,
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
    let response_headers = with_ingestion_response_guards(response_headers);
    if !state.unauthenticated_paste_allowed {
        if state.ws_access.required_bearer.is_none() {
            return (
                StatusCode::FORBIDDEN,
                response_headers,
                Json(json!({
                    "error": "file_ingestion_auth_required",
                    "message": "file ingestion token minting is disabled without authenticated REST access",
                })),
            );
        }
        if let Err(error) = state.ws_access.validate_bearer_headers(&headers) {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({
                    "error": "file_ingestion_auth_failed",
                    "message": error.to_string(),
                })),
            );
        }
    }

    let Ok(Json(request)) = body else {
        return invalid_ingestion_request(response_headers);
    };
    let file_bytes = match STANDARD.decode(request.file_base64.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => {
            return store_json_error(
                response_headers,
                invalid_upload_encoding(),
                "file_ingestion_failed",
            );
        }
    };
    let session_id = Uuid::new_v4().to_string();
    // `A-02`: the exam instant input rides through unchanged.
    let input = CreateFileStudySet {
        user_id: state.trusted_user_id.clone(),
        study_set_id: None,
        title: request.title,
        course: request.course,
        exam_date: request.exam_date,
        file_name: request.file_name,
        content_type: request.content_type,
        file_bytes,
        session_id: Some(session_id),
    };
    let mut record = match state.study_store.create_file_study_set(input).await {
        Ok(record) => record,
        Err(error) => {
            return store_json_error(response_headers, error, "file_ingestion_failed");
        }
    };
    if let Err(error) = attach_ready_session_token(&state, &mut record, request_origin(&headers)) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            response_headers,
            Json(json!({
                "error": "session_token_failed",
                "message": error.to_string(),
            })),
        );
    }
    (
        StatusCode::CREATED,
        response_headers,
        Json(
            serde_json::to_value(PasteStudySetResponse { record }).unwrap_or_else(|error| {
                json!({
                    "error": "file_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

pub(super) async fn retry_file_study_set(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(study_set_id): Path<String>,
    Query(query): Query<LibrarySnapshotQuery>,
    headers: HeaderMap,
    body: Result<Json<RetryFileStudySetRequest>, JsonRejection>,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers = match optional_cors_json_headers(&state.ws_access, &headers) {
        Ok(headers) => headers,
        Err(error) => return cors_json_error(error),
    };
    let response_headers = with_ingestion_response_guards(response_headers);
    let user_id = requested_library_user_id(&query, &state);
    if let Some(error) =
        require_library_control_access(&state, &headers, &response_headers, &user_id, "file_retry")
    {
        return error;
    }
    let Ok(Json(request)) = body else {
        return invalid_ingestion_request(response_headers);
    };
    let file_bytes = match STANDARD.decode(request.file_base64.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => {
            return store_json_error(
                response_headers,
                invalid_upload_encoding(),
                "file_retry_failed",
            );
        }
    };
    let session_id = Uuid::new_v4().to_string();
    let input = CreateFileStudySet {
        user_id,
        study_set_id: Some(study_set_id),
        title: String::new(),
        course: None,
        exam_date: None,
        file_name: request.file_name,
        content_type: request.content_type,
        file_bytes,
        session_id: Some(session_id),
    };
    let mut record = match state.study_store.retry_file_study_set(input).await {
        Ok(record) => record,
        Err(error) => return store_json_error(response_headers, error, "file_retry_failed"),
    };
    if let Err(error) = attach_ready_session_token(&state, &mut record, request_origin(&headers)) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            response_headers,
            Json(json!({
                "error": "session_token_failed",
                "message": error.to_string(),
            })),
        );
    }
    (
        StatusCode::OK,
        response_headers,
        Json(
            serde_json::to_value(PasteStudySetResponse { record }).unwrap_or_else(|error| {
                json!({
                    "error": "file_retry_response_failed",
                    "message": error.to_string(),
                })
            }),
        ),
    )
}

pub(super) fn attach_ready_session_token(
    state: &AppState,
    record: &mut StudySetIngestionRecord,
    origin: Option<&str>,
) -> Result<(), crate::config::SessionTokenError> {
    if record.study_set.ingestion_status == StudySetIngestionStatus::Ready {
        if let Some(secret) = state
            .ws_access
            .session_token_secret
            .as_ref()
            .map(RedactedSecret::as_str)
        {
            record.session_token = Some(signed_session_token(record, secret, state, origin)?);
        }
    }
    Ok(())
}

/// `SERVICE-016` / `DATA-014`: the one sanitized mapping from Plan 06's closed port
/// taxonomy to HTTP.
///
/// Status comes only from `error.kind()`. `error.reason()` is diagnostic prose that
/// may carry a filename, PDF bytes, SQL detail, a bearer, or learner text, so it is
/// never inspected, never branched on, and never returned. Every `InvalidInput`
/// answers with one fixed public message, which is what keeps a refused PDF
/// indistinguishable from any other unusable upload.
pub(super) fn store_json_error(
    response_headers: HeaderMap,
    error: PortError,
    error_code: &'static str,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let (status, message) = match error.kind() {
        PortErrorKind::InvalidInput => (
            StatusCode::BAD_REQUEST,
            "uploaded content is invalid or unsupported",
        ),
        PortErrorKind::Conflict => (
            StatusCode::CONFLICT,
            "the request conflicts with the current state",
        ),
        PortErrorKind::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "the requested resource is unavailable",
        ),
        PortErrorKind::Durability | PortErrorKind::Internal => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "the request could not be completed",
        ),
    };
    (
        status,
        response_headers,
        Json(json!({
            "error": error_code,
            "message": message,
        })),
    )
}

/// `SERVICE-015`: the one rejection every ingestion route returns for a body that
/// does not match its contract. Serde and extractor diagnostics never reach the
/// caller, and the rejected key and value are never echoed.
pub(super) fn invalid_ingestion_request(
    response_headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        response_headers,
        Json(json!({
            "error": "invalid_ingestion_request",
            "message": "request body does not match the ingestion contract",
        })),
    )
}

/// Ingestion responses are learner-derived and are never cached or sniffed.
pub(super) fn with_ingestion_response_guards(mut headers: HeaderMap) -> HeaderMap {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers
}

/// The typed refusal for an upload whose transport encoding is not canonical. It
/// carries no decoder prose, so it maps through the same sanitized `InvalidInput`
/// arm as every other unusable upload.
pub(super) fn invalid_upload_encoding() -> PortError {
    PortError::invalid_input(
        "agent_service.file_ingestion",
        "file_base64",
        "file_base64 is not canonical base64",
    )
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/study-sets/paste",
            post(create_paste_study_set).options(paste_options),
        )
        .route(
            "/study-sets/files",
            post(create_file_study_set).options(paste_options),
        )
        .route(
            "/study-sets/{study_set_id}/files/retry",
            post(retry_file_study_set).options(paste_options),
        )
}

#[cfg(test)]
mod store_error_mapping_tests {
    use super::*;

    /// A store reason built to carry everything that must never reach a caller.
    fn hostile_reason() -> String {
        concat!(
            "Bearer viva-fixture-operator-credential-0001 ",
            "viva1.eyJ1c2VyX2lkIjoidXNlci0xIn0.c2ln ",
            "Lecture 9.pdf %PDF-1.7 1 0 obj /Catalog endobj ",
            "ERROR: duplicate key value violates unique constraint \"study_sets_pkey\" ",
            "the mitochondria is the powerhouse of the cell"
        )
        .to_owned()
    }

    fn body_text(
        response: (StatusCode, HeaderMap, Json<serde_json::Value>),
    ) -> (StatusCode, String) {
        (response.0, response.2 .0.to_string())
    }

    /// `SERVICE-016` / `DATA-014`: one sanitized mapping, selected only from
    /// `PortErrorKind`, with a fixed public message per arm.
    #[test]
    fn store_json_error_maps_every_kind_to_a_sanitized_public_shape() {
        let reason = hostile_reason();
        let cases: Vec<(PortError, StatusCode, &str)> = vec![
            (
                PortError::invalid_input("store", "unsupported_pdf", reason.clone()),
                StatusCode::BAD_REQUEST,
                "uploaded content is invalid or unsupported",
            ),
            (
                PortError::conflict("store", "target", reason.clone()),
                StatusCode::CONFLICT,
                "the request conflicts with the current state",
            ),
            (
                PortError::unavailable("store", "target", reason.clone()),
                StatusCode::SERVICE_UNAVAILABLE,
                "the requested resource is unavailable",
            ),
            (
                PortError::durability("store", "target", reason.clone()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "the request could not be completed",
            ),
            (
                PortError::internal("store", "target", reason.clone()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "the request could not be completed",
            ),
        ];

        for (error, expected_status, expected_message) in cases {
            let kind = error.kind();
            let (status, body) = body_text(store_json_error(
                HeaderMap::new(),
                error,
                "file_ingestion_failed",
            ));
            assert_eq!(status, expected_status, "{kind:?}");
            let payload: serde_json::Value = serde_json::from_str(&body).expect("body is JSON");
            assert_eq!(payload["error"], "file_ingestion_failed", "{kind:?}");
            assert_eq!(payload["message"], expected_message, "{kind:?}");
            for forbidden in [
                "Bearer",
                "viva1.",
                "Lecture 9.pdf",
                "%PDF",
                "study_sets_pkey",
                "powerhouse",
                "unsupported_pdf",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "{kind:?} leaked {forbidden} in {body}"
                );
            }
        }
    }

    /// The route's coarse code is the caller's only variable, and it is preserved.
    #[test]
    fn store_json_error_preserves_the_route_code_without_inspecting_the_reason() {
        for code in ["file_ingestion_failed", "file_retry_failed"] {
            let (status, body) = body_text(store_json_error(
                HeaderMap::new(),
                PortError::invalid_input("store", "unsupported_pdf", hostile_reason()),
                code,
            ));
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let payload: serde_json::Value = serde_json::from_str(&body).expect("body is JSON");
            assert_eq!(payload["error"], code);
            assert_eq!(
                payload["message"],
                "uploaded content is invalid or unsupported"
            );
        }
    }
}
