//! `SERVICE-017`: provider task spawn/stop, provider stream receive, durable event forwarding prerequisites, and provider backoff input.
//!
//! Moved verbatim out of `ws.rs` by the responsibility split. No route,
//! response, timer, capacity transition, authorization decision, store or
//! provider call, protocol frame, or cleanup order changed; only the file the
//! code lives in and the visibility the move forces.

use super::*;

pub(super) const TERMINAL_EVENT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) fn abort_realtime_session_tasks(session: &mut agent_domain::RealtimeSession) {
    drop(session.task_guard.take());
}

/// `SERVICE-017`: open the provider session for this socket — the selected
/// failure-control scenario when one is bound, the real brain otherwise — and
/// record the outcome.
///
/// `None` means the open failed: the degraded-durability evidence, or the
/// provider-failure evidence, is already recorded, the terminal session phase is
/// already emitted, and the terminal reason is already recorded, so the caller
/// returns. Moved out of the session loop unchanged, including recording
/// `SessionOpened` only after a successful open.
pub(super) async fn open_provider_session<S>(
    state: &AppState,
    sender: &mut BoundedSender<S>,
    voice_session_id: Option<String>,
    config: SessionConfig,
    failure_control: Option<FailureControlScenario>,
) -> Option<agent_domain::RealtimeSession>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let session_result = match failure_control {
        Some(scenario) => open_failure_control_session(state, config, scenario).await,
        None => state.brain.open(config).await,
    };
    match session_result {
        Ok(session) => {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::SessionOpened,
                voice_session_id,
                "session opened",
            ));
            Some(session)
        }
        Err(error) => {
            let terminal_reason = if brain_error_is_durability_degraded(state, &error) {
                state.evidence.record(VoiceEvidenceEvent::new(
                    VoiceEvidenceEventKind::StoreCounts,
                    voice_session_id.clone(),
                    "durability_degraded",
                ));
                TerminalSessionReason::DurabilityDegraded
            } else {
                record_brain_open_provider_failure(state, voice_session_id.clone(), &error);
                terminal_reason_for_brain_error(&error)
            };
            let close_terminal_reason =
                close_with_terminal_session_phase_only(sender, terminal_reason, close_code::ERROR)
                    .await;
            let recorded_terminal_reason =
                terminal_label_after_terminal_phase_close(terminal_reason, close_terminal_reason);
            record_terminal(state, voice_session_id, recorded_terminal_reason).await;
            None
        }
    }
}

pub(super) struct BrainForwardContext<'a> {
    pub(super) state: &'a AppState,
    pub(super) voice_session_id: Option<String>,
    pub(super) session_binding: &'a AuthorizedClientSession,
    pub(super) limits: &'a VoiceLimitConfig,
    pub(super) session_limits: &'a mut SessionLimitRuntime,
    pub(super) turn_bindings: &'a mut TurnBindingTracker,
}

