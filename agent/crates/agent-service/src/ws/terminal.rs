//! `SERVICE-017`: the bounded sender, the v5 serialization fallback, heartbeat, terminal/error/Close emission, and the write-timeout cleanup trigger.
//!
//! Moved verbatim out of `ws.rs` by the responsibility split. No route,
//! response, timer, capacity transition, authorization decision, store or
//! provider call, protocol frame, or cleanup order changed; only the file the
//! code lives in and the visibility the move forces.

use super::*;

/// `SERVICE-002`: how long a closed socket stays readable so the peer's in-flight
/// bytes are consumed before it is dropped. Server-owned and short: it holds no
/// lease, and dropping a socket with unread bytes resets the connection, which
/// discards the terminal frame and Close frame already written to it.
pub(super) const CLOSING_HANDSHAKE_GRACE: Duration = Duration::from_millis(250);

/// What the heartbeat timer asks the socket to do next.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum HeartbeatAction {
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
pub(super) struct HeartbeatState {
    pub(super) next_ping: Instant,
    pub(super) pong_deadline: Option<Instant>,
}

impl HeartbeatState {
    pub(super) fn new(now: Instant, interval: Duration) -> Self {
        Self {
            next_ping: now + interval,
            pong_deadline: None,
        }
    }

    /// The next instant this state has anything to do: an outstanding pong
    /// deadline first, otherwise the next scheduled ping.
    pub(super) fn next_wake(&self) -> Instant {
        self.pong_deadline.unwrap_or(self.next_ping)
    }

