use std::{
    borrow::Cow,
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_domain::{
    fixture_question, learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA, AudioFrame, BrainError,
    BrainEvent, BrainFailureClass, BrainFailureStage, BrainInput, BrainProviderError,
    BrainProviderFailure, BrainProviderFailureParts, PortError, PortErrorKind, RealtimeSession,
    RealtimeSessionTaskGuard, SessionConfig, SessionTokenNonceClaim, StudyQuestion,
    StudySessionDurableCounts, StudySessionPhase, StudySessionRecap, TerminalSessionReason,
    VoiceUsageRecord,
};
use axum::{
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{
    future::{BoxFuture, Fuse, FusedFuture, FutureExt},
    SinkExt, StreamExt,
};
use observe::{VoiceEvidenceEvent, VoiceEvidenceEventKind};
use serde_json::json;
use tokio::{
    sync::{mpsc, watch, OwnedSemaphorePermit},
    time::{timeout, Instant, Sleep},
};

use crate::{
    app::{
        AppState, ProviderAdmission, ProviderAdmissionDecision, ProviderAdmissionDenial,
        ProviderQueueBehavior, VoiceLimitLease, VoiceLimitState,
    },
    config::{
        authenticate_upgrade, bac_510_max_turn_duration, FailureControlScenario, RedactedSecret,
        SessionAuthFailureCode, SessionTokenClaims, TrustedProxyConfig, UpgradePrincipal,
        VoiceLimitConfig, VoiceWsAccessError,
    },
    protocol::{
        parse_client_frame_json, ClientFrame, ClientTurnIntent, ServerFrame, VivaServerEvent,
        VoiceProtocolDiagnostic, VoiceProtocolDiagnosticCode, VoiceServerErrorCode,
        VIVA_AUDIO_MAX_CHUNK_BYTES, VIVA_AUDIO_MAX_TURN_BYTES, VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
        VIVA_VOICE_PROTOCOL_VERSION, VOICE_SERIALIZATION_FALLBACK_FRAME,
    },
};

const TERMINAL_EVENT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const RECONNECT_LEASE_GRACE: Duration = Duration::from_millis(250);
/// `SERVICE-002`: how long a closed socket stays readable so the peer's in-flight
/// bytes are consumed before it is dropped. Server-owned and short: it holds no
/// lease, and dropping a socket with unread bytes resets the connection, which
/// discards the terminal frame and Close frame already written to it.
const CLOSING_HANDSHAKE_GRACE: Duration = Duration::from_millis(250);
const RECONNECT_LEASE_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET: usize = 1;
/// `SERVICE-003`: the longest forwarding chain a trusted proxy may present. The
/// count is checked before a hop vector or a session permit is allocated.
const MAX_FORWARDED_HOPS: usize = 32;

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
    status: StatusCode,
    body: serde_json::Value,
}

impl VoiceWsRejection {
    fn new(status: StatusCode, body: serde_json::Value) -> Self {
        Self { status, body }
    }

    #[cfg(test)]
    fn status(&self) -> StatusCode {
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
fn client_ip_key(
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

pub async fn voice_ws(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, VoiceWsRejection> {
    let admission = validate_ws_preflight(&state, peer, &headers)?;
    let request_origin = request_origin(&headers).unwrap_or_default();

    Ok(ws
        .protocols(["viva-voice"])
        .on_upgrade(move |socket| handle_socket(socket, state, admission, request_origin)))
}

fn validate_ws_preflight(
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
        principal,
    })
}

async fn acquire_user_lease_with_reconnect_grace(
    limits: &VoiceLimitState,
    user_id: &str,
    max: usize,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    acquire_with_reconnect_grace(|| limits.try_acquire_user(user_id, max), grace).await
}

async fn acquire_failure_control_identity_lease_with_reconnect_grace(
    limits: &VoiceLimitState,
    user_id: &str,
    max: usize,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    acquire_with_reconnect_grace(
        || limits.try_acquire_failure_control_identity(user_id, max),
        grace,
    )
    .await
}

async fn acquire_user_study_set_with_reconnect_grace(
    limits: &VoiceLimitState,
    user_id: &str,
    study_set_id: &str,
    max: usize,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    acquire_with_reconnect_grace(
        || limits.try_acquire_user_study_set(user_id, study_set_id, max),
        grace,
    )
    .await
}

async fn acquire_with_reconnect_grace(
    mut acquire: impl FnMut() -> Option<VoiceLimitLease>,
    grace: Duration,
) -> Option<VoiceLimitLease> {
    if let Some(lease) = acquire() {
        return Some(lease);
    }

    let started_at = Instant::now();
    while started_at.elapsed() < grace {
        tokio::time::sleep(RECONNECT_LEASE_RETRY_INTERVAL).await;
        if let Some(lease) = acquire() {
            return Some(lease);
        }
    }
    None
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

struct VoiceAdmission {
    _permit: OwnedSemaphorePermit,
    /// `None` only when per-IP limiting is disabled for this deployment.
    _ip_lease: Option<VoiceLimitLease>,
    principal: UpgradePrincipal,
}

struct SessionLimitRuntime {
    audio_window_started_at: Instant,
    audio_bytes_this_window: u64,
    session_cost_usd: f64,
}

impl SessionLimitRuntime {
    fn new() -> Self {
        Self {
            audio_window_started_at: Instant::now(),
            audio_bytes_this_window: 0,
            session_cost_usd: 0.0,
        }
    }

    fn record_audio_bytes(&mut self, limits: &VoiceLimitConfig, bytes: u64) -> bool {
        let Some(max_bytes) = limits.max_audio_bytes_per_minute else {
            return true;
        };
        if self.audio_window_started_at.elapsed() >= Duration::from_secs(60) {
            self.audio_window_started_at = Instant::now();
            self.audio_bytes_this_window = 0;
        }
        if self.audio_bytes_this_window.saturating_add(bytes) > max_bytes {
            return false;
        }
        self.audio_bytes_this_window = self.audio_bytes_this_window.saturating_add(bytes);
        true
    }

    fn record_session_cost(&mut self, limits: &VoiceLimitConfig, cost_usd: f64) -> bool {
        if cost_usd.is_finite() && cost_usd > 0.0 {
            self.session_cost_usd += cost_usd;
        }
        match limits.max_session_cost_usd {
            Some(max_cost_usd) => self.session_cost_usd <= max_cost_usd,
            None => true,
        }
    }

    fn cost_budget_exhausted(&self, limits: &VoiceLimitConfig) -> bool {
        limits
            .max_session_cost_usd
            .is_some_and(|max_cost_usd| self.session_cost_usd >= max_cost_usd)
    }
}

/// What the heartbeat timer asks the socket to do next.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HeartbeatAction {
    SleepUntil(Instant),
    SendPing,
    Expired,
}

/// `SERVICE-001`: the server-owned transport liveness probe.
///
/// Only a Pong received while one is outstanding clears `pong_deadline`, so an
/// unsolicited Pong buys nothing. Ping/Pong activity never touches the in-turn,
/// between-turn, or absolute-session deadlines: this state owns no other clock.
#[derive(Debug)]
struct HeartbeatState {
    next_ping: Instant,
    pong_deadline: Option<Instant>,
}

impl HeartbeatState {
    fn new(now: Instant, interval: Duration) -> Self {
        Self {
            next_ping: now + interval,
            pong_deadline: None,
        }
    }

    /// The next instant this state has anything to do: an outstanding pong
    /// deadline first, otherwise the next scheduled ping.
    fn next_wake(&self) -> Instant {
        self.pong_deadline.unwrap_or(self.next_ping)
    }

    fn on_timer(
        &mut self,
        now: Instant,
        interval: Duration,
        pong_timeout: Duration,
    ) -> HeartbeatAction {
        if let Some(deadline) = self.pong_deadline {
            return if now >= deadline {
                HeartbeatAction::Expired
            } else {
                HeartbeatAction::SleepUntil(deadline)
            };
        }
        if now < self.next_ping {
            return HeartbeatAction::SleepUntil(self.next_ping);
        }
        self.pong_deadline = Some(now + pong_timeout);
        self.next_ping = now + interval;
        HeartbeatAction::SendPing
    }

    fn on_pong(&mut self, now: Instant, interval: Duration) -> bool {
        if self.pong_deadline.take().is_none() {
            return false;
        }
        self.next_ping = now + interval;
        true
    }
}

/// `SERVICE-002`: why an outbound write did not complete. A missed deadline and a
/// broken sink are different facts and record different sanitized terminal labels.
#[derive(Debug, thiserror::Error)]
enum OutboundWriteError {
    #[error("outbound websocket write exceeded its deadline")]
    Timeout,
    #[error("outbound websocket sink failed")]
    Sink(#[source] axum::Error),
}

/// The one outbound write path. Every server frame, `Ready`, provider event,
/// protocol error, Ping/Pong, terminal frame, and Close frame goes through it, so
/// no write on this socket can outlive one server-configured deadline.
struct BoundedSender<S> {
    inner: S,
    timeout: Duration,
}

impl<S> BoundedSender<S>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    fn new(inner: S, timeout: Duration) -> Self {
        Self { inner, timeout }
    }

    async fn send(&mut self, message: Message) -> Result<(), OutboundWriteError> {
        match tokio::time::timeout(self.timeout, self.inner.send(message)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(OutboundWriteError::Sink(error)),
            Err(_) => Err(OutboundWriteError::Timeout),
        }
    }
}

/// The sanitized terminal label an outbound write failure records. A client that
/// stopped reading is a slow client; a sink that broke is a failed send.
fn outbound_write_terminal_label(error: &OutboundWriteError) -> &'static str {
    match error {
        OutboundWriteError::Timeout => TerminalSessionReason::SlowClient.as_str(),
        OutboundWriteError::Sink(_) => "send_failed",
    }
}

/// Whether a recorded terminal label came from a failed outbound write.
fn is_outbound_write_failure_label(label: &str) -> bool {
    label == "send_failed"
        || label == TerminalSessionReason::SlowClient.as_str()
        || label == HEARTBEAT_TIMEOUT_TERMINAL_LABEL
}

/// `SERVICE-001`: the sanitized terminal label a heartbeat expiry records.
///
/// A peer that stopped answering Pings is half-open; a peer whose outbound write
/// missed its deadline is a slow reader. Both end on Plan 05's published
/// `slow_client` wire contract — this plan adds no wire reason and browsers keep
/// one terminal vocabulary — so the distinction lives in the recorded evidence,
/// which is the only place a half-open socket can be detected after the fact.
/// There is no `TerminalSessionReason` variant for it, exactly as `send_failed`
/// has none.
const HEARTBEAT_TIMEOUT_TERMINAL_LABEL: &str = "heartbeat_timeout";

/// Relabel a completed slow-client close as a heartbeat timeout. A close that
/// degraded under its own store write, or that failed outright, keeps the label
/// it produced: only the ordinary slow-client close is a heartbeat expiry.
fn heartbeat_expiry_terminal_label(close_terminal_label: &'static str) -> &'static str {
    if close_terminal_label == TerminalSessionReason::SlowClient.as_str() {
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL
    } else {
        close_terminal_label
    }
}

/// A client that stopped reading is not worth another provider turn's work, so a
/// missed write deadline aborts the provider tasks before the socket unwinds. A
/// broken sink leaves them to the ordinary teardown.
fn handle_outbound_write_failure(
    error: &OutboundWriteError,
    session: &mut agent_domain::RealtimeSession,
) -> &'static str {
    if matches!(error, OutboundWriteError::Timeout) {
        abort_realtime_session_tasks(session);
    }
    outbound_write_terminal_label(error)
}

/// `SERVICE-008`: serialization is fallible, and its only fallback is Plan 05's
/// published frame. The serializer is a parameter so the fallback is reachable in
/// a test without a frame that cannot be serialized.
fn serialize_server_frame_with<E>(
    frame: &ServerFrame,
    serializer: impl FnOnce(&ServerFrame) -> Result<String, E>,
) -> String {
    serializer(frame).unwrap_or_else(|_| VOICE_SERIALIZATION_FALLBACK_FRAME.to_owned())
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    admission: VoiceAdmission,
    request_origin: String,
) {
    let (sender, receiver) = socket.split();
    // `SERVICE-002`: the bounded sender is installed the instant the socket is
    // split, so there is no window in which an unbounded write is possible.
    let sender = BoundedSender::new(sender, state.ws_timeouts.outbound_write);
    run_voice_session(sender, receiver, state, admission, request_origin).await;
}

/// The whole post-split session, generic over its sink and stream so a
/// deterministic test drives the real cleanup path rather than a parallel helper.
async fn run_voice_session<S, R>(
    mut sender: BoundedSender<S>,
    mut receiver: R,
    state: AppState,
    admission: VoiceAdmission,
    request_origin: String,
) where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
    R: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let principal = admission.principal.clone();
    if send_json(
        &mut sender,
        &ServerFrame::ready_with_capabilities(
            state.brain.capabilities(),
            state.study_store.capabilities(),
        ),
    )
    .await
    .is_err()
    {
        return;
    }

    let mut initial = match timeout(state.ws_timeouts.first_frame, receiver.next()).await {
        Err(_) => {
            let _ = send_json(
                &mut sender,
                &ServerFrame::error(
                    VoiceServerErrorCode::ClientFrameMalformed,
                    "first client frame timeout",
                ),
            )
            .await;
            let _ = close_with(&mut sender, close_code::POLICY, "first frame timeout").await;
            record_terminal(&state, None, "first_frame_timeout").await;
            return;
        }
        Ok(incoming) => match incoming {
            Some(Ok(message)) => {
                match initial_session_config_from_message(message).and_then(|config| {
                    authorize_initial_session_config(config, &state, &principal, &request_origin)
                }) {
                    Ok(config) => config,
                    Err(error) => {
                        record_session_auth_failure(&state, None, error.auth_failure_code).await;
                        let _ =
                            send_json(&mut sender, &ServerFrame::error(error.code, error.message))
                                .await;
                        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                        record_terminal(&state, None, error.terminal_reason).await;
                        return;
                    }
                }
            }
            _ => {
                record_terminal(&state, None, "closed_before_config").await;
                return;
            }
        },
    };
    let session_binding = initial.session_binding.clone();
    let voice_session_id = initial.config.session_id.as_deref().map(ToOwned::to_owned);
    let _failure_control_identity_lease = match (
        initial.failure_control,
        state.failure_control.max_sessions_per_identity(),
    ) {
        (Some(_), Some(max)) => match acquire_failure_control_identity_lease_with_reconnect_grace(
            &state.limit_state,
            &session_binding.user_id,
            max,
            RECONNECT_LEASE_GRACE,
        )
        .await
        {
            Some(lease) => Some(lease),
            None => {
                let terminal_reason = close_with_terminal_session_phase_only(
                    &mut sender,
                    TerminalSessionReason::SessionCap,
                    close_code::POLICY,
                )
                .await;
                record_terminal(&state, None, terminal_reason).await;
                return;
            }
        },
        _ => None,
    };
    let _user_total_lease = match state.voice_limits.max_user_sessions {
        Some(max) => match acquire_user_lease_with_reconnect_grace(
            &state.limit_state,
            &session_binding.user_id,
            max,
            RECONNECT_LEASE_GRACE,
        )
        .await
        {
            Some(lease) => Some(lease),
            None => {
                let terminal_reason = close_with_terminal_session_phase_only(
                    &mut sender,
                    TerminalSessionReason::SessionCap,
                    close_code::POLICY,
                )
                .await;
                record_terminal(&state, None, terminal_reason).await;
                return;
            }
        },
        None => None,
    };
    let _user_study_set_lease = match acquire_user_study_set_with_reconnect_grace(
        &state.limit_state,
        &session_binding.user_id,
        &session_binding.study_set_id,
        MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET,
        RECONNECT_LEASE_GRACE,
    )
    .await
    {
        Some(lease) => lease,
        None => {
            let terminal_reason = close_with_terminal_session_phase_only(
                &mut sender,
                TerminalSessionReason::SessionCap,
                close_code::POLICY,
            )
            .await;
            record_terminal(&state, None, terminal_reason).await;
            return;
        }
    };
    if let Some(admission) = state
        .limit_state
        .provider_backoff_admission(&state.voice_limits)
    {
        record_provider_admission(&state, voice_session_id.clone(), &admission);
        if let ProviderAdmissionDecision::Denied(denial) = admission.decision {
            let terminal_reason = close_with_terminal_session_phase_only(
                &mut sender,
                denial.terminal_reason,
                close_code::POLICY,
            )
            .await;
            record_terminal(&state, voice_session_id, terminal_reason).await;
            return;
        }
    }
    if let Some(claim) = initial.token_nonce_claim.take() {
        match state.study_store.claim_session_token_nonce(claim).await {
            Ok(()) => {}
            Err(error) if store_error_is_durability_degraded(&state, &error) => {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::StoreCounts,
                    voice_session_id.clone(),
                    "durability_degraded",
                ));
                let close_terminal_reason = close_with_terminal_session_phase_only(
                    &mut sender,
                    TerminalSessionReason::DurabilityDegraded,
                    close_code::ERROR,
                )
                .await;
                record_terminal(
                    &state,
                    voice_session_id,
                    terminal_label_after_terminal_phase_close(
                        TerminalSessionReason::DurabilityDegraded,
                        close_terminal_reason,
                    ),
                )
                .await;
                return;
            }
            Err(store_error) => {
                let error = if nonce_claim_was_replayed(&store_error) {
                    ClientFrameError::session_auth_failed(SessionAuthFailureCode::Replayed)
                } else {
                    ClientFrameError::nonce_store_unavailable()
                };
                record_session_auth_failure(
                    &state,
                    voice_session_id.clone(),
                    error.auth_failure_code,
                )
                .await;
                let _ =
                    send_json(&mut sender, &ServerFrame::error(error.code, error.message)).await;
                let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                record_terminal(&state, voice_session_id, error.terminal_reason).await;
                return;
            }
        }
    }
    // `SERVICE-004`: the single atomic nonce claim above is the last gate before
    // any study lookup, queueing, or provider input. Moving the lookup here keeps a
    // replayed credential from reading a study set at all.
    let study_context = match validate_study_set_access(&state, &initial.config).await {
        StudySetAccessResult::Allowed(study_context) => study_context,
        StudySetAccessResult::Denied(error) => {
            record_session_auth_failure(&state, voice_session_id.clone(), error.auth_failure_code)
                .await;
            let _ = send_json(&mut sender, &ServerFrame::error(error.code, error.message)).await;
            let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
            record_terminal(&state, voice_session_id, error.terminal_reason).await;
            return;
        }
        StudySetAccessResult::DurabilityDegraded => {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                voice_session_id.clone(),
                "durability_degraded",
            ));
            let close_terminal_reason = close_with_terminal_session_phase_only(
                &mut sender,
                TerminalSessionReason::DurabilityDegraded,
                close_code::ERROR,
            )
            .await;
            record_terminal(
                &state,
                voice_session_id,
                terminal_label_after_terminal_phase_close(
                    TerminalSessionReason::DurabilityDegraded,
                    close_terminal_reason,
                ),
            )
            .await;
            return;
        }
    };
    let mut initial_config = initial.config;
    initial_config.active_concepts = server_active_concepts(&study_context);
    let failure_control = initial.failure_control;
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ConfigAccepted,
        voice_session_id.clone(),
        "session config accepted",
    ));
    record_turn_cap_config(&state, voice_session_id.clone());
    let session_started_at = Instant::now();

    let session_result = match failure_control {
        Some(scenario) => open_failure_control_session(&state, initial_config, scenario).await,
        None => state.brain.open(initial_config).await,
    };
    let mut session = match session_result {
        Ok(session) => session,
        Err(error) => {
            let terminal_reason = if brain_error_is_durability_degraded(&state, &error) {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::StoreCounts,
                    voice_session_id.clone(),
                    "durability_degraded",
                ));
                TerminalSessionReason::DurabilityDegraded
            } else {
                record_brain_open_provider_failure(&state, voice_session_id.clone(), &error);
                terminal_reason_for_brain_error(&error)
            };
            let close_terminal_reason = close_with_terminal_session_phase_only(
                &mut sender,
                terminal_reason,
                close_code::ERROR,
            )
            .await;
            let recorded_terminal_reason =
                terminal_label_after_terminal_phase_close(terminal_reason, close_terminal_reason);
            record_terminal(&state, voice_session_id, recorded_terminal_reason).await;
            return;
        }
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::SessionOpened,
        voice_session_id.clone(),
        "session opened",
    ));
    let mut terminal_reason = "event_stream_closed";
    let mut terminal_persisted = false;
    let mut cancelled_responses = CancelledResponseTracker::default();
    let mut session_limits = SessionLimitRuntime::new();
    let mut turn_bindings = TurnBindingTracker::default();
    // One bounded browser audio turn under assembly at a time, connection-local.
    let mut incoming_audio_turn = AudioTurnAssembly::default();
    let session_cap = tokio::time::sleep(state.ws_timeouts.session);
    tokio::pin!(session_cap);
    let turn_cap = tokio::time::sleep(state.ws_timeouts.idle);
    tokio::pin!(turn_cap);
    // `SERVICE-001`: the sleeping-client deadline between turns, never the
    // in-turn progress deadline. A client frame cannot extend it.
    let pre_answer_idle = tokio::time::sleep(state.ws_timeouts.between_turn_idle);
    tokio::pin!(pre_answer_idle);
    let mut pre_answer_idle_armed = true;
    let mut turn_cap_deadline: Option<Instant> = None;
    let mut pending_submitted_answers = 0_u32;
    let mut active_provider_turns = 0_u32;
    let mut pending_provider_admissions = Vec::<VoiceLimitLease>::new();
    let mut pending_provider_admission: Fuse<BoxFuture<'static, QueuedProviderAdmission>> =
        Fuse::terminated();
    let mut pending_provider_admission_reserved_submission = false;
    let mut resolved_submitted_answer_response_ids = HashSet::<String>::new();
    let mut completed_provider_turn_response_ids = HashSet::<String>::new();
    let mut superseded_provider_turn_response_ids = HashSet::<String>::new();
    let mut turn_work_outstanding = false;
    // `SERVICE-001`: the transport liveness probe owns its own timer. It never
    // reads or writes the absolute-session, in-turn, or between-turn sleepers.
    let mut heartbeat = HeartbeatState::new(Instant::now(), state.ws_timeouts.heartbeat_interval);
    let heartbeat_timer = tokio::time::sleep_until(heartbeat.next_wake());
    tokio::pin!(heartbeat_timer);
    let mut drain_signal = state.drain_signal.subscribe();
    if *drain_signal.borrow_and_update() {
        terminal_reason = close_with_terminal_session_phase(
            &mut sender,
            &session.input,
            &state,
            voice_session_id.clone(),
            &mut terminal_persisted,
            TerminalSessionReason::Drained,
            close_code::NORMAL,
        )
        .await;
        record_terminal_evidence(&state, voice_session_id, terminal_reason).await;
        return;
    }

    loop {
        // `SERVICE-001`: the falling edge of outstanding turn work is the only
        // thing that re-arms the between-turn deadline. A client frame, a
        // keepalive, a context-only refresh, or a repeated resolution reaches
        // this point with the counters unchanged, so none of them moves it.
        let outstanding = pending_submitted_answers != 0 || active_provider_turns != 0;
        if turn_work_outstanding
            && !outstanding
            && rearm_between_turn_idle(
                pending_submitted_answers,
                active_provider_turns,
                pre_answer_idle.as_mut(),
                Instant::now(),
                state.ws_timeouts.between_turn_idle,
            )
        {
            pre_answer_idle_armed = true;
        }
        turn_work_outstanding = outstanding;

        tokio::select! {
            biased;

            changed = drain_signal.changed() => {
                if changed.is_ok() && *drain_signal.borrow_and_update() {
                    terminal_reason = close_with_terminal_session_phase(
                        &mut sender,
                        &session.input,
                        &state,
                        voice_session_id.clone(),
                        &mut terminal_persisted,
                        TerminalSessionReason::Drained,
                        close_code::NORMAL,
                    )
                    .await;
                    break;
                }
            }
            _ = &mut session_cap => {
                terminal_reason = close_with_terminal_session_phase(
                    &mut sender,
                    &session.input,
                    &state,
                    voice_session_id.clone(),
                    &mut terminal_persisted,
                    TerminalSessionReason::SessionCap,
                    close_code::POLICY,
                )
                .await;
                break;
            }
            _ = &mut pre_answer_idle, if pre_answer_idle_armed => {
                abort_realtime_session_tasks(&mut session);
                terminal_reason = close_with_terminal_session_phase(
                    &mut sender,
                    &session.input,
                    &state,
                    voice_session_id.clone(),
                    &mut terminal_persisted,
                    TerminalSessionReason::TurnCap,
                    close_code::POLICY,
                )
                .await;
                break;
            }
            _ = &mut turn_cap, if turn_cap_deadline.is_some() => {
                abort_realtime_session_tasks(&mut session);
                terminal_reason = close_with_terminal_session_phase(
                    &mut sender,
                    &session.input,
                    &state,
                    voice_session_id.clone(),
                    &mut terminal_persisted,
                    TerminalSessionReason::TurnCap,
                    close_code::POLICY,
                )
                .await;
                break;
            }
            _ = &mut heartbeat_timer => {
                match heartbeat.on_timer(
                    Instant::now(),
                    state.ws_timeouts.heartbeat_interval,
                    state.ws_timeouts.pong_timeout,
                ) {
                    HeartbeatAction::SleepUntil(deadline) => {
                        heartbeat_timer.as_mut().reset(deadline);
                    }
                    HeartbeatAction::SendPing => {
                        if let Err(error) = sender.send(Message::Ping(Vec::new().into())).await {
                            terminal_reason = handle_outbound_write_failure(&error, &mut session);
                            break;
                        }
                        heartbeat_timer.as_mut().reset(heartbeat.next_wake());
                    }
                    HeartbeatAction::Expired => {
                        // The wire contract is Plan 05's published slow-client
                        // termination; the recorded label is `heartbeat_timeout`,
                        // so a half-open peer is never read back as a slow reader.
                        abort_realtime_session_tasks(&mut session);
                        terminal_reason = heartbeat_expiry_terminal_label(
                            close_with_terminal_session_phase(
                                &mut sender,
                                &session.input,
                                &state,
                                voice_session_id.clone(),
                                &mut terminal_persisted,
                                TerminalSessionReason::SlowClient,
                                close_code::POLICY,
                            )
                            .await,
                        );
                        break;
                    }
                }
            }
            queued = &mut pending_provider_admission, if !pending_provider_admission.is_terminated() => {
                let QueuedProviderAdmission {
                    client_input,
                    mut admission,
                } = queued;
                let admission_reserved_submission =
                    pending_provider_admission_reserved_submission;
                pending_provider_admission_reserved_submission = false;
                record_provider_admission(&state, voice_session_id.clone(), &admission);
                if let ProviderAdmissionDecision::Denied(denial) = &admission.decision {
                    terminal_reason = close_with_terminal_session_phase(
                        &mut sender,
                        &session.input,
                        &state,
                        voice_session_id.clone(),
                        &mut terminal_persisted,
                        denial.terminal_reason,
                        close_code::POLICY,
                    )
                    .await;
                    break;
                }
                let accepted_audio_turn = client_input.accepted_audio_turn();
                let submitted_turn_id = client_input.submitted_turn_id().map(ToOwned::to_owned);
                let mut provider_admission_lease = admission.lease.take();
                let turn_send_deadline = if client_input.action().arms_turn_cap() {
                    pre_answer_idle_armed = false;
                    if !admission_reserved_submission {
                        pending_submitted_answers = pending_submitted_answers.saturating_add(1);
                    }
                    Some(*turn_cap_deadline.get_or_insert_with(|| {
                        let deadline = Instant::now() + state.ws_timeouts.idle;
                        turn_cap.as_mut().reset(deadline);
                        deadline
                    }))
                } else {
                    None
                };
                match send_client_input_action_with_drain(
                    &session.input,
                    client_input,
                    &mut drain_signal,
                    turn_send_deadline,
                )
                .await
                {
                    Ok(action) => {
                        record_client_action(&state, voice_session_id.clone(), action);
                        if action.arms_turn_cap() {
                            register_submitted_turn(
                                &mut turn_bindings,
                                submitted_turn_id.as_deref(),
                            );
                            mark_completed_provider_turns_superseded(
                                &completed_provider_turn_response_ids,
                                &mut superseded_provider_turn_response_ids,
                            );
                            active_provider_turns = active_provider_turns.saturating_add(1);
                            if let Some(lease) = provider_admission_lease.take() {
                                pending_provider_admissions.push(lease);
                            }
                        }
                        if let Some(accepted) = accepted_audio_turn {
                            if let Err(error) = send_json(
                                &mut sender,
                                &ServerFrame::audio_turn_accepted(
                                    accepted.client_generation_id,
                                    accepted.turn_id,
                                    accepted.final_sequence,
                                ),
                            )
                            .await
                            {
                                terminal_reason = handle_outbound_write_failure(&error, &mut session);
                                break;
                            }
                        }
                    }
                    Err(ClientMessageError::Drained) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::Drained,
                            close_code::NORMAL,
                        )
                        .await;
                        break;
                    }
                    Err(ClientMessageError::RateLimit) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::RateLimit,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                    Err(ClientMessageError::Frame(error)) => {
                        let _ = send_json(&mut sender, &ServerFrame::error(error.code, error.message)).await;
                        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                        terminal_reason = error.terminal_reason;
                        break;
                    }
                    Err(ClientMessageError::TurnCap) => {
                        abort_realtime_session_tasks(&mut session);
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::TurnCap,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else {
                    let _ = session.input.try_send(BrainInput::Stop);
                    state.evidence.record(VoiceEvidenceEvent::new(
                        VoiceEvidenceEventKind::StopReceived,
                        voice_session_id.clone(),
                        "disconnect sent stop",
                    ));
                    terminal_reason = "client_disconnect";
                    break;
                };
                // `SERVICE-001`: WebSocket control frames are transport, not
                // protocol. They are answered here, before any `ClientFrame`
                // parsing, and they move no session deadline.
                match &message {
                    Message::Ping(payload) => {
                        let payload = payload.clone();
                        if let Err(error) = sender.send(Message::Pong(payload)).await {
                            terminal_reason = handle_outbound_write_failure(&error, &mut session);
                            break;
                        }
                        continue;
                    }
                    Message::Pong(_) => {
                        if heartbeat
                            .on_pong(Instant::now(), state.ws_timeouts.heartbeat_interval)
                        {
                            heartbeat_timer.as_mut().reset(heartbeat.next_wake());
                        }
                        continue;
                    }
                    Message::Text(_) | Message::Binary(_) | Message::Close(_) => {}
                }
                let client_input = match prepare_client_message_with_drain(
                    message,
                    &session_binding,
                    &state.voice_limits,
                    &mut session_limits,
                    &mut incoming_audio_turn,
                ) {
                    Ok(client_input) => client_input,
                    Err(ClientMessageError::Drained) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::Drained,
                            close_code::NORMAL,
                        )
                        .await;
                        break;
                    }
                    Err(ClientMessageError::RateLimit) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::RateLimit,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                    Err(ClientMessageError::Frame(error)) => {
                        record_session_auth_failure(&state, voice_session_id.clone(), error.auth_failure_code)
                            .await;
                        let _ = send_json(&mut sender, &ServerFrame::error(error.code, error.message)).await;
                        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                        terminal_reason = error.terminal_reason;
                        break;
                    }
                    Err(ClientMessageError::TurnCap) => unreachable!("pre-send parsing cannot trip turn cap"),
                };
                // `D-03B QUIZ_ONLY`: service policy refuses the parsed context change
                // on the same socket. No provider input, store write, lease, or
                // deadline is touched, and Plan 05 classifies the frame nonterminal.
                if let Some(denial) = client_input.recoverable_denial() {
                    if let Err(error) = send_json(
                        &mut sender,
                        &ServerFrame::Event {
                            version: VIVA_VOICE_PROTOCOL_VERSION,
                            event: Box::new(denial.event()),
                        },
                    )
                    .await
                    {
                        terminal_reason = handle_outbound_write_failure(&error, &mut session);
                        break;
                    }
                    continue;
                }
                if !pending_provider_admission.is_terminated()
                    && client_input.action() == ClientAction::Cancel
                {
                    pending_provider_admission = Fuse::terminated();
                    if pending_provider_admission_reserved_submission {
                        pending_submitted_answers = pending_submitted_answers.saturating_sub(1);
                        pending_provider_admission_reserved_submission = false;
                        if pending_submitted_answers == 0 {
                            turn_cap_deadline = None;
                        }
                        // The `continue` below returns to the loop head, whose
                        // falling-edge check is the one place the between-turn
                        // deadline is re-armed.
                    }
                    match send_client_input_action_with_drain(
                        &session.input,
                        client_input,
                        &mut drain_signal,
                        None,
                    )
                    .await
                    {
                        Ok(action) => {
                            record_client_action(&state, voice_session_id.clone(), action);
                        }
                        Err(ClientMessageError::Drained) => {
                            terminal_reason = close_with_terminal_session_phase(
                                &mut sender,
                                &session.input,
                                &state,
                                voice_session_id.clone(),
                                &mut terminal_persisted,
                                TerminalSessionReason::Drained,
                                close_code::NORMAL,
                            )
                            .await;
                            break;
                        }
                        Err(ClientMessageError::RateLimit) => {
                            terminal_reason = close_with_terminal_session_phase(
                                &mut sender,
                                &session.input,
                                &state,
                                voice_session_id.clone(),
                                &mut terminal_persisted,
                                TerminalSessionReason::RateLimit,
                                close_code::POLICY,
                            )
                            .await;
                            break;
                        }
                        Err(ClientMessageError::Frame(error)) => {
                            let _ = send_json(&mut sender, &ServerFrame::error(error.code, error.message)).await;
                            let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                            terminal_reason = error.terminal_reason;
                            break;
                        }
                        Err(ClientMessageError::TurnCap) => {
                            abort_realtime_session_tasks(&mut session);
                            terminal_reason = close_with_terminal_session_phase(
                                &mut sender,
                                &session.input,
                                &state,
                                voice_session_id.clone(),
                                &mut terminal_persisted,
                                TerminalSessionReason::TurnCap,
                                close_code::POLICY,
                            )
                            .await;
                            break;
                        }
                    }
                    continue;
                }
                let accepted_audio_turn = client_input.accepted_audio_turn();
                let submitted_turn_id = client_input.submitted_turn_id().map(ToOwned::to_owned);
                let mut provider_admission_lease = None;
                let requires_provider_admission =
                    client_input_requires_provider_admission(&client_input);
                if requires_provider_admission {
                    {
                        let mut forward_context = BrainForwardContext {
                            state: &state,
                            voice_session_id: voice_session_id.clone(),
                            session_binding: &session_binding,
                            limits: &state.voice_limits,
                            session_limits: &mut session_limits,
                            turn_bindings: &mut turn_bindings,
                        };
                        let mut provider_runtime = ProviderTurnRuntime {
                            pending_submitted_answers: &mut pending_submitted_answers,
                            active_provider_turns: &mut active_provider_turns,
                            pending_provider_admissions: &mut pending_provider_admissions,
                            resolved_submitted_answer_response_ids: &mut resolved_submitted_answer_response_ids,
                            completed_provider_turn_response_ids: &mut completed_provider_turn_response_ids,
                            superseded_provider_turn_response_ids: &mut superseded_provider_turn_response_ids,
                            turn_cap_deadline: &mut turn_cap_deadline,
                        };
                        match forward_ready_brain_events(
                            &mut forward_context,
                            &mut session.events,
                            &mut cancelled_responses,
                            session_started_at,
                            &mut sender,
                            &mut provider_runtime,
                        )
                        .await
                        {
                            Ok(ForwardBrainEvent::Continue | ForwardBrainEvent::Suppressed) => {}
                            Ok(ForwardBrainEvent::Rejected) => {
                                terminal_reason = "provider_source_authority_rejected";
                                let _ = close_with(
                                    &mut sender,
                                    close_code::POLICY,
                                    "provider source authority rejected",
                                )
                                .await;
                                break;
                            }
                            Ok(ForwardBrainEvent::DurabilityDegraded) => {
                                terminal_reason = close_with_terminal_session_phase(
                                    &mut sender,
                                    &session.input,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_persisted,
                                    TerminalSessionReason::DurabilityDegraded,
                                    close_code::ERROR,
                                )
                                .await;
                                break;
                            }
                            Ok(ForwardBrainEvent::CostBudgetExceeded) => {
                                terminal_reason = close_with_terminal_session_phase(
                                    &mut sender,
                                    &session.input,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_persisted,
                                    TerminalSessionReason::CostBudget,
                                    close_code::POLICY,
                                )
                                .await;
                                break;
                            }
                            Ok(ForwardBrainEvent::ProviderFailure {
                                reason,
                                response_id,
                            }) => {
                                if let Err(error) = send_partial_recap_for_provider_failure(
                                    &forward_context,
                                    reason,
                                    response_id.as_deref(),
                                    &mut sender,
                                )
                                .await
                                {
                                    terminal_reason = handle_outbound_write_failure(&error, &mut session);
                                    break;
                                }
                                terminal_reason = close_with_terminal_session_phase(
                                    &mut sender,
                                    &session.input,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_persisted,
                                    reason,
                                    close_code::ERROR,
                                )
                                .await;
                                break;
                            }
                            Err(error) => {
                                terminal_reason = handle_outbound_write_failure(&error, &mut session);
                                break;
                            }
                        }
                    }
                    let mut admission = if session_limits.cost_budget_exhausted(&state.voice_limits) {
                        ProviderAdmission::denied(ProviderAdmissionDenial {
                            reason: "cost_budget",
                            terminal_reason: TerminalSessionReason::CostBudget,
                            retry_after_ms: 0,
                            reset_hint: "none".to_owned(),
                            budget_state: "exhausted".to_owned(),
                            queue_depth: 0,
                            queue_delay_ms: 0,
                        })
                    } else {
                        if pending_provider_admissions.is_empty()
                            && pending_provider_admission.is_terminated()
                        {
                            if client_input.action().arms_turn_cap() {
                                pre_answer_idle_armed = false;
                                pending_submitted_answers =
                                    pending_submitted_answers.saturating_add(1);
                                pending_provider_admission_reserved_submission = true;
                                turn_cap_deadline.get_or_insert_with(|| {
                                    let deadline = Instant::now() + state.ws_timeouts.idle;
                                    turn_cap.as_mut().reset(deadline);
                                    deadline
                                });
                            } else {
                                pending_provider_admission_reserved_submission = false;
                            }
                            pending_provider_admission = start_provider_admission(
                                state.limit_state.clone(),
                                state.voice_limits.clone(),
                                client_input,
                                ProviderQueueBehavior::Wait,
                            );
                            continue;
                        }
                        let queue_behavior =
                            ProviderQueueBehavior::Deny {
                                reason: "overlapping_provider_turn",
                                terminal_reason: TerminalSessionReason::SlowClient,
                            };
                        state
                            .limit_state
                            .try_admit_provider_turn(&state.voice_limits, queue_behavior)
                            .await
                    };
                    record_provider_admission(&state, voice_session_id.clone(), &admission);
                    if let ProviderAdmissionDecision::Denied(denial) = &admission.decision {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            denial.terminal_reason,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                    provider_admission_lease = admission.lease.take();
                }
                let starts_new_submitted_turn =
                    client_input.action().arms_turn_cap() && requires_provider_admission;
                let turn_send_deadline = if starts_new_submitted_turn {
                    pre_answer_idle_armed = false;
                    pending_submitted_answers = pending_submitted_answers.saturating_add(1);
                    Some(*turn_cap_deadline.get_or_insert_with(|| {
                        let deadline = Instant::now() + state.ws_timeouts.idle;
                        turn_cap.as_mut().reset(deadline);
                        deadline
                    }))
                } else if client_input.action().arms_turn_cap() {
                    turn_cap_deadline
                } else {
                    None
                };
                match send_client_input_action_with_drain(
                    &session.input,
                    client_input,
                    &mut drain_signal,
                    turn_send_deadline,
                )
                .await
                {
                    Ok(action) => {
                        record_client_action(&state, voice_session_id.clone(), action);
                        if action.arms_turn_cap() {
                            register_submitted_turn(
                                &mut turn_bindings,
                                submitted_turn_id.as_deref(),
                            );
                            if requires_provider_admission {
                                mark_completed_provider_turns_superseded(
                                    &completed_provider_turn_response_ids,
                                    &mut superseded_provider_turn_response_ids,
                                );
                                active_provider_turns = active_provider_turns.saturating_add(1);
                            }
                            if let Some(lease) = provider_admission_lease.take() {
                                pending_provider_admissions.push(lease);
                            }
                        }
                        if let Some(accepted) = accepted_audio_turn {
                            if let Err(error) = send_json(
                                &mut sender,
                                &ServerFrame::audio_turn_accepted(
                                    accepted.client_generation_id,
                                    accepted.turn_id,
                                    accepted.final_sequence,
                                ),
                            )
                            .await
                            {
                                terminal_reason = handle_outbound_write_failure(&error, &mut session);
                                break;
                            }
                        }
                        match action {
                            ClientAction::Stop => {
                                let mut forward_context = BrainForwardContext {
                                    state: &state,
                                    voice_session_id: voice_session_id.clone(),
                                    session_binding: &session_binding,
                                    limits: &state.voice_limits,
                                    session_limits: &mut session_limits,
                                    turn_bindings: &mut turn_bindings,
                                };
                                match drain_terminal_events(
                                    &mut forward_context,
                                    &mut session.events,
                                    &mut cancelled_responses,
                                    session_started_at,
                                    &mut sender,
                                )
                                .await
                                {
                                    Ok(ForwardBrainEvent::Continue | ForwardBrainEvent::Suppressed) => {}
                                    Ok(ForwardBrainEvent::Rejected) => {
                                        terminal_reason = "provider_source_authority_rejected";
                                        let _ = close_with(
                                            &mut sender,
                                            close_code::POLICY,
                                            "provider source authority rejected",
                                        )
                                        .await;
                                        break;
                                    }
                                    Ok(ForwardBrainEvent::DurabilityDegraded) => {
                                        terminal_reason = close_with_terminal_session_phase(
                                            &mut sender,
                                            &session.input,
                                            &state,
                                            voice_session_id.clone(),
                                            &mut terminal_persisted,
                                            TerminalSessionReason::DurabilityDegraded,
                                            close_code::ERROR,
                                        )
                                        .await;
                                        break;
                                    }
                                    Ok(ForwardBrainEvent::CostBudgetExceeded) => {
                                        terminal_reason = close_with_terminal_session_phase(
                                            &mut sender,
                                            &session.input,
                                            &state,
                                            voice_session_id.clone(),
                                            &mut terminal_persisted,
                                            TerminalSessionReason::CostBudget,
                                            close_code::POLICY,
                                        )
                                        .await;
                                        break;
                                    }
                                    Ok(ForwardBrainEvent::ProviderFailure {
                                        reason,
                                        response_id,
                                    }) => {
                                        if let Err(error) = send_partial_recap_for_provider_failure(
                                            &forward_context,
                                            reason,
                                            response_id.as_deref(),
                                            &mut sender,
                                        )
                                        .await
                                        {
                                            terminal_reason = handle_outbound_write_failure(&error, &mut session);
                                            break;
                                        }
                                        terminal_reason = close_with_terminal_session_phase(
                                            &mut sender,
                                            &session.input,
                                            &state,
                                            voice_session_id.clone(),
                                            &mut terminal_persisted,
                                            reason,
                                            close_code::ERROR,
                                        )
                                        .await;
                                        break;
                                    }
                                    Err(error) => {
                                        terminal_reason = handle_outbound_write_failure(&error, &mut session);
                                        let _ = close_with(
                                            &mut sender,
                                            close_code::NORMAL,
                                            "client stop",
                                        )
                                        .await;
                                        break;
                                    }
                                }
                                terminal_reason = close_with_client_stop(
                                    &mut sender,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_persisted,
                                )
                                .await;
                                break;
                            }
                            ClientAction::Close => {
                                terminal_reason = close_with_client_stop(
                                    &mut sender,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_persisted,
                                )
                                .await;
                                break;
                            }
                            _ => {}
                        }
                    }
                    Err(ClientMessageError::Drained) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::Drained,
                            close_code::NORMAL,
                        )
                        .await;
                        break;
                    }
                    Err(ClientMessageError::RateLimit) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::RateLimit,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                    Err(ClientMessageError::Frame(error)) => {
                        let _ = send_json(&mut sender, &ServerFrame::error(error.code, error.message)).await;
                        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                        terminal_reason = error.terminal_reason;
                        break;
                    }
                    Err(ClientMessageError::TurnCap) => {
                        abort_realtime_session_tasks(&mut session);
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::TurnCap,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                }
            }
            event = session.events.recv() => {
                let Some(event) = event else {
                    break;
                };
                let mut forward_context = BrainForwardContext {
                    state: &state,
                    voice_session_id: voice_session_id.clone(),
                    session_binding: &session_binding,
                    limits: &state.voice_limits,
                    session_limits: &mut session_limits,
                    turn_bindings: &mut turn_bindings,
                };
                let mut provider_runtime = ProviderTurnRuntime {
                    pending_submitted_answers: &mut pending_submitted_answers,
                    active_provider_turns: &mut active_provider_turns,
                    pending_provider_admissions: &mut pending_provider_admissions,
                    resolved_submitted_answer_response_ids: &mut resolved_submitted_answer_response_ids,
                    completed_provider_turn_response_ids: &mut completed_provider_turn_response_ids,
                    superseded_provider_turn_response_ids: &mut superseded_provider_turn_response_ids,
                    turn_cap_deadline: &mut turn_cap_deadline,
                };
                match forward_brain_event_with_turn_accounting(
                    &mut forward_context,
                    event,
                    &mut cancelled_responses,
                    session_started_at,
                    &mut sender,
                    &mut provider_runtime,
                )
                .await
                {
                    Ok(ForwardBrainEvent::Continue) => {}
                    Ok(ForwardBrainEvent::Suppressed) => {}
                    Ok(ForwardBrainEvent::Rejected) => {
                        terminal_reason = "provider_source_authority_rejected";
                        let _ = close_with(
                            &mut sender,
                            close_code::POLICY,
                            "provider source authority rejected",
                        )
                        .await;
                        break;
                    }
                    Ok(ForwardBrainEvent::DurabilityDegraded) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::DurabilityDegraded,
                            close_code::ERROR,
                        )
                        .await;
                        break;
                    }
                    Ok(ForwardBrainEvent::CostBudgetExceeded) => {
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            TerminalSessionReason::CostBudget,
                            close_code::POLICY,
                        )
                        .await;
                        break;
                    }
                    Ok(ForwardBrainEvent::ProviderFailure {
                        reason,
                        response_id,
                    }) => {
                        if let Err(error) = send_partial_recap_for_provider_failure(
                            &forward_context,
                            reason,
                            response_id.as_deref(),
                            &mut sender,
                        )
                        .await
                        {
                            terminal_reason = handle_outbound_write_failure(&error, &mut session);
                            break;
                        }
                        terminal_reason = close_with_terminal_session_phase(
                            &mut sender,
                            &session.input,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_persisted,
                            reason,
                            close_code::ERROR,
                        )
                        .await;
                        break;
                    }
                    Err(error) => {
                        terminal_reason = handle_outbound_write_failure(&error, &mut session);
                        break;
                    }
                }
            }
        }
    }
    if terminal_persisted {
        record_terminal_evidence(&state, voice_session_id, terminal_reason).await;
    } else {
        record_terminal(&state, voice_session_id, terminal_reason).await;
    }
    // `SERVICE-002`: every server-owned permit is released *before* the closing
    // handshake is waited on, so a client that never answers the Close cannot
    // hold a lease for the length of that wait.
    drop(pending_provider_admissions);
    drop(session);
    drop(_user_study_set_lease);
    drop(_user_total_lease);
    drop(_failure_control_identity_lease);
    drop(admission);
    // A socket whose own write side already failed, or whose client is already
    // gone, has no handshake left to finish and must not wait for one.
    if !is_outbound_write_failure_label(terminal_reason) && terminal_reason != "client_disconnect" {
        finish_closing_handshake(&mut receiver, CLOSING_HANDSHAKE_GRACE).await;
    }
}

