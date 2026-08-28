//! `SERVICE-017`: the authenticated projection, the library snapshot/export, and the delete surface.
//!
//! Moved verbatim out of `app.rs` by the responsibility split. No route,
//! response, timer, authorization decision, store call, or error mapping
//! changed; only the file the code lives in and the visibility the move forces.

use agent_domain::{
    LibrarySessionSummary, LibraryStudyDocumentSummary, LibraryStudySetSummary, SessionConfig,
    SessionId, StudyMode, StudySetIngestionStatus, StudyStoreWriteOutcome,
};
use axum::{
    extract::{rejection::QueryRejection, Path, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::{delete, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use std::time::{SystemTime, UNIX_EPOCH};

use crate::app::*;
use crate::config::ProjectionRejection;
use crate::config::{ProjectionReadAccess, RedactedSecret, SessionTokenClaims};
use crate::http::ingestion::store_json_error;

#[derive(Clone, Debug, Deserialize)]
pub(super) struct LibrarySnapshotQuery {
    user_id: Option<String>,
    /// `A-32`: the start-mint selector. The library snapshot is a listing, and a
    /// listing is a read — every start action it returns is signed, but only the
    /// one study set this names has its session recorded durably. Absent (the
    /// landing render, the panel refresh, the read-scoped proxy) the route writes
    /// nothing at all, so repeating it cannot accumulate open sessions or invent a
    /// session to resume. Present, it is `POST /api/viva-session/start` asking for
    /// the one session it is about to hand the browser.
    ///
    /// It selects; it does not authorize. Any caller can type it — the browser
    /// proxy copies a request's query string upstream verbatim — so the durable
    /// write is gated on the scoped session-mint credential the mint presents (see
    /// [`crate::config::SessionMintAccess`]), and this field narrows the write that
    /// authority already permits to the single study set the mint is starting.
    record_start_for: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct LibrarySnapshotResponse {
    user_id: String,
    privacy: LibraryPrivacyResponse,
    study_sets: Vec<LibraryStudySetResponse>,
    sessions: Vec<LibrarySessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct LibraryExportResponse {
    user_id: String,
    privacy: LibraryPrivacyResponse,
    study_sets: Vec<LibraryExportStudySetResponse>,
    sessions: Vec<LibrarySessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct LibraryPrivacyResponse {
    voice_recordings_saved: bool,
    transcripts_saved: bool,
    raw_audio_persistence: bool,
    transcript_persistence: bool,
    export_contains_raw_provider_payloads: bool,
    export: LibraryAction,
    copy: &'static str,
    data_handling_statement: &'static str,
    retention_statement: &'static str,
    deletion_statement: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct LibraryStudySetResponse {
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
pub(super) struct LibraryExportStudySetResponse {
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
pub(super) struct LibraryStudySetActions {
    start: LibraryAction,
    resume: LibraryAction,
    archive: LibraryAction,
    delete: LibraryAction,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct LibraryAction {
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

pub(super) async fn library_snapshot(
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
    // `A-34`: the mint operation carries its own authority.
    //
    // A public bind sets `unauthenticated_paste_allowed` to false, so this route
    // demands a credential — and the credential it demands is
    // `VoiceWsAccess::required_bearer` (`VIVA_VOICE_WS_BEARER_TOKEN`, the WebSocket
    // upgrade credential this route reuses to authenticate REST reads), which the
    // session mint deliberately does not hold: the two are byte-distinct by
    // configuration (`CredentialCollision` is startup-fatal). That left
    // `VIVA_AGENT_SESSION_MINT_BEARER_TOKEN` required exactly where it could not be
    // used, refusing the mint at this check before the record gate below saw it, and
    // putting the projection back in the `A-32` deadlock.
    //
    // So the scoped credential authenticates the operation it exists for. Two
    // conditions make a request that operation, and both are load-bearing:
    //
    // * it names the study set it is starting. A request presenting the credential
    //   without naming a start is a plain library read, is not the operation this
    //   credential is for, and falls through to the ordinary check that refuses it.
    // * it names the service's own `trusted_user_id`. Who a snapshot may be read for
    //   is a rule this route already had, and `A-34` does not touch it: a mint that
    //   named another learner would hand back their library *and* record an open
    //   session under their name, which is authority no deadlock fix needs. Every
    //   cross-user request — mint credential or not — meets the same rule it met
    //   before, on either bind shape.
    //
    // What is admitted is an operation, not a narrowed read: the mint's response is
    // the whole snapshot for that one subject, because the signed start the caller
    // came for is an action *inside* that snapshot. A selector naming a set that
    // does not exist is still the mint operation, is still answered with the
    // snapshot, and still writes nothing. The narrowing this credential does get is
    // the write below (at most the one set it named) and the surfaces it never
    // reaches: `require_library_control_access` gates export and both deletes and
    // never consults it.
    let mint_operation = query
        .record_start_for
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mint_authorized = mint_operation.is_some()
        && user_id == state.trusted_user_id
        && state
            .session_mint_access
            .as_ref()
            .is_some_and(|access| access.authorizes(&headers));
    // `A-36.3`: the same deadlock, one credential over, and the same answer.
    //
    // The browser's BFF reads this route with `VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN`,
    // which `main.rs` wires into [`ProjectionReadAccess`] and nowhere else — so the
    // check below never consulted it, compared against the WebSocket upgrade
    // credential instead, and refused the browser's plain library read on exactly the
    // bind that requires the read key. `A-34.2` fixed this for the mint; this is its
    // sibling.
    //
    // The admission mirrors the trust `ProjectionReadAccess` already places in this
    // credential and adds nothing to it. Three conditions, each load-bearing:
    //
    // * it is the READ-ONLY snapshot operation. A request that also names a start is
    //   asking for the mint's write authority, which this credential does not hold, so
    //   it is not this operation and falls through to the ordinary check that refuses
    //   it. `A-34.2`'s converse pin — the mint credential cannot plain-read — is
    //   untouched: this compares against a different credential entirely.
    // * it names the service's own `trusted_user_id`, the narrowing `A-36.2` ratified
    //   for the mint. The projection never reads for a subject its verified token does
    //   not name, so its mirror cannot read for a subject the query string names.
    // * it presents the credential from the canonical origin, which is
    //   [`ProjectionReadAccess::authorizes_snapshot_read`]'s own decision, not a second
    //   opinion about it.
    //
    // Read-only is the whole grant. Three of the four surfaces below enforce it
    // without knowing this decision was made: the record gate reads `mint_authorized`
    // alone, and `require_library_control_access` (export, both deletes) plus
    // `library_mutation_access_unavailable_reason` (the delete action and its
    // capability) consult neither scoped credential — so an admitted read is handed no
    // mutation token and no export. The fourth is `session_token`, and it needs the
    // explicit withholding below.
    let library_read_authorized = mint_operation.is_none()
        && user_id == state.trusted_user_id
        && state
            .projection_read_access
            .as_ref()
            .is_some_and(|access| access.authorizes_snapshot_read(&headers));
    if !mint_authorized
        && !library_read_authorized
        && (!state.unauthenticated_paste_allowed || user_id != state.trusted_user_id)
    {
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
        if let Err(error) = state.ws_access.validate_bearer_headers(&headers) {
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
    let request_origin = request_origin(&headers).map(ToOwned::to_owned);
    // `A-32`: at most one study set per request may record a start, and only the one
    // the caller named. Everything else this route does is a read.
    //
    // The selector is a request, never a permission. It is honored only for a caller
    // presenting the scoped session-mint credential — the credential
    // `POST /api/viva-session/start` presents and the browser's read-scoped proxy
    // does not hold — so a query string copied upstream from a browser, on a public
    // bind or a loopback one, cannot open a durable session however it is written.
    // An unauthorized selector is ignored, not refused: the snapshot is still a
    // snapshot, and its start actions are still signed.
    //
    // `A-34`: this is the same decision the authentication above already made, which
    // is why it is read from that decision rather than recomputed. A caller admitted
    // as the mint records; every other caller — admitted by the REST bearer, by the
    // loopback trust, or by nothing at all — reads.
    let record_start_for = mint_authorized.then_some(mint_operation).flatten();
    // `A-36.3` review fix: read-only has to mean read-only on the wire too.
    //
    // A start or resume action carries a `session_token`, and
    // [`crate::config::authenticate_upgrade`] accepts that token ALONE as WebSocket
    // authority — D-07's token-only path, no upgrade bearer required — after which
    // the socket's own provisioning records the `voice_sessions` row. Handing this
    // credential a session token would therefore hand it durable session creation one
    // hop later, which is the authority `A-36.3` reserves to
    // `VIVA_AGENT_SESSION_MINT_BEARER_TOKEN` and this route's own store assertions
    // cannot see, because the leak is not a store call this route makes.
    //
    // Withheld from exactly the admission that needed it. Every caller this route
    // already admitted keeps its tokens, because for them the token is no new
    // authority: the upgrade bearer opens the socket by itself, and a loopback bind
    // answers this same read with no `Authorization` header at all. Those two are why
    // the condition is this short — a request admitted by the upgrade bearer or by
    // the mint presents that credential in the one `Authorization` position, and
    // `CredentialCollision` makes it byte-distinct from this one, so
    // `library_read_authorized` is already false for both. Loopback is the only
    // overlap left, and `unauthenticated_paste_allowed` is exactly it.
    //
    // The browser contract survives whole. The action stays `available` and keeps its
    // `session_id`, which is all `apps/web`'s BFF reads before attaching its own
    // same-origin bootstrap token, and that BFF strips every upstream `*_token` key
    // before the browser sees the body regardless. The browser's real session token
    // comes from `POST /api/viva-session/start`, which presents the session-mint
    // credential — the authority that is allowed to create a session.
    let read_credential_is_the_only_authority =
        library_read_authorized && !state.unauthenticated_paste_allowed;
    let mut study_sets = Vec::with_capacity(snapshot.study_sets.len());
    for study_set in snapshot.study_sets {
        let mutation_control_token = signed_library_control_token(&state, &study_set.user_id);
        let unavailable_reason = study_set_start_unavailable_reason(&study_set);
        let start = match unavailable_reason {
            Some(reason) => unavailable_action(reason),
            None if record_start_for == Some(study_set.id.as_str()) => {
                recorded_signed_start_action(
                    &state,
                    &study_set.user_id,
                    &study_set.id,
                    request_origin.as_deref(),
                )
                .await
            }
            None => signed_library_action(
                &state,
                &study_set.user_id,
                &study_set.id,
                Uuid::new_v4().to_string(),
                request_origin.as_deref(),
            ),
        };
        let resume = match (unavailable_reason, study_set.open_session_id.clone()) {
            (Some(reason), _) => unavailable_action(reason),
            (None, Some(session_id)) => signed_library_action(
                &state,
                &study_set.user_id,
                &study_set.id,
                session_id,
                request_origin.as_deref(),
            ),
            (None, None) => unavailable_action("no_open_session"),
        };
        let (start, resume) = if read_credential_is_the_only_authority {
            (
                action_without_session_token(start),
                action_without_session_token(resume),
            )
        } else {
            (start, resume)
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

        study_sets.push(LibraryStudySetResponse {
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
        });
    }

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

pub(super) async fn library_export(
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

/// `SERVICE-011`: the only selector the projection route accepts. `deny_unknown_fields`
/// makes an extra or duplicate query key a contract violation rather than a silently
/// ignored one.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProjectionQuery {
    voice_session_id: String,
}

pub(super) fn projection_error(
    response_headers: HeaderMap,
    rejection: ProjectionRejection,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let status = match rejection {
        ProjectionRejection::Unauthorized => StatusCode::UNAUTHORIZED,
        ProjectionRejection::Forbidden => StatusCode::FORBIDDEN,
        ProjectionRejection::Invalid => StatusCode::BAD_REQUEST,
    };
    (
        status,
        response_headers,
        Json(json!({
            "error": rejection.error_code(),
            "message": rejection.message(),
        })),
    )
}

/// Headers every projection response carries, success or failure. The learner state
/// this route returns is never cached and never content-sniffed.
pub(super) fn projection_response_headers(
    access: Option<&ProjectionReadAccess>,
    request_headers: &HeaderMap,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if let Some(origin) = access.and_then(|access| access.allowed_origin_header(request_headers)) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers
}

/// `SERVICE-011`: the claim-bound study projection Plans 04, 09, 10, and 11 consume.
///
/// The Plan 11 scoped read credential authorizes the caller; the signed access
/// credential supplies identity. `user_id`, `study_set_id`, and `voice_session_id` are
/// read from the verified claims and the request's path/query selectors are compared
/// with them in constant time, so a request can never name an identity it did not
/// prove. Plan 09's port answers, and Plan 04's exact type is returned unchanged.
pub(super) async fn authenticated_study_projection(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(study_set_id): Path<String>,
    query: Result<Query<ProjectionQuery>, QueryRejection>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    let response_headers =
        projection_response_headers(state.projection_read_access.as_ref(), &headers);
    let Some(access) = state.projection_read_access.as_ref() else {
        return projection_error(response_headers, ProjectionRejection::Unauthorized);
    };
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_secs(),
        Err(_) => {
            return projection_error(response_headers, ProjectionRejection::Unauthorized);
        }
    };
    let claims = match access.authorize(&headers, now) {
        Ok(claims) => claims,
        Err(rejection) => return projection_error(response_headers, rejection),
    };
    // Extractor diagnostics are never returned: an invalid selector shape is one
    // fixed public body.
    let Ok(Query(query)) = query else {
        return projection_error(response_headers, ProjectionRejection::Invalid);
    };
    if let Err(rejection) =
        ProjectionReadAccess::bind_selectors(&claims, &study_set_id, &query.voice_session_id)
    {
        return projection_error(response_headers, rejection);
    }

    match state
        .study_store
        .authenticated_study_projection(&claims.user_id, &claims.study_set_id, &claims.session_id)
        .await
    {
        Ok(projection) => match serde_json::to_value(&projection) {
            Ok(value) => (StatusCode::OK, response_headers, Json(value)),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                response_headers,
                Json(json!({
                    "error": "projection_failed",
                    "message": "study projection is unavailable",
                })),
            ),
        },
        Err(error) => store_json_error(response_headers, error, "projection_failed"),
    }
}

pub(super) async fn delete_study_set(
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

pub(super) async fn delete_session_history(
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

pub(super) fn study_set_start_unavailable_reason(
    study_set: &LibraryStudySetSummary,
) -> Option<&'static str> {
    if !study_set.server_owned {
        return Some("not_server_owned");
    }
    match study_set.ingestion_status {
        StudySetIngestionStatus::Pending => return Some("ingestion_pending"),
        StudySetIngestionStatus::Processing => return Some("ingestion_processing"),
        StudySetIngestionStatus::Retry => return Some("ingestion_retry"),
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

pub(super) fn unavailable_action(reason: &'static str) -> LibraryAction {
    LibraryAction {
        available: false,
        session_id: None,
        session_token: None,
        control_token: None,
        unavailable_reason: Some(reason),
    }
}

/// `A-36.3` review fix: the same action, minus the one field that is a WebSocket key.
///
/// `session_token` is `skip_serializing_if = "Option::is_none"`, so the action goes on
/// the wire as `{"available": true, "session_id": ...}` — the shape an action already
/// has when no token could be signed, and the shape `apps/web`'s BFF reads to attach
/// its own same-origin bootstrap token. Nothing else about the action changes: an
/// available start stays available, because refusing it would re-open the deadlock
/// `A-36.3` closed.
pub(super) fn action_without_session_token(action: LibraryAction) -> LibraryAction {
    LibraryAction {
        session_token: None,
        ..action
    }
}

pub(super) fn available_mutation_action(control_token: Option<String>) -> LibraryAction {
    LibraryAction {
        available: true,
        session_id: None,
        session_token: None,
        control_token,
        unavailable_reason: None,
    }
}

/// `A-32`: a started session IS a session.
///
/// The signed start mints a session id and, in the same step, records the
/// `voice_sessions` row `authenticated_study_projection` requires — under the
/// exact identity (`user_id`, `study_set_id`, `session_id`, `D-03B` quiz mode) the
/// socket's own provisioning claims later. The projection therefore validates
/// before any socket exists, which is what the browser's `connectionEligible`
/// gate waits for; the socket's own `record_voice_session` is then an idempotent
/// replay of this row, never a second session.
///
/// Reached only for a caller holding the scoped session-mint credential, and then
/// only for the single study set its `record_start_for` selector names, so this is
/// the mint and not the listing: every other library read signs its start actions
/// through `signed_library_action` and writes nothing. Recording on every read
/// would open one permanently-open session per startable set per page render and
/// would flip `resume` onto a session the learner never entered.
///
/// Fail closed in both directions: no row is written unless a credential could
/// actually be minted for it, and no credential is returned unless its row
/// committed. A store that cannot record the session reports the start
/// unavailable rather than handing out a credential whose projection can never
/// validate.
pub(super) async fn recorded_signed_start_action(
    state: &AppState,
    user_id: &str,
    study_set_id: &str,
    origin: Option<&str>,
) -> LibraryAction {
    let session_id = Uuid::new_v4().to_string();
    let action = signed_library_action(state, user_id, study_set_id, session_id.clone(), origin);
    if !action.available {
        return action;
    }
    let recorded = state
        .study_store
        .record_voice_session(&SessionConfig {
            session_id: Some(SessionId::new(session_id)),
            user_id: Some(user_id.to_owned()),
            study_set_id: Some(study_set_id.to_owned()),
            // `D-03B QUIZ_ONLY`: the only mode this service starts, and the mode a
            // later `session_config` is sanitized to, so the socket's replay
            // matches this row instead of conflicting with it.
            mode: Some(StudyMode::Quiz),
            ..SessionConfig::default()
        })
        .await;
    match recorded {
        // A fresh v4 identifier can only insert; the replay arm is named because
        // the outcome is the vocabulary this write speaks, not a value to discard.
        Ok(StudyStoreWriteOutcome::Inserted | StudyStoreWriteOutcome::IdempotentReplay) => action,
        // The store's own diagnostic never reaches the browser: the action carries
        // one fixed reason, exactly like every other unavailable start.
        Err(_) => unavailable_action("session_record_unavailable"),
    }
}

pub(super) fn signed_library_action(
    state: &AppState,
    user_id: &str,
    study_set_id: &str,
    session_id: String,
    origin: Option<&str>,
) -> LibraryAction {
    let Some(secret) = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)
    else {
        return unavailable_action("session_token_unavailable");
    };
    let Ok(failure_control) =
        failure_control_claim_for(state, user_id, study_set_id, &session_id, origin)
    else {
        return unavailable_action("session_token_unavailable");
    };
    let Ok(session_token) =
        signed_session_token_for(user_id, study_set_id, &session_id, secret, failure_control)
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

pub(super) fn signed_library_control_token(state: &AppState, user_id: &str) -> Option<String> {
    let secret = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)?;
    signed_session_token_for(
        user_id,
        "__library_control__",
        &Uuid::new_v4().to_string(),
        secret,
        None,
    )
    .ok()
}

pub(super) fn requested_library_user_id(query: &LibrarySnapshotQuery, state: &AppState) -> String {
    query
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.trusted_user_id)
        .to_owned()
}

pub(super) fn require_library_control_access(
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
        && state.ws_access.validate_bearer_headers(headers).is_ok()
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

pub(super) fn validate_library_control_token(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> Result<(), crate::config::SessionTokenError> {
    let secret = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)
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

pub(super) fn library_mutation_access_unavailable_reason(
    state: &AppState,
    headers: &HeaderMap,
    user_id: &str,
) -> Option<&'static str> {
    if state.ws_access.required_bearer.is_some()
        && state.ws_access.validate_bearer_headers(headers).is_ok()
    {
        return None;
    }
    if validate_library_control_token(state, headers, user_id).is_ok() {
        return None;
    }
    Some("mutation_auth_required")
}

pub(super) fn privacy_response_for_headers(
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

pub(super) fn privacy_response(state: &AppState, export: LibraryAction) -> LibraryPrivacyResponse {
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
        data_handling_statement: "Viva records sanitized study-set records, source summaries, session status, recaps, review items, usage rows, answer-attempt envelopes, and nonce rows; this configured store does not retain raw microphone audio or raw transcripts.",
        retention_statement: "Durable Postgres rows remain until the tester deletes the session recap or the study set; local in-memory rows expire with the process.",
        deletion_statement: "Delete recap removes the session recap, review items, usage rows, answer-attempt envelopes, and nonce rows while marking the session deleted. Delete source tombstones source material and purges the set's session artifacts.",
    }
}

/// `D-04 CONFIRM_DELETE` is the recorded branch, so no restore route is
/// registered here or anywhere else.
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/study-sets/export",
            get(library_export).options(paste_options),
        )
        .route("/study-sets/library", get(library_snapshot))
        .route(
            "/v1/study-sets/{study_set_id}/projection",
            get(authenticated_study_projection),
        )
        .route(
            "/study-sets/{study_set_id}",
            delete(delete_study_set).options(paste_options),
        )
        .route(
            "/study-sets/{study_set_id}/sessions/{voice_session_id}",
            delete(delete_session_history).options(paste_options),
        )
}
