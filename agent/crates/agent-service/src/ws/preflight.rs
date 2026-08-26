//! `SERVICE-017`: peer/proxy IP derivation, Origin/bearer/token preflight, signed claim verification, and the initial-config nonce/binding gate.
//!
//! Moved verbatim out of `ws.rs` by the responsibility split. No route,
//! response, timer, capacity transition, authorization decision, store or
//! provider call, protocol frame, or cleanup order changed; only the file the
//! code lives in and the visibility the move forces.

use super::*;

/// `SERVICE-003`: the longest forwarding chain a trusted proxy may present. The
/// count is checked before a hop vector or a session permit is allocated.
pub(super) const MAX_FORWARDED_HOPS: usize = 32;

/// Why an upgrade could not be given a client address. Every variant is coarse
/// and carries no header value, hop, or derived address.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ClientIpError {
    #[error("forwarding chain is missing")]
    MissingForwardedChain,
    #[error("forwarding chain is malformed")]
    MalformedForwardedChain,
    #[error("forwarding chain names no untrusted client")]
    AllForwardedHopsTrusted,
    #[error("forwarding chain has too many hops")]
    TooManyForwardedHops,
}

/// The HTTP rejection an unaccepted upgrade returns.
#[derive(Debug)]
pub struct VoiceWsRejection {
    pub(super) status: StatusCode,
    pub(super) body: serde_json::Value,
}

impl VoiceWsRejection {
    pub(super) fn new(status: StatusCode, body: serde_json::Value) -> Self {
        Self { status, body }
    }

    #[cfg(test)]
    pub(super) fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for VoiceWsRejection {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// `SERVICE-003`: derive the client address from the socket peer, and only behind
/// a configured trusted proxy from the forwarding chain.
///
/// An untrusted direct peer's forwarding headers are ignored outright, so a
/// spoofed `X-Forwarded-For` cannot open a second rate-limit bucket. A trusted
/// peer must present a syntactically valid chain; the scan runs right to left,
/// skips configured trusted hops, and takes the first untrusted one. `X-Real-IP`
/// is never consulted and there is no `unknown` bucket to fall into.
pub(super) fn client_ip_key(
    peer: SocketAddr,
    headers: &HeaderMap,
    trusted: &TrustedProxyConfig,
) -> Result<IpAddr, ClientIpError> {
    if !trusted.trusts(peer.ip()) {
        return Ok(peer.ip());
    }
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .ok_or(ClientIpError::MissingForwardedChain)?;
    if forwarded.split(',').count() > MAX_FORWARDED_HOPS {
        return Err(ClientIpError::TooManyForwardedHops);
    }
    let mut hops = Vec::with_capacity(MAX_FORWARDED_HOPS.min(forwarded.split(',').count()));
    for hop in forwarded.split(',') {
        let hop = hop.trim();
        if hop.is_empty() {
            return Err(ClientIpError::MalformedForwardedChain);
        }
        hops.push(
            hop.parse::<IpAddr>()
                .map_err(|_| ClientIpError::MalformedForwardedChain)?,
        );
    }
    hops.iter()
        .rev()
        .find(|hop| !trusted.trusts(**hop))
        .copied()
        .ok_or(ClientIpError::AllForwardedHopsTrusted)
}

pub(super) fn validate_ws_preflight(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
) -> Result<VoiceAdmission, VoiceWsRejection> {
    if state.drain_signal.is_draining() {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PreflightRejected,
            None,
            "server draining",
        ));
        return Err(VoiceWsRejection::new(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "voice session draining" }),
        ));
    }
    if let Err(error) = state.ws_access.validate_origin(headers) {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PreflightRejected,
            None,
            error.to_string(),
        ));
        return Err(ws_access_error(error));
    }
    // `SERVICE-004`: the signed access credential is verified here, before a
    // session slot, an IP lease, or `Ready`. The nonce store is not consulted.
    let Ok(now) = unix_timestamp_now() else {
        return Err(VoiceWsRejection::new(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "voice session clock unavailable" }),
        ));
    };
    let principal = match authenticate_upgrade(headers, &state.ws_access, now) {
        Ok(principal) => principal,
        Err(error) => {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::AuthFailure,
                None,
                error.to_string(),
            ));
            return Err(ws_access_error(error));
        }
    };
    // The client address is settled before any resource is acquired, so a chain
    // this deployment cannot attribute never costs a session permit.
    let ip_key = match state.voice_limits.max_ip_sessions {
        Some(_) => match client_ip_key(peer, headers, &state.trusted_proxies) {
            Ok(ip) => Some(ip.to_string()),
            Err(error) => {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::PreflightRejected,
                    None,
                    error.to_string(),
                ));
                return Err(VoiceWsRejection::new(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "voice session client address is not attributable" }),
                ));
            }
        },
        None => None,
    };
    // `SERVICE-012`: the drain flag and the handler count move under one lock,
    // here, before a session slot is allocated. A drain that starts after this
    // returns therefore waits for this handler instead of racing it, and a drain
    // that started before it refuses the upgrade without touching capacity.
    let handler_guard = state.runtime_tracker.enter().map_err(|_| {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PreflightRejected,
            None,
            "server draining",
        ));
        VoiceWsRejection::new(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "voice session draining" }),
        )
    })?;
    let permit = state
        .session_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::PreflightRejected,
                None,
                "capacity exceeded",
            ));
            VoiceWsRejection::new(
                StatusCode::TOO_MANY_REQUESTS,
                json!({ "error": "voice session capacity exceeded" }),
            )
        })?;
    let ip_lease = match (state.voice_limits.max_ip_sessions, ip_key) {
        (Some(max), Some(ip_key)) => match state.limit_state.try_acquire_ip(&ip_key, max) {
            Some(lease) => Some(lease),
            None => {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::PreflightRejected,
                    None,
                    "ip capacity exceeded",
                ));
                return Err(VoiceWsRejection::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    json!({ "error": "voice session IP capacity exceeded" }),
                ));
            }
        },
        _ => None,
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::PreflightAccepted,
        None,
        "websocket preflight accepted",
    ));
    Ok(VoiceAdmission {
        _permit: permit,
        _ip_lease: ip_lease,
        _handler_guard: handler_guard,
        principal,
    })
}