/// `SERVICE-002`: read the peer out before the socket is dropped.
///
/// Dropping a socket that still holds unread client bytes resets the connection,
/// and a reset discards the terminal frame and the Close frame already written to
/// it — the client sees a transport error instead of the reason it was closed.
/// The wait is bounded by a server-owned grace and holds no lease; a client can
/// neither shorten nor extend it.
async fn finish_closing_handshake<R>(receiver: &mut R, grace: Duration)
where
    R: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let _ = timeout(grace, async {
        while let Some(Ok(message)) = receiver.next().await {
            if matches!(message, Message::Close(_)) {
                return;
            }
        }
    })
    .await;
}

fn abort_realtime_session_tasks(session: &mut agent_domain::RealtimeSession) {
    drop(session.task_guard.take());
}

/// `SERVICE-006`: how one provider event resolves outstanding turn work. There is
/// exactly one mapping and both the submitted-answer counter and the
/// active-provider-turn counter consume the same returned value, so the two can
/// never disagree about whether a turn ended.
#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderTurnResolution {
    One { response_id: Option<String> },
    All,
}

/// The single classification of a provider event.
///
/// `BrainEvent` is `#[non_exhaustive]` in another crate, so the final arm safely
/// ignores a future event until its contract owner classifies it; every current
/// variant is named explicitly above it and pinned by the lane's table test.
fn classify_provider_turn_event(event: &BrainEvent) -> Option<ProviderTurnResolution> {
    match event {
        BrainEvent::TerminalSessionPhase { .. } => Some(ProviderTurnResolution::All),
        BrainEvent::AnswerEvaluated { response_id, .. }
        | BrainEvent::RecapReady { response_id, .. }
        | BrainEvent::ResponseCompleted { response_id }
        | BrainEvent::TurnDeferred { response_id, .. }
        | BrainEvent::ResponseCancelledFor { response_id } => Some(ProviderTurnResolution::One {
            response_id: Some(response_id.clone()),
        }),
        BrainEvent::ResponseCancelled => Some(ProviderTurnResolution::One { response_id: None }),
        BrainEvent::SessionPhase { .. }
        | BrainEvent::QuestionStarted { .. }
        | BrainEvent::TranscriptDelta { .. }
        | BrainEvent::SourceReference { .. }
        | BrainEvent::ConceptStatus { .. }
        | BrainEvent::ManuscriptIntent { .. }
        | BrainEvent::AudioDelta { .. }
        | BrainEvent::ResponseStarted { .. }
        | BrainEvent::ResponseAudio { .. }
        | BrainEvent::Transcript(_)
        | BrainEvent::ResponseToolProposal { .. }
        | BrainEvent::Usage(_)
        | BrainEvent::ProviderFallbackActivated { .. }
        | BrainEvent::Error(_)
        | BrainEvent::SpeechIntent(_)
        | BrainEvent::InputSpeechStarted
        | BrainEvent::InputSpeechStopped
        | BrainEvent::ResponseTranscriptDelta { .. }
        | BrainEvent::ResponseTextStarted { .. }
        | BrainEvent::TranscriptFinal { .. } => None,
        _ => None,
    }
}

/// `SERVICE-001`: return a socket with no outstanding work to the between-turn
/// sleeping-client deadline. Returns `false` — leaving the deadline exactly where
/// it was — while any submitted answer or provider turn is still outstanding, so
/// a mid-turn event can never postpone it.
fn rearm_between_turn_idle(
    pending_submitted_answers: u32,
    active_provider_turns: u32,
    mut sleeper: Pin<&mut Sleep>,
    now: Instant,
    timeout: Duration,
) -> bool {
    if pending_submitted_answers != 0 || active_provider_turns != 0 {
        return false;
    }
    sleeper.as_mut().reset(now + timeout);
    true
}

async fn close_with_terminal_session_phase<S>(
    sender: &mut BoundedSender<S>,
    input: &mpsc::Sender<BrainInput>,
    state: &AppState,
    voice_session_id: Option<String>,
    terminal_persisted: &mut bool,
    terminal_reason: TerminalSessionReason,
    close_code: u16,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let _ = input.try_send(BrainInput::Stop);
    let terminal_reason =
        persist_terminal_session_reason(state, voice_session_id, terminal_reason).await;
    *terminal_persisted = true;
    if let Err(error) = send_terminal_session_phase(sender, terminal_reason).await {
        return terminal_label_after_terminal_phase_close(
            terminal_reason,
            outbound_write_terminal_label(&error),
        );
    }
    let close_code = terminal_close_code(terminal_reason, close_code);
    let _ = close_with(sender, close_code, terminal_reason.close_reason()).await;
    terminal_reason.as_str()
}

async fn close_with_terminal_session_phase_only<S>(
    sender: &mut BoundedSender<S>,
    terminal_reason: TerminalSessionReason,
    close_code: u16,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if let Err(error) = send_terminal_session_phase(sender, terminal_reason).await {
        return outbound_write_terminal_label(&error);
    }
    let _ = close_with(sender, close_code, terminal_reason.close_reason()).await;
    terminal_reason.as_str()
}

fn terminal_label_after_terminal_phase_close(
    terminal_reason: TerminalSessionReason,
    close_terminal_reason: &'static str,
) -> &'static str {
    if is_outbound_write_failure_label(close_terminal_reason)
        && terminal_reason_overrides_send_failure(terminal_reason)
    {
        terminal_reason.as_str()
    } else {
        close_terminal_reason
    }
}

fn terminal_reason_overrides_send_failure(terminal_reason: TerminalSessionReason) -> bool {
    matches!(
        terminal_reason,
        TerminalSessionReason::CostBudget
            | TerminalSessionReason::ProviderAuthFailed
            | TerminalSessionReason::ProviderRateLimited
            | TerminalSessionReason::ProviderTimeout
            | TerminalSessionReason::ProviderMalformedStream
            | TerminalSessionReason::ProviderNetworkDisconnect
            | TerminalSessionReason::ProviderCancelled
            | TerminalSessionReason::PartialStageSuccess
            | TerminalSessionReason::DurabilityDegraded
            | TerminalSessionReason::Drained
            | TerminalSessionReason::RateLimit
            | TerminalSessionReason::SessionCap
            | TerminalSessionReason::SlowClient
            | TerminalSessionReason::ToolExecutorFailure
            | TerminalSessionReason::TurnCap
            | TerminalSessionReason::Rollback
    )
}

async fn close_with_client_stop<S>(
    sender: &mut BoundedSender<S>,
    state: &AppState,
    voice_session_id: Option<String>,
    terminal_persisted: &mut bool,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let terminal_label =
        persist_terminal_label_or_durability_degraded(state, voice_session_id, "client_stop").await;
    *terminal_persisted = true;
    if terminal_label == TerminalSessionReason::DurabilityDegraded.as_str() {
        let _ =
            send_terminal_session_phase(sender, TerminalSessionReason::DurabilityDegraded).await;
        let _ = close_with(
            sender,
            close_code::ERROR,
            TerminalSessionReason::DurabilityDegraded.close_reason(),
        )
        .await;
        return TerminalSessionReason::DurabilityDegraded.as_str();
    }
    let _ = close_with(sender, close_code::NORMAL, "client stop").await;
    terminal_label
}

async fn send_terminal_session_phase<S>(
    sender: &mut BoundedSender<S>,
    terminal_reason: TerminalSessionReason,
) -> Result<(), OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    // Plan 05's mapping converts a terminal session phase unconditionally; a
    // diagnostic here would mean the shared contract moved under this call, so it
    // surfaces as the protocol's own fallback frame instead of being dropped.
    match ServerFrame::event(agent_domain::BrainEvent::TerminalSessionPhase {
        phase: StudySessionPhase::Recap,
        terminal_reason,
    }) {
        Ok(frame) => send_json(sender, &frame).await,
        Err(_) => {
            sender
                .send(Message::Text(VOICE_SERIALIZATION_FALLBACK_FRAME.into()))
                .await
        }
    }
}

async fn send_partial_recap_for_provider_failure<S>(
    context: &BrainForwardContext<'_>,
    terminal_reason: TerminalSessionReason,
    response_id: Option<&str>,
    sender: &mut BoundedSender<S>,
) -> Result<bool, OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if !supports_provider_failure_partial_recap(terminal_reason) {
        return Ok(false);
    }
    let Some(voice_session_id) = context.voice_session_id.as_deref() else {
        return Ok(false);
    };
    let Some(response_id) = response_id else {
        context.state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PartialRecap,
            context.voice_session_id.clone(),
            "skipped reason=no_durable_response_id",
        ));
        return Ok(false);
    };
    let answer_attempt_recorded = match context
        .state
        .study_store
        .answer_attempt_was_recorded(
            &context.session_binding.user_id,
            &context.session_binding.study_set_id,
            voice_session_id,
            response_id,
        )
        .await
    {
        Ok(recorded) => recorded,
        Err(error) => {
            context.state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::PartialRecap,
                context.voice_session_id.clone(),
                format!("skipped reason=answer_attempt_check_failed error={error}"),
            ));
            return Ok(false);
        }
    };
    if !answer_attempt_recorded {
        context.state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PartialRecap,
            context.voice_session_id.clone(),
            format!("skipped reason=response_answer_attempt_missing response_id={response_id}"),
        ));
        return Ok(false);
    }
    let counts = match context
        .state
        .study_store
        .study_session_durable_counts(
            &context.session_binding.user_id,
            &context.session_binding.study_set_id,
            voice_session_id,
        )
        .await
    {
        Ok(counts) => counts,
        Err(error) => {
            context.state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::PartialRecap,
                context.voice_session_id.clone(),
                format!("skipped reason=durable_counts_unavailable error={error}"),
            ));
            return Ok(false);
        }
    };
    if counts.answer_attempts == 0 {
        return Ok(false);
    }
    if counts.prior_recaps > 0 {
        context.state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PartialRecap,
            context.voice_session_id.clone(),
            format!(
                "skipped reason=prior_recap_exists prior_recaps={}",
                counts.prior_recaps
            ),
        ));
        return Ok(false);
    }
    let question = match context
        .state
        .study_store
        .active_question(
            &context.session_binding.user_id,
            &context.session_binding.study_set_id,
        )
        .await
    {
        Ok(Some(question)) => question,
        Ok(None) => {
            context.state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::PartialRecap,
                context.voice_session_id.clone(),
                "skipped reason=active_question_unavailable",
            ));
            return Ok(false);
        }
        Err(error) => {
            context.state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::PartialRecap,
                context.voice_session_id.clone(),
                format!("skipped reason=active_question_error error={error}"),
            ));
            return Ok(false);
        }
    };
    let recap = deterministic_provider_failure_partial_recap(
        voice_session_id,
        &question,
        terminal_reason,
        &counts,
    );
    if let Err(error) = context
        .state
        .study_store
        .record_recap(
            &context.session_binding.user_id,
            &context.session_binding.study_set_id,
            voice_session_id,
            response_id,
            recap.clone(),
        )
        .await
    {
        context.state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PartialRecap,
            context.voice_session_id.clone(),
            format!("skipped reason=record_recap_failed error={error}"),
        ));
        return Ok(false);
    }
    context.state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::PartialRecap,
        context.voice_session_id.clone(),
        format!(
            "terminal_reason={} answer_attempts={} concept_statuses={} review_items={} prior_recaps={} source_id={} document_id={} span={}",
            terminal_reason.as_str(),
            counts.answer_attempts,
            counts.concept_statuses,
            counts.review_items,
            counts.prior_recaps,
            question.source.source_id,
            question.source.document_id,
            question.source.span
        ),
    ));
    send_json(
        sender,
        &ServerFrame::Event {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            event: Box::new(VivaServerEvent::partial_recap_ready(
                response_id.to_owned(),
                recap,
                terminal_reason,
            )),
        },
    )
    .await?;
    Ok(true)
}

fn supports_provider_failure_partial_recap(reason: TerminalSessionReason) -> bool {
    matches!(
        reason,
        TerminalSessionReason::ProviderAuthFailed
            | TerminalSessionReason::ProviderRateLimited
            | TerminalSessionReason::ProviderTimeout
            | TerminalSessionReason::ProviderMalformedStream
            | TerminalSessionReason::ProviderNetworkDisconnect
            | TerminalSessionReason::PartialStageSuccess
    )
}

fn deterministic_provider_failure_partial_recap(
    voice_session_id: &str,
    question: &StudyQuestion,
    terminal_reason: TerminalSessionReason,
    counts: &StudySessionDurableCounts,
) -> StudySessionRecap {
    // A provider failure produced no graded outcome, so this recap claims none:
    // concept outcomes, the review schedule, and source moments stay empty rather
    // than being invented from the question's expected terms. Only Plan 04's
    // authoritative scheduler may populate `review_schedule`.
    StudySessionRecap {
        schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
        voice_session_id: voice_session_id.to_owned(),
        headline: "Partial recap: your answer was preserved.".to_owned(),
        summary: format!(
            "Generated from durable state only after provider failure. terminal_reason={} answer_attempts={} concept_statuses={} review_items={} prior_recaps={} source_id={} document_id={} span={}. No model-written recap was generated after provider failure.",
            terminal_reason.as_str(),
            counts.answer_attempts,
            counts.concept_statuses,
            counts.review_items,
            counts.prior_recaps,
            question.source.source_id,
            question.source.document_id,
            question.source.span
        ),
        concepts: vec![],
        review_schedule: vec![],
        next_action: "Retry this question when the provider is available, or continue with a fresh prompt.".to_owned(),
        source_moments: vec![],
        deferred_turns: 0,
    }
}

/// `VOICE-TURN-001` / `VOICE-TURN-002`: the socket's wire-turn accounting.
///
/// Why a turn binding was refused. Every variant is a fail-closed refusal; none
/// of them is an invitation to invent a replacement identifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
enum TurnBindingError {
    #[error("turn id is already registered on this socket")]
    DuplicateTurn,
    #[error("response id is already bound to a turn")]
    DuplicateResponse,
    #[error("no registered turn is waiting for a question")]
    MissingTurn,
    #[error("response id has no turn binding")]
    MissingResponse,
}

/// `SERVICE-014`: the socket's own record of which wire turn each provider
/// response belongs to.
///
/// The active v5 turn binding is tracked separately from provider response
/// identity: a turn is registered when its input is admitted (or minted by the
/// server before a proactive provider question), bound to a response when that
/// response's `question_started` arrives, and released only after that response's
/// single resolution has been forwarded. A released turn id is spent, never
/// recycled.
#[derive(Debug, Default)]
struct TurnBindingTracker {
    pending_turn_ids: VecDeque<String>,
    response_to_turn: HashMap<String, String>,
    spent_turn_ids: HashSet<String>,
    minted: u32,
}

impl TurnBindingTracker {
    fn register_submission(&mut self, turn_id: String) -> Result<(), TurnBindingError> {
        if self.knows_turn(&turn_id) {
            return Err(TurnBindingError::DuplicateTurn);
        }
        self.pending_turn_ids.push_back(turn_id);
        Ok(())
    }

    /// Whether this socket has ever used `turn_id`: pending, bound, or spent.
    fn knows_turn(&self, turn_id: &str) -> bool {
        self.pending_turn_ids.iter().any(|known| known == turn_id)
            || self.response_to_turn.values().any(|known| known == turn_id)
            || self.spent_turn_ids.contains(turn_id)
    }

    /// A provider that asks proactively names no client turn, so the server mints
    /// the canonical id itself *before* the question can be bound. This is the
    /// only place an identifier is created; a deferral never mints one.
    fn register_server_turn(&mut self) -> Result<String, TurnBindingError> {
        self.minted = self.minted.saturating_add(1);
        let turn_id = format!("turn-{}", self.minted);
        self.register_submission(turn_id.clone())?;
        Ok(turn_id)
    }

    fn bind_question(&mut self, response_id: &str) -> Result<&str, TurnBindingError> {
        if self.response_to_turn.contains_key(response_id) {
            return Err(TurnBindingError::DuplicateResponse);
        }
        let turn_id = self
            .pending_turn_ids
            .pop_front()
            .ok_or(TurnBindingError::MissingTurn)?;
        self.response_to_turn
            .insert(response_id.to_owned(), turn_id);
        self.response_to_turn
            .get(response_id)
            .map(String::as_str)
            .ok_or(TurnBindingError::MissingTurn)
    }

    fn turn_for_response(&self, response_id: &str) -> Result<&str, TurnBindingError> {
        self.response_to_turn
            .get(response_id)
            .map(String::as_str)
            .ok_or(TurnBindingError::MissingResponse)
    }

    /// Drop a response binding after its single resolution was forwarded.
    fn release_response(&mut self, response_id: &str) {
        if let Some(turn_id) = self.response_to_turn.remove(response_id) {
            self.spent_turn_ids.insert(turn_id);
        }
    }
}

/// `SERVICE-014`: register a client-named turn once its bounded input is admitted.
///
/// A client that answers a turn the server already named is not opening a new
/// one, so an id this socket already knows is left exactly as it is. Only a turn
/// identity the socket has never seen becomes a pending client submission.
fn register_submitted_turn(bindings: &mut TurnBindingTracker, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else {
        return;
    };
    if bindings.knows_turn(turn_id) {
        return;
    }
    let _ = bindings.register_submission(turn_id.to_owned());
}

/// Plan 05 publishes no `VoiceProtocolDiagnostic::invariant` constructor and
/// `protocol.rs` is its file, so the lane names the invariant code here rather
/// than editing an upstream contract.
fn invariant_diagnostic(path: &'static str) -> VoiceProtocolDiagnostic {
    VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::Invariant, path)
}

/// `VOICE-TURN-002`: look up the wire turn a persisted deferral belongs to and
/// hand both to Plan 05's constructor. Nothing about the frame is redeclared
/// here: the destructuring exists only to read `response_id` for the lookup, and
/// the constructor's own `Result` is returned unchanged.
fn map_turn_deferred(
    event: &BrainEvent,
    bindings: &TurnBindingTracker,
) -> Result<ServerFrame, VoiceProtocolDiagnostic> {
    let BrainEvent::TurnDeferred { response_id, .. } = event else {
        return Err(invariant_diagnostic("$.event.type"));
    };
    let turn_id = bindings
        .turn_for_response(response_id)
        .map_err(|_| invariant_diagnostic("$.event.turn_id"))?;
    ServerFrame::turn_deferred(turn_id, event)
}

struct BrainForwardContext<'a> {
    state: &'a AppState,
    voice_session_id: Option<String>,
    session_binding: &'a AuthorizedClientSession,
    limits: &'a VoiceLimitConfig,
    session_limits: &'a mut SessionLimitRuntime,
    turn_bindings: &'a mut TurnBindingTracker,
}

async fn drain_terminal_events<S>(
    context: &mut BrainForwardContext<'_>,
    events: &mut mpsc::Receiver<agent_domain::BrainEvent>,
    cancelled_responses: &mut CancelledResponseTracker,
    session_started_at: Instant,
    sender: &mut BoundedSender<S>,
) -> Result<ForwardBrainEvent, OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    loop {
        let Some(event) = timeout(TERMINAL_EVENT_DRAIN_TIMEOUT, events.recv())
            .await
            .ok()
            .flatten()
        else {
            return Ok(ForwardBrainEvent::Continue);
        };
        let result = forward_brain_event(
            context,
            event,
            cancelled_responses,
            session_started_at.elapsed(),
            sender,
        )
        .await?;
        if !matches!(
            result,
            ForwardBrainEvent::Continue | ForwardBrainEvent::Suppressed
        ) {
            return Ok(result);
        }
    }
}

