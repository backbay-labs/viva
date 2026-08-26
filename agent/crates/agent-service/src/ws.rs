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

pub(crate) mod admission;
mod preflight;
mod provider;
mod terminal;
mod turn;

// `SERVICE-017`: the five responsibility modules are the same namespace this file
// used to be. Each one re-enters through `use super::*`, so a moved item resolves
// from its new home exactly as it did from this one.
use admission::*;
use preflight::*;
use provider::*;
use terminal::*;
use turn::*;

use crate::{
    app::AppState,
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

    // `SERVICE-012`: a socket parked here holds a session slot and an
    // active-handler guard, and the process drain waits for both. The deadline it
    // waits out is this server-owned first-frame bound, which is shorter than the
    // drain grace; the drain deliberately does not preempt it, because a first
    // frame the client has already put on the wire must not be discarded by a
    // reactor-scheduling race.
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
                        close_client_frame_error_before_session(&state, &mut sender, None, error)
                            .await;
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
    // `SERVICE-012`: the three per-session reservations are held for the whole
    // socket life and released only after the session and its queued provider
    // admissions are gone, in the reverse of this acquisition order.
    let Some(leases) = acquire_session_leases(
        &state,
        &mut sender,
        &session_binding,
        initial.failure_control,
    )
    .await
    else {
        return;
    };
    if !admit_provider_backoff(&state, &mut sender, voice_session_id.clone()).await {
        return;
    }
    // `SERVICE-004`: the single atomic nonce claim is the last gate before any
    // study lookup, queueing, or provider input, so a replayed credential never
    // reads a study set at all. Both steps live together in `ws/preflight.rs`
    // precisely so that order cannot drift apart.
    let Some(study_context) = claim_nonce_and_authorize_study_set(
        &state,
        &mut sender,
        voice_session_id.clone(),
        initial.token_nonce_claim.take(),
        &initial.config,
    )
    .await
    else {
        return;
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

    let Some(mut session) = open_provider_session(
        &state,
        &mut sender,
        voice_session_id.clone(),
        initial_config,
        failure_control,
    )
    .await
    else {
        return;
    };
    let mut terminal_reason = "event_stream_closed";
    let mut terminal_close = TerminalCloseState::default();
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
            &mut terminal_close,
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
                        &mut terminal_close,
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
                    &mut terminal_close,
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
                    &mut terminal_close,
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
                    &mut terminal_close,
                    TerminalSessionReason::TurnCap,
                    close_code::POLICY,
                )
                .await;
                break;
            }
            _ = &mut heartbeat_timer => {
                if let Some(reason) = drive_heartbeat_timer(
                    &mut heartbeat,
                    heartbeat_timer.as_mut(),
                    &mut sender,
                    &mut session,
                    &state,
                    voice_session_id.clone(),
                    &mut terminal_close,
                )
                .await
                {
                    terminal_reason = reason;
                    break;
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
                        &mut terminal_close,
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
                                terminal_reason = handle_outbound_write_failure(&error, &mut session, &mut terminal_close);
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        terminal_reason = close_for_client_message_error(
                            &mut sender,
                            &mut session,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_close,
                            error,
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
                            terminal_reason = handle_outbound_write_failure(&error, &mut session, &mut terminal_close);
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
                    // Ordered before the catch-all: pre-send parsing has no turn
                    // cap to trip, and a silent graceful close here would hide
                    // that the invariant moved.
                    Err(ClientMessageError::TurnCap) => unreachable!("pre-send parsing cannot trip turn cap"),
                    Err(error) => {
                        // Only this rejection is client-attributable before the
                        // frame is forwarded, so only this one records an auth
                        // failure — before anything is written back.
                        if let ClientMessageError::Frame(frame) = &error {
                            record_session_auth_failure(&state, voice_session_id.clone(), frame.auth_failure_code)
                                .await;
                        }
                        terminal_reason = close_for_client_message_error(
                            &mut sender,
                            &mut session,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_close,
                            error,
                        )
                        .await;
                        break;
                    }
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
                        terminal_reason = handle_outbound_write_failure(&error, &mut session, &mut terminal_close);
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
                        Err(error) => {
                            terminal_reason = close_for_client_message_error(
                                &mut sender,
                                &mut session,
                                &state,
                                voice_session_id.clone(),
                                &mut terminal_close,
                                error,
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
                        let outcome = forward_ready_brain_events(
                            &mut forward_context,
                            &mut session.events,
                            &mut cancelled_responses,
                            session_started_at,
                            &mut sender,
                            &mut provider_runtime,
                        )
                        .await;
                        if let Some(reason) = close_for_forward_outcome(
                            &forward_context,
                            &mut sender,
                            &mut session,
                            &mut terminal_close,
                            outcome,
                        )
                        .await
                        {
                            terminal_reason = reason;
                            break;
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
                            &mut terminal_close,
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
                                terminal_reason = handle_outbound_write_failure(&error, &mut session, &mut terminal_close);
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
                                let outcome = drain_terminal_events(
                                    &mut forward_context,
                                    &mut session.events,
                                    &mut cancelled_responses,
                                    session_started_at,
                                    &mut sender,
                                )
                                .await;
                                // A stop whose terminal drain could not be
                                // written still owes the client the Close frame
                                // its stop asked for; that is the one arm this
                                // site does not share with the other two.
                                if let Err(error) = &outcome {
                                    terminal_reason = handle_outbound_write_failure(error, &mut session, &mut terminal_close);
                                    let _ = close_with(
                                        &mut sender,
                                        close_code::NORMAL,
                                        "client stop",
                                    )
                                    .await;
                                    break;
                                }
                                if let Some(reason) = close_for_forward_outcome(
                                    &forward_context,
                                    &mut sender,
                                    &mut session,
                                    &mut terminal_close,
                                    outcome,
                                )
                                .await
                                {
                                    terminal_reason = reason;
                                    break;
                                }
                                terminal_reason = close_with_client_stop(
                                    &mut sender,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_close,
                                )
                                .await;
                                break;
                            }
                            ClientAction::Close => {
                                terminal_reason = close_with_client_stop(
                                    &mut sender,
                                    &state,
                                    voice_session_id.clone(),
                                    &mut terminal_close,
                                )
                                .await;
                                break;
                            }
                            _ => {}
                        }
                    }
                    Err(error) => {
                        terminal_reason = close_for_client_message_error(
                            &mut sender,
                            &mut session,
                            &state,
                            voice_session_id.clone(),
                            &mut terminal_close,
                            error,
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
                let outcome = forward_brain_event_with_turn_accounting(
                    &mut forward_context,
                    event,
                    &mut cancelled_responses,
                    session_started_at,
                    &mut sender,
                    &mut provider_runtime,
                )
                .await;
                if let Some(reason) = close_for_forward_outcome(
                    &forward_context,
                    &mut sender,
                    &mut session,
                    &mut terminal_close,
                    outcome,
                )
                .await
                {
                    terminal_reason = reason;
                    break;
                }
            }
        }
    }
    if terminal_close.persisted {
        record_terminal_evidence(&state, voice_session_id, terminal_reason).await;
    } else {
        record_terminal(&state, voice_session_id, terminal_reason).await;
    }
    // `SERVICE-002`: every server-owned permit is released *before* the closing
    // handshake is waited on, so a client that never answers the Close cannot
    // hold a lease for the length of that wait.
    drop(pending_provider_admissions);
    drop(session);
    drop(leases.user_study_set);
    drop(leases.user_total);
    drop(leases.failure_control_identity);
    drop(admission);
    // A socket whose own write side already failed, or whose client is already
    // gone, has no handshake left to finish and must not wait for one.
    if should_finish_closing_handshake(terminal_close.write_failed, terminal_reason) {
        finish_closing_handshake(&mut receiver, CLOSING_HANDSHAKE_GRACE).await;
    }
}

#[cfg(test)]
mod tests;