pub(super) fn request_origin(headers: &HeaderMap) -> Option<String> {
    headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn unix_timestamp_now() -> Result<u64, std::time::SystemTimeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BrowserEventAuthorization {
    Authorized,
    Rejected,
    DurabilityDegraded,
}

pub(super) async fn authorize_browser_event(
    state: &AppState,
    session_binding: &AuthorizedClientSession,
    event: &agent_domain::BrainEvent,
) -> BrowserEventAuthorization {
    let result = match event {
        agent_domain::BrainEvent::QuestionStarted { question, .. } => {
            state
                .study_store
                .authorize_question_started(
                    &session_binding.user_id,
                    &session_binding.study_set_id,
                    &session_binding.session_id,
                    question,
                )
                .await
        }
        agent_domain::BrainEvent::AnswerEvaluated {
            response_id,
            evaluation,
        } => {
            state
                .study_store
                .authorize_answer_evaluation(
                    &session_binding.user_id,
                    &session_binding.study_set_id,
                    &session_binding.session_id,
                    response_id,
                    evaluation,
                )
                .await
        }
        agent_domain::BrainEvent::SourceReference { source, .. } => {
            state
                .study_store
                .authorize_source_reference(
                    &session_binding.user_id,
                    &session_binding.study_set_id,
                    &session_binding.session_id,
                    source,
                )
                .await
        }
        agent_domain::BrainEvent::ConceptStatus {
            response_id,
            concept_id,
            status,
            ..
        } => {
            state
                .study_store
                .authorize_concept_status(
                    &session_binding.user_id,
                    &session_binding.study_set_id,
                    &session_binding.session_id,
                    response_id,
                    concept_id,
                    status,
                )
                .await
        }
        agent_domain::BrainEvent::ManuscriptIntent { intent, .. } => {
            state
                .study_store
                .authorize_manuscript_intent(
                    &session_binding.user_id,
                    &session_binding.study_set_id,
                    &session_binding.session_id,
                    intent,
                )
                .await
        }
        agent_domain::BrainEvent::RecapReady { response_id, recap } => {
            state
                .study_store
                .authorize_recap(
                    &session_binding.user_id,
                    &session_binding.study_set_id,
                    &session_binding.session_id,
                    response_id,
                    recap,
                )
                .await
        }
        _ => return BrowserEventAuthorization::Authorized,
    };
    match result {
        Ok(()) => BrowserEventAuthorization::Authorized,
        Err(error) if store_error_is_durability_degraded(state, &error) => {
            BrowserEventAuthorization::DurabilityDegraded
        }
        Err(_) => BrowserEventAuthorization::Rejected,
    }
}

pub(super) enum StudySetAccessResult {
    Allowed(serde_json::Value),
    Denied(ClientFrameError),
    DurabilityDegraded,
}

pub(super) async fn validate_study_set_access(
    state: &AppState,
    config: &SessionConfig,
) -> StudySetAccessResult {
    let (Some(user_id), Some(study_set_id)) =
        (config.user_id.as_deref(), config.study_set_id.as_deref())
    else {
        return StudySetAccessResult::Denied(ClientFrameError::invalid_session_identity());
    };
    match state.study_store.study_context(user_id, study_set_id).await {
        Ok(Some(study_context)) => StudySetAccessResult::Allowed(study_context),
        Ok(None) => StudySetAccessResult::Denied(ClientFrameError::study_set_access_denied()),
        Err(error) if store_error_is_durability_degraded(state, &error) => {
            StudySetAccessResult::DurabilityDegraded
        }
        Err(_) => StudySetAccessResult::Denied(ClientFrameError::study_store_unavailable()),
    }
}

/// `SERVICE-004`/`SERVICE-017`: the single atomic nonce claim and the study-set
/// lookup it gates, in that exact order, moved out of the session loop as one
/// unit.
///
/// The order is the security property: the claim is the last gate before any
/// study lookup, queueing, or provider input, so a replayed credential never
/// reads a study set at all. Returns the authorized study context, or `None`
/// when the socket has already emitted its error/terminal frames, closed, and
/// recorded its terminal reason — the caller then returns.
pub(super) async fn claim_nonce_and_authorize_study_set<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
    voice_session_id: Option<String>,
    token_nonce_claim: Option<SessionTokenNonceClaim>,
    config: &SessionConfig,
) -> Option<serde_json::Value>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if let Some(claim) = token_nonce_claim {
        match state.study_store.claim_session_token_nonce(claim).await {
            Ok(()) => {}
            Err(error) if store_error_is_durability_degraded(state, &error) => {
                close_durability_degraded_before_session(state, sender, voice_session_id).await;
                return None;
            }
            Err(store_error) => {
                let error = if nonce_claim_was_replayed(&store_error) {
                    ClientFrameError::session_auth_failed(SessionAuthFailureCode::Replayed)
                } else {
                    ClientFrameError::nonce_store_unavailable()
                };
                close_client_frame_error_before_session(state, sender, voice_session_id, error)
                    .await;
                return None;
            }
        }
    }
    match validate_study_set_access(state, config).await {
        StudySetAccessResult::Allowed(study_context) => Some(study_context),
        StudySetAccessResult::Denied(error) => {
            close_client_frame_error_before_session(state, sender, voice_session_id, error).await;
            None
        }
        StudySetAccessResult::DurabilityDegraded => {
            close_durability_degraded_before_session(state, sender, voice_session_id).await;
            None
        }
    }
}