struct ProviderTurnRuntime<'a> {
    pending_submitted_answers: &'a mut u32,
    active_provider_turns: &'a mut u32,
    pending_provider_admissions: &'a mut Vec<VoiceLimitLease>,
    resolved_submitted_answer_response_ids: &'a mut HashSet<String>,
    completed_provider_turn_response_ids: &'a mut HashSet<String>,
    superseded_provider_turn_response_ids: &'a mut HashSet<String>,
    turn_cap_deadline: &'a mut Option<Instant>,
}

async fn forward_ready_brain_events<S>(
    context: &mut BrainForwardContext<'_>,
    events: &mut mpsc::Receiver<agent_domain::BrainEvent>,
    cancelled_responses: &mut CancelledResponseTracker,
    session_started_at: Instant,
    sender: &mut BoundedSender<S>,
    runtime: &mut ProviderTurnRuntime<'_>,
) -> Result<ForwardBrainEvent, OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    loop {
        let event = match events.try_recv() {
            Ok(event) => event,
            Err(mpsc::error::TryRecvError::Empty) => return Ok(ForwardBrainEvent::Continue),
            Err(mpsc::error::TryRecvError::Disconnected) => {
                return Ok(ForwardBrainEvent::Suppressed);
            }
        };
        let result = forward_brain_event_with_turn_accounting(
            context,
            event,
            cancelled_responses,
            session_started_at,
            sender,
            runtime,
        )
        .await?;
        if !matches!(
            result,
            ForwardBrainEvent::Continue | ForwardBrainEvent::Suppressed
        ) {
            return Ok(result);
        }
    }
}

async fn forward_brain_event_with_turn_accounting<S>(
    context: &mut BrainForwardContext<'_>,
    event: agent_domain::BrainEvent,
    cancelled_responses: &mut CancelledResponseTracker,
    session_started_at: Instant,
    sender: &mut BoundedSender<S>,
    runtime: &mut ProviderTurnRuntime<'_>,
) -> Result<ForwardBrainEvent, OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if should_suppress_superseded_recap(&event, runtime.superseded_provider_turn_response_ids) {
        return Ok(ForwardBrainEvent::Suppressed);
    }
    // `SERVICE-006`: classified once, before forwarding, and consumed by both
    // counters. There is deliberately no second call site.
    let resolution = classify_provider_turn_event(&event);
    let resolved_response_id = match &resolution {
        Some(ProviderTurnResolution::One {
            response_id: Some(response_id),
        }) => Some(response_id.clone()),
        _ => None,
    };
    let result = forward_brain_event(
        context,
        event,
        cancelled_responses,
        session_started_at.elapsed(),
        sender,
    )
    .await?;
    if matches!(result, ForwardBrainEvent::Continue) {
        apply_provider_turn_accounting(resolution, runtime);
        // The binding is released only after its single resolution reached the
        // wire, so a deferral that failed to send keeps its turn identity.
        if let Some(response_id) = &resolved_response_id {
            context.turn_bindings.release_response(response_id);
        }
    }
    Ok(result)
}

fn apply_provider_turn_accounting(
    resolution: Option<ProviderTurnResolution>,
    runtime: &mut ProviderTurnRuntime<'_>,
) {
    let Some(resolution) = resolution else {
        return;
    };
    match resolution {
        ProviderTurnResolution::One { response_id } => {
            let count_resolution = match &response_id {
                Some(response_id) => runtime
                    .resolved_submitted_answer_response_ids
                    .insert(response_id.clone()),
                None => true,
            };
            if count_resolution {
                *runtime.pending_submitted_answers =
                    runtime.pending_submitted_answers.saturating_sub(1);
            }
            if *runtime.pending_submitted_answers == 0 {
                *runtime.turn_cap_deadline = None;
            }
            let count_completion = match response_id {
                Some(response_id) => {
                    let superseded_by_active_turn = *runtime.active_provider_turns > 1;
                    let count_completion = runtime
                        .completed_provider_turn_response_ids
                        .insert(response_id.clone());
                    if superseded_by_active_turn {
                        runtime
                            .superseded_provider_turn_response_ids
                            .insert(response_id);
                    }
                    count_completion
                }
                None => true,
            };
            if count_completion {
                *runtime.active_provider_turns = runtime.active_provider_turns.saturating_sub(1);
                let _ = runtime.pending_provider_admissions.pop();
            }
        }
        ProviderTurnResolution::All => {
            *runtime.pending_submitted_answers = 0;
            runtime.resolved_submitted_answer_response_ids.clear();
            *runtime.turn_cap_deadline = None;
            *runtime.active_provider_turns = 0;
            runtime.completed_provider_turn_response_ids.clear();
            runtime.superseded_provider_turn_response_ids.clear();
            runtime.pending_provider_admissions.clear();
        }
    }
}

fn mark_completed_provider_turns_superseded(
    completed_provider_turn_response_ids: &HashSet<String>,
    superseded_provider_turn_response_ids: &mut HashSet<String>,
) {
    superseded_provider_turn_response_ids
        .extend(completed_provider_turn_response_ids.iter().cloned());
}

fn should_suppress_superseded_recap(
    event: &agent_domain::BrainEvent,
    superseded_provider_turn_response_ids: &HashSet<String>,
) -> bool {
    matches!(
        event,
        agent_domain::BrainEvent::RecapReady { response_id, .. }
            if superseded_provider_turn_response_ids.contains(response_id)
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ForwardBrainEvent {
    Continue,
    Suppressed,
    Rejected,
    DurabilityDegraded,
    CostBudgetExceeded,
    ProviderFailure {
        reason: TerminalSessionReason,
        response_id: Option<String>,
    },
}

async fn forward_brain_event<S>(
    context: &mut BrainForwardContext<'_>,
    event: agent_domain::BrainEvent,
    cancelled_responses: &mut CancelledResponseTracker,
    session_elapsed: Duration,
    sender: &mut BoundedSender<S>,
) -> Result<ForwardBrainEvent, OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if should_suppress_cancelled_response(cancelled_responses, &event) {
        return Ok(ForwardBrainEvent::Suppressed);
    }
    if let agent_domain::BrainEvent::Error(error) = &event {
        record_provider_stage_failure(context.state, context.voice_session_id.clone(), error);
        if provider_error_is_durability_degraded(context.state, error) {
            context.state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                context.voice_session_id.clone(),
                "durability_degraded",
            ));
            return Ok(ForwardBrainEvent::DurabilityDegraded);
        }
        let terminal_reason = terminal_reason_for_provider_error(error);
        // The failure-control harness fabricates provider failures on demand; feeding
        // them to the real backoff limiter would let a synthetic scenario throttle
        // production traffic.
        if error.source != FAILURE_CONTROL_SOURCE {
            context
                .state
                .limit_state
                .record_provider_failure(context.limits, &provider_error_failure(error));
        }
        return Ok(ForwardBrainEvent::ProviderFailure {
            reason: terminal_reason,
            response_id: cancelled_responses.partial_recap_response_id(),
        });
    }
    match authorize_browser_event(context.state, context.session_binding, &event).await {
        BrowserEventAuthorization::Authorized => {}
        BrowserEventAuthorization::Rejected => {
            send_json(
                sender,
                &ServerFrame::error(
                    VoiceServerErrorCode::ClientAuthorityForbidden,
                    "provider source authority rejected",
                ),
            )
            .await?;
            return Ok(ForwardBrainEvent::Rejected);
        }
        BrowserEventAuthorization::DurabilityDegraded => {
            context.state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                context.voice_session_id.clone(),
                "durability_degraded",
            ));
            return Ok(ForwardBrainEvent::DurabilityDegraded);
        }
    }
    match record_brain_event(
        context.state,
        context.voice_session_id.clone(),
        &event,
        session_elapsed,
    )
    .await
    {
        BrainEventRecordResult::None => {}
        BrainEventRecordResult::DurabilityDegraded => {
            return Ok(ForwardBrainEvent::DurabilityDegraded);
        }
        BrainEventRecordResult::Usage(usage_record) => {
            if !context
                .session_limits
                .record_session_cost(context.limits, usage_record.cost_estimate_usd)
            {
                return Ok(ForwardBrainEvent::CostBudgetExceeded);
            }
        }
    }
    // `question_started` and `turn_deferred` are turn-bound: the domain event has no
    // turn identity, and Plan 05's blanket conversion deliberately refuses to invent
    // one. The socket supplies it from its own ledger through the explicit
    // constructors; everything else takes the blanket path unchanged.
    let frame = match &event {
        agent_domain::BrainEvent::QuestionStarted { response_id, .. } => {
            // A question with no admitted client turn is a proactive provider
            // turn, so the server mints its canonical id before binding. A
            // duplicate response id is an invariant breach and fails closed.
            if context.turn_bindings.pending_turn_ids.is_empty() {
                context.turn_bindings.register_server_turn().map_err(|_| {
                    OutboundWriteError::Sink(axum::Error::new(std::io::Error::other(
                        "server turn id is not registrable",
                    )))
                })?;
            }
            let turn_id = context
                .turn_bindings
                .bind_question(response_id)
                .map_err(|_| {
                    OutboundWriteError::Sink(axum::Error::new(std::io::Error::other(
                        "question_started is not turn-bindable",
                    )))
                })?
                .to_owned();
            Some(
                ServerFrame::question_started(&turn_id, &event).map_err(|_| {
                    OutboundWriteError::Sink(axum::Error::new(std::io::Error::other(
                        "question_started is not turn-bindable",
                    )))
                })?,
            )
        }
        agent_domain::BrainEvent::TurnDeferred { response_id, .. } => {
            // A provider may resolve a turn it never announced: the runner re-keys
            // a first turn's response identity by the client generation of the
            // answer it is resolving, without a second `question_started`. That
            // turn is still one this socket admitted, so the oldest admitted turn
            // id is bound here under the same oldest-first rule `bind_question`
            // uses. Nothing is minted: with no admitted turn left to bind, the
            // mapping below produces `VOICE_PROTOCOL_INVARIANT` and no frame at
            // all rather than a fabricated or borrowed id.
            if context
                .turn_bindings
                .turn_for_response(response_id)
                .is_err()
            {
                let _ = context.turn_bindings.bind_question(response_id);
            }
            map_turn_deferred(&event, context.turn_bindings).ok()
        }
        _ => ServerFrame::browser_event(event),
    };
    let Some(frame) = frame else {
        return Ok(ForwardBrainEvent::Continue);
    };
    send_json(sender, &frame).await?;
    Ok(ForwardBrainEvent::Continue)
}

/// Every brain failure is a classified failure. The terminal reason is implied by
/// the typed failure class, so no provider message is ever parsed to pick one.
fn terminal_reason_for_brain_error(error: &BrainError) -> TerminalSessionReason {
    error.terminal_reason()
}

fn brain_error_is_durability_degraded(state: &AppState, error: &BrainError) -> bool {
    state.study_store.capabilities().durable
        && error.terminal_reason() == TerminalSessionReason::DurabilityDegraded
}

fn record_brain_open_provider_failure(
    state: &AppState,
    voice_session_id: Option<String>,
    error: &BrainError,
) {
    let failure = error.failure();
    record_provider_stage_failure(
        state,
        voice_session_id,
        &BrainProviderError::from_failure(failure.clone()),
    );
    // `record_provider_failure` already refuses to back off on the store, tool, and
    // recap stages, so the local-store carve-out no longer needs a message probe.
    state
        .limit_state
        .record_provider_failure(&state.voice_limits, failure);
}

/// A provider error that reaches this service without its typed failure is an
/// invariant breach, never an invitation to classify `source`/`message` prose. It
/// becomes an explicit rollback failure observed at the WebSocket stage.
fn provider_error_failure(error: &BrainProviderError) -> Cow<'_, BrainProviderFailure> {
    match error.require_failure() {
        Ok(failure) => Cow::Borrowed(failure),
        Err(_) => Cow::Owned(BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::Rollback,
            stage: BrainFailureStage::Websocket,
            retry_eligible: false,
            latency_ms: 0,
            provider: error.source.clone(),
            model: String::new(),
            metadata: "error_kind=missing_typed_failure".to_owned(),
        })),
    }
}

fn terminal_reason_for_provider_error(error: &BrainProviderError) -> TerminalSessionReason {
    provider_error_failure(error).terminal_reason()
}

fn provider_error_is_durability_degraded(state: &AppState, error: &BrainProviderError) -> bool {
    provider_error_is_durability_degraded_for_store(state.study_store.capabilities().durable, error)
}

fn provider_error_is_durability_degraded_for_store(
    store_is_durable: bool,
    error: &BrainProviderError,
) -> bool {
    store_is_durable
        && provider_error_failure(error).terminal_reason()
            == TerminalSessionReason::DurabilityDegraded
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TerminalObservabilityClassification {
    failure_class: &'static str,
    stage: &'static str,
    signal: &'static str,
}

fn terminal_observability_classification(
    reason: &str,
) -> Option<TerminalObservabilityClassification> {
    let classification = match reason {
        "provider_rate_limited" => TerminalObservabilityClassification {
            failure_class: "quota_rate_failure",
            stage: "provider",
            signal: "gemini_http_429",
        },
        "provider_auth_failed" => TerminalObservabilityClassification {
            failure_class: "provider_auth_failure",
            stage: "provider_auth",
            signal: "provider_auth_failed",
        },
        "provider_timeout" => TerminalObservabilityClassification {
            failure_class: "timeout",
            stage: "websocket",
            signal: "provider_timeout",
        },
        "provider_malformed_stream" => TerminalObservabilityClassification {
            failure_class: "malformed_stream",
            stage: "websocket",
            signal: "provider_malformed_stream",
        },
        "provider_network_disconnect" => TerminalObservabilityClassification {
            failure_class: "network_disconnect",
            stage: "transport",
            signal: "provider_network_disconnect",
        },
        "provider_cancelled" => TerminalObservabilityClassification {
            failure_class: "cancellation",
            stage: "provider",
            signal: "provider_cancelled",
        },
        "partial_stage_success" => TerminalObservabilityClassification {
            failure_class: "partial_stage_success",
            stage: "recap",
            signal: "recap_failure",
        },
        "tool_executor_failure" => TerminalObservabilityClassification {
            failure_class: "tool_executor_failure",
            stage: "tools",
            signal: "tool_executor_failure",
        },
        "pending_evaluation" => TerminalObservabilityClassification {
            failure_class: "pending_evaluation",
            stage: "store",
            signal: "pending_evaluation",
        },
        "study_set_access_denied" | "study_store_unavailable" => {
            TerminalObservabilityClassification {
                failure_class: "pre_loop_unavailable",
                stage: "pre_loop",
                signal: "pre_loop_unavailable",
            }
        }
        "first_frame_timeout" | "invalid_first_frame" => TerminalObservabilityClassification {
            failure_class: "session_bootstrap_unavailable",
            stage: "startup",
            signal: "session_bootstrap_unavailable",
        },
        "agent_input_closed" => TerminalObservabilityClassification {
            failure_class: "network_disconnect",
            stage: "transport",
            signal: "agent_input_closed",
        },
        "invalid_session_identity"
        | "invalid_session_token"
        | "session_token_nonce_store_unavailable" => TerminalObservabilityClassification {
            failure_class: "session_auth_failure",
            stage: "session_auth",
            signal: "session_auth_rejected",
        },
        "durability_degraded" => TerminalObservabilityClassification {
            failure_class: "durability_degraded",
            stage: "store",
            signal: "durability_degraded",
        },
        "cost_budget" => TerminalObservabilityClassification {
            failure_class: "cost_budget",
            stage: "provider",
            signal: "cost_budget_exhausted",
        },
        "rate_limit" => TerminalObservabilityClassification {
            failure_class: "local_rate_limit",
            stage: "session",
            signal: "local_rate_limit",
        },
        "turn_cap" => TerminalObservabilityClassification {
            failure_class: "turn_cap",
            stage: "session",
            signal: "turn_cap",
        },
        "session_cap" => TerminalObservabilityClassification {
            failure_class: "session_cap",
            stage: "session",
            signal: "session_cap",
        },
        "slow_client" => TerminalObservabilityClassification {
            failure_class: "slow_client",
            stage: "session",
            signal: "slow_client",
        },
        // `SERVICE-001`: the half-open detection signal. Its own class, so the
        // operator log separates a peer that stopped answering Pings from a peer
        // whose outbound write missed its deadline.
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL => TerminalObservabilityClassification {
            failure_class: "heartbeat_timeout",
            stage: "session",
            signal: "heartbeat_timeout",
        },
        "drained" => TerminalObservabilityClassification {
            failure_class: "deploy_drain",
            stage: "deployment",
            signal: "deploy_drain",
        },
        "rollback" => TerminalObservabilityClassification {
            failure_class: "rollback",
            stage: "rollback",
            signal: "rollback_required",
        },
        _ => return None,
    };
    Some(classification)
}

fn deployment_sha() -> String {
    for name in [
        "RAILWAY_GIT_COMMIT_SHA",
        "VERCEL_GIT_COMMIT_SHA",
        "GITHUB_SHA",
        "SOURCE_VERSION",
    ] {
        if let Ok(value) = std::env::var(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.chars().take(64).collect();
            }
        }
    }
    "unknown".to_owned()
}

fn emit_terminal_observability_log(state: &AppState, reason: &str) {
    let Some(classification) = terminal_observability_classification(reason) else {
        return;
    };
    let deploy_sha = deployment_sha();
    let model = observability_model(&state.provider);
    tracing::warn!(
        event = "provider_failure_observed",
        failure_class = classification.failure_class,
        stage = classification.stage,
        provider = %state.provider,
        model = %model,
        deploy_sha = %deploy_sha,
        terminal_reason = reason,
        signal = classification.signal,
        latency_ms = "unknown",
        latency_bucket = "unknown",
        usage = "unknown",
        usage_bucket = "unknown",
        cost_usd = "unknown",
        cost_bucket = "unknown",
        "viva provider failure observed"
    );
}

fn emit_pending_evaluation_observability_log(
    state: &AppState,
    _terminal_reason: &str,
    pending_answer_attempts: usize,
) {
    if pending_answer_attempts == 0 {
        return;
    }
    let deploy_sha = deployment_sha();
    let model = observability_model(&state.provider);
    tracing::warn!(
        event = "provider_failure_observed",
        failure_class = "pending_evaluation",
        stage = "store",
        provider = %state.provider,
        model = %model,
        deploy_sha = %deploy_sha,
        terminal_reason = pending_evaluation_terminal_reason(),
        signal = "pending_evaluation",
        evaluation_state = "pending",
        pending_answer_attempts,
        latency_ms = "unknown",
        latency_bucket = "unknown",
        usage = "unknown",
        usage_bucket = "unknown",
        cost_usd = "unknown",
        cost_bucket = "unknown",
        "viva pending evaluation observed"
    );
}

fn pending_evaluation_terminal_reason() -> &'static str {
    "pending_evaluation"
}

fn observability_model(provider: &str) -> String {
    observability_model_with(provider, |name| std::env::var(name).ok())
}

fn observability_model_with(provider: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    if provider == "cartesia_gemini" {
        for name in ["GEMINI_MODEL", "GEMINI_REALTIME_MODEL"] {
            if let Some(value) = lookup(name) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return trimmed.chars().take(128).collect();
                }
            }
        }
    }
    format!("{provider}-viva")
}