pub(super) async fn drain_terminal_events<S>(
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

pub(super) async fn forward_ready_brain_events<S>(
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

pub(super) async fn forward_brain_event_with_turn_accounting<S>(
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ForwardBrainEvent {
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

pub(super) async fn forward_brain_event<S>(
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
            // resolution is bindable only when a single open submission can own
            // it; anything ambiguous, absent, or already bound fails closed and
            // consumes nothing. Nothing is minted: with no bindable turn the
            // mapping below produces `VOICE_PROTOCOL_INVARIANT` and no frame at
            // all rather than a fabricated or borrowed id.
            if context
                .turn_bindings
                .turn_for_response(response_id)
                .is_err()
            {
                let _ = context.turn_bindings.bind_unannounced_deferral(response_id);
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
pub(super) fn terminal_reason_for_brain_error(error: &BrainError) -> TerminalSessionReason {
    error.terminal_reason()
}

pub(super) fn brain_error_is_durability_degraded(state: &AppState, error: &BrainError) -> bool {
    state.study_store.capabilities().durable
        && error.terminal_reason() == TerminalSessionReason::DurabilityDegraded
}

pub(super) fn record_brain_open_provider_failure(
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
pub(super) fn provider_error_failure(error: &BrainProviderError) -> Cow<'_, BrainProviderFailure> {
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

pub(super) fn terminal_reason_for_provider_error(
    error: &BrainProviderError,
) -> TerminalSessionReason {
    provider_error_failure(error).terminal_reason()
}

pub(super) fn provider_error_is_durability_degraded(
    state: &AppState,
    error: &BrainProviderError,
) -> bool {
    provider_error_is_durability_degraded_for_store(state.study_store.capabilities().durable, error)
}

pub(super) fn provider_error_is_durability_degraded_for_store(
    store_is_durable: bool,
    error: &BrainProviderError,
) -> bool {
    store_is_durable
        && provider_error_failure(error).terminal_reason()
            == TerminalSessionReason::DurabilityDegraded
}

pub(super) async fn open_failure_control_session(
    state: &AppState,
    config: SessionConfig,
    scenario: FailureControlScenario,
) -> Result<RealtimeSession, BrainError> {
    // `A-32`: this socket's own provisioning is explicitly idempotent-on-existing.
    // The signed start already recorded this session under the same identity, so a
    // replay is the expected outcome here and is not a second session; a first
    // insert is equally accepted, because the same code path serves a session whose
    // start was never recorded through the mint. Only a refusal to write at all
    // gates the session.
    let outcome = state
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
    match outcome {
        StudyStoreWriteOutcome::Inserted | StudyStoreWriteOutcome::IdempotentReplay => {}
    }

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
pub(super) const FAILURE_CONTROL_SOURCE: &str = "failure_control";

pub(super) fn failure_control_provider_error(
    scenario: FailureControlScenario,
) -> BrainProviderError {
    BrainProviderError {
        source: FAILURE_CONTROL_SOURCE.to_owned(),
        message: failure_control_provider_message(scenario),
        failure: Some(failure_control_provider_failure(scenario)),
    }
}

/// Each rehearsal scenario declares its own typed class and stage, so the terminal
/// reason it produces is chosen here rather than recovered from its message.
pub(super) fn failure_control_provider_failure(
    scenario: FailureControlScenario,
) -> BrainProviderFailure {
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

pub(super) fn failure_control_failure_class(scenario: FailureControlScenario) -> BrainFailureClass {
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

pub(super) fn failure_control_failure_stage(scenario: FailureControlScenario) -> BrainFailureStage {
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

pub(super) fn failure_control_failure_metadata(scenario: FailureControlScenario) -> String {
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

pub(super) fn failure_control_provider_message(scenario: FailureControlScenario) -> String {
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

pub(super) fn failure_control_stage(scenario: FailureControlScenario) -> &'static str {
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

pub(super) fn store_error_is_durability_degraded(state: &AppState, error: &PortError) -> bool {
    state.study_store.capabilities().durable && store_adapter_error_is_durability_degraded(error)
}

pub(super) fn store_write_error_is_durability_degraded(
    state: &AppState,
    error: &PortError,
) -> bool {
    state.study_store.capabilities().durable && store_adapter_error_is_durability_degraded(error)
}

/// `PortErrorKind` is the classifier. `reason()` is diagnostics, so a store that
/// could not durably commit says so with its kind rather than with prose this
/// service pattern-matches.
pub(super) fn store_adapter_error_is_durability_degraded(error: &PortError) -> bool {
    match error.kind() {
        PortErrorKind::Durability | PortErrorKind::Internal => true,
        PortErrorKind::Unavailable | PortErrorKind::InvalidInput | PortErrorKind::Conflict => false,
    }
}

pub(super) async fn send_client_input_action_with_drain(
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

pub(super) async fn send_brain_input_with_drain(
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

pub(super) async fn send_brain_input_with_deadline(
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

pub(super) fn record_provider_stage_failure(
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

pub(super) const PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS: usize = 384;

pub(super) const PROVIDER_STAGE_FAILURE_DEPLOY_SHA_MAX_CHARS: usize = 8;

pub(super) const PROVIDER_STAGE_FAILURE_MODEL_MAX_CHARS: usize = 32;

pub(super) const PROVIDER_STAGE_FAILURE_PROVIDER_MAX_CHARS: usize = 24;

pub(super) const PROVIDER_STAGE_FAILURE_METADATA_VALUE_MAX_CHARS: usize = 32;

pub(super) fn provider_stage_failure_detail(failure: &BrainProviderFailure) -> String {
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

pub(super) fn provider_stage_failure_has_rate_metadata(
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

pub(super) fn safe_provider_stage_metadata_fields(metadata: &str) -> Vec<String> {
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

pub(super) fn bounded_evidence_detail(fields: impl IntoIterator<Item = String>) -> String {
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

pub(super) fn bounded_evidence_value(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub(super) fn metadata_field<'a>(metadata: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    metadata
        .split_whitespace()
        .find_map(|field| field.strip_prefix(&prefix))
        .filter(|value| !value.is_empty())
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum BrainEventRecordResult {
    None,
    Usage(VoiceUsageRecord),
    DurabilityDegraded,
}

pub(super) async fn record_brain_event(
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