/// Emit and record a pre-session rejection: the typed error frame, the Close
/// frame it names, and the terminal reason it records — in that order, with the
/// auth-failure record first, exactly as every pre-session rejection did inline.
pub(super) async fn close_client_frame_error_before_session<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
    voice_session_id: Option<String>,
    error: ClientFrameError,
) where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    record_session_auth_failure(state, voice_session_id.clone(), error.auth_failure_code).await;
    let _ = send_json(sender, &ServerFrame::error(error.code, error.message)).await;
    let _ = close_with(sender, error.close_code, error.close_reason).await;
    record_terminal(state, voice_session_id, error.terminal_reason).await;
}

/// Record the degraded-durability evidence, emit the terminal session phase, and
/// record the label the close produced. Never a client-attributable failure, so
/// no auth-failure record and no typed error frame.
pub(super) async fn close_durability_degraded_before_session<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
    voice_session_id: Option<String>,
) where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::StoreCounts,
        voice_session_id.clone(),
        "durability_degraded",
    ));
    let close_terminal_reason = close_with_terminal_session_phase_only(
        sender,
        TerminalSessionReason::DurabilityDegraded,
        close_code::ERROR,
    )
    .await;
    record_terminal(
        state,
        voice_session_id,
        terminal_label_after_terminal_phase_close(
            TerminalSessionReason::DurabilityDegraded,
            close_terminal_reason,
        ),
    )
    .await;
}