async fn open_failure_control_session(
    state: &AppState,
    config: SessionConfig,
    scenario: FailureControlScenario,
) -> Result<RealtimeSession, BrainError> {
    // The write outcome is deliberately unread here: this rehearsal harness reports
    // no store counts, and only whether the row committed at all gates the session.
    let _outcome = state
        .study_store
        .record_voice_session(&config)
        .await
        .map_err(|error| {
            // A store that cannot record the session is a store-stage durability
            // failure whatever its diagnostic text says.
            BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
                failure_class: BrainFailureClass::DurabilityDegraded,
                stage: BrainFailureStage::Store,
                retry_eligible: false,
                latency_ms: 0,
                provider: FAILURE_CONTROL_SOURCE.to_owned(),
                model: String::new(),
                metadata: format!("error_kind={}", error.kind()),
            }))
        })?;

    let (input, mut input_rx) = mpsc::channel::<BrainInput>(32);
    let (event_tx, events) = mpsc::channel::<BrainEvent>(32);
    let response_id = format!("failure-control-{}", scenario.as_str());
    let task = tokio::spawn(async move {
        let _ = event_tx
            .send(BrainEvent::SessionPhase {
                phase: StudySessionPhase::Ready,
            })
            .await;
        let _ = event_tx
            .send(BrainEvent::QuestionStarted {
                response_id: response_id.clone(),
                question: fixture_question(),
            })
            .await;

        while let Some(input) = input_rx.recv().await {
            match input {
                BrainInput::Audio(_)
                | BrainInput::AudioWithMetadata { .. }
                | BrainInput::Text(_)
                | BrainInput::TextWithMetadata { .. } => {
                    let _ = event_tx.send(BrainEvent::InputSpeechStarted).await;
                    let _ = event_tx.send(BrainEvent::InputSpeechStopped).await;
                    if scenario == FailureControlScenario::SilentStall {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    let _ = event_tx
                        .send(BrainEvent::Error(failure_control_provider_error(scenario)))
                        .await;
                    break;
                }
                BrainInput::CancelResponse => {
                    let _ = event_tx
                        .send(BrainEvent::ResponseCancelledFor {
                            response_id: response_id.clone(),
                        })
                        .await;
                }
                BrainInput::Stop => break,
                BrainInput::ToolResult(_)
                | BrainInput::SessionContextRefresh(_)
                | BrainInput::ProactiveTurn { .. } => {}
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

/// The synthetic provider identity every failure-control error is attributed to.
/// It is checked by identity, never by parsing a message.
const FAILURE_CONTROL_SOURCE: &str = "failure_control";

fn failure_control_provider_error(scenario: FailureControlScenario) -> BrainProviderError {
    BrainProviderError {
        source: FAILURE_CONTROL_SOURCE.to_owned(),
        message: failure_control_provider_message(scenario),
        failure: Some(failure_control_provider_failure(scenario)),
    }
}

/// Each rehearsal scenario declares its own typed class and stage, so the terminal
/// reason it produces is chosen here rather than recovered from its message.
fn failure_control_provider_failure(scenario: FailureControlScenario) -> BrainProviderFailure {
    BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: failure_control_failure_class(scenario),
        stage: failure_control_failure_stage(scenario),
        retry_eligible: false,
        latency_ms: 0,
        provider: FAILURE_CONTROL_SOURCE.to_owned(),
        model: scenario.as_str().to_owned(),
        metadata: failure_control_failure_metadata(scenario),
    })
}

fn failure_control_failure_class(scenario: FailureControlScenario) -> BrainFailureClass {
    match scenario {
        FailureControlScenario::ProviderRateLimited => BrainFailureClass::QuotaRateFailure,
        FailureControlScenario::ProviderAuthFailed
        | FailureControlScenario::InvalidToken
        | FailureControlScenario::ExpiredToken
        | FailureControlScenario::ReplayedToken
        | FailureControlScenario::MalformedToken => BrainFailureClass::ProviderAuthFailure,
        FailureControlScenario::ProviderTimeout
        | FailureControlScenario::SonicTtsTimeout
        | FailureControlScenario::RecapTimeout
        | FailureControlScenario::SilentStall => BrainFailureClass::Timeout,
        FailureControlScenario::ProviderMalformedStream => BrainFailureClass::MalformedStream,
        FailureControlScenario::ProviderNetworkDisconnect => BrainFailureClass::NetworkDisconnect,
        FailureControlScenario::SlowStaleSocketClose
        | FailureControlScenario::DoubleSubmitRace
        | FailureControlScenario::MicDenied => BrainFailureClass::SlowClient,
        FailureControlScenario::TypedFallback => BrainFailureClass::PartialStageSuccess,
    }
}

fn failure_control_failure_stage(scenario: FailureControlScenario) -> BrainFailureStage {
    match scenario {
        FailureControlScenario::ProviderRateLimited | FailureControlScenario::ProviderTimeout => {
            BrainFailureStage::Gemini
        }
        FailureControlScenario::ProviderAuthFailed => BrainFailureStage::ProviderAuth,
        FailureControlScenario::SilentStall
        | FailureControlScenario::ProviderMalformedStream
        | FailureControlScenario::ProviderNetworkDisconnect
        | FailureControlScenario::SonicTtsTimeout => BrainFailureStage::Provider,
        FailureControlScenario::RecapTimeout => BrainFailureStage::Recap,
        FailureControlScenario::InvalidToken
        | FailureControlScenario::ExpiredToken
        | FailureControlScenario::ReplayedToken
        | FailureControlScenario::MalformedToken => BrainFailureStage::SessionAuth,
        FailureControlScenario::SlowStaleSocketClose => BrainFailureStage::Websocket,
        FailureControlScenario::DoubleSubmitRace => BrainFailureStage::Session,
        FailureControlScenario::MicDenied | FailureControlScenario::TypedFallback => {
            BrainFailureStage::Transport
        }
    }
}

fn failure_control_failure_metadata(scenario: FailureControlScenario) -> String {
    let mut metadata = format!(
        "scenario={} stage={}",
        scenario.as_str(),
        failure_control_stage(scenario)
    );
    if scenario == FailureControlScenario::ProviderRateLimited {
        metadata.push_str(" retry_after_ms=250 retry_after_source=synthetic");
    }
    metadata
}

fn failure_control_provider_message(scenario: FailureControlScenario) -> String {
    let message = match scenario {
        FailureControlScenario::ProviderRateLimited => {
            "synthetic provider 429 rate limit; retry_after_ms=250; request_id=synth"
        }
        FailureControlScenario::ProviderAuthFailed => "synthetic provider auth failed",
        FailureControlScenario::ProviderTimeout
        | FailureControlScenario::SonicTtsTimeout
        | FailureControlScenario::RecapTimeout
        | FailureControlScenario::SilentStall => "synthetic provider timeout",
        FailureControlScenario::ProviderMalformedStream => "synthetic provider malformed stream",
        FailureControlScenario::ProviderNetworkDisconnect => {
            "synthetic provider network disconnect"
        }
        FailureControlScenario::InvalidToken
        | FailureControlScenario::ExpiredToken
        | FailureControlScenario::ReplayedToken
        | FailureControlScenario::MalformedToken => "synthetic provider auth failed",
        FailureControlScenario::SlowStaleSocketClose => "synthetic slow client stale socket close",
        FailureControlScenario::DoubleSubmitRace => "synthetic slow client double submit race",
        FailureControlScenario::MicDenied => "synthetic slow client mic denied",
        FailureControlScenario::TypedFallback => "synthetic partial stage success typed fallback",
    };
    format!(
        "{message}; scenario={}; stage={}",
        scenario.as_str(),
        failure_control_stage(scenario)
    )
}

fn failure_control_stage(scenario: FailureControlScenario) -> &'static str {
    match scenario {
        FailureControlScenario::ProviderRateLimited | FailureControlScenario::ProviderTimeout => {
            "gemini"
        }
        FailureControlScenario::ProviderAuthFailed => "provider_auth",
        FailureControlScenario::SilentStall
        | FailureControlScenario::ProviderMalformedStream
        | FailureControlScenario::ProviderNetworkDisconnect => "provider_stream",
        FailureControlScenario::SonicTtsTimeout => "sonic_tts",
        FailureControlScenario::RecapTimeout => "recap",
        FailureControlScenario::InvalidToken
        | FailureControlScenario::ExpiredToken
        | FailureControlScenario::ReplayedToken
        | FailureControlScenario::MalformedToken => "session_auth",
        FailureControlScenario::SlowStaleSocketClose => "websocket_generation",
        FailureControlScenario::DoubleSubmitRace => "answer_submission",
        FailureControlScenario::MicDenied => "browser_mic",
        FailureControlScenario::TypedFallback => "browser_fallback",
    }
}

fn unix_timestamp_now() -> Result<u64, std::time::SystemTimeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BrowserEventAuthorization {
    Authorized,
    Rejected,
    DurabilityDegraded,
}

async fn authorize_browser_event(
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

fn store_error_is_durability_degraded(state: &AppState, error: &PortError) -> bool {
    state.study_store.capabilities().durable && store_adapter_error_is_durability_degraded(error)
}

fn store_write_error_is_durability_degraded(state: &AppState, error: &PortError) -> bool {
    state.study_store.capabilities().durable && store_adapter_error_is_durability_degraded(error)
}

/// `PortErrorKind` is the classifier. `reason()` is diagnostics, so a store that
/// could not durably commit says so with its kind rather than with prose this
/// service pattern-matches.
fn store_adapter_error_is_durability_degraded(error: &PortError) -> bool {
    match error.kind() {
        PortErrorKind::Durability | PortErrorKind::Internal => true,
        PortErrorKind::Unavailable | PortErrorKind::InvalidInput | PortErrorKind::Conflict => false,
    }
}

#[derive(Default)]
struct CancelledResponseTracker {
    active_response_id: Option<String>,
    last_durable_response_id: Option<String>,
    response_ids: HashSet<String>,
}

impl CancelledResponseTracker {
    fn partial_recap_response_id(&self) -> Option<String> {
        self.active_response_id
            .clone()
            .or_else(|| self.last_durable_response_id.clone())
    }
}

fn should_suppress_cancelled_response(
    cancelled_responses: &mut CancelledResponseTracker,
    event: &agent_domain::BrainEvent,
) -> bool {
    match event {
        agent_domain::BrainEvent::QuestionStarted { response_id, .. } => {
            cancelled_responses.active_response_id = Some(response_id.clone());
            cancelled_responses.last_durable_response_id = None;
            false
        }
        agent_domain::BrainEvent::ResponseCancelledFor { response_id } => {
            cancelled_responses.response_ids.insert(response_id.clone());
            if cancelled_responses
                .active_response_id
                .as_deref()
                .is_some_and(|active| active == response_id)
            {
                cancelled_responses.active_response_id = None;
            }
            if cancelled_responses
                .last_durable_response_id
                .as_deref()
                .is_some_and(|durable| durable == response_id)
            {
                cancelled_responses.last_durable_response_id = None;
            }
            false
        }
        agent_domain::BrainEvent::ResponseCancelled => {
            if let Some(response_id) = cancelled_responses.active_response_id.take() {
                cancelled_responses.response_ids.insert(response_id);
            }
            cancelled_responses.last_durable_response_id = None;
            false
        }
        agent_domain::BrainEvent::ResponseCompleted { response_id } => {
            if cancelled_responses.response_ids.contains(response_id) {
                return true;
            }
            cancelled_responses.last_durable_response_id = Some(response_id.clone());
            false
        }
        agent_domain::BrainEvent::RecapReady { response_id, .. } => {
            if cancelled_responses.response_ids.contains(response_id) {
                return true;
            }
            if cancelled_responses
                .active_response_id
                .as_deref()
                .is_some_and(|active| active == response_id)
            {
                cancelled_responses.active_response_id = None;
            }
            if cancelled_responses
                .last_durable_response_id
                .as_deref()
                .is_some_and(|durable| durable == response_id)
            {
                cancelled_responses.last_durable_response_id = None;
            }
            false
        }
        agent_domain::BrainEvent::ProviderFallbackActivated { .. } => false,
        _ => event
            .response_id()
            .is_some_and(|response_id| cancelled_responses.response_ids.contains(response_id)),
    }
}

enum StudySetAccessResult {
    Allowed(serde_json::Value),
    Denied(ClientFrameError),
    DurabilityDegraded,
}

async fn validate_study_set_access(
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

/// A reused nonce is the uniqueness race `PortErrorKind::Conflict` names. Matching
/// the store's diagnostic text instead would silently stop detecting replays the
/// moment a store reworded it.
fn nonce_claim_was_replayed(error: &PortError) -> bool {
    error.kind() == PortErrorKind::Conflict
}

fn server_active_concepts(study_context: &serde_json::Value) -> Vec<String> {
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
async fn handle_client_message(
    message: Message,
    input: &mpsc::Sender<BrainInput>,
    session_binding: &AuthorizedClientSession,
    audio_assembly: &mut AudioTurnAssembly,
) -> Result<ClientAction, ClientFrameError> {
    match client_input_action(message, session_binding, audio_assembly)? {
        ClientInputAction::Send {
            brain_input,
            action,
            ..
        } => input
            .send(brain_input)
            .await
            .map(|_| action)
            .map_err(|_| ClientFrameError::disconnected()),
        ClientInputAction::SendAudioTurn { brain_input, .. } => input
            .send(brain_input)
            .await
            .map(|_| ClientAction::Audio)
            .map_err(|_| ClientFrameError::disconnected()),
        ClientInputAction::TrySend {
            brain_input,
            action,
        } => {
            let _ = input.try_send(brain_input);
            Ok(action)
        }
        // The session loop answers a recoverable denial with its own frame before
        // reaching this point; nothing is ever forwarded for it.
        ClientInputAction::Keepalive | ClientInputAction::RecoverableDenial(_) => {
            Ok(ClientAction::Keepalive)
        }
        ClientInputAction::AudioTurnBuffered => Ok(ClientAction::AudioChunk),
        ClientInputAction::AudioTurnDiscarded => Ok(ClientAction::AudioTurnCancel),
    }
}

fn prepare_client_message_with_drain(
    message: Message,
    session_binding: &AuthorizedClientSession,
    limits: &VoiceLimitConfig,
    session_limits: &mut SessionLimitRuntime,
    audio_assembly: &mut AudioTurnAssembly,
) -> Result<ClientInputAction, ClientMessageError> {
    let action = client_input_action(message, session_binding, audio_assembly)
        .map_err(ClientMessageError::Frame)?;
    let brain_input = match &action {
        ClientInputAction::Send { brain_input, .. }
        | ClientInputAction::SendAudioTurn { brain_input, .. } => Some(brain_input),
        _ => None,
    };
    if let Some(brain_input) = brain_input {
        if let Some(bytes) = brain_input_audio_bytes(brain_input) {
            if !session_limits.record_audio_bytes(limits, bytes) {
                return Err(ClientMessageError::RateLimit);
            }
        }
    }
    Ok(action)
}

async fn send_client_input_action_with_drain(
    input: &mpsc::Sender<BrainInput>,
    client_input: ClientInputAction,
    drain_signal: &mut watch::Receiver<bool>,
    turn_deadline: Option<Instant>,
) -> Result<ClientAction, ClientMessageError> {
    match client_input {
        ClientInputAction::Send {
            brain_input,
            action,
            ..
        } => send_brain_input_with_deadline(input, brain_input, drain_signal, turn_deadline)
            .await
            .map(|_| action),
        ClientInputAction::SendAudioTurn { brain_input, .. } => {
            send_brain_input_with_deadline(input, brain_input, drain_signal, turn_deadline)
                .await
                .map(|_| ClientAction::Audio)
        }
        ClientInputAction::TrySend {
            brain_input,
            action,
        } => {
            let _ = input.try_send(brain_input);
            Ok(action)
        }
        // The session loop answers a recoverable denial with its own frame before
        // reaching this point; nothing is ever forwarded for it.
        ClientInputAction::Keepalive | ClientInputAction::RecoverableDenial(_) => {
            Ok(ClientAction::Keepalive)
        }
        ClientInputAction::AudioTurnBuffered => Ok(ClientAction::AudioChunk),
        ClientInputAction::AudioTurnDiscarded => Ok(ClientAction::AudioTurnCancel),
    }
}

fn brain_input_audio_bytes(brain_input: &BrainInput) -> Option<u64> {
    match brain_input {
        BrainInput::Audio(frame) => Some(frame.pcm16_bytes().len().try_into().unwrap_or(u64::MAX)),
        BrainInput::AudioWithMetadata { frame, .. } => {
            Some(frame.pcm16_bytes().len().try_into().unwrap_or(u64::MAX))
        }
        _ => None,
    }
}

fn validated_client_generation_id(
    value: Option<String>,
) -> Result<Option<String>, ClientFrameError> {
    match value {
        Some(value) if value.trim().is_empty() => Err(ClientFrameError::invalid()),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

/// One connection-local bounded audio turn under assembly. Retained until an
/// explicit `audio_end`, a matching scoped `cancel`, or a protocol violation.
#[derive(Debug)]
struct IncomingAudioTurn {
    client_generation_id: String,
    turn_id: String,
    next_sequence: u32,
    pcm16: Vec<u8>,
}

/// How the connection-local audio turn most recently ended.
///
/// Only the last one is kept, because only the last one can still be racing a
/// client cancel. A submitted turn is already with the provider; a discarded one
/// never reached it.
#[derive(Clone, Debug, Eq, PartialEq)]
enum SettledAudioTurn {
    Submitted {
        client_generation_id: String,
        turn_id: String,
    },
    Discarded {
        client_generation_id: String,
        turn_id: String,
    },
}

impl SettledAudioTurn {
    fn identity(&self) -> (&str, &str) {
        match self {
            Self::Submitted {
                client_generation_id,
                turn_id,
            }
            | Self::Discarded {
                client_generation_id,
                turn_id,
            } => (client_generation_id, turn_id),
        }
    }
}

/// One bounded browser audio turn under assembly at a time, plus how the previous
/// one ended. Connection-local; nothing here is shared between sockets.
#[derive(Debug, Default)]
struct AudioTurnAssembly {
    open: Option<IncomingAudioTurn>,
    settled: Option<SettledAudioTurn>,
}

impl AudioTurnAssembly {
    fn settle(&mut self, settled: SettledAudioTurn) {
        self.settled = Some(settled);
    }

    fn settled_as(&self, client_generation_id: &str, turn_id: &str) -> Option<&SettledAudioTurn> {
        self.settled
            .as_ref()
            .filter(|settled| settled.identity() == (client_generation_id, turn_id))
    }
}

#[derive(Debug)]
enum AudioAssemblyAction {
    Pending,
    Complete {
        client_generation_id: String,
        turn_id: String,
        final_sequence: u32,
        frame: AudioFrame,
    },
    Cancelled,
    /// A scoped cancel that names a turn this connection already submitted. The
    /// bytes are with the provider, so the client is asking to cancel the turn,
    /// not the assembly.
    CancelSubmittedTurn,
    /// A scoped cancel that names a turn this connection already discarded. There
    /// is nothing left to cancel and no provider work was ever created.
    AlreadyDiscarded,
}

/// The completed turn identity echoed back to the browser once its single
/// assembled `BrainInput` has been admitted.
#[derive(Clone, Debug, Eq, PartialEq)]
struct AcceptedAudioTurn {
    client_generation_id: String,
    turn_id: String,
    final_sequence: u32,
}

fn audio_identity_is_valid(client_generation_id: &str, turn_id: &str) -> bool {
    !client_generation_id.trim().is_empty() && !turn_id.trim().is_empty()
}

/// `SERVICE-007`: why the stateful turn assembler refused a frame. Plan 05's parser
/// owns every per-frame diagnostic; these are the aggregate outcomes only this
/// assembler can decide, and each maps to exactly one published diagnostic code and
/// JSON path. No variant carries a payload, an identifier, or a byte count.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AudioAssemblyRejection {
    /// A generation or turn id that is empty, or that does not own the open turn.
    InvalidIdentity,
    /// A payload that is empty or not a whole number of PCM16 samples.
    InvalidPayload,
    /// One chunk above the per-frame ceiling.
    ChunkTooLarge,
    /// The aggregate turn bound, which no single frame can carry.
    TurnTooLarge,
    /// A chunk sequence that is not the next one this turn expects.
    Sequence,
    /// An `audio_end` whose `final_sequence` does not close the open turn.
    FinalSequence,
}

impl AudioAssemblyRejection {
    /// The one classification of a stateful assembler rejection. Both the published
    /// diagnostic and the wire error are derived from it, so the two can never drift.
    fn code(self) -> VoiceProtocolDiagnosticCode {
        match self {
            Self::InvalidIdentity | Self::InvalidPayload => {
                VoiceProtocolDiagnosticCode::InvalidField
            }
            Self::ChunkTooLarge => VoiceProtocolDiagnosticCode::FrameTooLarge,
            Self::TurnTooLarge => VoiceProtocolDiagnosticCode::TurnTooLarge,
            Self::Sequence | Self::FinalSequence => VoiceProtocolDiagnosticCode::AudioSequence,
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::InvalidIdentity => "$.turn_id",
            Self::InvalidPayload | Self::ChunkTooLarge | Self::TurnTooLarge => {
                "$.frame.pcm16_base64"
            }
            Self::Sequence => "$.sequence",
            Self::FinalSequence => "$.final_sequence",
        }
    }

    fn diagnostic(self) -> VoiceProtocolDiagnostic {
        VoiceProtocolDiagnostic::new(self.code(), self.path())
    }
}

impl From<VoiceProtocolDiagnostic> for ClientFrameError {
    /// The closed wire vocabulary a stateful assembler diagnostic maps to. The
    /// diagnostic keeps the sanitized code and path; the wire error keeps the coarse
    /// client-visible classification.
    fn from(diagnostic: VoiceProtocolDiagnostic) -> Self {
        match diagnostic.code {
            VoiceProtocolDiagnosticCode::FrameTooLarge => Self::oversized_audio_chunk(),
            VoiceProtocolDiagnosticCode::TurnTooLarge => Self::oversized_audio_turn(),
            _ => Self::invalid_audio_frame(),
        }
    }
}

fn accept_audio_chunk(
    assembly: &mut AudioTurnAssembly,
    client_generation_id: String,
    turn_id: String,
    sequence: u32,
    frame: AudioFrame,
) -> Result<AudioAssemblyAction, VoiceProtocolDiagnostic> {
    let reject = |assembly: &mut AudioTurnAssembly, rejection: AudioAssemblyRejection| {
        assembly.open = None;
        Err(rejection.diagnostic())
    };

    if !audio_identity_is_valid(&client_generation_id, &turn_id) {
        return reject(assembly, AudioAssemblyRejection::InvalidIdentity);
    }

    // Decode before mutation: a rejected payload never reaches the retained turn.
    let pcm16 = frame.pcm16_bytes();
    if pcm16.is_empty() {
        return reject(assembly, AudioAssemblyRejection::InvalidPayload);
    }
    if pcm16.len() > VIVA_AUDIO_MAX_CHUNK_BYTES {
        return reject(assembly, AudioAssemblyRejection::ChunkTooLarge);
    }
    if !pcm16.len().is_multiple_of(2) {
        return reject(assembly, AudioAssemblyRejection::InvalidPayload);
    }

    match assembly.open.as_mut() {
        None => {
            if sequence != 0 {
                return reject(assembly, AudioAssemblyRejection::Sequence);
            }
            assembly.open = Some(IncomingAudioTurn {
                client_generation_id,
                turn_id,
                next_sequence: 1,
                pcm16: pcm16.to_vec(),
            });
        }
        Some(turn) => {
            if turn.client_generation_id != client_generation_id || turn.turn_id != turn_id {
                return reject(assembly, AudioAssemblyRejection::InvalidIdentity);
            }
            if turn.next_sequence != sequence {
                return reject(assembly, AudioAssemblyRejection::Sequence);
            }
            let Some(total) = turn.pcm16.len().checked_add(pcm16.len()) else {
                return reject(assembly, AudioAssemblyRejection::TurnTooLarge);
            };
            if total > VIVA_AUDIO_MAX_TURN_BYTES {
                return reject(assembly, AudioAssemblyRejection::TurnTooLarge);
            }
            let Some(next_sequence) = turn.next_sequence.checked_add(1) else {
                return reject(assembly, AudioAssemblyRejection::Sequence);
            };
            turn.pcm16.extend_from_slice(pcm16);
            turn.next_sequence = next_sequence;
        }
    }
    Ok(AudioAssemblyAction::Pending)
}

fn accept_audio_end(
    assembly: &mut AudioTurnAssembly,
    client_generation_id: &str,
    turn_id: &str,
    final_sequence: u32,
) -> Result<AudioAssemblyAction, VoiceProtocolDiagnostic> {
    let Some(turn) = assembly.open.take() else {
        return Err(AudioAssemblyRejection::FinalSequence.diagnostic());
    };
    if turn.client_generation_id != client_generation_id || turn.turn_id != turn_id {
        return Err(AudioAssemblyRejection::InvalidIdentity.diagnostic());
    }
    if turn.next_sequence != final_sequence.saturating_add(1) {
        return Err(AudioAssemblyRejection::FinalSequence.diagnostic());
    }
    assembly.settle(SettledAudioTurn::Submitted {
        client_generation_id: turn.client_generation_id.clone(),
        turn_id: turn.turn_id.clone(),
    });
    Ok(AudioAssemblyAction::Complete {
        client_generation_id: turn.client_generation_id,
        turn_id: turn.turn_id,
        final_sequence,
        frame: AudioFrame::from_pcm16_bytes(turn.pcm16),
    })
}

/// A scoped cancel.
///
/// Cancelling and submitting the same turn race by construction: the browser
/// decides to cancel while its own `audio_end` is already on the wire. The
/// server has no way to make that race disappear, so a cancel that names a turn
/// this connection has already settled is answered for what it is — a request to
/// cancel a turn that is now with the provider, or a repeat of a cancel that
/// already discarded one — and never as a malformed audio frame. Only a scoped
/// cancel naming a turn this connection never saw is still a protocol error.
fn accept_audio_cancel(
    assembly: &mut AudioTurnAssembly,
    client_generation_id: &str,
    turn_id: &str,
) -> Result<AudioAssemblyAction, VoiceProtocolDiagnostic> {
    let Some(turn) = assembly.open.take() else {
        return match assembly.settled_as(client_generation_id, turn_id) {
            Some(SettledAudioTurn::Submitted { .. }) => {
                Ok(AudioAssemblyAction::CancelSubmittedTurn)
            }
            Some(SettledAudioTurn::Discarded { .. }) => Ok(AudioAssemblyAction::AlreadyDiscarded),
            None => Err(AudioAssemblyRejection::InvalidIdentity.diagnostic()),
        };
    };
    if turn.client_generation_id != client_generation_id || turn.turn_id != turn_id {
        return Err(AudioAssemblyRejection::InvalidIdentity.diagnostic());
    }
    assembly.settle(SettledAudioTurn::Discarded {
        client_generation_id: turn.client_generation_id,
        turn_id: turn.turn_id,
    });
    Ok(AudioAssemblyAction::Cancelled)
}

fn client_input_action(
    message: Message,
    session_binding: &AuthorizedClientSession,
    audio_assembly: &mut AudioTurnAssembly,
) -> Result<ClientInputAction, ClientFrameError> {
    match message {
        Message::Text(text) => {
            if text.len() > VIVA_VOICE_MAX_TEXT_FRAME_BYTES {
                return Err(ClientFrameError::oversized_text());
            }
            let frame: ClientFrame =
                serde_json::from_str(&text).map_err(|_| ClientFrameError::invalid())?;
            if frame.version() != VIVA_VOICE_PROTOCOL_VERSION {
                return Err(ClientFrameError::invalid());
            }
            match frame {
                ClientFrame::SessionConfig {
                    client_generation_id,
                    session_token,
                    session,
                    ..
                } => {
                    let sanitized = sanitize_refresh_session_config(
                        session,
                        &client_generation_id,
                        &session_token,
                        session_binding,
                    )?;
                    Ok(ClientInputAction::Send {
                        brain_input: BrainInput::SessionContextRefresh(
                            serde_json::to_value(sanitized)
                                .map_err(|_| ClientFrameError::invalid())?,
                        ),
                        action: ClientAction::ConfigRefresh,
                        turn_id: None,
                    })
                }
                ClientFrame::AudioChunk {
                    client_generation_id,
                    turn_id,
                    sequence,
                    frame,
                    ..
                } => {
                    match accept_audio_chunk(
                        audio_assembly,
                        client_generation_id,
                        turn_id,
                        sequence,
                        frame,
                    )? {
                        AudioAssemblyAction::Pending => Ok(ClientInputAction::AudioTurnBuffered),
                        AudioAssemblyAction::Complete { .. }
                        | AudioAssemblyAction::Cancelled
                        | AudioAssemblyAction::CancelSubmittedTurn
                        | AudioAssemblyAction::AlreadyDiscarded => {
                            Err(ClientFrameError::invalid_audio_frame())
                        }
                    }
                }
                ClientFrame::AudioEnd {
                    client_generation_id,
                    turn_id,
                    final_sequence,
                    ..
                } => {
                    match accept_audio_end(
                        audio_assembly,
                        &client_generation_id,
                        &turn_id,
                        final_sequence,
                    )? {
                        AudioAssemblyAction::Complete {
                            client_generation_id,
                            turn_id,
                            final_sequence,
                            frame,
                        } => Ok(ClientInputAction::SendAudioTurn {
                            brain_input: BrainInput::AudioWithMetadata {
                                frame,
                                client_generation_id: Some(client_generation_id.clone()),
                            },
                            accepted: AcceptedAudioTurn {
                                client_generation_id,
                                turn_id,
                                final_sequence,
                            },
                        }),
                        AudioAssemblyAction::Pending
                        | AudioAssemblyAction::Cancelled
                        | AudioAssemblyAction::CancelSubmittedTurn
                        | AudioAssemblyAction::AlreadyDiscarded => {
                            Err(ClientFrameError::invalid_audio_frame())
                        }
                    }
                }
                ClientFrame::TurnIntent {
                    client_generation_id,
                    turn_id,
                    intent,
                    ..
                } => {
                    let client_generation_id =
                        validated_client_generation_id(Some(client_generation_id))?;
                    match intent {
                        ClientTurnIntent::AnswerText { text } => Ok(ClientInputAction::Send {
                            brain_input: match client_generation_id {
                                Some(client_generation_id) => BrainInput::TextWithMetadata {
                                    text,
                                    client_generation_id: Some(client_generation_id),
                                },
                                None => BrainInput::Text(text),
                            },
                            action: ClientAction::AnswerText,
                            turn_id: Some(turn_id),
                        }),
                        // A citation challenge is not an answer and must never be
                        // graded as one. No typed provider input carries a challenge
                        // today, and synthesizing prose to stand in for one is exactly
                        // the magic-string payload the v5 contract removed, so the
                        // intent is refused instead of silently downgraded.
                        ClientTurnIntent::CitationChallenge { .. } => {
                            Err(ClientFrameError::citation_challenge_unroutable())
                        }
                    }
                }
                // `D-03B QUIZ_ONLY`: the one engine has no client-selectable mode and
                // no client goal, so every attempted context change is refused. The
                // frame reaches neither the provider nor the store, and the refusal
                // is recoverable: the socket and its deadlines are unchanged.
                ClientFrame::SessionRefresh {
                    client_generation_id,
                    ..
                } => {
                    // `session_refresh` is the only in-socket frame that could smuggle
                    // a renewed credential or a second identity, so it is re-read
                    // through Plan 05's strict parser: token, user, study, session,
                    // source and active-concept members are refused there, before this
                    // service applies any policy.
                    parse_client_frame_json(&text).map_err(|_| ClientFrameError::invalid())?;
                    bind_context_refresh(
                        &client_generation_id,
                        session_binding,
                        SESSION_REFRESH_POLICY,
                    )
                }
                ClientFrame::Cancel {
                    client_generation_id,
                    turn_id,
                    ..
                } => match turn_id {
                    // A scoped cancel discards a matching in-progress assembly and
                    // never creates a provider turn. v5 makes the generation
                    // mandatory, so a turn a client cannot prove it owns is
                    // unrepresentable rather than rejected at runtime.
                    Some(turn_id) => {
                        match accept_audio_cancel(audio_assembly, &client_generation_id, &turn_id)?
                        {
                            AudioAssemblyAction::Cancelled => {
                                Ok(ClientInputAction::AudioTurnDiscarded)
                            }
                            // The turn is already with the provider, so the
                            // client is asking to cancel the turn, not the
                            // assembly. This is the ordinary provider-response
                            // cancellation, scoped to a turn it can prove it owns.
                            AudioAssemblyAction::CancelSubmittedTurn => {
                                Ok(ClientInputAction::Send {
                                    brain_input: BrainInput::CancelResponse,
                                    action: ClientAction::Cancel,
                                    turn_id: Some(turn_id),
                                })
                            }
                            // Nothing left to cancel and no provider work was ever
                            // created: a benign no-op, not a protocol violation.
                            AudioAssemblyAction::AlreadyDiscarded => {
                                Ok(ClientInputAction::AudioTurnDiscarded)
                            }
                            AudioAssemblyAction::Pending | AudioAssemblyAction::Complete { .. } => {
                                Err(ClientFrameError::invalid_audio_frame())
                            }
                        }
                    }
                    // Without a turn id this preserves provider-response cancellation.
                    None => Ok(ClientInputAction::Send {
                        brain_input: BrainInput::CancelResponse,
                        action: ClientAction::Cancel,
                        turn_id: None,
                    }),
                },
                ClientFrame::Stop { .. } => Ok(ClientInputAction::TrySend {
                    brain_input: BrainInput::Stop,
                    action: ClientAction::Stop,
                }),
            }
        }
        // Protocol v5 has no binary client surface. Accepting one here would admit
        // an audio turn that never passed the bounded assembler, so the frame is
        // refused without inspecting its bytes.
        Message::Binary(_) => Err(ClientFrameError::unsupported_binary_frame()),
        Message::Close(_) => Ok(ClientInputAction::TrySend {
            brain_input: BrainInput::Stop,
            action: ClientAction::Close,
        }),
        Message::Ping(_) | Message::Pong(_) => Ok(ClientInputAction::Keepalive),
    }
}

async fn send_brain_input_with_drain(
    input: &mpsc::Sender<BrainInput>,
    brain_input: BrainInput,
    drain_signal: &mut watch::Receiver<bool>,
) -> Result<(), ClientMessageError> {
    if *drain_signal.borrow_and_update() {
        return Err(ClientMessageError::Drained);
    }
    let send = input.send(brain_input);
    tokio::pin!(send);
    loop {
        tokio::select! {
            result = &mut send => {
                return result.map_err(|_| {
                    ClientMessageError::Frame(ClientFrameError::disconnected())
                });
            }
            changed = drain_signal.changed() => {
                if changed.is_ok() && *drain_signal.borrow_and_update() {
                    return Err(ClientMessageError::Drained);
                }
            }
        }
    }
}

async fn send_brain_input_with_deadline(
    input: &mpsc::Sender<BrainInput>,
    brain_input: BrainInput,
    drain_signal: &mut watch::Receiver<bool>,
    turn_deadline: Option<Instant>,
) -> Result<(), ClientMessageError> {
    let send = send_brain_input_with_drain(input, brain_input, drain_signal);
    match turn_deadline {
        Some(deadline) => match tokio::time::timeout_at(deadline, send).await {
            Ok(result) => result,
            Err(_) => Err(ClientMessageError::TurnCap),
        },
        None => send.await,
    }
}

#[cfg(test)]
fn session_config_from_message(message: Message) -> Result<SessionConfig, ClientFrameError> {
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
fn initial_session_config_from_message(
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
fn sanitize_client_session_config(
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

fn authorize_initial_session_config(
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
struct SessionIdentity {
    user_id: String,
    study_set_id: String,
    signed_session_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionAuthMode {
    Trusted,
    Signed,
}

/// `D-03B QUIZ_ONLY`: the only refresh policy this service compiles. `D-03A`'s
/// claim-bound branch would compare a server-bound learning intent; that branch is
/// not selected, so neither its variant nor its comparison exists here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LearningIntentRefreshPolicy {
    QuizOnlyNoRefresh,
}

const SESSION_REFRESH_POLICY: LearningIntentRefreshPolicy =
    LearningIntentRefreshPolicy::QuizOnlyNoRefresh;

/// The one engine has no client-selectable mode and no client goal, so every
/// attempted context change is refused before any provider or store work. The
/// denial is recoverable: it changes no session deadline and ends no socket.
fn validate_refresh_context(policy: LearningIntentRefreshPolicy) -> RecoverablePolicyDenial {
    match policy {
        LearningIntentRefreshPolicy::QuizOnlyNoRefresh => RecoverablePolicyDenial::SessionRefresh,
    }
}

/// A refusal the browser can recover from: Plan 05 classifies it nonterminal, so the
/// socket, its leases, and every deadline are unchanged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoverablePolicyDenial {
    SessionRefresh,
}

impl RecoverablePolicyDenial {
    fn event(self) -> VivaServerEvent {
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
fn bind_context_refresh(
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
fn sanitize_refresh_session_config(
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
struct AuthorizedClientSession {
    user_id: String,
    study_set_id: String,
    /// Provider and store identity; never client-supplied on a later frame.
    session_id: String,
    /// The session id the browser is allowed to assert.
    client_session_id: String,
    client_generation_id: String,
    /// The credential this socket bound. Compared in constant time on a later
    /// `session_config`; unread on the trusted loopback path.
    bound_session_token: String,
    auth_mode: SessionAuthMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InitialSessionConfig {
    client_generation_id: String,
    session: SessionConfig,
    session_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AuthorizedInitialSessionConfig {
    config: SessionConfig,
    session_binding: AuthorizedClientSession,
    token_nonce_claim: Option<SessionTokenNonceClaim>,
    failure_control: Option<FailureControlScenario>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClientAction {
    Audio,
    AudioChunk,
    AudioTurnCancel,
    AnswerText,
    Cancel,
    Close,
    ConfigRefresh,
    Keepalive,
    Stop,
}

impl ClientAction {
    fn arms_turn_cap(self) -> bool {
        matches!(self, Self::Audio | Self::AnswerText)
    }
}

#[derive(Debug)]
enum ClientInputAction {
    Send {
        brain_input: BrainInput,
        action: ClientAction,
        /// The v5 turn identity this submission names, when it names one. It is
        /// registered with the socket's turn bindings only once the input is
        /// actually admitted.
        turn_id: Option<String>,
    },
    /// One complete bounded audio turn, admitted exactly once at explicit end.
    SendAudioTurn {
        brain_input: BrainInput,
        accepted: AcceptedAudioTurn,
    },
    TrySend {
        brain_input: BrainInput,
        action: ClientAction,
    },
    Keepalive,
    /// A valid chunk retained in the connection-local assembly; nothing forwarded.
    AudioTurnBuffered,
    /// A matching scoped cancel discarded the assembly; no provider turn exists.
    AudioTurnDiscarded,
    /// A parsed frame service policy refuses without ending the session. Nothing is
    /// forwarded and no deadline moves.
    RecoverableDenial(RecoverablePolicyDenial),
}

impl ClientInputAction {
    fn action(&self) -> ClientAction {
        match self {
            Self::Send { action, .. } | Self::TrySend { action, .. } => *action,
            Self::SendAudioTurn { .. } => ClientAction::Audio,
            Self::Keepalive | Self::RecoverableDenial(_) => ClientAction::Keepalive,
            Self::AudioTurnBuffered => ClientAction::AudioChunk,
            Self::AudioTurnDiscarded => ClientAction::AudioTurnCancel,
        }
    }

    fn accepted_audio_turn(&self) -> Option<AcceptedAudioTurn> {
        match self {
            Self::SendAudioTurn { accepted, .. } => Some(accepted.clone()),
            _ => None,
        }
    }

    /// `SERVICE-014`: the v5 turn identity a submission names, for the socket's
    /// turn bindings. A keepalive, a buffered chunk, a discarded assembly, and a
    /// refused context change all name none.
    fn submitted_turn_id(&self) -> Option<&str> {
        match self {
            Self::Send { turn_id, .. } => turn_id.as_deref(),
            Self::SendAudioTurn { accepted, .. } => Some(accepted.turn_id.as_str()),
            Self::TrySend { .. }
            | Self::Keepalive
            | Self::AudioTurnBuffered
            | Self::AudioTurnDiscarded
            | Self::RecoverableDenial(_) => None,
        }
    }

    fn recoverable_denial(&self) -> Option<RecoverablePolicyDenial> {
        match self {
            Self::RecoverableDenial(denial) => Some(*denial),
            _ => None,
        }
    }
}

fn client_input_requires_provider_admission(client_input: &ClientInputAction) -> bool {
    client_input.action().arms_turn_cap()
}

#[derive(Debug)]
struct QueuedProviderAdmission {
    client_input: ClientInputAction,
    admission: ProviderAdmission,
}

fn start_provider_admission(
    limit_state: VoiceLimitState,
    limits: VoiceLimitConfig,
    client_input: ClientInputAction,
    queue_behavior: ProviderQueueBehavior,
) -> Fuse<BoxFuture<'static, QueuedProviderAdmission>> {
    async move {
        let admission = limit_state
            .try_admit_provider_turn(&limits, queue_behavior)
            .await;
        QueuedProviderAdmission {
            client_input,
            admission,
        }
    }
    .boxed()
    .fuse()
}

#[derive(Debug)]
enum ClientMessageError {
    Frame(ClientFrameError),
    Drained,
    RateLimit,
    TurnCap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ClientFrameError {
    auth_failure_code: Option<SessionAuthFailureCode>,
    /// `VOICE-ERROR-001`: the typed code the client frame carries. The wire
    /// vocabulary is closed by Plan 05, so every rejection selects exactly one
    /// member of it and `message` stays a human diagnostic nothing branches on.
    code: VoiceServerErrorCode,
    message: &'static str,
    close_code: u16,
    close_reason: &'static str,
    terminal_reason: &'static str,
}

impl ClientFrameError {
    fn invalid_first_frame() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "first client frame must be session_config",
            close_code: close_code::PROTOCOL,
            close_reason: "session config required",
            terminal_reason: "invalid_first_frame",
        }
    }

    fn invalid() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "invalid client frame",
            close_code: close_code::PROTOCOL,
            close_reason: "invalid client frame",
            terminal_reason: "invalid_client_frame",
        }
    }

    fn invalid_session_identity() -> Self {
        Self::session_auth_failed(SessionAuthFailureCode::IdentityMismatch)
    }

    fn session_auth_failed(auth_failure_code: SessionAuthFailureCode) -> Self {
        Self {
            auth_failure_code: Some(auth_failure_code),
            code: match auth_failure_code {
                SessionAuthFailureCode::Expired => VoiceServerErrorCode::AuthExpired,
                SessionAuthFailureCode::Replayed => VoiceServerErrorCode::AuthReplayed,
                SessionAuthFailureCode::IdentityMismatch => {
                    VoiceServerErrorCode::AuthIdentityMismatch
                }
                SessionAuthFailureCode::Malformed
                | SessionAuthFailureCode::InvalidSignature
                | SessionAuthFailureCode::AccessDenied => VoiceServerErrorCode::AuthInvalid,
            },
            message: "session auth failed",
            close_code: close_code::POLICY,
            close_reason: "session auth failed",
            terminal_reason: match auth_failure_code {
                SessionAuthFailureCode::IdentityMismatch => "invalid_session_identity",
                SessionAuthFailureCode::AccessDenied => "study_set_access_denied",
                _ => "invalid_session_token",
            },
        }
    }

    fn study_set_access_denied() -> Self {
        Self::session_auth_failed(SessionAuthFailureCode::AccessDenied)
    }

    /// A store that cannot answer at session bootstrap is reported with the same
    /// coarse authorization code as any other failed admission: the client learns
    /// only that authorization did not succeed, never which server component
    /// failed.
    fn study_store_unavailable() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::AuthInvalid,
            message: "study store unavailable",
            close_code: close_code::POLICY,
            close_reason: "study store unavailable",
            terminal_reason: "study_store_unavailable",
        }
    }

    fn nonce_store_unavailable() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::AuthInvalid,
            message: "session token nonce store unavailable",
            close_code: close_code::POLICY,
            close_reason: "session token nonce store unavailable",
            terminal_reason: concat!("session_", "token_nonce_store_unavailable"),
        }
    }

    /// A `citation_challenge` turn intent parses, but no typed provider input
    /// carries it. Refusing it keeps the challenge out of the answer-grading path
    /// entirely; it is never coerced into answer text.
    fn citation_challenge_unroutable() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientAuthorityForbidden,
            message: "citation challenge is not routable by this server",
            close_code: close_code::POLICY,
            close_reason: "citation challenge unavailable",
            terminal_reason: "citation_challenge_unroutable",
        }
    }

    /// `SERVICE-007`: a later frame naming a generation this socket did not bind is
    /// an identity failure, not a refresh. It never rebinds identity or a credential.
    fn generation_mismatch() -> Self {
        Self::session_auth_failed(SessionAuthFailureCode::IdentityMismatch)
    }

    fn oversized_text() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameTooLarge,
            message: "text frame exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "text frame too large",
            terminal_reason: "oversized_text_frame",
        }
    }

    fn invalid_audio_frame() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "invalid audio frame",
            close_code: close_code::PROTOCOL,
            close_reason: "invalid audio frame",
            terminal_reason: "invalid_audio_frame",
        }
    }

    fn oversized_audio_chunk() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameTooLarge,
            message: "audio chunk exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "audio chunk too large",
            terminal_reason: "oversized_audio_chunk",
        }
    }

    fn oversized_audio_turn() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientTurnTooLarge,
            message: "audio turn exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "audio turn too large",
            terminal_reason: "oversized_audio_turn",
        }
    }

    /// Protocol v5 carries audio as bounded `audio_chunk`/`audio_end` JSON frames.
    /// A raw WebSocket binary frame is v4 legacy input that would bypass the turn
    /// assembler's generation, sequence, and aggregate-byte bounds entirely, so it
    /// is refused outright rather than size-checked.
    fn unsupported_binary_frame() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::ClientFrameMalformed,
            message: "binary client frames are not accepted",
            close_code: close_code::UNSUPPORTED,
            close_reason: "binary client frames unsupported",
            terminal_reason: "unsupported_binary_frame",
        }
    }

    fn disconnected() -> Self {
        Self {
            auth_failure_code: None,
            code: VoiceServerErrorCode::InternalSerialization,
            message: "agent input channel closed",
            close_code: close_code::ABNORMAL,
            close_reason: "agent input closed",
            terminal_reason: "agent_input_closed",
        }
    }
}

fn record_client_action(state: &AppState, voice_session_id: Option<String>, action: ClientAction) {
    let (kind, detail) = match action {
        ClientAction::Audio => (
            VoiceEvidenceEventKind::AnswerReceived,
            "audio frame received",
        ),
        ClientAction::AnswerText => (
            VoiceEvidenceEventKind::AnswerReceived,
            "text answer received",
        ),
        ClientAction::Cancel => (VoiceEvidenceEventKind::CancelReceived, "cancel received"),
        ClientAction::Close => (VoiceEvidenceEventKind::StopReceived, "close received"),
        ClientAction::ConfigRefresh => (
            VoiceEvidenceEventKind::ConfigAccepted,
            "config refresh received",
        ),
        // Bounded chunks are connection-local until an explicit end; they are not
        // an answer and never enter the evidence pack on their own.
        ClientAction::AudioChunk | ClientAction::Keepalive => return,
        ClientAction::AudioTurnCancel => (
            VoiceEvidenceEventKind::CancelReceived,
            "audio turn cancel received",
        ),
        ClientAction::Stop => (VoiceEvidenceEventKind::StopReceived, "stop received"),
    };
    state
        .evidence
        .record(VoiceEvidenceEvent::new(kind, voice_session_id, detail));
}

