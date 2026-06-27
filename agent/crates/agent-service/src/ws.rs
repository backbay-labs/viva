use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_domain::{
    fixture_question, AudioFrame, BrainError, BrainEvent, BrainInput, BrainProviderError,
    BrainProviderFailure, PortError, RealtimeSession, RealtimeSessionTaskGuard, SessionConfig,
    SessionTokenNonceClaim, StudySessionPhase, TerminalSessionReason, VoiceUsageRecord,
};
use axum::{
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
use observe::{VoiceEvidenceEvent, VoiceEvidenceEventKind};
use serde::Deserialize;
use serde_json::json;
use tokio::{
    sync::{mpsc, watch, OwnedSemaphorePermit},
    time::{timeout, Instant},
};

use crate::{
    app::{AppState, VoiceLimitLease, VoiceLimitState},
    config::{
        bac_510_max_turn_duration, FailureControlScenario, SessionAuthFailureCode,
        SessionTokenClaims, VoiceLimitConfig, VoiceWsAccessError,
    },
    protocol::{
        ClientFrame, ServerFrame, VIVA_VOICE_MAX_BINARY_FRAME_BYTES,
        VIVA_VOICE_MAX_TEXT_FRAME_BYTES, VIVA_VOICE_PROTOCOL_VERSION,
    },
};

const TERMINAL_EVENT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const RECONNECT_LEASE_GRACE: Duration = Duration::from_millis(250);
const RECONNECT_LEASE_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET: usize = 1;

pub async fn voice_ws(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let admission = match validate_ws_preflight(&state, &headers) {
        Ok(permit) => permit,
        Err(error) => return error.into_response(),
    };
    let request_origin = request_origin(&headers).unwrap_or_default();

    ws.protocols(["viva-voice"])
        .on_upgrade(move |socket| handle_socket(socket, state, admission, request_origin))
}

fn validate_ws_preflight(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<VoiceAdmission, (StatusCode, Json<serde_json::Value>)> {
    if state.drain_signal.is_draining() {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PreflightRejected,
            None,
            "server draining",
        ));
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "voice session draining" })),
        ));
    }
    if let Err(error) = state.ws_access.validate_headers(headers) {
        state.evidence.record(VoiceEvidenceEvent::new(
            VoiceEvidenceEventKind::PreflightRejected,
            None,
            error.to_string(),
        ));
        return Err(ws_access_error(error));
    }
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
            (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "voice session capacity exceeded" })),
            )
        })?;
    let ip_key = session_ip_key(headers);
    let ip_lease = match state.voice_limits.max_ip_sessions {
        Some(max) => match state.limit_state.try_acquire_ip(&ip_key, max) {
            Some(lease) => Some(lease),
            None => {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::PreflightRejected,
                    None,
                    "ip capacity exceeded",
                ));
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({ "error": "voice session IP capacity exceeded" })),
                ));
            }
        },
        None => None,
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::PreflightAccepted,
        None,
        "websocket preflight accepted",
    ));
    Ok(VoiceAdmission {
        _permit: permit,
        _ip_lease: ip_lease,
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

fn session_ip_key(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("unknown")
        .to_owned()
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
    _ip_lease: Option<VoiceLimitLease>,
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
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    _admission: VoiceAdmission,
    request_origin: String,
) {
    let (mut sender, mut receiver) = socket.split();
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
                &ServerFrame::error("first client frame timeout"),
            )
            .await;
            let _ = close_with(&mut sender, close_code::POLICY, "first frame timeout").await;
            record_terminal(&state, None, "first_frame_timeout").await;
            return;
        }
        Ok(incoming) => match incoming {
            Some(Ok(message)) => {
                match initial_session_config_from_message(message).and_then(|config| {
                    authorize_initial_session_config(config, &state, &request_origin)
                }) {
                    Ok(config) => config,
                    Err(error) => {
                        record_session_auth_failure(&state, None, error.auth_failure_code).await;
                        let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
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
    let session_binding = AuthorizedClientSession::from_config(&initial.config)
        .expect("authorized session config has required identity");
    let voice_session_id = initial.config.session_id.as_deref().map(ToOwned::to_owned);
    let study_context = match validate_study_set_access(&state, &initial.config).await {
        StudySetAccessResult::Allowed(study_context) => study_context,
        StudySetAccessResult::Denied(error) => {
            record_session_auth_failure(&state, voice_session_id.clone(), error.auth_failure_code)
                .await;
            let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
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
                let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
                let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                record_terminal(&state, voice_session_id, error.terminal_reason).await;
                return;
            }
        }
    }
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
    let session_cap = tokio::time::sleep(state.ws_timeouts.session);
    tokio::pin!(session_cap);
    let turn_cap = tokio::time::sleep(state.ws_timeouts.idle);
    tokio::pin!(turn_cap);
    let pre_answer_idle = tokio::time::sleep(state.ws_timeouts.idle);
    tokio::pin!(pre_answer_idle);
    let mut pre_answer_idle_armed = true;
    let mut turn_cap_deadline: Option<Instant> = None;
    let mut pending_submitted_answers = 0_u32;
    let mut resolved_submitted_answer_response_ids = HashSet::<String>::new();
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
        record_terminal_evidence(&state, voice_session_id, terminal_reason);
        return;
    }

    loop {
        tokio::select! {
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
                let client_input = match prepare_client_message_with_drain(
                    message,
                    &session_binding,
                    &state.voice_limits,
                    &mut session_limits,
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
                        let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
                        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                        terminal_reason = error.terminal_reason;
                        break;
                    }
                    Err(ClientMessageError::TurnCap) => unreachable!("pre-send parsing cannot trip turn cap"),
                };
                let parsed_action = client_input.action();
                let turn_send_deadline = if parsed_action.arms_turn_cap() {
                    pre_answer_idle_armed = false;
                    pending_submitted_answers = pending_submitted_answers.saturating_add(1);
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
                        match action {
                            ClientAction::Stop => {
                                let mut forward_context = BrainForwardContext {
                                    state: &state,
                                    voice_session_id: voice_session_id.clone(),
                                    session_binding: &session_binding,
                                    limits: &state.voice_limits,
                                    session_limits: &mut session_limits,
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
                                    Ok(ForwardBrainEvent::ProviderFailure(reason)) => {
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
                                    Err(_) => {
                                        terminal_reason = "send_failed";
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
                        let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
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
                let submitted_answer_resolution = brain_event_submitted_answer_resolution(&event);
                let mut forward_context = BrainForwardContext {
                    state: &state,
                    voice_session_id: voice_session_id.clone(),
                    session_binding: &session_binding,
                    limits: &state.voice_limits,
                    session_limits: &mut session_limits,
                };
                match forward_brain_event(
                    &mut forward_context,
                    event,
                    &mut cancelled_responses,
                    session_started_at.elapsed(),
                    &mut sender,
                )
                .await
                {
                    Ok(ForwardBrainEvent::Continue) => {
                        if let Some(resolution) = submitted_answer_resolution {
                            match resolution {
                                SubmittedAnswerResolution::One { response_id } => {
                                    let count_resolution = match response_id {
                                        Some(response_id) => resolved_submitted_answer_response_ids
                                            .insert(response_id),
                                        None => true,
                                    };
                                    if count_resolution {
                                        pending_submitted_answers =
                                            pending_submitted_answers.saturating_sub(1);
                                    }
                                }
                                SubmittedAnswerResolution::All => {
                                    pending_submitted_answers = 0;
                                    resolved_submitted_answer_response_ids.clear();
                                }
                            }
                            if pending_submitted_answers == 0 {
                                turn_cap_deadline = None;
                            }
                        }
                    }
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
                    Ok(ForwardBrainEvent::ProviderFailure(reason)) => {
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
                    Err(_) => {
                        terminal_reason = "send_failed";
                        break;
                    }
                }
            }
        }
    }
    if terminal_persisted {
        record_terminal_evidence(&state, voice_session_id, terminal_reason);
    } else {
        record_terminal(&state, voice_session_id, terminal_reason).await;
    }
}

fn abort_realtime_session_tasks(session: &mut agent_domain::RealtimeSession) {
    drop(session.task_guard.take());
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SubmittedAnswerResolution {
    One { response_id: Option<String> },
    All,
}

fn brain_event_submitted_answer_resolution(
    event: &agent_domain::BrainEvent,
) -> Option<SubmittedAnswerResolution> {
    match event {
        agent_domain::BrainEvent::RecapReady { .. }
        | agent_domain::BrainEvent::TerminalSessionPhase { .. } => {
            Some(SubmittedAnswerResolution::All)
        }
        agent_domain::BrainEvent::AnswerEvaluated { .. }
        | agent_domain::BrainEvent::ResponseCompleted { .. }
        | agent_domain::BrainEvent::ResponseCancelledFor { .. } => {
            Some(SubmittedAnswerResolution::One {
                response_id: event.response_id().map(ToOwned::to_owned),
            })
        }
        agent_domain::BrainEvent::ResponseCancelled => {
            Some(SubmittedAnswerResolution::One { response_id: None })
        }
        _ => None,
    }
}

async fn close_with_terminal_session_phase<S>(
    sender: &mut S,
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
    if send_terminal_session_phase(sender, terminal_reason)
        .await
        .is_err()
    {
        return "send_failed";
    }
    let close_code = terminal_close_code(terminal_reason, close_code);
    let _ = close_with(sender, close_code, terminal_reason.close_reason()).await;
    terminal_reason.as_str()
}

async fn close_with_terminal_session_phase_only<S>(
    sender: &mut S,
    terminal_reason: TerminalSessionReason,
    close_code: u16,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if send_terminal_session_phase(sender, terminal_reason)
        .await
        .is_err()
    {
        return "send_failed";
    }
    let _ = close_with(sender, close_code, terminal_reason.close_reason()).await;
    terminal_reason.as_str()
}

fn terminal_label_after_terminal_phase_close(
    terminal_reason: TerminalSessionReason,
    close_terminal_reason: &'static str,
) -> &'static str {
    if terminal_reason == TerminalSessionReason::DurabilityDegraded {
        terminal_reason.as_str()
    } else {
        close_terminal_reason
    }
}

async fn close_with_client_stop<S>(
    sender: &mut S,
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
    sender: &mut S,
    terminal_reason: TerminalSessionReason,
) -> Result<(), axum::Error>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    send_json(
        sender,
        &ServerFrame::event(agent_domain::BrainEvent::TerminalSessionPhase {
            phase: StudySessionPhase::Recap,
            terminal_reason,
        }),
    )
    .await
}

struct BrainForwardContext<'a> {
    state: &'a AppState,
    voice_session_id: Option<String>,
    session_binding: &'a AuthorizedClientSession,
    limits: &'a VoiceLimitConfig,
    session_limits: &'a mut SessionLimitRuntime,
}

async fn drain_terminal_events<S>(
    context: &mut BrainForwardContext<'_>,
    events: &mut mpsc::Receiver<agent_domain::BrainEvent>,
    cancelled_responses: &mut CancelledResponseTracker,
    session_started_at: Instant,
    sender: &mut S,
) -> Result<ForwardBrainEvent, axum::Error>
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ForwardBrainEvent {
    Continue,
    Suppressed,
    Rejected,
    DurabilityDegraded,
    CostBudgetExceeded,
    ProviderFailure(TerminalSessionReason),
}

async fn forward_brain_event<S>(
    context: &mut BrainForwardContext<'_>,
    event: agent_domain::BrainEvent,
    cancelled_responses: &mut CancelledResponseTracker,
    session_elapsed: Duration,
    sender: &mut S,
) -> Result<ForwardBrainEvent, axum::Error>
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
        return Ok(ForwardBrainEvent::ProviderFailure(
            terminal_reason_for_provider_error(error),
        ));
    }
    match authorize_browser_event(context.state, context.session_binding, &event).await {
        BrowserEventAuthorization::Authorized => {}
        BrowserEventAuthorization::Rejected => {
            send_json(
                sender,
                &ServerFrame::error("provider source authority rejected"),
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
    let Some(frame) = ServerFrame::browser_event(event) else {
        return Ok(ForwardBrainEvent::Continue);
    };
    send_json(sender, &frame).await?;
    Ok(ForwardBrainEvent::Continue)
}

fn terminal_reason_for_brain_error(error: &BrainError) -> TerminalSessionReason {
    match error {
        BrainError::MissingApiKey => TerminalSessionReason::ProviderAuthFailed,
        BrainError::StageFailure(failure) => failure.terminal_reason,
        BrainError::Connection(message) => terminal_reason_for_provider_message(message),
        BrainError::Protocol(message) => {
            let reason = terminal_reason_for_provider_message(message);
            if reason == TerminalSessionReason::ProviderNetworkDisconnect {
                TerminalSessionReason::ProviderMalformedStream
            } else {
                reason
            }
        }
    }
}

fn brain_error_is_durability_degraded(state: &AppState, error: &BrainError) -> bool {
    if !state.study_store.capabilities().durable {
        return false;
    }
    match error {
        BrainError::Connection(message) | BrainError::Protocol(message) => {
            provider_store_error_message_is_durability_degraded(message)
        }
        BrainError::StageFailure(failure) => {
            failure.terminal_reason == TerminalSessionReason::DurabilityDegraded
        }
        BrainError::MissingApiKey => false,
    }
}

fn terminal_reason_for_provider_error(error: &BrainProviderError) -> TerminalSessionReason {
    if let Some(failure) = &error.failure {
        return failure.terminal_reason;
    }
    let combined = format!("{} {}", error.source, error.message);
    terminal_reason_for_provider_message(&combined)
}

fn provider_error_is_durability_degraded(state: &AppState, error: &BrainProviderError) -> bool {
    provider_error_is_durability_degraded_for_store(state.study_store.capabilities().durable, error)
}

fn provider_error_is_durability_degraded_for_store(
    store_is_durable: bool,
    error: &BrainProviderError,
) -> bool {
    if !store_is_durable {
        return false;
    }
    if let Some(failure) = &error.failure {
        return failure.terminal_reason == TerminalSessionReason::DurabilityDegraded;
    }
    provider_store_error_is_durability_degraded(&error.source, &error.message)
}

fn provider_store_error_is_durability_degraded(source: &str, message: &str) -> bool {
    let source = source.to_ascii_lowercase();
    if !matches!(
        source.as_str(),
        "synthetic-memory" | "fake-provider-store" | "cartesia-gemini-store"
    ) {
        return false;
    }
    message.trim().eq_ignore_ascii_case("store adapter error")
        || provider_store_error_message_is_durability_degraded(message)
}

fn provider_store_error_message_is_durability_degraded(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("store unavailable")
        || normalized.contains("database unavailable")
        || normalized.contains("durable store")
        || ((normalized.contains("postgres")
            || normalized.contains("database")
            || normalized.contains("store"))
            && (normalized.contains("connection")
                || normalized.contains("pool")
                || normalized.contains("timed out")
                || normalized.contains("timeout")))
}

fn terminal_reason_for_provider_message(message: &str) -> TerminalSessionReason {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("auth")
        || normalized.contains("api key")
        || normalized.contains("_api_key")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
        || normalized.contains("permission")
    {
        return TerminalSessionReason::ProviderAuthFailed;
    }
    if normalized.contains("rate")
        || normalized.contains("quota")
        || normalized.contains("budget")
        || normalized.contains("429")
    {
        return TerminalSessionReason::ProviderRateLimited;
    }
    if normalized.contains("timeout") || normalized.contains("timed out") {
        return TerminalSessionReason::ProviderTimeout;
    }
    if normalized.contains("slow client")
        || normalized.contains("stale socket")
        || normalized.contains("double submit")
        || normalized.contains("mic denied")
    {
        return TerminalSessionReason::SlowClient;
    }
    if normalized.contains("partial stage success") || normalized.contains("typed fallback") {
        return TerminalSessionReason::PartialStageSuccess;
    }
    if normalized.contains("tool_executor_failure") || normalized.contains("tool executor") {
        return TerminalSessionReason::ToolExecutorFailure;
    }
    if normalized.contains("cancel") || normalized.contains("abort") {
        return TerminalSessionReason::ProviderCancelled;
    }
    if normalized.contains("protocol")
        || normalized.contains("invalid")
        || normalized.contains("malformed")
        || normalized.contains("parse")
        || normalized.contains("schema")
    {
        return TerminalSessionReason::ProviderMalformedStream;
    }
    TerminalSessionReason::ProviderNetworkDisconnect
}

async fn open_failure_control_session(
    state: &AppState,
    config: SessionConfig,
    scenario: FailureControlScenario,
) -> Result<RealtimeSession, BrainError> {
    state
        .study_store
        .record_voice_session(&config)
        .await
        .map_err(|error| BrainError::Connection(error.to_string()))?;

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

fn failure_control_provider_error(scenario: FailureControlScenario) -> BrainProviderError {
    BrainProviderError {
        source: "failure_control".to_owned(),
        message: failure_control_provider_message(scenario),
        failure: None,
    }
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

fn store_adapter_error_is_durability_degraded(error: &PortError) -> bool {
    match error {
        PortError::Adapter { reason, .. } => {
            let normalized = reason.to_ascii_lowercase();
            normalized.contains("durable store")
                || normalized.contains("store unavailable")
                || normalized.contains("database unavailable")
                || normalized.contains("postgres unavailable")
                || normalized.contains("connection")
                || normalized.contains("pool")
                || normalized.contains("timed out")
                || normalized.contains("timeout")
        }
        PortError::Unavailable { .. } => false,
    }
}

#[derive(Default)]
struct CancelledResponseTracker {
    active_response_id: Option<String>,
    response_ids: HashSet<String>,
}

fn should_suppress_cancelled_response(
    cancelled_responses: &mut CancelledResponseTracker,
    event: &agent_domain::BrainEvent,
) -> bool {
    match event {
        agent_domain::BrainEvent::QuestionStarted { response_id, .. } => {
            cancelled_responses.active_response_id = Some(response_id.clone());
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
            false
        }
        agent_domain::BrainEvent::ResponseCancelled => {
            if let Some(response_id) = cancelled_responses.active_response_id.take() {
                cancelled_responses.response_ids.insert(response_id);
            }
            false
        }
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

fn nonce_claim_was_replayed(error: &PortError) -> bool {
    matches!(
        error,
        PortError::Unavailable { reason, .. } if reason == "session token nonce already used"
    )
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
) -> Result<ClientAction, ClientFrameError> {
    match client_input_action(message, session_binding)? {
        ClientInputAction::Send {
            brain_input,
            action,
        } => input
            .send(brain_input)
            .await
            .map(|_| action)
            .map_err(|_| ClientFrameError::disconnected()),
        ClientInputAction::TrySend {
            brain_input,
            action,
        } => {
            let _ = input.try_send(brain_input);
            Ok(action)
        }
        ClientInputAction::Keepalive => Ok(ClientAction::Keepalive),
    }
}

fn prepare_client_message_with_drain(
    message: Message,
    session_binding: &AuthorizedClientSession,
    limits: &VoiceLimitConfig,
    session_limits: &mut SessionLimitRuntime,
) -> Result<ClientInputAction, ClientMessageError> {
    let action =
        client_input_action(message, session_binding).map_err(ClientMessageError::Frame)?;
    if let ClientInputAction::Send { brain_input, .. } = &action {
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
        } => send_brain_input_with_deadline(input, brain_input, drain_signal, turn_deadline)
            .await
            .map(|_| action),
        ClientInputAction::TrySend {
            brain_input,
            action,
        } => {
            let _ = input.try_send(brain_input);
            Ok(action)
        }
        ClientInputAction::Keepalive => Ok(ClientAction::Keepalive),
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

fn client_input_action(
    message: Message,
    session_binding: &AuthorizedClientSession,
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
                ClientFrame::SessionConfig { session, .. } => {
                    let sanitized = sanitize_refresh_session_config(session, session_binding)?;
                    Ok(ClientInputAction::Send {
                        brain_input: BrainInput::SessionContextRefresh(
                            serde_json::to_value(sanitized)
                                .map_err(|_| ClientFrameError::invalid())?,
                        ),
                        action: ClientAction::ConfigRefresh,
                    })
                }
                ClientFrame::Audio {
                    frame,
                    client_generation_id,
                    ..
                } => {
                    let client_generation_id =
                        validated_client_generation_id(client_generation_id)?;
                    Ok(ClientInputAction::Send {
                        brain_input: match client_generation_id {
                            Some(client_generation_id) => BrainInput::AudioWithMetadata {
                                frame,
                                client_generation_id: Some(client_generation_id),
                            },
                            None => BrainInput::Audio(frame),
                        },
                        action: ClientAction::Audio,
                    })
                }
                ClientFrame::Text {
                    text,
                    client_generation_id,
                    ..
                } => {
                    let client_generation_id =
                        validated_client_generation_id(client_generation_id)?;
                    Ok(ClientInputAction::Send {
                        brain_input: match client_generation_id {
                            Some(client_generation_id) => BrainInput::TextWithMetadata {
                                text,
                                client_generation_id: Some(client_generation_id),
                            },
                            None => BrainInput::Text(text),
                        },
                        action: ClientAction::AnswerText,
                    })
                }
                ClientFrame::ToolResult { .. } => Err(ClientFrameError::untrusted_tool_result()),
                ClientFrame::Cancel { .. } => Ok(ClientInputAction::Send {
                    brain_input: BrainInput::CancelResponse,
                    action: ClientAction::Cancel,
                }),
                ClientFrame::Stop { .. } => Ok(ClientInputAction::TrySend {
                    brain_input: BrainInput::Stop,
                    action: ClientAction::Stop,
                }),
            }
        }
        Message::Binary(bytes) => {
            if bytes.len() > VIVA_VOICE_MAX_BINARY_FRAME_BYTES {
                return Err(ClientFrameError::oversized_binary());
            }
            Ok(ClientInputAction::Send {
                brain_input: BrainInput::Audio(AudioFrame::from_pcm16_bytes(bytes)),
                action: ClientAction::Audio,
            })
        }
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

fn initial_session_config_from_message(
    message: Message,
) -> Result<InitialSessionConfig, ClientFrameError> {
    let Message::Text(text) = message else {
        return Err(ClientFrameError::invalid_first_frame());
    };
    if text.len() > VIVA_VOICE_MAX_TEXT_FRAME_BYTES {
        return Err(ClientFrameError::oversized_text());
    }
    let frame: InitialClientFrame =
        serde_json::from_str(&text).map_err(|_| ClientFrameError::invalid())?;
    if frame.version != VIVA_VOICE_PROTOCOL_VERSION {
        return Err(ClientFrameError::invalid());
    }
    if frame.frame_type != "session_config" {
        return Err(ClientFrameError::invalid_first_frame());
    }
    let client_generation_id = validated_client_generation_id(frame.client_generation_id)?;
    Ok(InitialSessionConfig {
        client_generation_id,
        session: frame.session,
        session_token: frame.session_token,
    })
}

fn sanitize_client_session_config(
    mut config: SessionConfig,
    session_binding: &AuthorizedClientSession,
) -> Result<SessionConfig, ClientFrameError> {
    let Some(session_id) = config.session_id.as_deref() else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    if session_id.trim().is_empty() || session_id != session_binding.session_id {
        return Err(ClientFrameError::invalid_session_identity());
    }
    let Some(user_id) = config.user_id.as_deref() else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    if user_id.trim().is_empty() || user_id != session_binding.user_id {
        return Err(ClientFrameError::invalid_session_identity());
    }
    let Some(study_set_id) = config.study_set_id.as_deref() else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    if study_set_id.trim().is_empty() || study_set_id != session_binding.study_set_id {
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
    request_origin: &str,
) -> Result<AuthorizedInitialSessionConfig, ClientFrameError> {
    let mut rotate_trusted_session = false;
    let mut failure_control = None;
    let (binding, token_nonce_claim) = if let Some(secret) =
        state.ws_access.session_token_secret.as_deref()
    {
        let token = initial.session_token.as_deref().ok_or_else(|| {
            ClientFrameError::session_auth_failed(SessionAuthFailureCode::Malformed)
        })?;
        let claims = SessionTokenClaims::verify(token, secret).map_err(|error| {
            ClientFrameError::session_auth_failed(SessionAuthFailureCode::from_token_error(&error))
        })?;
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
            AuthorizedClientSession {
                user_id: claims.user_id.clone(),
                study_set_id: claims.study_set_id.clone(),
                session_id: claims.session_id.clone(),
            },
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
            AuthorizedClientSession {
                user_id: state.trusted_user_id.clone(),
                study_set_id: state.trusted_study_set_id.clone(),
                session_id: state.trusted_session_id.clone(),
            },
            None,
        )
    };
    let mut config = sanitize_client_session_config(initial.session, &binding)?;
    config.client_generation_id = initial.client_generation_id;
    if rotate_trusted_session {
        config.session_id = Some(agent_domain::SessionId::new(
            state.next_trusted_voice_session_id(),
        ));
    }
    Ok(AuthorizedInitialSessionConfig {
        config,
        token_nonce_claim,
        failure_control,
    })
}

fn sanitize_refresh_session_config(
    config: SessionConfig,
    session_binding: &AuthorizedClientSession,
) -> Result<SessionConfig, ClientFrameError> {
    sanitize_client_session_config(config, session_binding)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AuthorizedClientSession {
    user_id: String,
    study_set_id: String,
    session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InitialSessionConfig {
    client_generation_id: Option<String>,
    session: SessionConfig,
    session_token: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AuthorizedInitialSessionConfig {
    config: SessionConfig,
    token_nonce_claim: Option<SessionTokenNonceClaim>,
    failure_control: Option<FailureControlScenario>,
}

#[derive(Debug, Deserialize)]
struct InitialClientFrame {
    #[serde(rename = "type")]
    frame_type: String,
    version: u32,
    session: SessionConfig,
    #[serde(default)]
    client_generation_id: Option<String>,
    #[serde(default)]
    session_token: Option<String>,
}

impl AuthorizedClientSession {
    fn from_config(config: &SessionConfig) -> Option<Self> {
        Some(Self {
            user_id: config.user_id.clone()?,
            study_set_id: config.study_set_id.clone()?,
            session_id: config.session_id.as_ref()?.to_string(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClientAction {
    Audio,
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
    },
    TrySend {
        brain_input: BrainInput,
        action: ClientAction,
    },
    Keepalive,
}

impl ClientInputAction {
    fn action(&self) -> ClientAction {
        match self {
            Self::Send { action, .. } | Self::TrySend { action, .. } => *action,
            Self::Keepalive => ClientAction::Keepalive,
        }
    }
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
    message: &'static str,
    close_code: u16,
    close_reason: &'static str,
    terminal_reason: &'static str,
}

impl ClientFrameError {
    fn invalid_first_frame() -> Self {
        Self {
            auth_failure_code: None,
            message: "first client frame must be session_config",
            close_code: close_code::PROTOCOL,
            close_reason: "session config required",
            terminal_reason: "invalid_first_frame",
        }
    }

    fn invalid() -> Self {
        Self {
            auth_failure_code: None,
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

    fn study_store_unavailable() -> Self {
        Self {
            auth_failure_code: None,
            message: "study store unavailable",
            close_code: close_code::POLICY,
            close_reason: "study store unavailable",
            terminal_reason: "study_store_unavailable",
        }
    }

    fn nonce_store_unavailable() -> Self {
        Self {
            auth_failure_code: None,
            message: "session token nonce store unavailable",
            close_code: close_code::POLICY,
            close_reason: "session token nonce store unavailable",
            terminal_reason: concat!("session_", "token_nonce_store_unavailable"),
        }
    }

    fn untrusted_tool_result() -> Self {
        Self {
            auth_failure_code: None,
            message: "browser tool_result frames are not trusted",
            close_code: close_code::POLICY,
            close_reason: "untrusted tool_result",
            terminal_reason: "untrusted_tool_result",
        }
    }

    fn oversized_text() -> Self {
        Self {
            auth_failure_code: None,
            message: "text frame exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "text frame too large",
            terminal_reason: "oversized_text_frame",
        }
    }

    fn oversized_binary() -> Self {
        Self {
            auth_failure_code: None,
            message: "binary frame exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "binary frame too large",
            terminal_reason: "oversized_binary_frame",
        }
    }

    fn disconnected() -> Self {
        Self {
            auth_failure_code: None,
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
        ClientAction::Keepalive => return,
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

const PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS: usize = 240;

fn provider_stage_failure_detail(failure: &BrainProviderFailure) -> String {
    let retry_after_ms = metadata_field(&failure.metadata, "retry_after_ms");
    let retry_after_source = metadata_field(&failure.metadata, "retry_after_source");
    let reset_hint = metadata_field(&failure.metadata, "reset_hint");
    let budget_state = metadata_field(&failure.metadata, "budget_state");
    let deploy_sha = metadata_field(&failure.metadata, "deploy_sha");
    let fields = [
        format!("failure_class={}", failure.failure_class),
        format!("stage={}", failure.stage),
        format!("terminal_reason={}", failure.terminal_reason.as_str()),
        format!("provider={}", bounded_evidence_value(&failure.provider, 24)),
        format!("model={}", bounded_evidence_value(&failure.model, 24)),
        format!("latency_ms={}", failure.latency_ms),
        format!("deploy_sha={}", deploy_sha.unwrap_or("unknown")),
        format!("retry_after_ms={}", retry_after_ms.unwrap_or("unknown")),
        format!(
            "retry_after_source={}",
            retry_after_source.unwrap_or("unknown")
        ),
        format!("reset_hint={}", reset_hint.unwrap_or("unknown")),
        format!("budget_state={}", budget_state.unwrap_or("unknown")),
    ];
    bounded_evidence_detail(fields)
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
    record_terminal_evidence(state, voice_session_id, terminal_reason);
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

fn record_terminal_evidence(state: &AppState, voice_session_id: Option<String>, reason: &str) {
    let counts = state.study_store.write_counts();
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
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::Close,
        voice_session_id,
        reason,
    ));
}

async fn send_json<S>(sender: &mut S, frame: &ServerFrame) -> Result<(), axum::Error>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let text = serde_json::to_string(frame).unwrap_or_else(|_| {
        "{\"type\":\"error\",\"version\":1,\"message\":\"serialization failed\"}".to_owned()
    });
    sender.send(Message::Text(text.into())).await
}

async fn close_with<S>(sender: &mut S, code: u16, reason: &'static str) -> Result<(), axum::Error>
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

fn ws_access_error(error: VoiceWsAccessError) -> (StatusCode, Json<serde_json::Value>) {
    let status = match error {
        VoiceWsAccessError::OriginDenied => StatusCode::FORBIDDEN,
        VoiceWsAccessError::MissingBearer | VoiceWsAccessError::InvalidBearer => {
            StatusCode::UNAUTHORIZED
        }
    };
    (status, Json(json!({ "error": error.to_string() })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_adapters::SyntheticBrain;
    use agent_domain::{BrainProviderFailure, BrainProviderFailureParts};
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
        }
    }

    #[test]
    fn provider_message_classifier_covers_failure_control_terminal_reasons() {
        assert_eq!(
            terminal_reason_for_provider_message("synthetic provider 429 rate limit"),
            TerminalSessionReason::ProviderRateLimited
        );
        assert_eq!(
            terminal_reason_for_provider_message("synthetic provider auth failed"),
            TerminalSessionReason::ProviderAuthFailed
        );
        assert_eq!(
            terminal_reason_for_provider_message("synthetic provider timeout"),
            TerminalSessionReason::ProviderTimeout
        );
        assert_eq!(
            terminal_reason_for_provider_message("synthetic provider malformed stream"),
            TerminalSessionReason::ProviderMalformedStream
        );
        assert_eq!(
            terminal_reason_for_provider_message("synthetic provider network disconnect"),
            TerminalSessionReason::ProviderNetworkDisconnect
        );
        assert_eq!(
            terminal_reason_for_provider_message("synthetic slow client double submit race"),
            TerminalSessionReason::SlowClient
        );
        assert_eq!(
            terminal_reason_for_provider_message("synthetic partial stage success typed fallback"),
            TerminalSessionReason::PartialStageSuccess
        );
    }

    #[test]
    fn durability_classifier_ignores_semantic_adapter_errors() {
        assert!(provider_store_error_message_is_durability_degraded(
            "postgres adapter error: durable store write failed"
        ));
        assert!(provider_store_error_message_is_durability_degraded(
            "postgres connection pool timed out"
        ));
        assert!(!provider_store_error_message_is_durability_degraded(
            "postgres adapter error: closed voice session cannot be reopened"
        ));
        assert!(!provider_store_error_message_is_durability_degraded(
            "postgres unavailable for missing-study-set: study set does not exist"
        ));
        assert!(!provider_store_error_message_is_durability_degraded(
            "postgres unavailable for concept-1: concept is not available for this study set"
        ));
        assert!(!provider_store_error_message_is_durability_degraded(
            "shared Cartesia/Gemini runner is wired but live transports remain gated; no network connection was attempted"
        ));
    }

    #[test]
    fn durability_classifier_preserves_sanitized_store_adapter_marker_for_store_sources() {
        assert!(provider_store_error_is_durability_degraded(
            "fake-provider-store",
            "store adapter error"
        ));
        assert!(provider_store_error_is_durability_degraded(
            "cartesia-gemini-store",
            "store adapter error"
        ));
        assert!(!provider_store_error_is_durability_degraded(
            "agent-service",
            "store adapter error"
        ));
        assert!(!provider_store_error_is_durability_degraded(
            "fake-provider-store",
            "postgres adapter error: closed voice session cannot be reopened"
        ));
    }

    #[test]
    fn failure_control_provider_message_includes_scenario_and_stage_marker() {
        let message = failure_control_provider_message(FailureControlScenario::SonicTtsTimeout);

        assert!(message.contains("timeout"));
        assert!(message.contains("scenario=sonic_tts_timeout"));
        assert!(message.contains("stage=sonic_tts"));
        assert_eq!(
            terminal_reason_for_provider_message(&message),
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
        let error = BrainProviderError::from_stage_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: "tool_executor_failure".to_owned(),
                stage: "tools".to_owned(),
                terminal_reason: TerminalSessionReason::ToolExecutorFailure,
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
        let error = BrainProviderError::from_stage_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: "store_adapter_error".to_owned(),
                stage: "tools".to_owned(),
                terminal_reason: TerminalSessionReason::DurabilityDegraded,
                retry_eligible: true,
                latency_ms: 12,
                provider: "server".to_owned(),
                model: "viva-tools".to_owned(),
                metadata: "tool=retrieve_source_reference error_kind=store".to_owned(),
            },
        ));
        assert!(!provider_store_error_is_durability_degraded(
            &error.source,
            &error.message
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
        let mut context = BrainForwardContext {
            state: &state,
            voice_session_id: Some("voice-session-1".to_owned()),
            session_binding: &binding,
            limits: &limits,
            session_limits: &mut session_limits,
        };
        let mut cancelled_responses = CancelledResponseTracker::default();
        let mut sender = RecordingSink::new();
        let error = BrainProviderError::from_stage_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: "store_adapter_error".to_owned(),
                stage: "recap".to_owned(),
                terminal_reason: TerminalSessionReason::DurabilityDegraded,
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
        assert!(sender.sent.is_empty());
        let evidence = state.evidence.snapshot();
        assert!(evidence.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::ProviderStageFailure
                && event.detail.contains("failure_class=store_adapter_error")
                && event.detail.contains("stage=recap")
                && event.detail.contains("terminal_reason=durability_degraded")
                && event.detail.contains("latency_ms=37")
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
        let error = BrainProviderError::from_stage_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: "quota_rate_failure".to_owned(),
                stage: "gemini".to_owned(),
                terminal_reason: TerminalSessionReason::ProviderRateLimited,
                retry_eligible: true,
                latency_ms: 123,
                provider: "gemini".to_owned(),
                model: "gemini-35-flash".to_owned(),
                metadata:
                    "http_status=429 retry_after_ms=7000 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=unknown deploy_sha=unknown"
                        .to_owned(),
            },
        ));

        record_provider_stage_failure(&state, Some("voice-session-1".to_owned()), &error);

        let events = state.evidence.snapshot();
        assert_eq!(events.len(), 1);
        let detail = &events[0].detail;
        assert!(detail.len() <= 240);
        assert!(detail.contains("failure_class=quota_rate_failure"));
        assert!(detail.contains("stage=gemini"));
        assert!(detail.contains("terminal_reason=provider_rate_limited"));
        assert!(detail.contains("provider=gemini"));
        assert!(detail.contains("model=gemini-35-flash"));
        assert!(detail.contains("latency_ms=123"));
        assert!(detail.contains("deploy_sha=unknown"));
        assert!(detail.contains("retry_after_ms=7000"));
        assert!(detail.contains("retry_after_source=retry_after_delta"));
        assert!(detail.contains("budget_state=unknown"));
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
        let error = BrainProviderError::from_stage_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: "quota_rate_failure".to_owned(),
                stage: "gemini".to_owned(),
                terminal_reason: TerminalSessionReason::ProviderRateLimited,
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
        assert!(detail.len() <= 240);
        assert!(detail.contains("failure_class=quota_rate_failure"));
        assert!(detail.contains("stage=gemini"));
        assert!(detail.contains("terminal_reason=provider_rate_limited"));
        assert!(detail.contains("provider=gemini"));
        assert!(detail.contains("model=gemini-35-flash-preview-"));
        assert!(detail.contains("latency_ms=123"));
        assert!(detail.contains("deploy_sha=unknown"));
        assert!(detail.contains("retry_after_ms=7000"));
        assert!(detail.contains("retry_after_source=retry_after_delta"));
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
        let audio = include_str!("../../../fixtures/voice-protocol/client-audio.json");
        let binding = fixture_binding();

        handle_client_message(Message::Text(audio.to_owned().into()), &input, &binding)
            .await
            .unwrap();
        handle_client_message(
            Message::Text(
                json!({"type":"text","version":VIVA_VOICE_PROTOCOL_VERSION,"text":"quiz me"})
                    .to_string()
                    .into(),
            ),
            &input,
            &binding,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(
                json!({"type":"cancel","version":VIVA_VOICE_PROTOCOL_VERSION})
                    .to_string()
                    .into(),
            ),
            &input,
            &binding,
        )
        .await
        .unwrap();

        match received.recv().await.unwrap() {
            BrainInput::Audio(frame) => assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]),
            other => panic!("expected audio input, got {other:?}"),
        }
        match received.recv().await.unwrap() {
            BrainInput::Text(text) => assert_eq!(text, "quiz me"),
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

        assert_eq!(
            initial.client_generation_id.as_deref(),
            Some("token_refresh-3")
        );
        assert_eq!(
            initial.session_token.as_deref(),
            Some("placeholder-session-material")
        );
        assert_eq!(initial.session.client_generation_id, None);
    }

    #[tokio::test]
    async fn maps_client_generation_ids_to_brain_inputs() {
        let (input, mut received) = mpsc::channel(8);
        let binding = fixture_binding();

        handle_client_message(
            Message::Text(
                json!({
                    "type": "text",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "text": "quiz me",
                    "client_generation_id": "bfcache_restore-2",
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(
                json!({
                    "type": "audio",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "frame": { "pcm16_base64": "AQIDBA==" },
                    "client_generation_id": "token_refresh-3",
                })
                .to_string()
                .into(),
            ),
            &input,
            &binding,
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

    #[tokio::test]
    async fn maps_binary_pcm_frames_to_audio_input() {
        let (input, mut received) = mpsc::channel(8);
        let binding = fixture_binding();

        handle_client_message(Message::Binary(vec![5_u8, 6, 7].into()), &input, &binding)
            .await
            .unwrap();

        match received.recv().await.unwrap() {
            BrainInput::Audio(frame) => assert_eq!(frame.pcm16_bytes(), &[5, 6, 7]),
            other => panic!("expected audio input, got {other:?}"),
        }
    }

    #[test]
    fn requires_session_config_as_bootstrap_frame() {
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");
        let message = Message::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#
            )
            .into(),
        );
        let config = session_config_from_message(message).unwrap();

        assert_eq!(config.study_set_id.as_deref(), Some("biology-midterm"));
        assert!(session_config_from_message(Message::Text(
            json!({"type":"text","version":VIVA_VOICE_PROTOCOL_VERSION,"text":"quiz me"})
                .to_string()
                .into()
        ))
        .is_err());
    }

    #[test]
    fn sanitizes_session_config_identity_and_strips_browser_source_context() {
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");
        let message = Message::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"session":{session}}}"#
            )
            .into(),
        );
        let config = session_config_from_message(message).unwrap();
        let binding = fixture_binding();
        let sanitized = sanitize_client_session_config(config, &binding).unwrap();

        assert_eq!(sanitized.user_id.as_deref(), Some("user-1"));
        assert_eq!(sanitized.study_set_id.as_deref(), Some("biology-midterm"));
        assert_eq!(sanitized.session_id.as_deref(), Some("voice-session-1"));
        assert!(sanitized.source_context.is_empty());
        assert!(sanitized.active_concepts.is_empty());

        let mut missing_session = sanitized.clone();
        missing_session.session_id = None;
        assert_eq!(
            sanitize_client_session_config(missing_session, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut forged_session = sanitized.clone();
        forged_session.session_id = Some(agent_domain::SessionId::new("voice-session-2"));
        assert_eq!(
            sanitize_client_session_config(forged_session, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut forged_user = sanitized.clone();
        forged_user.user_id = Some("user-2".to_owned());
        assert_eq!(
            sanitize_client_session_config(forged_user, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut forged_study_set = sanitized.clone();
        forged_study_set.study_set_id = Some("chemistry-final".to_owned());
        assert_eq!(
            sanitize_client_session_config(forged_study_set, &binding),
            Err(ClientFrameError::invalid_session_identity())
        );

        let mut missing_study_set = sanitized;
        missing_study_set.study_set_id = None;
        assert_eq!(
            sanitize_client_session_config(missing_study_set, &binding),
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
        )
        .await;

        assert_eq!(result, Err(ClientFrameError::untrusted_tool_result()));
    }

    #[tokio::test]
    async fn keepalive_frames_do_not_reach_brain_input() {
        let (input, mut received) = mpsc::channel(1);
        let binding = fixture_binding();

        assert_eq!(
            handle_client_message(Message::Ping(vec![1, 2, 3].into()), &input, &binding).await,
            Ok(ClientAction::Keepalive)
        );
        assert_eq!(
            handle_client_message(Message::Pong(vec![1, 2, 3].into()), &input, &binding).await,
            Ok(ClientAction::Keepalive)
        );
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn rejects_oversized_text_and_binary_frames() {
        let (input, _received) = mpsc::channel(8);
        let binding = fixture_binding();
        let too_large_text = "x".repeat(VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1);
        let too_large_audio = vec![0_u8; VIVA_VOICE_MAX_BINARY_FRAME_BYTES + 1];

        assert_eq!(
            handle_client_message(Message::Text(too_large_text.into()), &input, &binding).await,
            Err(ClientFrameError::oversized_text())
        );
        assert_eq!(
            handle_client_message(Message::Binary(too_large_audio.into()), &input, &binding).await,
            Err(ClientFrameError::oversized_binary())
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
                required_bearer: Some("secret".to_owned()),
                session_token_secret: None,
                allowed_origins: vec![],
            },
            1,
        );
        let headers = HeaderMap::new();
        match validate_ws_preflight(&auth_state, &headers) {
            Err((status, _)) => assert_eq!(status, StatusCode::UNAUTHORIZED),
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
        match validate_ws_preflight(&origin_state, &headers) {
            Err((status, _)) => assert_eq!(status, StatusCode::FORBIDDEN),
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
        match validate_ws_preflight(&capacity_state, &HeaderMap::new()) {
            Err((status, _)) => assert_eq!(status, StatusCode::TOO_MANY_REQUESTS),
            Ok(_) => panic!("expected capacity rejection"),
        }
    }

    #[tokio::test]
    async fn terminal_session_phase_close_reports_send_failed_when_writer_fails() {
        let (input, mut received) = mpsc::channel(1);
        let mut sender = FailingSink;
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

        assert_eq!(reason, "send_failed");
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
                TerminalSessionReason::Drained,
                "send_failed"
            ),
            "send_failed"
        );
    }

    #[tokio::test]
    async fn terminal_session_phase_close_does_not_wait_for_full_input_channel() {
        let (input, mut received) = mpsc::channel(1);
        input
            .try_send(BrainInput::Text("queued".to_owned()))
            .unwrap();
        let mut sender = RecordingSink::new();
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
        assert_eq!(sender.sent.len(), 2);
        let Message::Text(text) = &sender.sent[0] else {
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
        let Message::Close(Some(close)) = &sender.sent[1] else {
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
        let mut sender = RecordingSink::new();
        let limits = VoiceLimitConfig::default();
        let mut session_limits = SessionLimitRuntime::new();
        let binding = fixture_binding();
        let mut context = BrainForwardContext {
            state: &state,
            voice_session_id: Some("voice-session-1".to_owned()),
            session_binding: &binding,
            limits: &limits,
            session_limits: &mut session_limits,
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
        assert!(sender.sent.is_empty());
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
}