/// A reused nonce is the uniqueness race `PortErrorKind::Conflict` names. Matching
/// the store's diagnostic text instead would silently stop detecting replays the
/// moment a store reworded it.
pub(super) fn nonce_claim_was_replayed(error: &PortError) -> bool {
    error.kind() == PortErrorKind::Conflict
}

pub(super) fn server_active_concepts(study_context: &serde_json::Value) -> Vec<String> {
    study_context
        .get("concepts")
        .and_then(serde_json::Value::as_array)
        .map(|concepts| {
            concepts
                .iter()
                .filter_map(|concept| {
                    concept
                        .get("public_id")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| concept.get("id").and_then(serde_json::Value::as_str))
                })
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub(super) fn session_config_from_message(
    message: Message,
) -> Result<SessionConfig, ClientFrameError> {
    let Message::Text(text) = message else {
        return Err(ClientFrameError::invalid_first_frame());
    };
    if text.len() > VIVA_VOICE_MAX_TEXT_FRAME_BYTES {
        return Err(ClientFrameError::oversized_text());
    }
    let frame: ClientFrame =
        serde_json::from_str(&text).map_err(|_| ClientFrameError::invalid())?;
    if frame.version() != VIVA_VOICE_PROTOCOL_VERSION {
        return Err(ClientFrameError::invalid());
    }
    match frame {
        ClientFrame::SessionConfig { session, .. } => Ok(session),
        _ => Err(ClientFrameError::invalid_first_frame()),
    }
}

/// `SERVICE-007`: the first frame is Plan 05's public `ClientFrame::SessionConfig`,
/// read through Plan 05's strict wire parser. There is no service-private shadow of
/// the initial frame, so `client_generation_id` and the signed credential are
/// structurally required rather than optional.
pub(super) fn initial_session_config_from_message(
    message: Message,
) -> Result<InitialSessionConfig, ClientFrameError> {
    let Message::Text(text) = message else {
        return Err(ClientFrameError::invalid_first_frame());
    };
    if text.len() > VIVA_VOICE_MAX_TEXT_FRAME_BYTES {
        return Err(ClientFrameError::oversized_text());
    }
    let frame: ClientFrame =
        serde_json::from_str(&text).map_err(|_| ClientFrameError::invalid())?;
    if frame.version() != VIVA_VOICE_PROTOCOL_VERSION {
        return Err(ClientFrameError::invalid());
    }
    let ClientFrame::SessionConfig {
        client_generation_id,
        session_token,
        session,
        ..
    } = frame
    else {
        return Err(ClientFrameError::invalid_first_frame());
    };
    if client_generation_id.trim().is_empty() {
        return Err(ClientFrameError::invalid());
    }
    Ok(InitialSessionConfig {
        client_generation_id,
        session,
        session_token,
    })
}

/// Compares the identity a client frame asserts with the identity the server bound,
/// then strips every browser-authored authority field. `expected_session_id` is the
/// session id the client is allowed to name: the signed claim in signed mode, or the
/// configured trusted identity on loopback. It is never the rotated server id, which
/// the browser has no way to learn.
pub(super) fn sanitize_client_session_config(
    mut config: SessionConfig,
    user_id: &str,
    study_set_id: &str,
    expected_session_id: &str,
) -> Result<SessionConfig, ClientFrameError> {
    let Some(session_id) = config.session_id.as_deref() else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    if session_id.trim().is_empty() || session_id != expected_session_id {
        return Err(ClientFrameError::invalid_session_identity());
    }
    let Some(asserted_user_id) = config.user_id.as_deref() else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    if asserted_user_id.trim().is_empty() || asserted_user_id != user_id {
        return Err(ClientFrameError::invalid_session_identity());
    }
    let Some(asserted_study_set_id) = config.study_set_id.as_deref() else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    if asserted_study_set_id.trim().is_empty() || asserted_study_set_id != study_set_id {
        return Err(ClientFrameError::invalid_session_identity());
    }
    config.source_context.clear();
    config.active_concepts.clear();
    config.client_generation_id = None;
    Ok(config)
}

pub(super) fn authorize_initial_session_config(
    initial: InitialSessionConfig,
    state: &AppState,
    principal: &UpgradePrincipal,
    request_origin: &str,
) -> Result<AuthorizedInitialSessionConfig, ClientFrameError> {
    let mut rotate_trusted_session = false;
    let mut failure_control = None;
    let (identity, auth_mode, token_nonce_claim) = if let Some(secret) = state
        .ws_access
        .session_token_secret
        .as_ref()
        .map(RedactedSecret::as_str)
    {
        let token = initial.session_token.as_str();
        // `D-07` branch `retain-token-only`: when the upgrade already verified a
        // credential, the first frame must present that exact one. It is compared
        // in constant time and its verified claims are reused; the frame is never
        // a second chance to present a different credential.
        let claims = match principal {
            UpgradePrincipal::TokenOnly(verified) => {
                if !verified.matches(token) {
                    return Err(ClientFrameError::session_auth_failed(
                        SessionAuthFailureCode::IdentityMismatch,
                    ));
                }
                verified.claims().clone()
            }
            UpgradePrincipal::ServiceBearer => {
                SessionTokenClaims::verify(token, secret).map_err(|error| {
                    ClientFrameError::session_auth_failed(SessionAuthFailureCode::from_token_error(
                        &error,
                    ))
                })?
            }
        };
        if let Some(claim) = claims.failure_control.as_ref() {
            failure_control = Some(
                state
                    .failure_control
                    .validate_claim(
                        claim,
                        &claims.user_id,
                        &claims.study_set_id,
                        &claims.session_id,
                        request_origin,
                        unix_timestamp_now().map_err(|_| {
                            ClientFrameError::session_auth_failed(
                                SessionAuthFailureCode::InvalidSignature,
                            )
                        })?,
                    )
                    .map_err(|error| {
                        ClientFrameError::session_auth_failed(
                            SessionAuthFailureCode::from_token_error(&error),
                        )
                    })?,
            );
        }
        (
            SessionIdentity {
                user_id: claims.user_id.clone(),
                study_set_id: claims.study_set_id.clone(),
                signed_session_id: claims.session_id.clone(),
            },
            SessionAuthMode::Signed,
            Some(SessionTokenNonceClaim {
                user_id: claims.user_id,
                study_set_id: claims.study_set_id,
                voice_session_id: claims.session_id,
                nonce: claims.nonce,
                expires_at: claims.expires_at,
            }),
        )
    } else {
        rotate_trusted_session = true;
        (
            SessionIdentity {
                user_id: state.trusted_user_id.clone(),
                study_set_id: state.trusted_study_set_id.clone(),
                signed_session_id: state.trusted_session_id.clone(),
            },
            SessionAuthMode::Trusted,
            None,
        )
    };
    let mut config = sanitize_client_session_config(
        initial.session,
        &identity.user_id,
        &identity.study_set_id,
        &identity.signed_session_id,
    )?;
    config.client_generation_id = Some(initial.client_generation_id.clone());
    if rotate_trusted_session {
        config.session_id = Some(agent_domain::SessionId::new(
            state.next_trusted_voice_session_id(),
        ));
    }
    let server_session_id = config
        .session_id
        .as_ref()
        .map(ToString::to_string)
        .ok_or_else(ClientFrameError::invalid_session_identity)?;
    let session_binding = AuthorizedClientSession {
        user_id: identity.user_id,
        study_set_id: identity.study_set_id,
        // Provider and store identity. In signed mode it is the verified claim; on
        // trusted loopback it is the rotated server value the browser never sees.
        session_id: server_session_id,
        client_session_id: identity.signed_session_id,
        client_generation_id: initial.client_generation_id,
        bound_session_token: initial.session_token,
        auth_mode,
    };
    Ok(AuthorizedInitialSessionConfig {
        config,
        session_binding,
        token_nonce_claim,
        failure_control,
    })
}

/// `SERVICE-007`: the identity a first frame proves. `signed_session_id` is what the
/// browser may assert on later frames; the server session id is derived from it and
/// kept in [`AuthorizedClientSession`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SessionIdentity {
    pub(super) user_id: String,
    pub(super) study_set_id: String,
    pub(super) signed_session_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SessionAuthMode {
    Trusted,
    Signed,
}

/// `D-03B QUIZ_ONLY`: the only refresh policy this service compiles. `D-03A`'s
/// claim-bound branch would compare a server-bound learning intent; that branch is
/// not selected, so neither its variant nor its comparison exists here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LearningIntentRefreshPolicy {
    QuizOnlyNoRefresh,
}

pub(super) const SESSION_REFRESH_POLICY: LearningIntentRefreshPolicy =
    LearningIntentRefreshPolicy::QuizOnlyNoRefresh;

/// The one engine has no client-selectable mode and no client goal, so every
/// attempted context change is refused before any provider or store work. The
/// denial is recoverable: it changes no session deadline and ends no socket.
pub(super) fn validate_refresh_context(
    policy: LearningIntentRefreshPolicy,
) -> RecoverablePolicyDenial {
    match policy {
        LearningIntentRefreshPolicy::QuizOnlyNoRefresh => RecoverablePolicyDenial::SessionRefresh,
    }
}

/// A refusal the browser can recover from: Plan 05 classifies it nonterminal, so the
/// socket, its leases, and every deadline are unchanged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RecoverablePolicyDenial {
    SessionRefresh,
}