async fn record_session_auth_failure(
    state: &AppState,
    voice_session_id: Option<String>,
    code: Option<SessionAuthFailureCode>,
) {
    let Some(code) = code else {
        return;
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::AuthFailure,
        voice_session_id,
        format!(
            "code={} client_class={} retry_eligible={} stage={} evidence_field={}",
            code.as_str(),
            code.client_class(),
            code.retry_eligible(),
            code.stage(),
            code.evidence_field()
        ),
    ));
}

fn record_provider_stage_failure(
    state: &AppState,
    voice_session_id: Option<String>,
    error: &BrainProviderError,
) {
    let Some(failure) = &error.failure else {
        return;
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ProviderStageFailure,
        voice_session_id,
        provider_stage_failure_detail(failure),
    ));
}

const PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS: usize = 384;
const PROVIDER_STAGE_FAILURE_DEPLOY_SHA_MAX_CHARS: usize = 8;
const PROVIDER_STAGE_FAILURE_MODEL_MAX_CHARS: usize = 32;
const PROVIDER_STAGE_FAILURE_PROVIDER_MAX_CHARS: usize = 24;
const PROVIDER_STAGE_FAILURE_METADATA_VALUE_MAX_CHARS: usize = 32;

fn provider_stage_failure_detail(failure: &BrainProviderFailure) -> String {
    let retry_after_ms = metadata_field(failure.metadata(), "retry_after_ms");
    let retry_after_source = metadata_field(failure.metadata(), "retry_after_source");
    let reset_hint = metadata_field(failure.metadata(), "reset_hint");
    let budget_state = metadata_field(failure.metadata(), "budget_state");
    let deploy_sha = metadata_field(failure.metadata(), "deploy_sha")
        .map(|value| bounded_evidence_value(value, PROVIDER_STAGE_FAILURE_DEPLOY_SHA_MAX_CHARS))
        .unwrap_or_else(|| "unknown".to_owned());
    let mut fields = vec![
        format!("failure_class={}", failure.failure_class()),
        format!("stage={}", failure.stage()),
        format!("terminal_reason={}", failure.terminal_reason().as_str()),
        format!(
            "provider={}",
            bounded_evidence_value(
                failure.provider(),
                PROVIDER_STAGE_FAILURE_PROVIDER_MAX_CHARS
            )
        ),
        format!(
            "model={}",
            bounded_evidence_value(failure.model(), PROVIDER_STAGE_FAILURE_MODEL_MAX_CHARS)
        ),
        format!("latency_ms={}", failure.latency_ms()),
        format!("deploy_sha={deploy_sha}"),
    ];
    if provider_stage_failure_has_rate_metadata(
        failure,
        retry_after_ms,
        retry_after_source,
        reset_hint,
        budget_state,
    ) {
        fields.extend([
            format!("retry_after_ms={}", retry_after_ms.unwrap_or("unknown")),
            format!(
                "retry_after_source={}",
                retry_after_source.unwrap_or("unknown")
            ),
            format!("reset_hint={}", reset_hint.unwrap_or("unknown")),
            format!("budget_state={}", budget_state.unwrap_or("unknown")),
        ]);
    }
    fields.extend(safe_provider_stage_metadata_fields(failure.metadata()));
    bounded_evidence_detail(fields)
}

fn provider_stage_failure_has_rate_metadata(
    failure: &BrainProviderFailure,
    retry_after_ms: Option<&str>,
    retry_after_source: Option<&str>,
    reset_hint: Option<&str>,
    budget_state: Option<&str>,
) -> bool {
    failure.failure_class() == BrainFailureClass::QuotaRateFailure
        || failure.terminal_reason() == TerminalSessionReason::ProviderRateLimited
        || retry_after_ms.is_some()
        || retry_after_source.is_some()
        || reset_hint.is_some()
        || budget_state.is_some()
}

fn safe_provider_stage_metadata_fields(metadata: &str) -> Vec<String> {
    ["tool", "error_kind"]
        .into_iter()
        .filter_map(|key| {
            metadata_field(metadata, key).map(|value| {
                format!(
                    "{key}={}",
                    bounded_evidence_value(value, PROVIDER_STAGE_FAILURE_METADATA_VALUE_MAX_CHARS)
                )
            })
        })
        .collect()
}

fn bounded_evidence_detail(fields: impl IntoIterator<Item = String>) -> String {
    let mut detail = String::new();
    for field in fields {
        let separator_len = usize::from(!detail.is_empty());
        if detail.len() + separator_len + field.len() > PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS {
            continue;
        }
        if !detail.is_empty() {
            detail.push(' ');
        }
        detail.push_str(&field);
    }
    detail
}

fn bounded_evidence_value(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn metadata_field<'a>(metadata: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    metadata
        .split_whitespace()
        .find_map(|field| field.strip_prefix(&prefix))
        .filter(|value| !value.is_empty())
}

fn record_provider_admission(
    state: &AppState,
    voice_session_id: Option<String>,
    admission: &ProviderAdmission,
) {
    let detail = match &admission.decision {
        ProviderAdmissionDecision::Admitted => format!(
            "admission_decision=admitted queue_depth={} queue_delay_ms={} retry_after_ms=0 reset_hint=none terminal_reason=none budget_state={}",
            admission.queue_depth, admission.queue_delay_ms, admission.budget_state
        ),
        ProviderAdmissionDecision::Denied(denial) => format!(
            "admission_decision=denied reason={} terminal_reason={} queue_depth={} queue_delay_ms={} retry_after_ms={} reset_hint={} budget_state={}",
            denial.reason,
            denial.terminal_reason.as_str(),
            denial.queue_depth,
            denial.queue_delay_ms,
            denial.retry_after_ms,
            denial.reset_hint,
            denial.budget_state
        ),
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ProviderAdmission,
        voice_session_id,
        detail,
    ));
}

fn record_turn_cap_config(state: &AppState, voice_session_id: Option<String>) {
    let source = if state.turn_cap_override {
        "explicit_override"
    } else {
        "contract_default"
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ConfigAccepted,
        voice_session_id,
        format!(
            "turn_cap_ms={} source={} contract_max_ms={}",
            state.ws_timeouts.idle.as_millis(),
            source,
            bac_510_max_turn_duration().as_millis()
        ),
    ));
}

#[derive(Clone, Debug, PartialEq)]
enum BrainEventRecordResult {
    None,
    Usage(VoiceUsageRecord),
    DurabilityDegraded,
}

async fn record_brain_event(
    state: &AppState,
    voice_session_id: Option<String>,
    event: &agent_domain::BrainEvent,
    session_elapsed: Duration,
) -> BrainEventRecordResult {
    if let agent_domain::BrainEvent::Usage(usage) = event {
        let elapsed_ms = session_elapsed.as_millis().try_into().unwrap_or(u64::MAX);
        let usage_record = state.usage.record(
            voice_session_id.as_deref(),
            &state.provider,
            &format!("{}-viva", state.provider),
            usage.clone(),
            session_elapsed.as_secs().max(1),
            Some(elapsed_ms),
        );
        if let Err(error) = state
            .study_store
            .record_voice_usage(usage_record.clone())
            .await
        {
            if store_write_error_is_durability_degraded(state, &error) {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::StoreCounts,
                    voice_session_id,
                    "durability_degraded",
                ));
                return BrainEventRecordResult::DurabilityDegraded;
            } else {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::StoreCounts,
                    voice_session_id,
                    format!("usage_persist_failed: {error}"),
                ));
            }
        }
        return BrainEventRecordResult::Usage(usage_record);
    }
    if let agent_domain::BrainEvent::ProviderFallbackActivated {
        provider,
        from_model,
        to_model,
        reason,
        failure: _,
        ..
    } = event
    {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::ProviderFallback,
            voice_session_id,
            format!(
                "provider={provider} from_model={from_model} to_model={to_model} reason={reason}"
            ),
        ));
        return BrainEventRecordResult::None;
    }
    let Some((kind, detail)) = (match event {
        agent_domain::BrainEvent::QuestionStarted { response_id, .. } => Some((
            VoiceEvidenceEventKind::QuestionEmitted,
            response_id.as_str(),
        )),
        agent_domain::BrainEvent::AnswerEvaluated { response_id, .. } => Some((
            VoiceEvidenceEventKind::EvaluationEmitted,
            response_id.as_str(),
        )),
        agent_domain::BrainEvent::SourceReference { response_id, .. } => {
            Some((VoiceEvidenceEventKind::SourceEmitted, response_id.as_str()))
        }
        agent_domain::BrainEvent::ResponseCancelledFor { response_id } => {
            Some((VoiceEvidenceEventKind::CancelReceived, response_id.as_str()))
        }
        agent_domain::BrainEvent::ResponseCancelled => {
            Some((VoiceEvidenceEventKind::CancelReceived, "response cancelled"))
        }
        _ => None,
    }) else {
        return BrainEventRecordResult::None;
    };
    state
        .evidence
        .record(VoiceEvidenceEvent::new(kind, voice_session_id, detail));
    BrainEventRecordResult::None
}

async fn record_terminal(state: &AppState, voice_session_id: Option<String>, reason: &str) {
    let mut terminal_reason = reason;
    if let Some(session_id) = voice_session_id.as_deref() {
        if let Err(error) = state
            .study_store
            .close_voice_session(session_id, reason)
            .await
        {
            let detail = if store_write_error_is_durability_degraded(state, &error) {
                terminal_reason = TerminalSessionReason::DurabilityDegraded.as_str();
                "session_close_failed: durability_degraded".to_owned()
            } else {
                format!("session_close_failed: {error}")
            };
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                voice_session_id.clone(),
                detail,
            ));
        }
    }
    record_terminal_evidence(state, voice_session_id, terminal_reason).await;
}

async fn persist_terminal_session_reason(
    state: &AppState,
    voice_session_id: Option<String>,
    reason: TerminalSessionReason,
) -> TerminalSessionReason {
    let Some(session_id) = voice_session_id.as_deref() else {
        return reason;
    };
    if let Err(error) = state
        .study_store
        .close_voice_session(session_id, reason.as_str())
        .await
    {
        if store_write_error_is_durability_degraded(state, &error) {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                voice_session_id,
                "session_close_failed: durability_degraded",
            ));
            return TerminalSessionReason::DurabilityDegraded;
        }
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::StoreCounts,
            voice_session_id,
            format!("session_close_failed: {error}"),
        ));
    }
    reason
}

async fn persist_terminal_label_or_durability_degraded(
    state: &AppState,
    voice_session_id: Option<String>,
    reason: &'static str,
) -> &'static str {
    let Some(session_id) = voice_session_id.as_deref() else {
        return reason;
    };
    if let Err(error) = state
        .study_store
        .close_voice_session(session_id, reason)
        .await
    {
        if store_write_error_is_durability_degraded(state, &error) {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                voice_session_id,
                "session_close_failed: durability_degraded",
            ));
            return TerminalSessionReason::DurabilityDegraded.as_str();
        }
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::StoreCounts,
            voice_session_id,
            format!("session_close_failed: {error}"),
        ));
    }
    reason
}

fn terminal_close_code(reason: TerminalSessionReason, close_code: u16) -> u16 {
    if reason == TerminalSessionReason::DurabilityDegraded {
        close_code::ERROR
    } else {
        close_code
    }
}

async fn record_terminal_evidence(
    state: &AppState,
    voice_session_id: Option<String>,
    reason: &str,
) {
    let pending_answer_attempts = if let Some(session_id) = voice_session_id.as_deref() {
        match state
            .study_store
            .pending_answer_attempts_for_session(session_id)
            .await
        {
            Ok(count) => count,
            Err(error) => {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::StoreCounts,
                    voice_session_id.clone(),
                    format!("pending_answer_attempts_failed: {error}"),
                ));
                0
            }
        }
    } else {
        0
    };
    let counts = state.study_store.write_counts();
    emit_pending_evaluation_observability_log(state, reason, pending_answer_attempts);
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::StoreCounts,
        voice_session_id.clone(),
        format!(
            "sessions={} answer_attempts={} concept_statuses={} review_items={} recaps={}",
            counts.sessions,
            counts.answer_attempts,
            counts.concept_statuses,
            counts.review_items,
            counts.recaps
        ),
    ));
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::TerminalReason,
        voice_session_id.clone(),
        reason,
    ));
    emit_terminal_observability_log(state, reason);
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::Close,
        voice_session_id,
        reason,
    ));
}

async fn send_json<S>(
    sender: &mut BoundedSender<S>,
    frame: &ServerFrame,
) -> Result<(), OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    // Plan 05 owns the fallback frame; this service never writes its own error JSON.
    let text = serialize_server_frame_with(frame, serde_json::to_string);
    sender.send(Message::Text(text.into())).await
}

async fn close_with<S>(
    sender: &mut BoundedSender<S>,
    code: u16,
    reason: &'static str,
) -> Result<(), OutboundWriteError>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    sender
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await
}