    pub(super) fn on_timer(
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

    pub(super) fn on_pong(&mut self, now: Instant, interval: Duration) -> bool {
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
pub(super) enum OutboundWriteError {
    #[error("outbound websocket write exceeded its deadline")]
    Timeout,
    #[error("outbound websocket sink failed")]
    Sink(#[source] axum::Error),
}

/// The one outbound write path. Every server frame, `Ready`, provider event,
/// protocol error, Ping/Pong, terminal frame, and Close frame goes through it, so
/// no write on this socket can outlive one server-configured deadline.
pub(super) struct BoundedSender<S> {
    pub(super) inner: S,
    pub(super) timeout: Duration,
}

impl<S> BoundedSender<S>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    pub(super) fn new(inner: S, timeout: Duration) -> Self {
        Self { inner, timeout }
    }

    pub(super) async fn send(&mut self, message: Message) -> Result<(), OutboundWriteError> {
        match tokio::time::timeout(self.timeout, self.inner.send(message)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(OutboundWriteError::Sink(error)),
            Err(_) => Err(OutboundWriteError::Timeout),
        }
    }
}

/// The sanitized terminal label an outbound write failure records. A client that
/// stopped reading is a slow client; a sink that broke is a failed send.
pub(super) fn outbound_write_terminal_label(error: &OutboundWriteError) -> &'static str {
    match error {
        OutboundWriteError::Timeout => TerminalSessionReason::SlowClient.as_str(),
        OutboundWriteError::Sink(_) => "send_failed",
    }
}

/// Whether a label produced *by a failed outbound write* names that failure.
///
/// `A-20.2`: this answers "which label won", never "did the write side fail".
/// Only `terminal_label_after_terminal_phase_close` may ask it, because only
/// there is the argument already known to have come from a write failure.
/// `slow_client` is also an ordinary policy-denial wire reason, so the same
/// string arriving from anywhere else says nothing about the socket.
pub(super) fn is_outbound_write_failure_label(label: &str) -> bool {
    label == "send_failed" || label == TerminalSessionReason::SlowClient.as_str()
}

/// What the session recorded about how its terminal close went.
///
/// `persisted` is whether the terminal reason reached durable storage.
/// `write_failed` is `A-20.2`'s explicit write-side fact: it is set only where
/// an outbound write actually failed, and it is the only evidence the
/// closing-handshake guard reads. It is never derived from a terminal label,
/// because `slow_client` is both an outbound-write label and an ordinary
/// policy-denial wire reason.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct TerminalCloseState {
    pub(super) persisted: bool,
    pub(super) write_failed: bool,
}

/// `A-20.2`: whether this socket still has a closing handshake to finish.
///
/// Two independent facts skip it, and neither may be inferred from the
/// sanitized terminal label: this socket's own write side failed, so there is
/// no way to deliver anything more, or the peer is already gone, so there is
/// nobody left to answer. Reading `slow_client` as write-side evidence stranded
/// clients that were reading perfectly well and had simply pipelined frames
/// behind the one the server refused — the socket was dropped on top of their
/// unread bytes and the reset discarded the terminal frame and the Close frame
/// already written to them.
pub(super) fn should_finish_closing_handshake(
    outbound_write_failed: bool,
    terminal_reason: &str,
) -> bool {
    !outbound_write_failed
        && terminal_reason != "client_disconnect"
        && terminal_reason != HEARTBEAT_TIMEOUT_TERMINAL_LABEL
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
pub(super) const HEARTBEAT_TIMEOUT_TERMINAL_LABEL: &str = "heartbeat_timeout";

/// Relabel a completed slow-client close as a heartbeat timeout. A close that
/// degraded under its own store write, or that failed outright, keeps the label
/// it produced: only the ordinary slow-client close is a heartbeat expiry.
pub(super) fn heartbeat_expiry_terminal_label(close_terminal_label: &'static str) -> &'static str {
    if close_terminal_label == TerminalSessionReason::SlowClient.as_str() {
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL
    } else {
        close_terminal_label
    }
}

/// A client that stopped reading is not worth another provider turn's work, so a
/// missed write deadline aborts the provider tasks before the socket unwinds. A
/// broken sink leaves them to the ordinary teardown.
///
/// `A-20.2`: this is one of the two places that record the write side failing,
/// and the flag it sets is the only evidence the closing-handshake guard reads.
pub(super) fn handle_outbound_write_failure(
    error: &OutboundWriteError,
    session: &mut agent_domain::RealtimeSession,
    terminal: &mut TerminalCloseState,
) -> &'static str {
    terminal.write_failed = true;
    if matches!(error, OutboundWriteError::Timeout) {
        abort_realtime_session_tasks(session);
    }
    outbound_write_terminal_label(error)
}

/// `SERVICE-008`: serialization is fallible, and its only fallback is Plan 05's
/// published frame. The serializer is a parameter so the fallback is reachable in
/// a test without a frame that cannot be serialized.
pub(super) fn serialize_server_frame_with<E>(
    frame: &ServerFrame,
    serializer: impl FnOnce(&ServerFrame) -> Result<String, E>,
) -> String {
    serializer(frame).unwrap_or_else(|_| VOICE_SERIALIZATION_FALLBACK_FRAME.to_owned())
}

/// `SERVICE-002`: read the peer out before the socket is dropped.
///
/// Dropping a socket that still holds unread client bytes resets the connection,
/// and a reset discards the terminal frame and the Close frame already written to
/// it — the client sees a transport error instead of the reason it was closed.
/// The wait is bounded by a server-owned grace and holds no lease; a client can
/// neither shorten nor extend it.
pub(super) async fn finish_closing_handshake<R>(receiver: &mut R, grace: Duration)
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

pub(super) async fn close_with_terminal_session_phase<S>(
    sender: &mut BoundedSender<S>,
    input: &mpsc::Sender<BrainInput>,
    state: &AppState,
    voice_session_id: Option<String>,
    terminal: &mut TerminalCloseState,
    terminal_reason: TerminalSessionReason,
    close_code: u16,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let _ = input.try_send(BrainInput::Stop);
    let terminal_reason =
        persist_terminal_session_reason(state, voice_session_id, terminal_reason).await;
    terminal.persisted = true;
    if let Err(error) = send_terminal_session_phase(sender, terminal_reason).await {
        // `A-20.2`: the write side failed here whatever label wins below, and a
        // label that loses the precedence contest must not hide that fact.
        terminal.write_failed = true;
        return terminal_label_after_terminal_phase_close(
            terminal_reason,
            outbound_write_terminal_label(&error),
        );
    }
    let close_code = terminal_close_code(terminal_reason, close_code);
    let _ = close_with(sender, close_code, terminal_reason.close_reason()).await;
    terminal_reason.as_str()
}

pub(super) async fn close_with_terminal_session_phase_only<S>(
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

pub(super) fn terminal_label_after_terminal_phase_close(
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

pub(super) fn terminal_reason_overrides_send_failure(
    terminal_reason: TerminalSessionReason,
) -> bool {
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

/// `SERVICE-017`: drive one heartbeat-timer expiry.
///
/// The transport liveness probe owns its own timer and this is the only place
/// that resets it. `None` means the session loop continues; `Some(label)` is the
/// terminal label it breaks with. Moved out of the session loop unchanged: the
/// same three actions, the same reset points, and the same relabelling of a
/// completed slow-client close as a heartbeat timeout.
pub(super) async fn drive_heartbeat_timer<S>(
    heartbeat: &mut HeartbeatState,
    mut heartbeat_timer: Pin<&mut Sleep>,
    sender: &mut BoundedSender<S>,
    session: &mut agent_domain::RealtimeSession,
    state: &AppState,
    voice_session_id: Option<String>,
    terminal: &mut TerminalCloseState,
) -> Option<&'static str>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    match heartbeat.on_timer(
        Instant::now(),
        state.ws_timeouts.heartbeat_interval,
        state.ws_timeouts.pong_timeout,
    ) {
        HeartbeatAction::SleepUntil(deadline) => {
            heartbeat_timer.as_mut().reset(deadline);
            None
        }
        HeartbeatAction::SendPing => {
            if let Err(error) = sender.send(Message::Ping(Vec::new().into())).await {
                return Some(handle_outbound_write_failure(&error, session, terminal));
            }
            heartbeat_timer.as_mut().reset(heartbeat.next_wake());
            None
        }
        HeartbeatAction::Expired => {
            // The wire contract is Plan 05's published slow-client termination;
            // the recorded label is `heartbeat_timeout`, so a half-open peer is
            // never read back as a slow reader.
            abort_realtime_session_tasks(session);
            Some(heartbeat_expiry_terminal_label(
                close_with_terminal_session_phase(
                    sender,
                    &session.input,
                    state,
                    voice_session_id,
                    terminal,
                    TerminalSessionReason::SlowClient,
                    close_code::POLICY,
                )
                .await,
            ))
        }
    }
}

/// `SERVICE-017`: the one owner of the terminal close a rejected client message
/// produces.
///
/// Four call sites in the session loop inlined these same four arms. They are
/// moved here unchanged — same order, same close codes, same recorded labels,
/// same provider-task abort on the turn cap — so the mapping from a refused
/// client message to a wire close exists exactly once. The caller keeps the
/// `break`: this returns the terminal label, it does not decide control flow.
///
/// `record_session_auth_failure` deliberately stays at the call site. Only the
/// pre-send parsing rejection records one, and folding a conditional record in
/// here would make a decision this function does not own.
pub(super) async fn close_for_client_message_error<S>(
    sender: &mut BoundedSender<S>,
    session: &mut agent_domain::RealtimeSession,
    state: &AppState,
    voice_session_id: Option<String>,
    terminal: &mut TerminalCloseState,
    error: ClientMessageError,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    match error {
        ClientMessageError::Drained => {
            close_with_terminal_session_phase(
                sender,
                &session.input,
                state,
                voice_session_id,
                terminal,
                TerminalSessionReason::Drained,
                close_code::NORMAL,
            )
            .await
        }
        ClientMessageError::RateLimit => {
            close_with_terminal_session_phase(
                sender,
                &session.input,
                state,
                voice_session_id,
                terminal,
                TerminalSessionReason::RateLimit,
                close_code::POLICY,
            )
            .await
        }
        ClientMessageError::Frame(error) => {
            let _ = send_json(sender, &ServerFrame::error(error.code, error.message)).await;
            let _ = close_with(sender, error.close_code, error.close_reason).await;
            error.terminal_reason
        }
        ClientMessageError::TurnCap => {
            abort_realtime_session_tasks(session);
            close_with_terminal_session_phase(
                sender,
                &session.input,
                state,
                voice_session_id,
                terminal,
                TerminalSessionReason::TurnCap,
                close_code::POLICY,
            )
            .await
        }
    }
}

/// `SERVICE-017`: the one owner of the terminal close a forwarded provider
/// outcome produces.
///
/// `None` means the session loop continues; `Some(label)` is the terminal label
/// it breaks with. Three call sites inlined this same match. The arms are moved
/// here unchanged, including the precedence between a partial-recap write
/// failure and the terminal reason that caused it.
///
/// The `Ok(Rejected)` arm assigned its label before writing the Close frame and
/// this returns it after; the label is only read once the loop has ended, so the
/// observable order is identical.
pub(super) async fn close_for_forward_outcome<S>(
    context: &BrainForwardContext<'_>,
    sender: &mut BoundedSender<S>,
    session: &mut agent_domain::RealtimeSession,
    terminal: &mut TerminalCloseState,
    outcome: Result<ForwardBrainEvent, OutboundWriteError>,
) -> Option<&'static str>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    match outcome {
        Ok(ForwardBrainEvent::Continue) => None,
        Ok(ForwardBrainEvent::Suppressed) => None,
        Ok(ForwardBrainEvent::Rejected) => {
            let _ = close_with(
                sender,
                close_code::POLICY,
                "provider source authority rejected",
            )
            .await;
            Some("provider_source_authority_rejected")
        }
        Ok(ForwardBrainEvent::DurabilityDegraded) => Some(
            close_with_terminal_session_phase(
                sender,
                &session.input,
                context.state,
                context.voice_session_id.clone(),
                terminal,
                TerminalSessionReason::DurabilityDegraded,
                close_code::ERROR,
            )
            .await,
        ),
        Ok(ForwardBrainEvent::CostBudgetExceeded) => Some(
            close_with_terminal_session_phase(
                sender,
                &session.input,
                context.state,
                context.voice_session_id.clone(),
                terminal,
                TerminalSessionReason::CostBudget,
                close_code::POLICY,
            )
            .await,
        ),
        Ok(ForwardBrainEvent::ProviderFailure {
            reason,
            response_id,
        }) => {
            if let Err(error) = send_partial_recap_for_provider_failure(
                context,
                reason,
                response_id.as_deref(),
                sender,
            )
            .await
            {
                return Some(handle_outbound_write_failure(&error, session, terminal));
            }
            Some(
                close_with_terminal_session_phase(
                    sender,
                    &session.input,
                    context.state,
                    context.voice_session_id.clone(),
                    terminal,
                    reason,
                    close_code::ERROR,
                )
                .await,
            )
        }
        Err(error) => Some(handle_outbound_write_failure(&error, session, terminal)),
    }
}

pub(super) async fn close_with_client_stop<S>(
    sender: &mut BoundedSender<S>,
    state: &AppState,
    voice_session_id: Option<String>,
    terminal: &mut TerminalCloseState,
) -> &'static str
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let terminal_label =
        persist_terminal_label_or_durability_degraded(state, voice_session_id, "client_stop").await;
    terminal.persisted = true;
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

pub(super) async fn send_terminal_session_phase<S>(
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

pub(super) async fn send_partial_recap_for_provider_failure<S>(
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

pub(super) fn supports_provider_failure_partial_recap(reason: TerminalSessionReason) -> bool {
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

pub(super) fn deterministic_provider_failure_partial_recap(
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct TerminalObservabilityClassification {
    pub(super) failure_class: &'static str,
    pub(super) stage: &'static str,
    pub(super) signal: &'static str,
}

pub(super) fn terminal_observability_classification(
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

pub(super) fn deployment_sha() -> String {
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

pub(super) fn emit_terminal_observability_log(state: &AppState, reason: &str) {
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

pub(super) fn emit_pending_evaluation_observability_log(
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

pub(super) fn pending_evaluation_terminal_reason() -> &'static str {
    "pending_evaluation"
}

pub(super) fn observability_model(provider: &str) -> String {
    observability_model_with(provider, |name| std::env::var(name).ok())
}

pub(super) fn observability_model_with(
    provider: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> String {
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

pub(super) async fn record_session_auth_failure(
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

pub(super) async fn record_terminal(
    state: &AppState,
    voice_session_id: Option<String>,
    reason: &str,
) {
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

pub(super) async fn persist_terminal_session_reason(
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

pub(super) async fn persist_terminal_label_or_durability_degraded(
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

pub(super) fn terminal_close_code(reason: TerminalSessionReason, close_code: u16) -> u16 {
    if reason == TerminalSessionReason::DurabilityDegraded {
        close_code::ERROR
    } else {
        close_code
    }
}

pub(super) async fn record_terminal_evidence(
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

pub(super) async fn send_json<S>(
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

pub(super) async fn close_with<S>(
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