impl RecoverablePolicyDenial {
    pub(super) fn event(self) -> VivaServerEvent {
        match self {
            Self::SessionRefresh => VivaServerEvent::recoverable_structured_error(
                "agent-service",
                "VOICE_SESSION_REFRESH_POLICY_DENIED",
                "Session refresh is not authorized.",
            ),
        }
    }
}

/// Binds an in-socket `session_refresh` to this socket's generation, then applies the
/// selected `D-03` policy. A different or stale generation is a terminal identity
/// failure; a policy denial is recoverable.
pub(super) fn bind_context_refresh(
    client_generation_id: &str,
    authorized: &AuthorizedClientSession,
    policy: LearningIntentRefreshPolicy,
) -> Result<ClientInputAction, ClientFrameError> {
    if client_generation_id != authorized.client_generation_id {
        return Err(ClientFrameError::generation_mismatch());
    }
    Ok(ClientInputAction::RecoverableDenial(
        validate_refresh_context(policy),
    ))
}

/// A later `session_config` re-assertion. It may only restate the identity this
/// socket already bound: the same generation, the same credential in signed mode,
/// and the session id the browser is allowed to name. The provider-facing identity
/// is rewritten to the unchanged server session id, so a rotated trusted session
/// stays invisible to the browser and unaffected by the refresh.
pub(super) fn sanitize_refresh_session_config(
    config: SessionConfig,
    client_generation_id: &str,
    session_token: &str,
    session_binding: &AuthorizedClientSession,
) -> Result<SessionConfig, ClientFrameError> {
    if client_generation_id != session_binding.client_generation_id {
        return Err(ClientFrameError::generation_mismatch());
    }
    if session_binding.auth_mode == SessionAuthMode::Signed
        && !crate::config::constant_time_eq(
            session_binding.bound_session_token.as_bytes(),
            session_token.as_bytes(),
        )
    {
        // Access-token renewal never happens inside an open socket.
        return Err(ClientFrameError::session_auth_failed(
            SessionAuthFailureCode::IdentityMismatch,
        ));
    }
    let mut config = sanitize_client_session_config(
        config,
        &session_binding.user_id,
        &session_binding.study_set_id,
        &session_binding.client_session_id,
    )?;
    config.session_id = Some(agent_domain::SessionId::new(
        session_binding.session_id.clone(),
    ));
    Ok(config)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AuthorizedClientSession {
    pub(super) user_id: String,
    pub(super) study_set_id: String,
    /// Provider and store identity; never client-supplied on a later frame.
    pub(super) session_id: String,
    /// The session id the browser is allowed to assert.
    pub(super) client_session_id: String,
    pub(super) client_generation_id: String,
    /// The credential this socket bound. Compared in constant time on a later
    /// `session_config`; unread on the trusted loopback path.
    pub(super) bound_session_token: String,
    pub(super) auth_mode: SessionAuthMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct InitialSessionConfig {
    pub(super) client_generation_id: String,
    pub(super) session: SessionConfig,
    pub(super) session_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AuthorizedInitialSessionConfig {
    pub(super) config: SessionConfig,
    pub(super) session_binding: AuthorizedClientSession,
    pub(super) token_nonce_claim: Option<SessionTokenNonceClaim>,
    pub(super) failure_control: Option<FailureControlScenario>,
}

pub(super) fn ws_access_error(error: VoiceWsAccessError) -> VoiceWsRejection {
    let status = match error {
        VoiceWsAccessError::OriginDenied => StatusCode::FORBIDDEN,
        VoiceWsAccessError::MissingBearer | VoiceWsAccessError::InvalidBearer => {
            StatusCode::UNAUTHORIZED
        }
    };
    VoiceWsRejection::new(status, json!({ "error": error.to_string() }))
}