fn ws_access_error(error: VoiceWsAccessError) -> VoiceWsRejection {
    let status = match error {
        VoiceWsAccessError::OriginDenied => StatusCode::FORBIDDEN,
        VoiceWsAccessError::MissingBearer | VoiceWsAccessError::InvalidBearer => {
            StatusCode::UNAUTHORIZED
        }
    };
    VoiceWsRejection::new(status, json!({ "error": error.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_adapters::SyntheticBrain;
    use agent_domain::{BrainProviderFailure, BrainProviderFailureParts};
    use serde::Deserialize;
    use std::{
        pin::Pin,
        sync::Arc,
        task::{Context, Poll},
    };

    fn fixture_binding() -> AuthorizedClientSession {
        AuthorizedClientSession {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            session_id: "voice-session-1".to_owned(),
            client_session_id: "voice-session-1".to_owned(),
            client_generation_id: "1".to_owned(),
            bound_session_token: "placeholder-session-material".to_owned(),
            auth_mode: SessionAuthMode::Trusted,
        }
    }

    #[test]
    fn failure_control_scenarios_declare_typed_terminal_reasons() {
        for (scenario, expected) in [
            (
                FailureControlScenario::ProviderRateLimited,
                TerminalSessionReason::ProviderRateLimited,
            ),
            (
                FailureControlScenario::ProviderAuthFailed,
                TerminalSessionReason::ProviderAuthFailed,
            ),
            (
                FailureControlScenario::ProviderTimeout,
                TerminalSessionReason::ProviderTimeout,
            ),
            (
                FailureControlScenario::SonicTtsTimeout,
                TerminalSessionReason::ProviderTimeout,
            ),
            (
                FailureControlScenario::RecapTimeout,
                TerminalSessionReason::ProviderTimeout,
            ),
            (
                FailureControlScenario::SilentStall,
                TerminalSessionReason::ProviderTimeout,
            ),
            (
                FailureControlScenario::ProviderMalformedStream,
                TerminalSessionReason::ProviderMalformedStream,
            ),
            (
                FailureControlScenario::ProviderNetworkDisconnect,
                TerminalSessionReason::ProviderNetworkDisconnect,
            ),
            (
                FailureControlScenario::InvalidToken,
                TerminalSessionReason::ProviderAuthFailed,
            ),
            (
                FailureControlScenario::ExpiredToken,
                TerminalSessionReason::ProviderAuthFailed,
            ),
            (
                FailureControlScenario::ReplayedToken,
                TerminalSessionReason::ProviderAuthFailed,
            ),
            (
                FailureControlScenario::MalformedToken,
                TerminalSessionReason::ProviderAuthFailed,
            ),
            (
                FailureControlScenario::SlowStaleSocketClose,
                TerminalSessionReason::SlowClient,
            ),
            (
                FailureControlScenario::DoubleSubmitRace,
                TerminalSessionReason::SlowClient,
            ),
            (
                FailureControlScenario::MicDenied,
                TerminalSessionReason::SlowClient,
            ),
            (
                FailureControlScenario::TypedFallback,
                TerminalSessionReason::PartialStageSuccess,
            ),
        ] {
            let error = failure_control_provider_error(scenario);
            assert_eq!(
                terminal_reason_for_provider_error(&error),
                expected,
                "scenario {} must declare its terminal reason",
                scenario.as_str()
            );
        }
    }

    #[test]
    fn store_error_durability_classification_reads_the_typed_kind_only() {
        // A hostile diagnostic string cannot promote a non-durability kind, and a
        // reassuring one cannot demote a durability kind.
        assert!(store_adapter_error_is_durability_degraded(
            &PortError::durability("study_store", "voice-session-1", "everything is fine")
        ));
        assert!(store_adapter_error_is_durability_degraded(
            &PortError::internal("study_store", "voice-session-1", "everything is fine")
        ));
        assert!(!store_adapter_error_is_durability_degraded(
            &PortError::unavailable(
                "study_store",
                "missing-study-set",
                "durable store connection pool timed out"
            )
        ));
        assert!(!store_adapter_error_is_durability_degraded(
            &PortError::invalid_input("study_store", "concept-1", "postgres database unavailable")
        ));
        assert!(!store_adapter_error_is_durability_degraded(
            &PortError::conflict(
                "study_store",
                "voice-session-1",
                "session token nonce already used"
            )
        ));
    }

    #[test]
    fn nonce_replay_is_detected_by_conflict_kind_not_by_reason_text() {
        assert!(nonce_claim_was_replayed(&PortError::conflict(
            "study_store",
            "user-1/set-1/voice-session-1",
            "any wording at all"
        )));
        assert!(!nonce_claim_was_replayed(&PortError::unavailable(
            "study_store",
            "user-1/set-1/voice-session-1",
            "session token nonce already used"
        )));
    }

    #[test]
    fn terminal_observability_classifier_emits_query_backing_fields() {
        assert_eq!(
            terminal_observability_classification("provider_rate_limited"),
            Some(TerminalObservabilityClassification {
                failure_class: "quota_rate_failure",
                stage: "provider",
                signal: "gemini_http_429",
            })
        );
        assert_eq!(
            terminal_observability_classification("provider_auth_failed"),
            Some(TerminalObservabilityClassification {
                failure_class: "provider_auth_failure",
                stage: "provider_auth",
                signal: "provider_auth_failed",
            })
        );
        assert_eq!(
            terminal_observability_classification("provider_cancelled"),
            Some(TerminalObservabilityClassification {
                failure_class: "cancellation",
                stage: "provider",
                signal: "provider_cancelled",
            })
        );
        assert_eq!(
            terminal_observability_classification(
                TerminalSessionReason::ToolExecutorFailure.as_str()
            ),
            Some(TerminalObservabilityClassification {
                failure_class: "tool_executor_failure",
                stage: "tools",
                signal: "tool_executor_failure",
            })
        );
        assert_eq!(
            terminal_observability_classification("turn_cap"),
            Some(TerminalObservabilityClassification {
                failure_class: "turn_cap",
                stage: "session",
                signal: "turn_cap",
            })
        );
        assert_eq!(
            terminal_observability_classification("study_set_access_denied"),
            Some(TerminalObservabilityClassification {
                failure_class: "pre_loop_unavailable",
                stage: "pre_loop",
                signal: "pre_loop_unavailable",
            })
        );
        assert_eq!(
            terminal_observability_classification("study_store_unavailable"),
            Some(TerminalObservabilityClassification {
                failure_class: "pre_loop_unavailable",
                stage: "pre_loop",
                signal: "pre_loop_unavailable",
            })
        );
        assert_eq!(
            terminal_observability_classification("first_frame_timeout"),
            Some(TerminalObservabilityClassification {
                failure_class: "session_bootstrap_unavailable",
                stage: "startup",
                signal: "session_bootstrap_unavailable",
            })
        );
        assert_eq!(
            terminal_observability_classification("agent_input_closed"),
            Some(TerminalObservabilityClassification {
                failure_class: "network_disconnect",
                stage: "transport",
                signal: "agent_input_closed",
            })
        );
        assert_eq!(
            terminal_observability_classification("invalid_session_token"),
            Some(TerminalObservabilityClassification {
                failure_class: "session_auth_failure",
                stage: "session_auth",
                signal: "session_auth_rejected",
            })
        );
        assert_eq!(
            terminal_observability_classification("session_token_nonce_store_unavailable"),
            Some(TerminalObservabilityClassification {
                failure_class: "session_auth_failure",
                stage: "session_auth",
                signal: "session_auth_rejected",
            })
        );
        assert_eq!(
            terminal_observability_classification("durability_degraded"),
            Some(TerminalObservabilityClassification {
                failure_class: "durability_degraded",
                stage: "store",
                signal: "durability_degraded",
            })
        );
        assert_eq!(
            terminal_observability_classification("closed_before_config"),
            None
        );
        assert_eq!(terminal_observability_classification("completed"), None);
    }

    #[test]
    fn pending_evaluation_observability_uses_dedicated_terminal_reason() {
        assert_eq!(pending_evaluation_terminal_reason(), "pending_evaluation");
        assert_ne!(
            pending_evaluation_terminal_reason(),
            "provider_rate_limited"
        );
        assert_ne!(pending_evaluation_terminal_reason(), "provider_timeout");
    }

    #[test]
    fn terminal_observability_model_uses_provider_suffix() {
        assert_eq!(
            observability_model_with("cartesia_gemini", |_| None),
            "cartesia_gemini-viva"
        );
    }

    #[test]
    fn terminal_observability_model_uses_configured_cartesia_gemini_model() {
        assert_eq!(
            observability_model_with("cartesia_gemini", |name| match name {
                "GEMINI_MODEL" => Some(" gemini-live-primary ".to_owned()),
                "GEMINI_REALTIME_MODEL" => Some("gemini-live-secondary".to_owned()),
                _ => None,
            }),
            "gemini-live-primary"
        );
        assert_eq!(
            observability_model_with("cartesia_gemini", |name| match name {
                "GEMINI_REALTIME_MODEL" => Some("gemini-live-secondary".to_owned()),
                _ => None,
            }),
            "gemini-live-secondary"
        );
        assert_eq!(
            observability_model_with("synthetic", |name| {
                (name == "GEMINI_MODEL").then(|| "ignored".to_owned())
            }),
            "synthetic-viva"
        );
    }

    #[test]
    fn failure_control_provider_message_includes_scenario_and_stage_marker() {
        let error = failure_control_provider_error(FailureControlScenario::SonicTtsTimeout);

        assert!(error.message.contains("timeout"));
        assert!(error.message.contains("scenario=sonic_tts_timeout"));
        assert!(error.message.contains("stage=sonic_tts"));
        // The terminal reason comes from the declared class, not from that message.
        assert_eq!(
            terminal_reason_for_provider_error(&error),
            TerminalSessionReason::ProviderTimeout
        );
    }

    #[tokio::test]
    async fn user_study_set_acquire_waits_for_reconnect_lease_release() {
        let limits = crate::app::VoiceLimitState::default();
        let held = limits
            .try_acquire_user_study_set("user-1", "biology-midterm", 1)
            .unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            drop(held);
        });

        let lease = acquire_user_study_set_with_reconnect_grace(
            &limits,
            "user-1",
            "biology-midterm",
            1,
            Duration::from_millis(250),
        )
        .await;

        release.await.unwrap();
        assert!(lease.is_some());
    }

    #[tokio::test]
    async fn user_study_set_acquire_still_rejects_live_duplicate_after_reconnect_grace() {
        let limits = crate::app::VoiceLimitState::default();
        let _held = limits
            .try_acquire_user_study_set("user-1", "biology-midterm", 1)
            .unwrap();

        let lease = acquire_user_study_set_with_reconnect_grace(
            &limits,
            "user-1",
            "biology-midterm",
            1,
            Duration::from_millis(25),
        )
        .await;

        assert!(lease.is_none());
    }

    #[test]
    fn provider_error_stage_metadata_overrides_message_classifier() {
        let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::ToolExecutorFailure,
                stage: BrainFailureStage::Tools,
                retry_eligible: true,
                latency_ms: 12,
                provider: "server".to_owned(),
                model: "viva-tools".to_owned(),
                metadata: "tool=retrieve_source_reference error_kind=store".to_owned(),
            },
        ));

        assert_eq!(
            terminal_reason_for_provider_error(&error),
            TerminalSessionReason::ToolExecutorFailure
        );
        assert!(!error.message.contains("retrieve_source_reference"));
    }

    #[test]
    fn structured_durability_provider_error_uses_durability_path_classifier() {
        let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::DurabilityDegraded,
                stage: BrainFailureStage::Tools,
                retry_eligible: true,
                latency_ms: 12,
                provider: "server".to_owned(),
                model: "viva-tools".to_owned(),
                metadata: "tool=retrieve_source_reference error_kind=store".to_owned(),
            },
        ));
        assert!(provider_error_is_durability_degraded_for_store(
            true, &error
        ));
        assert!(!provider_error_is_durability_degraded_for_store(
            false, &error
        ));
    }

    #[tokio::test]
    async fn structured_durability_provider_error_records_stage_failure_before_return() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://postgres:postgres@127.0.0.1:1/viva_test")
            .unwrap();
        let state_store: Arc<dyn agent_domain::StudyMemoryStore> =
            Arc::new(data::PostgresStudyStore::new(pool));
        let state = AppState::with_study_store(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
            state_store,
        );
        let binding = fixture_binding();
        let limits = VoiceLimitConfig::default();
        let mut session_limits = SessionLimitRuntime::new();
        let mut turn_bindings = TurnBindingTracker::default();
        let mut context = BrainForwardContext {
            state: &state,
            voice_session_id: Some("voice-session-1".to_owned()),
            session_binding: &binding,
            limits: &limits,
            session_limits: &mut session_limits,
            turn_bindings: &mut turn_bindings,
        };
        let mut cancelled_responses = CancelledResponseTracker::default();
        let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));
        let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::DurabilityDegraded,
                stage: BrainFailureStage::Recap,
                retry_eligible: true,
                latency_ms: 37,
                provider: "server".to_owned(),
                model: "viva-tools".to_owned(),
                metadata: "tool=build_session_recap error_kind=store".to_owned(),
            },
        ));

        let result = forward_brain_event(
            &mut context,
            agent_domain::BrainEvent::Error(error),
            &mut cancelled_responses,
            Duration::from_millis(37),
            &mut sender,
        )
        .await
        .unwrap();

        assert_eq!(result, ForwardBrainEvent::DurabilityDegraded);
        assert!(sender.inner.sent.is_empty());
        let evidence = state.evidence.snapshot();
        assert!(evidence.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::ProviderStageFailure
                && event.detail.contains("failure_class=durability_degraded")
                && event.detail.contains("stage=recap")
                && event.detail.contains("terminal_reason=durability_degraded")
                && event.detail.contains("latency_ms=37")
                && event.detail.contains("tool=build_session_recap")
                && event.detail.contains("error_kind=store")
        }));
        assert!(evidence.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::StoreCounts
                && event.detail == "durability_degraded"
        }));
    }

    #[test]
    fn provider_stage_failure_evidence_keeps_core_and_retry_metadata_before_truncation() {
        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 123,
                provider: "gemini".to_owned(),
                model: "gemini-35-flash".to_owned(),
                metadata:
                    "http_status=429 retry_after_ms=7000 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=unknown deploy_sha=abcdef1234567890abcdef1234567890abcdef12"
                        .to_owned(),
            },
        ));

        record_provider_stage_failure(&state, Some("voice-session-1".to_owned()), &error);

        let events = state.evidence.snapshot();
        assert_eq!(events.len(), 1);
        let detail = &events[0].detail;
        assert!(detail.len() <= PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS);
        assert!(detail.contains("failure_class=quota_rate_failure"));
        assert!(detail.contains("stage=gemini"));
        assert!(detail.contains("terminal_reason=provider_rate_limited"));
        assert!(detail.contains("provider=gemini"));
        assert!(detail.contains("model=gemini-35-flash"));
        assert!(detail.contains("latency_ms=123"));
        assert!(detail.contains("deploy_sha=abcdef12"));
        assert!(detail.contains("retry_after_ms=7000"));
        assert!(detail.contains("retry_after_source=retry_after_delta"));
        assert!(
            detail.contains("reset_hint=2030-01-01T00:00:00Z"),
            "{detail}"
        );
        assert!(detail.contains("budget_state=unknown"), "{detail}");
    }

    #[test]
    fn provider_stage_failure_evidence_keeps_provider_model_with_long_metadata() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 123,
                provider: "gemini".to_owned(),
                model: "gemini-35-flash-preview-long-sanitized-model-identifier-long-sanitized-model-identifier-long-tail"
                    .to_owned(),
                metadata:
                    "http_status=429 retry_after_ms=7000 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=unknown deploy_sha=unknown"
                        .to_owned(),
            },
        ));

        record_provider_stage_failure(&state, Some("voice-session-1".to_owned()), &error);

        let events = state.evidence.snapshot();
        assert_eq!(events.len(), 1);
        let detail = &events[0].detail;
        assert!(detail.len() <= PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS);
        assert!(detail.contains("failure_class=quota_rate_failure"));
        assert!(detail.contains("stage=gemini"));
        assert!(detail.contains("terminal_reason=provider_rate_limited"));
        assert!(detail.contains("provider=gemini"));
        assert!(detail.contains("model=gemini-35-flash-preview-long-san"));
        assert!(detail.contains("latency_ms=123"));
        assert!(detail.contains("deploy_sha=unknown"));
        assert!(detail.contains("retry_after_ms=7000"));
        assert!(detail.contains("retry_after_source=retry_after_delta"));
        assert!(
            detail.contains("reset_hint=2030-01-01T00:00:00Z"),
            "{detail}"
        );
        assert!(detail.contains("budget_state=unknown"), "{detail}");
    }

    #[test]
    fn provider_turn_completion_uses_answer_evaluation_signal() {
        let question = agent_domain::fixture_question();
        let mut evaluation_value = serde_json::Map::new();
        evaluation_value.insert("question_id".to_owned(), json!(question.question_id));
        evaluation_value.insert(["answer", "text"].join("_"), json!("omitted"));
        evaluation_value.insert("label".to_owned(), json!("mostly correct"));
        evaluation_value.insert("concise_feedback".to_owned(), json!("omitted"));
        evaluation_value.insert("retry_prompt".to_owned(), json!("omitted"));
        evaluation_value.insert("source".to_owned(), json!(question.source));
        evaluation_value.insert("concept_status".to_owned(), json!("strong"));
        evaluation_value.insert("confidence_score".to_owned(), json!(0.84));
        let evaluation: agent_domain::AnswerEvaluation =
            serde_json::from_value(serde_json::Value::Object(evaluation_value)).unwrap();
        let answer_evaluated = BrainEvent::AnswerEvaluated {
            response_id: "response-1".to_owned(),
            evaluation,
        };
        assert_eq!(
            classify_provider_turn_event(&answer_evaluated),
            Some(ProviderTurnResolution::One {
                response_id: Some("response-1".to_owned())
            })
        );

        let response_completed = BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned(),
        };
        assert_eq!(
            classify_provider_turn_event(&response_completed),
            Some(ProviderTurnResolution::One {
                response_id: Some("response-1".to_owned())
            })
        );

        let terminal_phase = BrainEvent::TerminalSessionPhase {
            phase: agent_domain::StudySessionPhase::Recap,
            terminal_reason: TerminalSessionReason::ProviderCancelled,
        };
        assert_eq!(
            classify_provider_turn_event(&terminal_phase),
            Some(ProviderTurnResolution::All)
        );
    }

    /// Recorded gate-check: `should_suppress_superseded_recap` versus Plan 07's
    /// one-recap-on-stop.
    ///
    /// DISPOSITION — no collision in the live runtime. Plan 07 emits the stop
    /// recap under a dedicated turn-0 response identity
    /// (`SyntheticStudySessionSpec::response_id(0)`), which is never an admitted
    /// provider turn, therefore never enters `completed_provider_turn_response_ids`,
    /// therefore can never enter `superseded_provider_turn_response_ids`. The
    /// suppression rule cannot reach it.
    ///
    /// ESCALATED — Plan 05's frozen `v5/synthetic-two-turn-session.json` binds its
    /// `recap_ready` to `response-1`, the same response the fixture cancels and
    /// evaluates. On a live socket that recap is suppressed twice over: once by
    /// `should_suppress_cancelled_response` (its response was cancelled) and again
    /// by `should_suppress_superseded_recap` once a later turn is admitted. That is
    /// a fixture/runtime disagreement, not something this service may paper over by
    /// weakening either rule, so it is reported to the fixture owner rather than
    /// improvised around here.
    #[test]
    fn stop_recap_identity_is_out_of_reach_of_superseded_recap_suppression() {
        let recap = agent_domain::StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Session recap".to_owned(),
            summary: "Review oxidative phosphorylation.".to_owned(),
            concepts: vec![],
            review_schedule: vec![],
            next_action: "Review the source moment.".to_owned(),
            source_moments: vec![],
            deferred_turns: 0,
        };

        // The turn-0 identity Plan 07's stop recap uses.
        let stop_recap = BrainEvent::RecapReady {
            response_id: "response-0-generation-viva-session-bootstrap-1".to_owned(),
            recap: recap.clone(),
        };
        // Every answered turn of the session, completed and then superseded.
        let mut completed = HashSet::new();
        completed.insert("response-1-generation-viva-session-bootstrap-1".to_owned());
        completed.insert("response-2-generation-viva-session-bootstrap-1".to_owned());
        let mut superseded = HashSet::new();
        mark_completed_provider_turns_superseded(&completed, &mut superseded);

        assert!(
            !should_suppress_superseded_recap(&stop_recap, &superseded),
            "the stop recap's turn-0 identity is never one of the superseded turns"
        );

        // The fixture's shape, recorded as the escalation it is: a recap bound to
        // an answered turn that was cancelled and then superseded.
        let fixture_shaped_recap = BrainEvent::RecapReady {
            response_id: "response-1-generation-viva-session-bootstrap-1".to_owned(),
            recap,
        };
        assert!(
            should_suppress_superseded_recap(&fixture_shaped_recap, &superseded),
            "a recap bound to a superseded answered turn is suppressed"
        );
        let mut cancelled = CancelledResponseTracker::default();
        assert!(!should_suppress_cancelled_response(
            &mut cancelled,
            &BrainEvent::ResponseCancelledFor {
                response_id: "response-1-generation-viva-session-bootstrap-1".to_owned(),
            }
        ));
        assert!(
            should_suppress_cancelled_response(&mut cancelled, &fixture_shaped_recap),
            "a recap bound to a cancelled response is already suppressed before the \
             superseded rule is consulted"
        );
    }

    #[test]
    fn superseded_recap_suppression_uses_response_identity_not_active_turn_count() {
        let recap = agent_domain::StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Session recap".to_owned(),
            summary: "Review oxidative phosphorylation.".to_owned(),
            concepts: vec![],
            review_schedule: vec![],
            next_action: "Review the source moment.".to_owned(),
            source_moments: vec![],
            deferred_turns: 0,
        };
        let stale_recap = BrainEvent::RecapReady {
            response_id: "response-a".to_owned(),
            recap: recap.clone(),
        };
        let current_recap = BrainEvent::RecapReady {
            response_id: "response-b".to_owned(),
            recap,
        };
        let mut completed = HashSet::new();
        completed.insert("response-a".to_owned());
        let mut superseded = HashSet::new();

        mark_completed_provider_turns_superseded(&completed, &mut superseded);

        assert!(should_suppress_superseded_recap(&stale_recap, &superseded));
        assert!(!should_suppress_superseded_recap(
            &current_recap,
            &superseded
        ));
    }

    // ---------------------------------------------------------------------
    // Task 8 (SERVICE-001, SERVICE-006, SERVICE-014): one classifier, durable
    // deferred-turn mapping, and between-turn idle rearm.
    // ---------------------------------------------------------------------

    fn classifier_fixture_recap() -> StudySessionRecap {
        StudySessionRecap {
            schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            headline: "Session recap".to_owned(),
            summary: "Review oxidative phosphorylation.".to_owned(),
            concepts: vec![],
            review_schedule: vec![],
            next_action: "Review the source moment.".to_owned(),
            source_moments: vec![],
            deferred_turns: 0,
        }
    }

    fn classifier_fixture_evaluation() -> agent_domain::AnswerEvaluation {
        agent_domain::AnswerEvaluation {
            question_id: fixture_question().question_id,
            answer_text: "omitted".to_owned(),
            label: "mostly correct".to_owned(),
            concise_feedback: "omitted".to_owned(),
            retry_prompt: "omitted".to_owned(),
            source: agent_domain::fixture_source_reference(),
            concept_status: agent_domain::ConceptStatus::Strong,
            confidence_score: 0.84,
        }
    }

    fn classifier_fixture_failure() -> BrainProviderFailure {
        BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::Timeout,
            stage: BrainFailureStage::Gemini,
            retry_eligible: true,
            latency_ms: 7,
            provider: "gemini".to_owned(),
            model: "gemini-35-flash".to_owned(),
            metadata: "http_status=504".to_owned(),
        })
    }

    fn resolved_one(response_id: &str) -> Option<ProviderTurnResolution> {
        Some(ProviderTurnResolution::One {
            response_id: Some(response_id.to_owned()),
        })
    }

    /// One constructed event for every currently named `BrainEvent` variant plus
    /// its exact expected resolution. `BrainEvent` is `#[non_exhaustive]`, so this
    /// table is the lane's record of what "every current variant" means; a new
    /// upstream variant is classified `None` by the final arm until its owner
    /// names it here.
    fn every_named_brain_event() -> Vec<(&'static str, BrainEvent, Option<ProviderTurnResolution>)>
    {
        vec![
            (
                "SessionPhase",
                BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Listening,
                },
                None,
            ),
            (
                "TerminalSessionPhase",
                BrainEvent::TerminalSessionPhase {
                    phase: StudySessionPhase::Recap,
                    terminal_reason: TerminalSessionReason::ProviderCancelled,
                },
                Some(ProviderTurnResolution::All),
            ),
            (
                "QuestionStarted",
                BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: fixture_question(),
                },
                None,
            ),
            (
                "TranscriptDelta",
                BrainEvent::TranscriptDelta {
                    response_id: "response-1".to_owned(),
                    text: "omitted".to_owned(),
                },
                None,
            ),
            (
                "AnswerEvaluated",
                BrainEvent::AnswerEvaluated {
                    response_id: "response-1".to_owned(),
                    evaluation: classifier_fixture_evaluation(),
                },
                resolved_one("response-1"),
            ),
            (
                "TurnDeferred",
                BrainEvent::TurnDeferred {
                    response_id: "response-1".to_owned(),
                    question_id: "question-1".to_owned(),
                    reason: agent_domain::EvaluationDeferralReason::EmptyAnswer,
                    can_retry_same_question: true,
                },
                resolved_one("response-1"),
            ),
            (
                "SourceReference",
                BrainEvent::SourceReference {
                    response_id: "response-1".to_owned(),
                    source: agent_domain::fixture_source_reference(),
                },
                None,
            ),
            (
                "ConceptStatus",
                BrainEvent::ConceptStatus {
                    response_id: "response-1".to_owned(),
                    concept_id: "oxidative-phosphorylation".to_owned(),
                    status: agent_domain::ConceptStatus::Review,
                },
                None,
            ),
            (
                "ManuscriptIntent",
                BrainEvent::ManuscriptIntent {
                    response_id: "response-1".to_owned(),
                    intent: agent_domain::ManuscriptIntent::Scene {
                        register: agent_domain::ManuscriptRegister::Examining,
                        emphasis: agent_domain::ManuscriptEmphasis::Measured,
                    },
                },
                None,
            ),
            (
                "RecapReady",
                BrainEvent::RecapReady {
                    response_id: "response-1".to_owned(),
                    recap: classifier_fixture_recap(),
                },
                resolved_one("response-1"),
            ),
            (
                "AudioDelta",
                BrainEvent::AudioDelta {
                    response_id: "response-1".to_owned(),
                    frame: AudioFrame::from_pcm16_bytes(vec![0, 0]),
                },
                None,
            ),
            (
                "ResponseStarted",
                BrainEvent::ResponseStarted {
                    response_id: "response-1".to_owned(),
                },
                None,
            ),
            (
                "ResponseCompleted",
                BrainEvent::ResponseCompleted {
                    response_id: "response-1".to_owned(),
                },
                resolved_one("response-1"),
            ),
            (
                "ResponseAudio",
                BrainEvent::ResponseAudio {
                    response_id: "response-1".to_owned(),
                    frame: AudioFrame::from_pcm16_bytes(vec![0, 0]),
                },
                None,
            ),
            (
                "Transcript",
                BrainEvent::Transcript("omitted".to_owned()),
                None,
            ),
            (
                "ResponseToolProposal",
                BrainEvent::ResponseToolProposal {
                    response_id: "response-1".to_owned(),
                    proposal: agent_domain::ToolProposal::new("select_next_question", json!({})),
                },
                None,
            ),
            (
                "Usage",
                BrainEvent::Usage(agent_domain::BrainUsage::default()),
                None,
            ),
            (
                "ProviderFallbackActivated",
                BrainEvent::ProviderFallbackActivated {
                    response_id: "response-1".to_owned(),
                    provider: "gemini".to_owned(),
                    from_model: "gemini-35-flash".to_owned(),
                    to_model: "gemini-35-flash-lite".to_owned(),
                    reason: "quota_rate_failure".to_owned(),
                    failure: Some(classifier_fixture_failure()),
                },
                None,
            ),
            (
                "Error",
                BrainEvent::Error(BrainProviderError::from_failure(
                    classifier_fixture_failure(),
                )),
                None,
            ),
            (
                "SpeechIntent",
                BrainEvent::SpeechIntent(agent_domain::SpeechIntent {
                    text: "omitted".to_owned(),
                }),
                None,
            ),
            ("InputSpeechStarted", BrainEvent::InputSpeechStarted, None),
            ("InputSpeechStopped", BrainEvent::InputSpeechStopped, None),
            (
                "ResponseCancelled",
                BrainEvent::ResponseCancelled,
                Some(ProviderTurnResolution::One { response_id: None }),
            ),
            (
                "ResponseCancelledFor",
                BrainEvent::ResponseCancelledFor {
                    response_id: "response-1".to_owned(),
                },
                resolved_one("response-1"),
            ),
            (
                "ResponseTranscriptDelta",
                BrainEvent::ResponseTranscriptDelta {
                    response_id: "response-1".to_owned(),
                    text: "omitted".to_owned(),
                },
                None,
            ),
            (
                "ResponseTextStarted",
                BrainEvent::ResponseTextStarted {
                    response_id: "response-1".to_owned(),
                },
                None,
            ),
            (
                "TranscriptFinal",
                BrainEvent::TranscriptFinal {
                    response_id: "response-1".to_owned(),
                    text: "omitted".to_owned(),
                    confidence: Some(0.9),
                },
                None,
            ),
        ]
    }

    struct ProviderTurnAccounting {
        pending_submitted_answers: u32,
        active_provider_turns: u32,
        pending_provider_admissions: Vec<VoiceLimitLease>,
        resolved_submitted_answer_response_ids: HashSet<String>,
        completed_provider_turn_response_ids: HashSet<String>,
        superseded_provider_turn_response_ids: HashSet<String>,
        turn_cap_deadline: Option<Instant>,
    }

    impl ProviderTurnAccounting {
        fn with_one_open_turn() -> Self {
            Self {
                pending_submitted_answers: 1,
                active_provider_turns: 1,
                pending_provider_admissions: Vec::new(),
                resolved_submitted_answer_response_ids: HashSet::new(),
                completed_provider_turn_response_ids: HashSet::new(),
                superseded_provider_turn_response_ids: HashSet::new(),
                turn_cap_deadline: Some(Instant::now() + Duration::from_secs(45)),
            }
        }

        fn apply(&mut self, event: &BrainEvent) {
            let resolution = classify_provider_turn_event(event);
            let mut runtime = ProviderTurnRuntime {
                pending_submitted_answers: &mut self.pending_submitted_answers,
                active_provider_turns: &mut self.active_provider_turns,
                pending_provider_admissions: &mut self.pending_provider_admissions,
                resolved_submitted_answer_response_ids: &mut self
                    .resolved_submitted_answer_response_ids,
                completed_provider_turn_response_ids: &mut self
                    .completed_provider_turn_response_ids,
                superseded_provider_turn_response_ids: &mut self
                    .superseded_provider_turn_response_ids,
                turn_cap_deadline: &mut self.turn_cap_deadline,
            };
            apply_provider_turn_accounting(resolution, &mut runtime);
        }
    }

    #[test]
    fn provider_turn_classifier_maps_every_named_brain_event_exactly_once() {
        for (name, event, expected) in every_named_brain_event() {
            assert_eq!(
                classify_provider_turn_event(&event),
                expected,
                "{name} classified differently than the single mapping declares"
            );
        }
    }

    /// `SERVICE-006`: both counters consume the same returned value. `TurnDeferred`
    /// is the discriminating case — the two pre-remediation classifiers each
    /// ignored it, so a surviving second classifier leaves one counter behind.
    #[test]
    fn provider_turn_classifier_feeds_both_counters_from_one_value() {
        for (name, event, expected) in every_named_brain_event() {
            let mut accounting = ProviderTurnAccounting::with_one_open_turn();
            accounting.apply(&event);
            let (expected_pending, expected_active) = match &expected {
                None => (1, 1),
                Some(_) => (0, 0),
            };
            assert_eq!(
                accounting.pending_submitted_answers, expected_pending,
                "{name} left the submitted-answer counter behind"
            );
            assert_eq!(
                accounting.active_provider_turns, expected_active,
                "{name} left the active-provider-turn counter behind"
            );
        }
    }

    #[test]
    fn provider_turn_classifier_resolves_a_duplicate_delivery_once() {
        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        accounting.pending_submitted_answers = 2;
        accounting.active_provider_turns = 2;
        let completed = BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned(),
        };

        accounting.apply(&completed);
        accounting.apply(&completed);

        assert_eq!(accounting.pending_submitted_answers, 1);
        assert_eq!(accounting.active_provider_turns, 1);
    }

    #[test]
    fn provider_turn_classifier_terminal_phase_clears_every_open_turn() {
        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        accounting.pending_submitted_answers = 3;
        accounting.active_provider_turns = 3;

        accounting.apply(&BrainEvent::TerminalSessionPhase {
            phase: StudySessionPhase::Recap,
            terminal_reason: TerminalSessionReason::Drained,
        });

        assert_eq!(accounting.pending_submitted_answers, 0);
        assert_eq!(accounting.active_provider_turns, 0);
        assert_eq!(accounting.turn_cap_deadline, None);
    }

    fn deferred_event(
        response_id: &str,
        question_id: &str,
        reason: agent_domain::EvaluationDeferralReason,
        can_retry_same_question: bool,
    ) -> BrainEvent {
        BrainEvent::TurnDeferred {
            response_id: response_id.to_owned(),
            question_id: question_id.to_owned(),
            reason,
            can_retry_same_question,
        }
    }

    fn bound_tracker(pairs: &[(&str, &str)]) -> TurnBindingTracker {
        let mut tracker = TurnBindingTracker::default();
        for (turn_id, response_id) in pairs {
            tracker
                .register_submission((*turn_id).to_owned())
                .expect("submission registers");
            tracker.bind_question(response_id).expect("question binds");
        }
        tracker
    }

    #[test]
    fn turn_deferred_binding_maps_sequential_and_overlapping_submissions() {
        let mut tracker = TurnBindingTracker::default();
        tracker.register_submission("turn-1".to_owned()).unwrap();
        tracker.register_submission("turn-2".to_owned()).unwrap();

        assert_eq!(tracker.bind_question("response-1").unwrap(), "turn-1");
        assert_eq!(tracker.bind_question("response-2").unwrap(), "turn-2");
        assert_eq!(tracker.turn_for_response("response-1").unwrap(), "turn-1");
        assert_eq!(tracker.turn_for_response("response-2").unwrap(), "turn-2");
    }

    #[test]
    fn turn_deferred_binding_rejects_duplicate_turn_and_response_ids() {
        let mut tracker = TurnBindingTracker::default();
        tracker.register_submission("turn-1".to_owned()).unwrap();
        assert_eq!(
            tracker.register_submission("turn-1".to_owned()),
            Err(TurnBindingError::DuplicateTurn)
        );

        tracker.bind_question("response-1").unwrap();
        assert_eq!(
            tracker.register_submission("turn-1".to_owned()),
            Err(TurnBindingError::DuplicateTurn)
        );

        tracker.register_submission("turn-2".to_owned()).unwrap();
        assert_eq!(
            tracker.bind_question("response-1").map(ToOwned::to_owned),
            Err(TurnBindingError::DuplicateResponse)
        );
    }

    #[test]
    fn turn_deferred_binding_requires_a_registered_turn_before_a_question() {
        let mut tracker = TurnBindingTracker::default();
        assert_eq!(
            tracker.bind_question("response-1").map(ToOwned::to_owned),
            Err(TurnBindingError::MissingTurn)
        );
        assert_eq!(
            tracker.turn_for_response("response-1"),
            Err(TurnBindingError::MissingResponse)
        );
    }

    #[test]
    fn turn_deferred_binding_mints_a_canonical_server_turn_for_a_proactive_question() {
        let mut tracker = TurnBindingTracker::default();

        let first = tracker.register_server_turn().expect("first server turn");
        assert_eq!(first, "turn-1");
        assert_eq!(tracker.bind_question("response-1").unwrap(), "turn-1");

        let second = tracker.register_server_turn().expect("second server turn");
        assert_eq!(second, "turn-2");
        assert_eq!(tracker.bind_question("response-2").unwrap(), "turn-2");
    }

    #[test]
    fn turn_deferred_binding_releases_a_response_only_after_its_resolution() {
        let mut tracker = bound_tracker(&[("turn-1", "response-1")]);
        assert_eq!(tracker.turn_for_response("response-1").unwrap(), "turn-1");

        tracker.release_response("response-1");

        assert_eq!(
            tracker.turn_for_response("response-1"),
            Err(TurnBindingError::MissingResponse)
        );
        // The released turn id is spent, not recycled.
        assert_eq!(
            tracker.register_submission("turn-1".to_owned()),
            Err(TurnBindingError::DuplicateTurn)
        );
    }

    #[test]
    fn turn_deferred_maps_an_unknown_response_to_a_protocol_invariant() {
        let bindings = bound_tracker(&[("turn-1", "response-1")]);
        let event = deferred_event(
            "response-unknown",
            "question-1",
            agent_domain::EvaluationDeferralReason::EmptyAnswer,
            true,
        );

        let diagnostic = map_turn_deferred(&event, &bindings).expect_err("unknown response");

        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::Invariant);
        assert_eq!(diagnostic.code.as_str(), "VOICE_PROTOCOL_INVARIANT");
        assert_eq!(diagnostic.path, "$.event.turn_id");
    }

    #[test]
    fn turn_deferred_refuses_to_map_any_other_event() {
        let bindings = bound_tracker(&[("turn-1", "response-1")]);
        let event = BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned(),
        };

        let diagnostic = map_turn_deferred(&event, &bindings).expect_err("wrong event type");

        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::Invariant);
        assert_eq!(diagnostic.path, "$.event.type");
    }

    #[derive(Deserialize)]
    struct TurnOutcomeFixtureCase {
        id: String,
        wire_json: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct TurnOutcomeFixture {
        schema: String,
        protocol_version: u32,
        cases: Vec<TurnOutcomeFixtureCase>,
    }

    /// Plan 05's frozen deferred cases, byte-for-byte. Every one of the six exact
    /// reasons and both retry booleans is mapped through the owner-provided
    /// constructor and re-serialized; the fixture bytes are the assertion.
    #[test]
    fn turn_deferred_fixture_cases_map_byte_for_byte() {
        let fixture: TurnOutcomeFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/turn-outcomes.json"
        ))
        .expect("turn-outcomes fixture parses");
        assert_eq!(fixture.schema, "viva.voice-server-event-cases.v1");
        assert_eq!(fixture.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);

        let mut seen_reasons = HashSet::new();
        let mut seen_retry = HashSet::new();
        let mut mapped = 0_usize;
        for case in &fixture.cases {
            if !case.valid {
                continue;
            }
            let wire: serde_json::Value =
                serde_json::from_str(&case.wire_json).expect("case wire json parses");
            if wire["event"]["type"] != "turn_deferred" {
                continue;
            }
            let turn_id = wire["event"]["turn_id"].as_str().expect("fixture turn_id");
            let response_id = wire["event"]["response_id"]
                .as_str()
                .expect("fixture response_id");
            let question_id = wire["event"]["question_id"]
                .as_str()
                .expect("fixture question_id");
            let reason: agent_domain::EvaluationDeferralReason =
                serde_json::from_value(wire["event"]["reason"].clone())
                    .expect("fixture reason is a typed deferral reason");
            let can_retry_same_question = wire["event"]["can_retry_same_question"]
                .as_bool()
                .expect("fixture can_retry_same_question");

            // Nothing beyond the five typed members may appear on the wire.
            let members = wire["event"]
                .as_object()
                .expect("event object")
                .keys()
                .cloned()
                .collect::<HashSet<_>>();
            assert_eq!(
                members,
                [
                    "type",
                    "turn_id",
                    "response_id",
                    "question_id",
                    "reason",
                    "can_retry_same_question",
                ]
                .into_iter()
                .map(ToOwned::to_owned)
                .collect::<HashSet<_>>(),
                "{} carries a member outside the deferral contract",
                case.id
            );
            for forbidden in [
                "retryable",
                "terminal_reason",
                "message",
                "provider_message",
                "feedback",
                "concise_feedback",
                "confidence",
                "confidence_score",
                "concept_status",
                "review_schedule",
                "schedule",
                "mastery",
                "recap",
            ] {
                assert!(
                    !case.wire_json.contains(forbidden),
                    "{} leaks {forbidden}",
                    case.id
                );
            }

            let event = deferred_event(
                response_id,
                question_id,
                reason.clone(),
                can_retry_same_question,
            );
            let mut bindings = TurnBindingTracker::default();
            bindings
                .register_submission(turn_id.to_owned())
                .expect("fixture turn registers");
            bindings
                .bind_question(response_id)
                .expect("fixture question binds");

            let frame = map_turn_deferred(&event, &bindings).expect("fixture case maps");
            let rendered = serde_json::to_string(&frame).expect("frame serializes");
            assert_eq!(
                rendered, case.wire_json,
                "{} did not map byte-exactly",
                case.id
            );

            seen_reasons.insert(format!("{reason:?}"));
            seen_retry.insert(can_retry_same_question);
            mapped += 1;
        }

        assert_eq!(
            seen_reasons.len(),
            6,
            "every deferral reason must be covered"
        );
        assert_eq!(seen_retry.len(), 2, "both retry booleans must be covered");
        assert_eq!(mapped, 12, "six reasons times two retry booleans");
    }

    #[tokio::test(start_paused = true)]
    async fn between_turn_idle_rearms_only_when_no_turn_is_outstanding() {
        for (pending, active, expected) in [
            (0_u32, 0_u32, true),
            (1, 0, false),
            (0, 1, false),
            (2, 3, false),
        ] {
            let sleeper = tokio::time::sleep(Duration::from_secs(1));
            tokio::pin!(sleeper);
            assert_eq!(
                rearm_between_turn_idle(
                    pending,
                    active,
                    sleeper.as_mut(),
                    Instant::now(),
                    Duration::from_secs(600),
                ),
                expected,
                "pending={pending} active={active}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn between_turn_idle_rearms_after_provider_completion() {
        let start = Instant::now();
        let between_turn_idle = Duration::from_secs(600);
        let sleeper = tokio::time::sleep(between_turn_idle);
        tokio::pin!(sleeper);
        assert_eq!(sleeper.deadline(), start + between_turn_idle);

        // A submitted answer disarms the between-turn deadline.
        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        assert!(!rearm_between_turn_idle(
            accounting.pending_submitted_answers,
            accounting.active_provider_turns,
            sleeper.as_mut(),
            Instant::now(),
            between_turn_idle,
        ));
        assert_eq!(sleeper.deadline(), start + between_turn_idle);

        tokio::time::advance(Duration::from_secs(30)).await;
        accounting.apply(&BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned(),
        });
        assert_eq!(accounting.pending_submitted_answers, 0);
        assert_eq!(accounting.active_provider_turns, 0);
        assert!(rearm_between_turn_idle(
            accounting.pending_submitted_answers,
            accounting.active_provider_turns,
            sleeper.as_mut(),
            Instant::now(),
            between_turn_idle,
        ));
        assert_eq!(sleeper.deadline(), start + Duration::from_secs(630));

        tokio::time::advance(Duration::from_secs(599)).await;
        assert!(!sleeper.is_elapsed(), "t=629 is still inside the deadline");

        tokio::time::advance(Duration::from_secs(1)).await;
        sleeper.as_mut().await;
        assert!(sleeper.is_elapsed(), "t=630 expires the between-turn idle");
    }

    #[tokio::test(start_paused = true)]
    async fn between_turn_idle_is_not_extended_by_keepalives_or_repeated_completion() {
        let start = Instant::now();
        let between_turn_idle = Duration::from_secs(600);
        let sleeper = tokio::time::sleep(between_turn_idle);
        tokio::pin!(sleeper);

        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        accounting.apply(&BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned(),
        });
        assert!(rearm_between_turn_idle(
            accounting.pending_submitted_answers,
            accounting.active_provider_turns,
            sleeper.as_mut(),
            Instant::now(),
            between_turn_idle,
        ));
        let armed_deadline = sleeper.deadline();
        assert_eq!(armed_deadline, start + between_turn_idle);

        tokio::time::advance(Duration::from_secs(100)).await;

        // A repeated completion for the same response resolves nothing, so the
        // deadline is not moved. Ping/Pong and a context-only refresh never reach
        // the classifier at all.
        accounting.apply(&BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned(),
        });
        assert_eq!(
            classify_provider_turn_event(&BrainEvent::SessionPhase {
                phase: StudySessionPhase::Listening,
            }),
            None
        );
        assert_eq!(sleeper.deadline(), armed_deadline);
    }

    #[tokio::test(start_paused = true)]
    async fn between_turn_idle_rearms_after_cancel_and_after_all_turns_complete() {
        let between_turn_idle = Duration::from_secs(600);
        for event in [
            BrainEvent::ResponseCancelled,
            BrainEvent::ResponseCancelledFor {
                response_id: "response-1".to_owned(),
            },
            BrainEvent::TerminalSessionPhase {
                phase: StudySessionPhase::Recap,
                terminal_reason: TerminalSessionReason::ProviderCancelled,
            },
        ] {
            let sleeper = tokio::time::sleep(Duration::from_secs(1));
            tokio::pin!(sleeper);
            let mut accounting = ProviderTurnAccounting::with_one_open_turn();
            accounting.apply(&event);
            let now = Instant::now();
            assert!(
                rearm_between_turn_idle(
                    accounting.pending_submitted_answers,
                    accounting.active_provider_turns,
                    sleeper.as_mut(),
                    now,
                    between_turn_idle,
                ),
                "{event:?} must return the socket to the between-turn deadline"
            );
            assert_eq!(sleeper.deadline(), now + between_turn_idle);
        }
    }

    #[tokio::test]
    async fn local_open_connection_failure_does_not_record_provider_backoff() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        // A store-stage failure at open is a local durability problem, not evidence
        // about the provider.
        let error =
            BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
                failure_class: BrainFailureClass::Timeout,
                stage: BrainFailureStage::Store,
                retry_eligible: false,
                latency_ms: 0,
                provider: "synthetic".to_owned(),
                model: String::new(),
                metadata: "error_kind=voice_session_write_failed".to_owned(),
            }));
        assert_eq!(
            terminal_reason_for_brain_error(&error),
            TerminalSessionReason::ProviderTimeout
        );

        record_brain_open_provider_failure(&state, Some("voice-session-1".to_owned()), &error);
        let admission = state
            .limit_state
            .try_admit_provider_turn(&state.voice_limits, ProviderQueueBehavior::Wait)
            .await;

        assert!(
            matches!(admission.decision, ProviderAdmissionDecision::Admitted),
            "local open failures must not poison provider backoff"
        );
    }

    #[tokio::test]
    async fn provider_open_connection_failure_records_provider_backoff() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let error =
            BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
                failure_class: BrainFailureClass::Timeout,
                stage: BrainFailureStage::Gemini,
                retry_eligible: false,
                latency_ms: 0,
                provider: "synthetic".to_owned(),
                model: String::new(),
                metadata: String::new(),
            }));
        assert_eq!(
            terminal_reason_for_brain_error(&error),
            TerminalSessionReason::ProviderTimeout
        );

        record_brain_open_provider_failure(&state, Some("voice-session-1".to_owned()), &error);
        let admission = state
            .limit_state
            .try_admit_provider_turn(&state.voice_limits, ProviderQueueBehavior::Wait)
            .await;

        assert!(
            matches!(admission.decision, ProviderAdmissionDecision::Denied(_)),
            "provider open failures must poison provider backoff"
        );
    }

    #[tokio::test]
    async fn queued_provider_admission_drop_releases_waiter() {
        let limit_state = crate::app::VoiceLimitState::default();
        let limits = VoiceLimitConfig {
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        };
        let held = limit_state
            .try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait)
            .await
            .lease
            .expect("first admission should hold the only provider slot");
        let client_input = ClientInputAction::Send {
            brain_input: BrainInput::TextWithMetadata {
                text: "omitted".to_owned(),
                client_generation_id: Some("queued-input".to_owned()),
            },
            action: ClientAction::AnswerText,
            turn_id: Some("queued-turn".to_owned()),
        };
        let mut queued = start_provider_admission(
            limit_state.clone(),
            limits.clone(),
            client_input,
            ProviderQueueBehavior::Wait,
        );

        assert!(
            timeout(Duration::from_millis(25), &mut queued)
                .await
                .is_err(),
            "queued admission should wait while the provider slot is held"
        );
        drop(queued);
        drop(held);

        let fresh = timeout(
            Duration::from_millis(50),
            limit_state.try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait),
        )
        .await
        .expect("dropping queued socket admission should release its queue waiter");
        assert!(matches!(
            fresh.decision,
            ProviderAdmissionDecision::Admitted
        ));
        assert_eq!(fresh.queue_depth, 0);
    }

    struct FailingSink;

    impl futures_util::Sink<Message> for FailingSink {
        type Error = axum::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Err(axum::Error::new(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "writer closed",
            )))
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    struct RecordingSink {
        sent: Vec<Message>,
    }

    impl RecordingSink {
        fn new() -> Self {
            Self { sent: vec![] }
        }
    }

    impl futures_util::Sink<Message> for RecordingSink {
        type Error = axum::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.sent.push(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn maps_versioned_audio_text_and_cancel_frames_to_brain_inputs() {
        let (input, mut received) = mpsc::channel(8);
        let audio_chunk = include_str!("../../../fixtures/voice-protocol/client-audio.json");
        let binding = fixture_binding();
        let mut audio_assembly = AudioTurnAssembly::default();

        assert_eq!(
            handle_client_message(
                Message::Text(audio_chunk.to_owned().into()),
                &input,
                &binding,
                &mut audio_assembly,
            )
            .await
            .unwrap(),
            ClientAction::AudioChunk
        );
        handle_client_message(
            Message::Text(
                json!({
                    "type": "audio_end",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "1",
                    "turn_id": "turn-1",
                    "final_sequence": 0,
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(
                json!({
                    "type": "turn_intent",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "1",
                    "turn_id": "turn-2",
                    "intent": { "kind": "answer_text", "text": "quiz me" },
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(
                json!({
                    "type": "cancel",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "1",
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap();

        match received.recv().await.unwrap() {
            BrainInput::AudioWithMetadata {
                frame,
                client_generation_id,
            } => {
                assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]);
                assert_eq!(client_generation_id.as_deref(), Some("1"));
            }
            other => panic!("expected one assembled audio input, got {other:?}"),
        }
        match received.recv().await.unwrap() {
            BrainInput::TextWithMetadata {
                text,
                client_generation_id,
            } => {
                assert_eq!(text, "quiz me");
                assert_eq!(client_generation_id.as_deref(), Some("1"));
            }
            other => panic!("expected text input, got {other:?}"),
        }
        assert!(matches!(
            received.recv().await.unwrap(),
            BrainInput::CancelResponse
        ));
    }

    #[test]
    fn preserves_initial_session_config_generation_metadata() {
        let initial = initial_session_config_from_message(Message::Text(
            json!({
                "type": "session_config",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "session": {
                    "session_id": "voice-session-1",
                    "user_id": "user-1",
                    "study_set_id": "biology-midterm",
                    "source_context": [],
                    "active_concepts": [],
                },
                "session_token": "placeholder-session-material",
                "client_generation_id": "token_refresh-3",
            })
            .to_string()
            .into(),
        ))
        .unwrap();

        assert_eq!(initial.client_generation_id, "token_refresh-3");
        assert_eq!(initial.session_token, "placeholder-session-material");
        assert_eq!(initial.session.client_generation_id, None);
    }

    #[tokio::test]
    async fn maps_client_generation_ids_to_brain_inputs() {
        let (input, mut received) = mpsc::channel(8);
        let binding = fixture_binding();
        let mut audio_assembly = AudioTurnAssembly::default();

        handle_client_message(
            Message::Text(
                json!({
                    "type": "turn_intent",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "bfcache_restore-2",
                    "turn_id": "turn-00",
                    "intent": { "kind": "answer_text", "text": "quiz me" },
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(
                json!({
                    "type": "audio_chunk",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "token_refresh-3",
                    "turn_id": "turn-01",
                    "sequence": 0,
                    "frame": { "pcm16_base64": "AQIDBA==" },
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(
                json!({
                    "type": "audio_end",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "token_refresh-3",
                    "turn_id": "turn-01",
                    "final_sequence": 0,
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap();

        match received.recv().await.unwrap() {
            BrainInput::TextWithMetadata {
                text,
                client_generation_id,
            } => {
                assert_eq!(text, "quiz me");
                assert_eq!(client_generation_id.as_deref(), Some("bfcache_restore-2"));
            }
            other => panic!("expected text input with metadata, got {other:?}"),
        }
        match received.recv().await.unwrap() {
            BrainInput::AudioWithMetadata {
                frame,
                client_generation_id,
            } => {
                assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]);
                assert_eq!(client_generation_id.as_deref(), Some("token_refresh-3"));
            }
            other => panic!("expected audio input with metadata, got {other:?}"),
        }
    }

    #[test]
    fn requires_session_config_as_bootstrap_frame() {
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");
        let message = Message::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"1","session_token":"placeholder-session-material","session":{session}}}"#
            )
            .into(),
        );
        let config = session_config_from_message(message).unwrap();

        assert_eq!(config.study_set_id.as_deref(), Some("biology-midterm"));
        assert!(session_config_from_message(Message::Text(
            json!({
                "type": "turn_intent",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
                "turn_id": "turn-1",
                "intent": { "kind": "answer_text", "text": "quiz me" },
            })
            .to_string()
            .into()
        ))
        .is_err());
    }

    /// The identity comparison a first frame runs, expressed against the binding the
    /// socket produced from it.
    fn sanitize_fixture_config(
        config: SessionConfig,
        binding: &AuthorizedClientSession,
    ) -> Result<SessionConfig, ClientFrameError> {
        sanitize_client_session_config(
            config,
            &binding.user_id,
            &binding.study_set_id,
            &binding.client_session_id,
        )
    }

    #[test]
    fn sanitizes_session_config_identity_and_strips_browser_source_context() {
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");
        let message = Message::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"1","session_token":"placeholder-session-material","session":{session}}}"#
            )
            .into(),
        );
        let config = session_config_from_message(message).unwrap();
        let binding = fixture_binding();
        let sanitized = sanitize_fixture_config(config, &binding).unwrap();

        assert_eq!(sanitized.user_id.as_deref(), Some("user-1"));
        assert_eq!(sanitized.study_set_id.as_deref(), Some("biology-midterm"));
        assert_eq!(sanitized.session_id.as_deref(), Some("voice-session-1"));
        assert!(sanitized.source_context.is_empty());
        assert!(sanitized.active_concepts.is_empty());

        let mut missing_session = sanitized.clone();
        missing_session.session_id = None;
        assert_eq!(
            sanitize_fixture_config(missing_session, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut forged_session = sanitized.clone();
        forged_session.session_id = Some(agent_domain::SessionId::new("voice-session-2"));
        assert_eq!(
            sanitize_fixture_config(forged_session, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut forged_user = sanitized.clone();
        forged_user.user_id = Some("user-2".to_owned());
        assert_eq!(
            sanitize_fixture_config(forged_user, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut forged_study_set = sanitized.clone();
        forged_study_set.study_set_id = Some("chemistry-final".to_owned());
        assert_eq!(
            sanitize_fixture_config(forged_study_set, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut missing_study_set = sanitized;
        missing_study_set.study_set_id = None;
        assert_eq!(
            sanitize_fixture_config(missing_study_set, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );
    }

    #[test]
    fn server_active_concepts_use_public_ids_or_uuid_fallback_in_context_order() {
        let context = serde_json::json!({
            "concepts": [
                {
                    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "public_id": "first-public",
                },
                {
                    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "public_id": null,
                },
                {
                    "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    "public_id": "third-public",
                }
            ]
        });

        assert_eq!(
            server_active_concepts(&context),
            vec![
                "first-public".to_owned(),
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_owned(),
                "third-public".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn rejects_unsupported_protocol_versions() {
        let (input, _received) = mpsc::channel(8);
        let binding = fixture_binding();

        let result = handle_client_message(
            Message::Text(r#"{"type":"text","version":1,"text":"quiz me"}"#.into()),
            &input,
            &binding,
            &mut AudioTurnAssembly::default(),
        )
        .await;

        assert_eq!(result, Err(ClientFrameError::invalid()));
    }

    #[tokio::test]
    async fn rejects_browser_tool_result_frames() {
        let (input, _received) = mpsc::channel(8);
        let binding = fixture_binding();

        let result = handle_client_message(
            Message::Text(
                json!({
                    "type": "tool_result",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "result": {
                        "proposal": {
                            "name": "evaluate_spoken_answer",
                            "arguments": {},
                        },
                        "result": {},
                    },
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
            &mut AudioTurnAssembly::default(),
        )
        .await;

        // `tool_result` is not a member of the v5 browser-sendable union at all, so
        // it never parses into a frame the server could act on.
        assert_eq!(result, Err(ClientFrameError::invalid()));
    }

    #[tokio::test]
    async fn keepalive_frames_do_not_reach_brain_input() {
        let (input, mut received) = mpsc::channel(1);
        let binding = fixture_binding();

        assert_eq!(
            handle_client_message(
                Message::Ping(vec![1, 2, 3].into()),
                &input,
                &binding,
                &mut AudioTurnAssembly::default()
            )
            .await,
            Ok(ClientAction::Keepalive)
        );
        assert_eq!(
            handle_client_message(
                Message::Pong(vec![1, 2, 3].into()),
                &input,
                &binding,
                &mut AudioTurnAssembly::default()
            )
            .await,
            Ok(ClientAction::Keepalive)
        );
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn rejects_oversized_text_and_every_binary_frame() {
        let (input, _received) = mpsc::channel(8);
        let binding = fixture_binding();
        let too_large_text = "x".repeat(VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1);
        // Protocol v5 has no binary client surface: even a one-byte frame is refused,
        // because accepting it would admit audio that skipped the turn assembler.
        let smallest_binary = vec![0_u8; 1];

        assert_eq!(
            handle_client_message(
                Message::Text(too_large_text.into()),
                &input,
                &binding,
                &mut AudioTurnAssembly::default()
            )
            .await,
            Err(ClientFrameError::oversized_text())
        );
        assert_eq!(
            handle_client_message(
                Message::Binary(smallest_binary.into()),
                &input,
                &binding,
                &mut AudioTurnAssembly::default(),
            )
            .await,
            Err(ClientFrameError::unsupported_binary_frame())
        );
    }

    #[test]
    fn preflight_maps_access_and_capacity_failures_to_http_statuses() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;
        use axum::http::HeaderValue;

        let auth_state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess {
                required_bearer: Some("secret".into()),
                session_token_secret: None,
                allowed_origins: vec![],
            },
            1,
        );
        let headers = HeaderMap::new();
        let peer = client_ip_test_peer("198.51.100.7");
        match validate_ws_preflight(&auth_state, peer, &headers) {
            Err(rejection) => assert_eq!(rejection.status(), StatusCode::UNAUTHORIZED),
            Ok(_) => panic!("expected bearer rejection"),
        }

        let origin_state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess {
                required_bearer: None,
                session_token_secret: None,
                allowed_origins: vec!["http://localhost:3000".to_owned()],
            },
            1,
        );
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("http://evil.test"));
        match validate_ws_preflight(&origin_state, peer, &headers) {
            Err(rejection) => assert_eq!(rejection.status(), StatusCode::FORBIDDEN),
            Ok(_) => panic!("expected origin rejection"),
        }

        let capacity_state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let _held = capacity_state
            .session_slots
            .clone()
            .try_acquire_owned()
            .unwrap();
        match validate_ws_preflight(&capacity_state, peer, &HeaderMap::new()) {
            Err(rejection) => assert_eq!(rejection.status(), StatusCode::TOO_MANY_REQUESTS),
            Ok(_) => panic!("expected capacity rejection"),
        }
    }

    #[tokio::test]
    async fn terminal_session_phase_close_preserves_deploy_drain_when_writer_fails() {
        let (input, mut received) = mpsc::channel(1);
        let mut sender = BoundedSender::new(FailingSink, Duration::from_secs(5));
        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let mut terminal_persisted = false;

        let reason = close_with_terminal_session_phase(
            &mut sender,
            &input,
            &state,
            None,
            &mut terminal_persisted,
            TerminalSessionReason::Drained,
            close_code::NORMAL,
        )
        .await;

        assert_eq!(reason, "drained");
        assert!(terminal_persisted);
        assert!(matches!(received.recv().await.unwrap(), BrainInput::Stop));
    }

    #[tokio::test]
    async fn terminal_session_phase_close_preserves_provider_reason_when_writer_fails() {
        let (input, mut received) = mpsc::channel(1);
        let mut sender = BoundedSender::new(FailingSink, Duration::from_secs(5));
        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let mut terminal_persisted = false;

        let reason = close_with_terminal_session_phase(
            &mut sender,
            &input,
            &state,
            None,
            &mut terminal_persisted,
            TerminalSessionReason::ProviderRateLimited,
            close_code::ERROR,
        )
        .await;

        assert_eq!(reason, "provider_rate_limited");
        assert!(terminal_persisted);
        assert!(matches!(received.recv().await.unwrap(), BrainInput::Stop));
    }

    #[test]
    fn terminal_phase_close_preserves_durability_label_after_send_failure() {
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::DurabilityDegraded,
                "send_failed",
            ),
            "durability_degraded"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::ProviderRateLimited,
                "send_failed",
            ),
            "provider_rate_limited"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::Drained,
                "send_failed"
            ),
            "drained"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::RateLimit,
                "send_failed"
            ),
            "rate_limit"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::TurnCap,
                "send_failed"
            ),
            "turn_cap"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::SessionCap,
                "send_failed"
            ),
            "session_cap"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::SlowClient,
                "send_failed"
            ),
            "slow_client"
        );
        assert_eq!(
            terminal_label_after_terminal_phase_close(
                TerminalSessionReason::ToolExecutorFailure,
                "send_failed",
            ),
            "tool_executor_failure"
        );
    }

    #[tokio::test]
    async fn terminal_session_phase_close_does_not_wait_for_full_input_channel() {
        let (input, mut received) = mpsc::channel(1);
        input
            .try_send(BrainInput::Text("queued".to_owned()))
            .unwrap();
        let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));
        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let mut terminal_persisted = false;

        let reason = timeout(
            Duration::from_millis(100),
            close_with_terminal_session_phase(
                &mut sender,
                &input,
                &state,
                None,
                &mut terminal_persisted,
                TerminalSessionReason::Drained,
                close_code::NORMAL,
            ),
        )
        .await
        .expect("terminal close must not block behind provider input backpressure");

        assert_eq!(reason, "drained");
        assert!(terminal_persisted);
        assert_eq!(sender.inner.sent.len(), 2);
        let Message::Text(text) = &sender.inner.sent[0] else {
            panic!("expected terminal session phase text frame");
        };
        let frame: ServerFrame = serde_json::from_str(text).unwrap();
        let ServerFrame::Event { event, .. } = frame else {
            panic!("expected terminal session phase event");
        };
        assert!(matches!(
            event.as_ref(),
            crate::VivaServerEvent::SessionPhase {
                terminal_reason: Some(TerminalSessionReason::Drained),
                ..
            }
        ));
        let Message::Close(Some(close)) = &sender.inner.sent[1] else {
            panic!("expected websocket close frame");
        };
        assert_eq!(close.code, close_code::NORMAL);
        assert!(matches!(
            received.try_recv().unwrap(),
            BrainInput::Text(text) if text == "queued"
        ));
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn client_stop_terminal_event_drain_times_out_when_provider_stops_sending() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let (_events_tx, mut events) = mpsc::channel(1);
        let mut cancelled_responses = CancelledResponseTracker::default();
        let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));
        let limits = VoiceLimitConfig::default();
        let mut session_limits = SessionLimitRuntime::new();
        let mut turn_bindings = TurnBindingTracker::default();
        let binding = fixture_binding();
        let mut context = BrainForwardContext {
            state: &state,
            voice_session_id: Some("voice-session-1".to_owned()),
            session_binding: &binding,
            limits: &limits,
            session_limits: &mut session_limits,
            turn_bindings: &mut turn_bindings,
        };
        let started_at = Instant::now();

        let result = drain_terminal_events(
            &mut context,
            &mut events,
            &mut cancelled_responses,
            started_at,
            &mut sender,
        )
        .await
        .unwrap();

        assert_eq!(result, ForwardBrainEvent::Continue);
        assert!(sender.inner.sent.is_empty());
        assert!(started_at.elapsed() >= TERMINAL_EVENT_DRAIN_TIMEOUT);
    }

    #[tokio::test]
    async fn records_usage_events_internally_without_browser_evidence() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        let record = record_brain_event(
            &state,
            Some("voice-session-1".to_owned()),
            &agent_domain::BrainEvent::Usage(agent_domain::BrainUsage {
                text_input_tokens: 20,
                text_output_tokens: 10,
                ..agent_domain::BrainUsage::default()
            }),
            Duration::from_secs(2),
        )
        .await;
        let BrainEventRecordResult::Usage(record) = record else {
            panic!("usage events should return a usage record");
        };

        let usage = state.usage.snapshot();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].provider, "synthetic");
        assert_eq!(usage[0].model, "synthetic-viva");
        assert_eq!(usage[0].duration_seconds, 2);
        assert_eq!(usage[0].answer_eval_latency_ms, Some(2_000));
        assert_eq!(usage[0].text_input_tokens, 20);
        assert_eq!(record.cost_estimate_usd, usage[0].cost_estimate_usd);
        assert!(state.evidence.snapshot().is_empty());
    }

    #[tokio::test]
    async fn records_provider_fallback_activations_internally_without_browser_evidence() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "cartesia_gemini",
            crate::VoiceWsAccess::default(),
            1,
        );
        let event = agent_domain::BrainEvent::ProviderFallbackActivated {
            response_id: "response-1".to_owned(),
            provider: "gemini".to_owned(),
            from_model: "gemini-3.5-pro".to_owned(),
            to_model: "gemini-3.5-flash".to_owned(),
            reason: "primary_429".to_owned(),
            failure: None,
        };

        assert!(matches!(
            record_brain_event(
                &state,
                Some("voice-session-1".to_owned()),
                &event,
                Duration::from_secs(1),
            )
            .await,
            BrainEventRecordResult::None
        ));
        assert!(crate::protocol::ServerFrame::browser_event(event).is_none());
        let evidence = state.evidence.snapshot();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].kind, VoiceEvidenceEventKind::ProviderFallback);
        assert_eq!(
            evidence[0].voice_session_id.as_deref(),
            Some("voice-session-1")
        );
        assert!(evidence[0].detail.contains("provider=gemini"));
        assert!(evidence[0].detail.contains("from_model=gemini-3.5-pro"));
        assert!(evidence[0].detail.contains("to_model=gemini-3.5-flash"));
        assert!(evidence[0].detail.contains("reason=primary_429"));
    }

    #[tokio::test]
    async fn provider_fallback_activation_rate_limit_does_not_feed_provider_backoff() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "cartesia_gemini",
            crate::VoiceWsAccess::default(),
            1,
        )
        .with_voice_limits(VoiceLimitConfig {
            provider_backoff_default_ms: 1_000,
            provider_backoff_max_ms: 5_000,
            ..VoiceLimitConfig::default()
        });
        let event = agent_domain::BrainEvent::ProviderFallbackActivated {
            response_id: "response-1".to_owned(),
            provider: "gemini".to_owned(),
            from_model: "gemini-3.5-pro".to_owned(),
            to_model: "gemini-3.5-flash".to_owned(),
            reason: "primary_429".to_owned(),
            failure: Some(BrainProviderFailure::new(BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 17,
                provider: "gemini".to_owned(),
                model: "gemini-3.5-pro".to_owned(),
                metadata: "http_status=429 retry_after_ms=750 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=within_limit deploy_sha=test-sha".to_owned(),
            })),
        };

        assert!(matches!(
            record_brain_event(
                &state,
                Some("voice-session-1".to_owned()),
                &event,
                Duration::from_secs(1),
            )
            .await,
            BrainEventRecordResult::None
        ));

        let admission = state
            .limit_state
            .try_admit_provider_turn(&state.voice_limits, ProviderQueueBehavior::Wait)
            .await;
        let ProviderAdmissionDecision::Admitted = admission.decision else {
            panic!("successful fallback activation must not install provider-wide backoff");
        };
        assert!(state.evidence.snapshot().iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::ProviderFallback
                && event.detail.contains("reason=primary_429")
        }));
    }

    #[test]
    fn cancellation_suppression_keeps_internal_provider_fallback_activations() {
        let mut tracker = CancelledResponseTracker::default();
        let question = fixture_question();

        assert!(!should_suppress_cancelled_response(
            &mut tracker,
            &agent_domain::BrainEvent::QuestionStarted {
                response_id: "response-1".to_owned(),
                question,
            },
        ));
        assert!(!should_suppress_cancelled_response(
            &mut tracker,
            &agent_domain::BrainEvent::ResponseCancelledFor {
                response_id: "response-1".to_owned(),
            },
        ));
        assert!(!should_suppress_cancelled_response(
            &mut tracker,
            &agent_domain::BrainEvent::ProviderFallbackActivated {
                response_id: "response-1".to_owned(),
                provider: "gemini".to_owned(),
                from_model: "gemini-3.5-pro".to_owned(),
                to_model: "gemini-3.5-flash".to_owned(),
                reason: "primary_429".to_owned(),
                failure: None,
            },
        ));
        assert!(should_suppress_cancelled_response(
            &mut tracker,
            &agent_domain::BrainEvent::ResponseTranscriptDelta {
                response_id: "response-1".to_owned(),
                text: "suppressed browser text".to_owned(),
            },
        ));
    }

    /// Connection-local assembler unit tests. The module name keeps every
    /// plan-named test reachable through the `audio_assembler` filter without
    /// renaming the test functions themselves.
    mod audio_assembler {
        use super::*;

        const TEST_GENERATION: &str = "generation-7";
        const TEST_TURN: &str = "turn-01";

        fn pcm_chunk(bytes: usize) -> AudioFrame {
            AudioFrame::from_pcm16_bytes(vec![0xAB_u8; bytes])
        }

        fn push_chunk(
            assembly: &mut AudioTurnAssembly,
            sequence: u32,
            bytes: usize,
        ) -> Result<AudioAssemblyAction, ClientFrameError> {
            accept_audio_chunk(
                assembly,
                TEST_GENERATION.to_owned(),
                TEST_TURN.to_owned(),
                sequence,
                pcm_chunk(bytes),
            )
            .map_err(ClientFrameError::from)
        }

        fn assert_sanitized_audio_error(error: ClientFrameError, frame: &AudioFrame) {
            let encoded = frame.pcm16_base64();
            if !encoded.is_empty() {
                assert!(!error.message.contains(encoded));
                assert!(!error.close_reason.contains(encoded));
                assert!(!error.terminal_reason.contains(encoded));
            }
            assert!(!error.message.contains("pcm16"));
            assert!(!error.close_reason.contains("pcm16"));
        }

        #[test]
        fn audio_assembler_requires_zero_based_contiguous_sequences() {
            let mut assembly = AudioTurnAssembly::default();
            for sequence in 0..3 {
                let action =
                    push_chunk(&mut assembly, sequence, 960).expect("contiguous chunk accepted");
                assert!(matches!(action, AudioAssemblyAction::Pending));
            }

            let turn = assembly
                .open
                .as_ref()
                .expect("assembly is retained until end");
            assert_eq!(turn.client_generation_id, TEST_GENERATION);
            assert_eq!(turn.turn_id, TEST_TURN);
            assert_eq!(turn.next_sequence, 3);
            assert_eq!(turn.pcm16.len(), 2_880);

            let mut nonzero_start = AudioTurnAssembly::default();
            let error =
                push_chunk(&mut nonzero_start, 1, 960).expect_err("a turn cannot start after zero");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(nonzero_start.open.is_none());
        }

        #[test]
        fn audio_assembler_rejects_duplicate_gap_and_out_of_order_sequences() {
            for replayed in [0_u32, 2] {
                let mut assembly = AudioTurnAssembly::default();
                push_chunk(&mut assembly, 0, 960).expect("first chunk accepted");
                let error = push_chunk(&mut assembly, replayed, 960)
                    .expect_err("duplicate and gapped sequences fail closed");
                assert_eq!(error, ClientFrameError::invalid_audio_frame());
                assert!(
                    assembly.open.is_none(),
                    "a rejected frame clears the assembly"
                );
            }

            let mut assembly = AudioTurnAssembly::default();
            push_chunk(&mut assembly, 0, 960).expect("first chunk accepted");
            push_chunk(&mut assembly, 1, 960).expect("second chunk accepted");
            let error = push_chunk(&mut assembly, 1, 960)
                .expect_err("a sequence cannot be reused out of order");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(assembly.open.is_none());
        }

        #[test]
        fn audio_assembler_rejects_mismatched_generation_or_turn() {
            for (generation, turn_id) in [(TEST_GENERATION, "turn-02"), ("generation-8", TEST_TURN)]
            {
                let mut assembly = AudioTurnAssembly::default();
                push_chunk(&mut assembly, 0, 960).expect("first chunk accepted");
                let error = accept_audio_chunk(
                    &mut assembly,
                    generation.to_owned(),
                    turn_id.to_owned(),
                    1,
                    pcm_chunk(960),
                )
                .map_err(ClientFrameError::from)
                .expect_err("a second identity cannot join an active turn");
                assert_eq!(error, ClientFrameError::invalid_audio_frame());
                assert!(assembly.open.is_none());
            }

            for (generation, turn_id) in [("", TEST_TURN), (TEST_GENERATION, "   ")] {
                let mut assembly = AudioTurnAssembly::default();
                let error = accept_audio_chunk(
                    &mut assembly,
                    generation.to_owned(),
                    turn_id.to_owned(),
                    0,
                    pcm_chunk(960),
                )
                .map_err(ClientFrameError::from)
                .expect_err("empty identity fails closed");
                assert_eq!(error, ClientFrameError::invalid_audio_frame());
                assert!(assembly.open.is_none());
            }
        }

        #[test]
        fn audio_assembler_rejects_empty_odd_or_oversized_chunks() {
            for (bytes, expected) in [
                (0_usize, ClientFrameError::invalid_audio_frame()),
                (1, ClientFrameError::invalid_audio_frame()),
                (
                    VIVA_AUDIO_MAX_CHUNK_BYTES + 1,
                    ClientFrameError::oversized_audio_chunk(),
                ),
            ] {
                let mut assembly = AudioTurnAssembly::default();
                let frame = pcm_chunk(bytes);
                let error = accept_audio_chunk(
                    &mut assembly,
                    TEST_GENERATION.to_owned(),
                    TEST_TURN.to_owned(),
                    0,
                    frame.clone(),
                )
                .map_err(ClientFrameError::from)
                .expect_err("invalid chunk sizes fail closed");
                assert_eq!(error, expected);
                assert!(assembly.open.is_none());
                assert_sanitized_audio_error(error, &frame);
            }

            let mut assembly = AudioTurnAssembly::default();
            push_chunk(&mut assembly, 0, VIVA_AUDIO_MAX_CHUNK_BYTES)
                .expect("the exact chunk ceiling is accepted");
            assert_eq!(
                assembly.open.expect("assembly retained").pcm16.len(),
                VIVA_AUDIO_MAX_CHUNK_BYTES
            );
        }

        #[test]
        fn audio_assembler_accepts_exact_45_second_limit_and_rejects_one_more_sample() {
            let full_chunks = VIVA_AUDIO_MAX_TURN_BYTES / VIVA_AUDIO_MAX_CHUNK_BYTES;
            let tail = VIVA_AUDIO_MAX_TURN_BYTES - full_chunks * VIVA_AUDIO_MAX_CHUNK_BYTES;

            let fill_to_limit = || {
                let mut assembly = AudioTurnAssembly::default();
                let mut sequence = 0_u32;
                for _ in 0..full_chunks {
                    push_chunk(&mut assembly, sequence, VIVA_AUDIO_MAX_CHUNK_BYTES)
                        .expect("chunk under the turn cap is accepted");
                    sequence += 1;
                }
                push_chunk(&mut assembly, sequence, tail)
                    .expect("the exact turn ceiling is accepted");
                assert_eq!(
                    assembly
                        .open
                        .as_ref()
                        .expect("assembly retained")
                        .pcm16
                        .len(),
                    VIVA_AUDIO_MAX_TURN_BYTES
                );
                (assembly, sequence)
            };

            let (mut accepted, final_sequence) = fill_to_limit();
            let action =
                accept_audio_end(&mut accepted, TEST_GENERATION, TEST_TURN, final_sequence)
                    .expect("the exact 45-second turn completes");
            let AudioAssemblyAction::Complete { frame, .. } = action else {
                panic!("expected one complete assembled turn");
            };
            assert_eq!(frame.pcm16_bytes().len(), VIVA_AUDIO_MAX_TURN_BYTES);

            let (mut overflowing, final_sequence) = fill_to_limit();
            let error = push_chunk(&mut overflowing, final_sequence + 1, 2)
                .expect_err("one more sample fails closed");
            assert_eq!(error, ClientFrameError::oversized_audio_turn());
            assert!(overflowing.open.is_none());
        }

        #[test]
        fn audio_end_requires_last_sequence_and_emits_one_complete_frame() {
            let mut mismatched = AudioTurnAssembly::default();
            for sequence in 0..3 {
                push_chunk(&mut mismatched, sequence, 960).expect("chunk accepted");
            }
            let error = accept_audio_end(&mut mismatched, TEST_GENERATION, TEST_TURN, 3)
                .map_err(ClientFrameError::from)
                .expect_err("audio_end must name the last accepted sequence");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(mismatched.open.is_none());

            let mut assembly = AudioTurnAssembly::default();
            for sequence in 0..3 {
                let action = push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
                assert!(
                    matches!(action, AudioAssemblyAction::Pending),
                    "no provider turn before explicit end"
                );
            }
            let action = accept_audio_end(&mut assembly, TEST_GENERATION, TEST_TURN, 2)
                .expect("the completed turn is admitted once");
            let AudioAssemblyAction::Complete {
                client_generation_id,
                turn_id,
                final_sequence,
                frame,
            } = action
            else {
                panic!("expected one complete assembled turn");
            };
            assert_eq!(client_generation_id, TEST_GENERATION);
            assert_eq!(turn_id, TEST_TURN);
            assert_eq!(final_sequence, 2);
            assert_eq!(frame.pcm16_bytes().len(), 2_880);
            assert!(
                assembly.open.is_none(),
                "the completed turn is moved out once"
            );

            let mut empty = AudioTurnAssembly::default();
            let error = accept_audio_end(&mut empty, TEST_GENERATION, TEST_TURN, 0)
                .map_err(ClientFrameError::from)
                .expect_err("audio_end without an assembled turn fails closed");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
        }

        /// Independent-review CRITICAL (cancel-after-submit): a scoped cancel and
        /// an `audio_end` for the same turn race by construction — the browser
        /// decides to cancel while its own `audio_end` is already on the wire.
        /// The late cancel names a turn this connection genuinely owns, so it is
        /// answered as a turn cancel, never as a malformed audio frame that ends
        /// the session with a PROTOCOL close.
        #[test]
        fn cancel_after_audio_end_is_a_turn_cancel_not_a_protocol_error() {
            let mut assembly = AudioTurnAssembly::default();
            for sequence in 0..3 {
                push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
            }
            let completed = accept_audio_end(&mut assembly, TEST_GENERATION, TEST_TURN, 2)
                .expect("the bounded turn is admitted");
            assert!(matches!(completed, AudioAssemblyAction::Complete { .. }));
            assert!(assembly.open.is_none());

            let late = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
                .expect("a cancel naming the just-submitted turn is not a protocol error");
            assert!(matches!(late, AudioAssemblyAction::CancelSubmittedTurn));
            // Repeating it stays benign.
            let repeated = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
                .expect("a repeated late cancel is still not a protocol error");
            assert!(matches!(repeated, AudioAssemblyAction::CancelSubmittedTurn));
        }

        /// A repeat of a cancel that already discarded its assembly is a benign
        /// no-op: no provider work was ever created, so none may be cancelled.
        #[test]
        fn cancel_after_cancel_is_a_benign_no_op() {
            let mut assembly = AudioTurnAssembly::default();
            push_chunk(&mut assembly, 0, 960).expect("chunk accepted");
            let cancelled = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
                .expect("a matching cancel discards the assembly");
            assert!(matches!(cancelled, AudioAssemblyAction::Cancelled));

            let repeated = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
                .expect("a repeated cancel is not a protocol error");
            assert!(matches!(repeated, AudioAssemblyAction::AlreadyDiscarded));
        }

        /// A scoped cancel naming a turn this connection never saw is still a
        /// protocol error: the settled-turn memory holds exactly one identity and
        /// is not a general amnesty.
        #[test]
        fn cancel_for_an_unknown_turn_is_still_a_protocol_error() {
            let mut assembly = AudioTurnAssembly::default();
            for sequence in 0..3 {
                push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
            }
            accept_audio_end(&mut assembly, TEST_GENERATION, TEST_TURN, 2).expect("turn admitted");

            let error = accept_audio_cancel(&mut assembly, TEST_GENERATION, "turn-99")
                .map_err(ClientFrameError::from)
                .expect_err("an unknown turn id is a protocol error");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            let error = accept_audio_cancel(&mut assembly, "generation-9", TEST_TURN)
                .map_err(ClientFrameError::from)
                .expect_err("an unknown generation is a protocol error");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
        }

        #[test]
        fn matching_cancel_discards_without_emitting_brain_input() {
            let mut assembly = AudioTurnAssembly::default();
            for sequence in 0..3 {
                push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
            }
            let action = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
                .expect("a matching cancel discards the assembly");
            assert!(matches!(action, AudioAssemblyAction::Cancelled));
            assert!(
                assembly.open.is_none(),
                "no phantom provider turn is created"
            );

            let mut other = AudioTurnAssembly::default();
            accept_audio_chunk(
                &mut other,
                TEST_GENERATION.to_owned(),
                "turn-02".to_owned(),
                0,
                pcm_chunk(960),
            )
            .expect("chunk accepted");
            let error = accept_audio_cancel(&mut other, TEST_GENERATION, TEST_TURN)
                .map_err(ClientFrameError::from)
                .expect_err("a mismatched cancel is a protocol error");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(other.open.is_none());

            let mut empty = AudioTurnAssembly::default();
            let error = accept_audio_cancel(&mut empty, TEST_GENERATION, TEST_TURN)
                .map_err(ClientFrameError::from)
                .expect_err("a scoped cancel without an assembly is a protocol error");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
        }
    }

    /// `SERVICE-007`: Plan 05's `audio-turn-lifecycle.json` validates only its own
    /// schema, case-id set, and per-frame parses. Executing the stateful outcome of
    /// every case against Plan 03's real `ws.rs` assembler is exclusively this
    /// plan's obligation, and the fixture is read-only here.
    mod audio_turn_lifecycle {
        use super::*;

        const AUDIO_TURN_LIFECYCLE_JSON: &str =
            include_str!("../../../fixtures/voice-protocol/v5/audio-turn-lifecycle.json");

        #[derive(Deserialize)]
        struct LifecycleFile {
            schema: String,
            protocol_version: u32,
            cases: Vec<LifecycleCase>,
        }

        #[derive(Deserialize)]
        struct LifecycleCase {
            id: String,
            wire_sequence_json: Vec<String>,
            valid: bool,
            diagnostic_code: Option<String>,
            path: Option<String>,
        }

        /// The outcome of replaying one fixture case through the real assembler.
        struct LifecycleOutcome {
            completed: Option<AcceptedAudioTurn>,
            rejection: Option<VoiceProtocolDiagnostic>,
            /// Which layer refused, so Plan 05's per-frame parse can be told apart
            /// from the stateful assembler outcome this plan owns.
            rejected_by: Option<RejectionSource>,
            assembly_retained: bool,
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        enum RejectionSource {
            Parser,
            Assembler,
        }

        /// Replays one fixture case exactly as the socket does: every wire entry goes
        /// through Plan 05's strict parser first, and only a parsed `audio_chunk` /
        /// `audio_end` reaches the connection-local assembler.
        fn replay(case: &LifecycleCase) -> LifecycleOutcome {
            let mut assembly = AudioTurnAssembly::default();
            let mut completed = None;
            let mut rejection = None;
            let mut rejected_by = None;

            for wire_json in &case.wire_sequence_json {
                if rejection.is_some() {
                    continue;
                }
                let frame = match parse_client_frame_json(wire_json) {
                    Ok(frame) => frame,
                    Err(diagnostic) => {
                        rejection = Some(diagnostic);
                        rejected_by = Some(RejectionSource::Parser);
                        continue;
                    }
                };
                let outcome = match frame {
                    ClientFrame::AudioChunk {
                        client_generation_id,
                        turn_id,
                        sequence,
                        frame,
                        ..
                    } => accept_audio_chunk(
                        &mut assembly,
                        client_generation_id,
                        turn_id,
                        sequence,
                        frame,
                    ),
                    ClientFrame::AudioEnd {
                        client_generation_id,
                        turn_id,
                        final_sequence,
                        ..
                    } => accept_audio_end(
                        &mut assembly,
                        &client_generation_id,
                        &turn_id,
                        final_sequence,
                    ),
                    other => panic!("{} carries a non-audio frame: {other:?}", case.id),
                };
                match outcome {
                    Ok(AudioAssemblyAction::Pending) => {}
                    Ok(AudioAssemblyAction::Complete {
                        client_generation_id,
                        turn_id,
                        final_sequence,
                        ..
                    }) => {
                        completed = Some(AcceptedAudioTurn {
                            client_generation_id,
                            turn_id,
                            final_sequence,
                        });
                    }
                    Ok(AudioAssemblyAction::Cancelled)
                    | Ok(AudioAssemblyAction::CancelSubmittedTurn)
                    | Ok(AudioAssemblyAction::AlreadyDiscarded) => {
                        panic!("{} produced a cancellation", case.id)
                    }
                    Err(reject) => {
                        rejection = Some(reject);
                        rejected_by = Some(RejectionSource::Assembler);
                    }
                }
            }

            LifecycleOutcome {
                completed,
                rejection,
                rejected_by,
                assembly_retained: assembly.open.is_some(),
            }
        }

        #[test]
        fn audio_turn_lifecycle_fixture_cases_execute_against_the_assembler() {
            let file: LifecycleFile = serde_json::from_str(AUDIO_TURN_LIFECYCLE_JSON)
                .expect("audio lifecycle fixture parses");
            assert_eq!(file.schema, "viva.voice-audio-sequence-cases.v1");
            assert_eq!(file.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
            assert_eq!(file.cases.len(), 8, "every published case must be executed");

            for case in &file.cases {
                let outcome = replay(case);
                if case.valid {
                    assert!(
                        outcome.rejection.is_none(),
                        "{} must assemble without a diagnostic",
                        case.id
                    );
                    let accepted = outcome
                        .completed
                        .as_ref()
                        .unwrap_or_else(|| panic!("{} must complete one turn", case.id));
                    assert_eq!(accepted.turn_id, "turn-fixture-audio", "{}", case.id);
                    assert_eq!(
                        accepted.client_generation_id, "generation-fixture-audio",
                        "{}",
                        case.id
                    );
                    let expected_final = case.wire_sequence_json.len() as u32 - 2;
                    assert_eq!(accepted.final_sequence, expected_final, "{}", case.id);
                    assert!(
                        !outcome.assembly_retained,
                        "{} must leave no retained assembly",
                        case.id
                    );
                    continue;
                }

                let diagnostic = outcome
                    .rejection
                    .as_ref()
                    .unwrap_or_else(|| panic!("{} must be rejected", case.id));
                assert_eq!(
                    Some(diagnostic.code.as_str().to_owned()),
                    case.diagnostic_code,
                    "{} diagnostic code",
                    case.id
                );
                assert_eq!(
                    Some(diagnostic.path.clone()),
                    case.path,
                    "{} diagnostic path",
                    case.id
                );
                assert!(
                    outcome.completed.is_none(),
                    "{} must never produce a provider turn",
                    case.id
                );
                assert!(
                    !outcome.assembly_retained,
                    "{} must clear the assembly on rejection",
                    case.id
                );
                // A `VOICE_PROTOCOL_FRAME_TOO_LARGE` case is Plan 05's per-frame
                // refusal; every other published rejection is a stateful outcome only
                // this plan's assembler can decide.
                let expected_source =
                    if case.diagnostic_code.as_deref() == Some("VOICE_PROTOCOL_FRAME_TOO_LARGE") {
                        RejectionSource::Parser
                    } else {
                        RejectionSource::Assembler
                    };
                assert_eq!(
                    outcome.rejected_by,
                    Some(expected_source),
                    "{} was refused by the wrong layer",
                    case.id
                );
            }
        }

        /// The three stateful rejections this plan owns are exactly the codes the
        /// fixture publishes; the per-frame ceiling stays Plan 05's parser diagnostic.
        #[test]
        fn audio_turn_lifecycle_rejections_carry_no_payload_material() {
            for rejection in [
                AudioAssemblyRejection::InvalidIdentity,
                AudioAssemblyRejection::InvalidPayload,
                AudioAssemblyRejection::ChunkTooLarge,
                AudioAssemblyRejection::TurnTooLarge,
                AudioAssemblyRejection::Sequence,
                AudioAssemblyRejection::FinalSequence,
            ] {
                let diagnostic = rejection.diagnostic();
                let rendered = format!("{diagnostic:?} {diagnostic}");
                assert!(!rendered.contains("AAA"), "{rejection:?} leaked a payload");
                assert!(diagnostic.path.starts_with('$'), "{rejection:?}");
                let error = ClientFrameError::from(rejection.diagnostic());
                assert!(!error.message.contains("pcm16_base64"));
            }

            assert_eq!(
                AudioAssemblyRejection::Sequence.diagnostic(),
                VoiceProtocolDiagnostic::new(
                    VoiceProtocolDiagnosticCode::AudioSequence,
                    "$.sequence"
                )
            );
            assert_eq!(
                AudioAssemblyRejection::FinalSequence.diagnostic(),
                VoiceProtocolDiagnostic::new(
                    VoiceProtocolDiagnosticCode::AudioSequence,
                    "$.final_sequence"
                )
            );
            assert_eq!(
                AudioAssemblyRejection::TurnTooLarge.diagnostic(),
                VoiceProtocolDiagnostic::new(
                    VoiceProtocolDiagnosticCode::TurnTooLarge,
                    "$.frame.pcm16_base64"
                )
            );
        }
    }

    fn client_ip_test_peer(address: &str) -> SocketAddr {
        SocketAddr::new(address.parse().expect("test peer address"), 44_321)
    }

    fn client_ip_test_headers(forwarded_for: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(forwarded_for) = forwarded_for {
            headers.insert(
                "x-forwarded-for",
                axum::http::HeaderValue::from_str(forwarded_for).expect("header value"),
            );
        }
        headers
    }

    fn client_ip_trusted_proxies() -> crate::config::TrustedProxyConfig {
        crate::config::TrustedProxyConfig::parse("10.0.0.0/8,2001:db8::/32")
            .expect("test CIDR list parses")
    }

    /// `SERVICE-003`: the client address is derived from the socket peer and, only
    /// behind a configured trusted proxy, from the rightmost untrusted forwarded
    /// hop. There is no `unknown` bucket and no left-most-header trust.
    #[test]
    fn client_ip_key_derives_from_peer_and_trusted_hops() {
        let trusted = client_ip_trusted_proxies();
        let untrusted_peer = client_ip_test_peer("198.51.100.7");
        let trusted_peer = client_ip_test_peer("10.1.2.3");
        let long_chain = |hops: usize| {
            (0..hops)
                .map(|index| format!("198.51.100.{}", index % 200 + 1))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let accepted: Vec<(&str, SocketAddr, Option<String>, &str)> = vec![
            (
                "direct attacker spoofing a forwarding header",
                untrusted_peer,
                Some("203.0.113.9".to_owned()),
                "198.51.100.7",
            ),
            (
                "untrusted peer supplying a valid-looking chain",
                untrusted_peer,
                Some("203.0.113.9, 10.0.0.4, 10.0.0.5".to_owned()),
                "198.51.100.7",
            ),
            (
                "untrusted peer with no forwarding header",
                untrusted_peer,
                None,
                "198.51.100.7",
            ),
            (
                "trusted proxy with client, trusted, trusted",
                trusted_peer,
                Some("203.0.113.9, 10.0.0.4, 10.0.0.5".to_owned()),
                "203.0.113.9",
            ),
            (
                "trusted proxy with a rightmost-untrusted mixed chain",
                trusted_peer,
                Some("203.0.113.9, 198.51.100.4, 10.0.0.5".to_owned()),
                "198.51.100.4",
            ),
            (
                "trusted proxy with a single untrusted hop",
                trusted_peer,
                Some("2001:db9::1".to_owned()),
                "2001:db9::1",
            ),
            (
                "trusted proxy with exactly 32 hops",
                trusted_peer,
                Some(long_chain(32)),
                "198.51.100.32",
            ),
        ];

        for (name, peer, forwarded_for, expected) in accepted {
            let headers = client_ip_test_headers(forwarded_for.as_deref());
            assert_eq!(
                client_ip_key(peer, &headers, &trusted),
                Ok(expected.parse::<IpAddr>().expect("expected address")),
                "{name}"
            );
        }

        let rejected: Vec<(&str, SocketAddr, Option<String>, ClientIpError)> = vec![
            (
                "trusted proxy with no forwarding header",
                trusted_peer,
                None,
                ClientIpError::MissingForwardedChain,
            ),
            (
                "trusted proxy with a malformed IPv4 hop",
                trusted_peer,
                Some("203.0.113.999".to_owned()),
                ClientIpError::MalformedForwardedChain,
            ),
            (
                "trusted proxy with a malformed IPv6 hop",
                trusted_peer,
                Some("2001:db9::zz".to_owned()),
                ClientIpError::MalformedForwardedChain,
            ),
            (
                "trusted proxy with an empty element",
                trusted_peer,
                Some("203.0.113.9, , 10.0.0.5".to_owned()),
                ClientIpError::MalformedForwardedChain,
            ),
            (
                "trusted proxy with an empty chain",
                trusted_peer,
                Some(String::new()),
                ClientIpError::MalformedForwardedChain,
            ),
            (
                "trusted proxy with an address:port hop",
                trusted_peer,
                Some("203.0.113.9:443".to_owned()),
                ClientIpError::MalformedForwardedChain,
            ),
            (
                "trusted proxy with an all-trusted chain",
                trusted_peer,
                Some("10.0.0.3, 10.0.0.4, 2001:db8::9".to_owned()),
                ClientIpError::AllForwardedHopsTrusted,
            ),
            (
                "trusted proxy with 33 hops",
                trusted_peer,
                Some(long_chain(33)),
                ClientIpError::TooManyForwardedHops,
            ),
        ];

        for (name, peer, forwarded_for, expected) in rejected {
            let headers = client_ip_test_headers(forwarded_for.as_deref());
            assert_eq!(
                client_ip_key(peer, &headers, &trusted),
                Err(expected),
                "{name}"
            );
        }
    }

    /// With no configured trusted proxy the forwarding header is ignored outright.
    #[test]
    fn client_ip_key_ignores_forwarding_headers_without_trusted_proxies() {
        let trusted = crate::config::TrustedProxyConfig::default();
        let peer = client_ip_test_peer("10.1.2.3");
        let headers = client_ip_test_headers(Some("203.0.113.9, 10.0.0.4"));

        assert_eq!(
            client_ip_key(peer, &headers, &trusted),
            Ok("10.1.2.3".parse::<IpAddr>().expect("peer address"))
        );
    }

    /// `X-Real-IP` is never consulted, in either peer position.
    #[test]
    fn client_ip_key_never_consults_x_real_ip() {
        let trusted = client_ip_trusted_proxies();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-real-ip",
            axum::http::HeaderValue::from_static("203.0.113.9"),
        );

        assert_eq!(
            client_ip_key(client_ip_test_peer("198.51.100.7"), &headers, &trusted),
            Ok("198.51.100.7".parse::<IpAddr>().expect("peer address"))
        );
        assert_eq!(
            client_ip_key(client_ip_test_peer("10.1.2.3"), &headers, &trusted),
            Err(ClientIpError::MissingForwardedChain)
        );
    }

    // ---------------------------------------------------------------------
    // Task 9 (SERVICE-002, SERVICE-008): one deadline on every outbound write.
    // ---------------------------------------------------------------------

    /// A sink that never becomes ready, flushes, or closes. It is the whole
    /// slow-reader model: no TCP buffer, no timing, nothing the test has to guess
    /// about. `blocking_after` lets a session make real progress first.
    struct PendingSink {
        accepted: usize,
        block_after: usize,
    }

    impl PendingSink {
        fn new() -> Self {
            Self {
                accepted: 0,
                block_after: 0,
            }
        }

        fn blocking_after(block_after: usize) -> Self {
            Self {
                accepted: 0,
                block_after,
            }
        }

        fn blocked(&self) -> bool {
            self.accepted >= self.block_after
        }
    }

    impl futures_util::Sink<Message> for PendingSink {
        type Error = axum::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            if self.blocked() {
                return Poll::Pending;
            }
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            self.accepted = self.accepted.saturating_add(1);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            if self.blocked() {
                return Poll::Pending;
            }
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
    }

    /// The plan's boundary is "one nanosecond before the deadline"; Tokio's paused
    /// clock is a millisecond timer wheel, so a one-nanosecond gap is not a
    /// representable instant — both timers would land on the same tick and the
    /// assertion would decide nothing. The boundary is therefore taken at the
    /// runtime's own smallest observable step.
    const TIMER_TICK: Duration = Duration::from_millis(1);

    #[tokio::test(start_paused = true)]
    async fn bounded_sender_times_out_one_tick_after_its_deadline() {
        let start = Instant::now();
        // A second timer armed across the same stalled write. It must fire on its
        // own schedule, which is what proves the bounded write parks on a real
        // timer rather than blocking the runtime.
        let concurrent = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Instant::now()
        });
        let mut sender = BoundedSender::new(PendingSink::new(), Duration::from_secs(5));
        let write = sender.send(Message::Text("frame".into()));
        tokio::pin!(write);

        let before_deadline = tokio::select! {
            biased;
            result = &mut write => Some(result),
            () = tokio::time::sleep(Duration::from_secs(5) - TIMER_TICK) => None,
        };
        assert!(
            before_deadline.is_none(),
            "the write must still be pending one tick before its deadline"
        );
        assert_eq!(
            Instant::now().duration_since(start),
            Duration::from_secs(5) - TIMER_TICK
        );

        let result = (&mut write).await;
        assert!(
            matches!(result, Err(OutboundWriteError::Timeout)),
            "{result:?}"
        );
        assert_eq!(Instant::now().duration_since(start), Duration::from_secs(5));
        assert_eq!(
            concurrent.await.expect("concurrent timer task"),
            start + Duration::from_secs(1),
            "a concurrently armed one-second timer must fire on schedule"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_sender_separates_a_failed_sink_from_a_missed_deadline() {
        let mut failing = BoundedSender::new(FailingSink, Duration::from_secs(5));
        let failed = failing.send(Message::Text("frame".into())).await;
        assert!(
            matches!(failed, Err(OutboundWriteError::Sink(_))),
            "{failed:?}"
        );
        assert_eq!(
            outbound_write_terminal_label(&failed.expect_err("sink failure")),
            "send_failed"
        );

        let mut stalled = BoundedSender::new(PendingSink::new(), Duration::from_secs(5));
        let timed_out = stalled.send(Message::Text("frame".into())).await;
        assert!(matches!(timed_out, Err(OutboundWriteError::Timeout)));
        assert_eq!(
            outbound_write_terminal_label(&timed_out.expect_err("write timeout")),
            TerminalSessionReason::SlowClient.as_str()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_sender_completes_a_ready_write_without_consuming_its_deadline() {
        let start = Instant::now();
        let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));

        sender
            .send(Message::Text("frame".into()))
            .await
            .expect("a ready sink completes inside its deadline");

        assert_eq!(Instant::now(), start);
        assert_eq!(sender.inner.sent.len(), 1);
    }

    #[test]
    fn serialization_fallback_uses_plan_05s_exact_published_bytes() {
        let frame = ServerFrame::error(
            VoiceServerErrorCode::ClientFrameMalformed,
            "a frame that cannot be serialized",
        );

        let rendered = serialize_server_frame_with(&frame, |_| Err::<String, ()>(()));

        assert_eq!(rendered, VOICE_SERIALIZATION_FALLBACK_FRAME);
        let value: serde_json::Value =
            serde_json::from_str(&rendered).expect("the fallback frame is valid JSON");
        assert_eq!(value["type"], "error");
        assert_eq!(value["version"], VIVA_VOICE_PROTOCOL_VERSION);
        assert_eq!(VIVA_VOICE_PROTOCOL_VERSION, 5);
        // Named through Plan 05's own enum rather than restated as a literal:
        // `protocol_v5_fixture_shadow_types_are_absent` proves no service-local
        // wire error JSON survives in this file.
        assert_eq!(
            value["error"]["code"],
            VoiceServerErrorCode::InternalSerialization.as_str()
        );
        assert_eq!(value["error"]["retryable"], true);
        assert_eq!(
            value
                .as_object()
                .expect("envelope object")
                .keys()
                .cloned()
                .collect::<HashSet<_>>(),
            ["type", "version", "error"]
                .into_iter()
                .map(ToOwned::to_owned)
                .collect::<HashSet<_>>(),
            "the fallback carries no application payload"
        );
        assert_eq!(
            value["error"]
                .as_object()
                .expect("error object")
                .keys()
                .cloned()
                .collect::<HashSet<_>>(),
            ["code", "message", "retryable"]
                .into_iter()
                .map(ToOwned::to_owned)
                .collect::<HashSet<_>>()
        );
    }

    #[test]
    fn serialization_fallback_is_not_used_when_the_frame_serializes() {
        let frame = ServerFrame::error(VoiceServerErrorCode::ClientFrameMalformed, "malformed");

        let rendered = serialize_server_frame_with(&frame, serde_json::to_string);

        assert_ne!(rendered, VOICE_SERIALIZATION_FALLBACK_FRAME);
        assert_eq!(rendered, serde_json::to_string(&frame).unwrap());
    }

    /// A provider that answers one question and then keeps a task alive forever.
    /// The task is handed back so the test can prove the socket aborted it.
    struct SlowClientProbeBrain {
        study_store: Arc<dyn agent_domain::StudyMemoryStore>,
        #[allow(clippy::type_complexity)]
        task: Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
    }

    #[async_trait::async_trait]
    impl agent_domain::RealtimeBrain for SlowClientProbeBrain {
        fn capabilities(&self) -> agent_domain::RealtimeBrainCapabilities {
            agent_domain::RealtimeBrainCapabilities {
                provider: "slow_client_probe".to_owned(),
                configured: true,
                selectable: true,
                live_runtime: false,
            }
        }

        async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
            let _recorded = self
                .study_store
                .record_voice_session(&config)
                .await
                .map_err(|_| {
                    BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
                        failure_class: BrainFailureClass::DurabilityDegraded,
                        stage: BrainFailureStage::Store,
                        retry_eligible: false,
                        latency_ms: 0,
                        provider: "slow_client_probe".to_owned(),
                        model: String::new(),
                        metadata: "error_kind=store_write_failed".to_owned(),
                    }))
                })?;
            let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
            let (event_tx, events) = mpsc::channel(8);
            let handle = tokio::spawn(async move {
                let _ = event_tx
                    .send(BrainEvent::SessionPhase {
                        phase: StudySessionPhase::Ready,
                    })
                    .await;
                let _ = event_tx
                    .send(BrainEvent::QuestionStarted {
                        response_id: "response-1".to_owned(),
                        question: fixture_question(),
                    })
                    .await;
                while let Some(input) = input_rx.recv().await {
                    if !matches!(
                        input,
                        BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                    ) {
                        continue;
                    }
                    let _ = event_tx
                        .send(BrainEvent::SessionPhase {
                            phase: StudySessionPhase::Thinking,
                        })
                        .await;
                }
                // The provider stays alive until the socket aborts it.
                loop {
                    tokio::time::sleep(Duration::from_secs(3_600)).await;
                }
            });
            let abort = handle.abort_handle();
            *self.task.lock().expect("probe task lock poisoned") = Some(handle);
            Ok(RealtimeSession {
                input,
                events,
                task_guard: Some(RealtimeSessionTaskGuard::new(vec![abort])),
            })
        }
    }

    /// `SERVICE-002`: a client that stops reading costs the server exactly one
    /// outbound-write deadline. The session records the sanitized `slow_client`
    /// label, aborts the provider task, and releases every server-owned permit.
    #[tokio::test(start_paused = true)]
    async fn bounded_sender_slow_client_aborts_the_provider_and_releases_every_lease() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let probe_task = Arc::new(std::sync::Mutex::new(None));
        let state = AppState::with_study_store(
            Arc::new(SlowClientProbeBrain {
                study_store: store.clone(),
                task: probe_task.clone(),
            }),
            "slow_client_probe",
            crate::config::VoiceWsAccess::default(),
            2,
            store,
        )
        .with_voice_limits(VoiceLimitConfig {
            max_ip_sessions: Some(2),
            max_user_sessions: Some(2),
            provider_limiter_enabled: true,
            max_provider_concurrent_turns: Some(1),
            max_provider_queue_depth: Some(1),
            ..VoiceLimitConfig::default()
        })
        .with_ws_timeouts(crate::app::WsTimeouts {
            first_frame: Duration::from_secs(60),
            idle: Duration::from_secs(600),
            between_turn_idle: Duration::from_secs(600),
            session: Duration::from_secs(6 * 60 * 60),
            outbound_write: Duration::from_secs(5),
            ..crate::app::WsTimeouts::default()
        });
        let evidence = state.evidence.clone();
        let limit_state = state.limit_state.clone();
        let session_slots = state.session_slots.clone();

        let permit = session_slots
            .clone()
            .acquire_owned()
            .await
            .expect("session slot");
        let ip_lease = limit_state
            .try_acquire_ip("198.51.100.7", 2)
            .expect("ip lease");
        assert_eq!(limit_state.ip_lease_count("198.51.100.7"), Some(1));
        assert_eq!(session_slots.available_permits(), 1);
        let admission = VoiceAdmission {
            _permit: permit,
            _ip_lease: Some(ip_lease),
            principal: crate::config::UpgradePrincipal::ServiceBearer,
        };

        // The client sends its bootstrap frame and one answer, then reads and
        // writes nothing ever again.
        let client_frames = futures_util::stream::iter(vec![
            Ok(Message::Text(slow_client_session_config_json().into())),
            Ok(Message::Text(slow_client_answer_json().into())),
        ])
        .chain(futures_util::stream::pending());

        let start = Instant::now();
        // Ready, session_phase, question_started go out; the provider event that
        // follows the admitted answer is the write that stalls.
        run_voice_session(
            BoundedSender::new(PendingSink::blocking_after(3), Duration::from_secs(5)),
            client_frames,
            state,
            admission,
            "http://localhost:3000".to_owned(),
        )
        .await;

        assert_eq!(
            Instant::now().duration_since(start),
            Duration::from_secs(5),
            "the stalled write costs exactly one outbound-write deadline"
        );
        let recorded = evidence.snapshot();
        assert!(
            recorded.iter().any(|event| {
                event.kind == VoiceEvidenceEventKind::TerminalReason
                    && event.detail == TerminalSessionReason::SlowClient.as_str()
            }),
            "{recorded:?}"
        );
        assert_eq!(limit_state.ip_lease_count("198.51.100.7"), None);
        assert_eq!(session_slots.available_permits(), 2);
        let provider = tokio::time::timeout(
            Duration::from_millis(50),
            limit_state.try_admit_provider_turn(
                &VoiceLimitConfig {
                    provider_limiter_enabled: true,
                    max_provider_concurrent_turns: Some(1),
                    max_provider_queue_depth: Some(1),
                    ..VoiceLimitConfig::default()
                },
                ProviderQueueBehavior::Wait,
            ),
        )
        .await
        .expect("the provider slot must be free");
        assert!(
            matches!(provider.decision, ProviderAdmissionDecision::Admitted),
            "the provider slot must be free: {:?}",
            provider.decision
        );
        let task = probe_task
            .lock()
            .expect("probe task lock poisoned")
            .take()
            .expect("probe task handle");
        let outcome = tokio::time::timeout(Duration::from_millis(50), task)
            .await
            .expect("the provider task must be aborted rather than left running")
            .expect_err("an aborted task reports cancellation");
        assert!(outcome.is_cancelled());
    }

    fn slow_client_session_config_json() -> String {
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");
        format!(
            r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"slow-client-1","session_token":"placeholder-session-material","session":{session}}}"#
        )
    }

    fn slow_client_answer_json() -> String {
        json!({
            "type": "turn_intent",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": "slow-client-1",
            "turn_id": "turn-1",
            "intent": { "kind": "answer_text", "text": "an answer the client never reads back" },
        })
        .to_string()
    }

    // ---------------------------------------------------------------------
    // Task 10 (SERVICE-001): heartbeat expiry that keepalives cannot extend.
    // ---------------------------------------------------------------------

    const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
    const PONG_TIMEOUT: Duration = Duration::from_secs(10);

    #[tokio::test(start_paused = true)]
    async fn heartbeat_pings_at_the_configured_interval_and_expires_without_a_pong() {
        let start = Instant::now();
        let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);
        assert_eq!(heartbeat.next_wake(), start + HEARTBEAT_INTERVAL);

        // Nothing is due before the interval elapses.
        assert_eq!(
            heartbeat.on_timer(
                start + Duration::from_secs(29),
                HEARTBEAT_INTERVAL,
                PONG_TIMEOUT
            ),
            HeartbeatAction::SleepUntil(start + HEARTBEAT_INTERVAL)
        );

        let at_thirty = start + HEARTBEAT_INTERVAL;
        assert_eq!(
            heartbeat.on_timer(at_thirty, HEARTBEAT_INTERVAL, PONG_TIMEOUT),
            HeartbeatAction::SendPing
        );
        assert_eq!(heartbeat.next_wake(), at_thirty + PONG_TIMEOUT);

        // Still inside the pong window at 39 seconds.
        assert_eq!(
            heartbeat.on_timer(
                start + Duration::from_secs(39),
                HEARTBEAT_INTERVAL,
                PONG_TIMEOUT
            ),
            HeartbeatAction::SleepUntil(at_thirty + PONG_TIMEOUT)
        );

        assert_eq!(
            heartbeat.on_timer(
                start + Duration::from_secs(40),
                HEARTBEAT_INTERVAL,
                PONG_TIMEOUT
            ),
            HeartbeatAction::Expired
        );
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_pong_before_the_deadline_schedules_the_next_ping() {
        let start = Instant::now();
        let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);
        assert_eq!(
            heartbeat.on_timer(start + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL, PONG_TIMEOUT),
            HeartbeatAction::SendPing
        );

        let at_thirty_nine = start + Duration::from_secs(39);
        assert!(heartbeat.on_pong(at_thirty_nine, HEARTBEAT_INTERVAL));
        assert_eq!(heartbeat.next_wake(), at_thirty_nine + HEARTBEAT_INTERVAL);

        // The next ping is due at 69 seconds, not at 60.
        assert_eq!(
            heartbeat.on_timer(
                start + Duration::from_secs(60),
                HEARTBEAT_INTERVAL,
                PONG_TIMEOUT
            ),
            HeartbeatAction::SleepUntil(start + Duration::from_secs(69))
        );
        assert_eq!(
            heartbeat.on_timer(
                start + Duration::from_secs(69),
                HEARTBEAT_INTERVAL,
                PONG_TIMEOUT
            ),
            HeartbeatAction::SendPing
        );
        assert_eq!(
            heartbeat.on_timer(
                start + Duration::from_secs(79),
                HEARTBEAT_INTERVAL,
                PONG_TIMEOUT
            ),
            HeartbeatAction::Expired
        );
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_ignores_an_unsolicited_pong() {
        let start = Instant::now();
        let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);

        // No ping is outstanding, so this pong clears nothing and moves nothing.
        assert!(!heartbeat.on_pong(start + Duration::from_secs(5), HEARTBEAT_INTERVAL));
        assert_eq!(heartbeat.next_wake(), start + HEARTBEAT_INTERVAL);
        assert_eq!(
            heartbeat.on_timer(start + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL, PONG_TIMEOUT),
            HeartbeatAction::SendPing
        );

        // A second pong while one is outstanding clears it; a third does not
        // re-open the window.
        assert!(heartbeat.on_pong(start + Duration::from_secs(31), HEARTBEAT_INTERVAL));
        assert!(!heartbeat.on_pong(start + Duration::from_secs(32), HEARTBEAT_INTERVAL));
        assert_eq!(
            heartbeat.next_wake(),
            start + Duration::from_secs(31) + HEARTBEAT_INTERVAL
        );
    }

    /// `SERVICE-001`: keepalives keep the transport alive and change nothing else.
    /// Twenty ping/pong exchanges span the whole 600-second between-turn deadline
    /// without moving it by a nanosecond.
    #[tokio::test(start_paused = true)]
    async fn heartbeat_never_moves_the_between_turn_or_session_deadline() {
        let start = Instant::now();
        let between_turn_idle = Duration::from_secs(600);
        let sleeper = tokio::time::sleep(between_turn_idle);
        tokio::pin!(sleeper);
        let armed_deadline = sleeper.deadline();
        assert_eq!(armed_deadline, start + between_turn_idle);

        let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);
        let mut now = start;
        let mut pings = 0_u32;
        while now < start + between_turn_idle {
            now += Duration::from_secs(30);
            match heartbeat.on_timer(now, HEARTBEAT_INTERVAL, PONG_TIMEOUT) {
                HeartbeatAction::SendPing => {
                    pings += 1;
                    assert!(heartbeat.on_pong(now, HEARTBEAT_INTERVAL));
                }
                other => panic!("expected a ping at {now:?}, got {other:?}"),
            }
            // Neither the ping nor the pong may re-arm the between-turn deadline:
            // there is still no outstanding turn work, and `rearm_between_turn_idle`
            // is never reached from a keepalive.
            assert_eq!(sleeper.deadline(), armed_deadline);
        }

        assert_eq!(pings, 20);
        assert_eq!(sleeper.deadline(), armed_deadline);
    }

    /// A sink that survives `run_voice_session` taking its sender by value, so a
    /// terminated session's wire frames can still be read back afterwards.
    #[derive(Clone)]
    struct SharedRecordingSink {
        sent: Arc<std::sync::Mutex<Vec<Message>>>,
    }

    impl SharedRecordingSink {
        fn new() -> Self {
            Self {
                sent: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }

        fn sent(&self) -> Vec<Message> {
            self.sent.lock().expect("recording sink lock").clone()
        }
    }

    impl futures_util::Sink<Message> for SharedRecordingSink {
        type Error = axum::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.sent.lock().expect("recording sink lock").push(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    /// `SERVICE-001`: a peer that stopped answering Pings is a half-open socket,
    /// and the operator evidence must say so. The wire keeps Plan 05's published
    /// slow-client terminal contract — browsers have one terminal vocabulary and
    /// this plan adds no wire reason — but the recorded terminal label is the
    /// service-local `heartbeat_timeout`, so a half-open socket is never read
    /// back as a slow reader whose outbound write missed its deadline.
    #[tokio::test(start_paused = true)]
    async fn heartbeat_expiry_records_heartbeat_timeout_on_the_slow_client_wire_contract() {
        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let probe_task = Arc::new(std::sync::Mutex::new(None));
        let state = AppState::with_study_store(
            Arc::new(SlowClientProbeBrain {
                study_store: store.clone(),
                task: probe_task.clone(),
            }),
            "slow_client_probe",
            crate::config::VoiceWsAccess::default(),
            2,
            store,
        )
        .with_ws_timeouts(crate::app::WsTimeouts {
            // Every other deadline is far away: only the heartbeat can end this
            // socket, and the outbound sink never stalls.
            first_frame: Duration::from_secs(600),
            idle: Duration::from_secs(3_600),
            between_turn_idle: Duration::from_secs(3_600),
            session: Duration::from_secs(6 * 60 * 60),
            heartbeat_interval: HEARTBEAT_INTERVAL,
            pong_timeout: PONG_TIMEOUT,
            outbound_write: Duration::from_secs(5),
            ..crate::app::WsTimeouts::default()
        });
        let evidence = state.evidence.clone();
        let limit_state = state.limit_state.clone();
        let session_slots = state.session_slots.clone();

        let permit = session_slots
            .clone()
            .acquire_owned()
            .await
            .expect("session slot");
        let ip_lease = limit_state
            .try_acquire_ip("198.51.100.9", 2)
            .expect("ip lease");
        let admission = VoiceAdmission {
            _permit: permit,
            _ip_lease: Some(ip_lease),
            principal: crate::config::UpgradePrincipal::ServiceBearer,
        };

        // The client bootstraps, then reads nothing and writes nothing ever
        // again — including no Pong.
        let client_frames = futures_util::stream::iter(vec![Ok(Message::Text(
            slow_client_session_config_json().into(),
        ))])
        .chain(futures_util::stream::pending());

        let sink = SharedRecordingSink::new();
        let start = Instant::now();
        run_voice_session(
            BoundedSender::new(sink.clone(), Duration::from_secs(5)),
            client_frames,
            state,
            admission,
            "http://localhost:3000".to_owned(),
        )
        .await;

        assert_eq!(
            Instant::now().duration_since(start),
            HEARTBEAT_INTERVAL + PONG_TIMEOUT,
            "the socket ends one ping interval plus one pong timeout after acceptance"
        );

        let sent = sink.sent();
        assert!(
            sent.iter().any(|message| matches!(
                message,
                Message::Ping(payload) if payload.is_empty()
            )),
            "the server must have pinged before it expired the peer: {sent:?}"
        );
        // The wire contract is unchanged: Plan 05's `slow_client` terminal phase
        // and its close reason.
        let terminal_wire_reason = sent
            .iter()
            .find_map(|message| match message {
                Message::Text(text) => {
                    let frame: serde_json::Value = serde_json::from_str(text).ok()?;
                    let event = frame.get("event")?;
                    if event.get("type")?.as_str()? != "session_phase" {
                        return None;
                    }
                    Some(event.get("terminal_reason")?.as_str()?.to_owned())
                }
                _ => None,
            })
            .expect("a terminal session_phase frame");
        assert_eq!(
            terminal_wire_reason,
            TerminalSessionReason::SlowClient.as_str(),
            "the wire keeps Plan 05's published terminal vocabulary: {sent:?}"
        );
        assert!(
            sent.iter().any(|message| matches!(
                message,
                Message::Close(Some(frame))
                    if frame.reason == TerminalSessionReason::SlowClient.close_reason()
            )),
            "the close frame keeps the slow-client reason: {sent:?}"
        );

        // The evidence is where the half-open socket is named.
        let recorded = evidence.snapshot();
        assert!(
            recorded.iter().any(|event| {
                event.kind == VoiceEvidenceEventKind::TerminalReason
                    && event.detail == HEARTBEAT_TIMEOUT_TERMINAL_LABEL
            }),
            "a missing Pong records `heartbeat_timeout`: {recorded:?}"
        );
        assert!(
            !recorded.iter().any(|event| {
                event.kind == VoiceEvidenceEventKind::TerminalReason
                    && event.detail == TerminalSessionReason::SlowClient.as_str()
            }),
            "a half-open socket is not reported as a slow reader: {recorded:?}"
        );
        assert!(
            recorded.iter().any(|event| {
                event.kind == VoiceEvidenceEventKind::Close
                    && event.detail == HEARTBEAT_TIMEOUT_TERMINAL_LABEL
            }),
            "the close evidence carries the same label: {recorded:?}"
        );

        assert_eq!(limit_state.ip_lease_count("198.51.100.9"), None);
        assert_eq!(session_slots.available_permits(), 2);
    }

    /// The two outbound-write labels and the heartbeat label stay distinct: a
    /// missed write deadline is a slow reader, a broken sink is a failed send,
    /// and only an unanswered Ping is a heartbeat timeout.
    #[test]
    fn heartbeat_timeout_is_distinct_from_every_outbound_write_label() {
        assert_eq!(
            heartbeat_expiry_terminal_label(TerminalSessionReason::SlowClient.as_str()),
            HEARTBEAT_TIMEOUT_TERMINAL_LABEL
        );
        assert_ne!(
            HEARTBEAT_TIMEOUT_TERMINAL_LABEL,
            outbound_write_terminal_label(&OutboundWriteError::Timeout)
        );
        assert_ne!(
            HEARTBEAT_TIMEOUT_TERMINAL_LABEL,
            outbound_write_terminal_label(&OutboundWriteError::Sink(axum::Error::new(
                std::io::Error::other("sink broke")
            )))
        );
        assert!(
            !TerminalSessionReason::ALL
                .iter()
                .any(|reason| reason.as_str() == HEARTBEAT_TIMEOUT_TERMINAL_LABEL),
            "`heartbeat_timeout` is a service-local evidence label, not a wire reason"
        );
        // A close that degraded under its own store write, or that failed
        // outright, keeps the label it produced rather than being relabelled.
        assert_eq!(
            heartbeat_expiry_terminal_label(TerminalSessionReason::DurabilityDegraded.as_str()),
            TerminalSessionReason::DurabilityDegraded.as_str()
        );
        assert_eq!(
            heartbeat_expiry_terminal_label("send_failed"),
            "send_failed"
        );
    }
}
