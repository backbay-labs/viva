use std::{collections::HashSet, time::Duration};

use agent_domain::{AudioFrame, BrainInput, SessionConfig};
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
    sync::{mpsc, OwnedSemaphorePermit},
    time::{timeout, Instant},
};

use crate::{
    app::AppState,
    config::{SessionTokenClaims, VoiceWsAccessError},
    protocol::{
        ClientFrame, ServerFrame, VIVA_VOICE_MAX_BINARY_FRAME_BYTES,
        VIVA_VOICE_MAX_TEXT_FRAME_BYTES, VIVA_VOICE_PROTOCOL_VERSION,
    },
};

pub async fn voice_ws(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let permit = match validate_ws_preflight(&state, &headers) {
        Ok(permit) => permit,
        Err(error) => return error.into_response(),
    };

    ws.protocols(["viva-voice"])
        .on_upgrade(move |socket| handle_socket(socket, state, permit))
}

fn validate_ws_preflight(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<OwnedSemaphorePermit, (StatusCode, Json<serde_json::Value>)> {
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
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::PreflightAccepted,
        None,
        "websocket preflight accepted",
    ));
    Ok(permit)
}

async fn handle_socket(socket: WebSocket, state: AppState, _permit: OwnedSemaphorePermit) {
    let (mut sender, mut receiver) = socket.split();
    if send_json(&mut sender, &ServerFrame::ready()).await.is_err() {
        return;
    }

    let initial_config = match timeout(state.ws_timeouts.first_frame, receiver.next()).await {
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
            Some(Ok(message)) => match initial_session_config_from_message(message)
                .and_then(|config| authorize_initial_session_config(config, &state))
            {
                Ok(config) => config,
                Err(error) => {
                    let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
                    let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                    record_terminal(&state, None, error.terminal_reason).await;
                    return;
                }
            },
            _ => {
                record_terminal(&state, None, "closed_before_config").await;
                return;
            }
        },
    };
    let session_binding = AuthorizedClientSession::from_config(&initial_config)
        .expect("authorized session config has required identity");
    let voice_session_id = initial_config.session_id.as_deref().map(ToOwned::to_owned);
    if let Err(error) = validate_study_set_access(&state, &initial_config).await {
        let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
        record_terminal(&state, voice_session_id, error.terminal_reason).await;
        return;
    }
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ConfigAccepted,
        voice_session_id.clone(),
        "session config accepted",
    ));
    let session_started_at = Instant::now();

    let mut session = match state.brain.open(initial_config).await {
        Ok(session) => session,
        Err(error) => {
            let _ = send_json(&mut sender, &ServerFrame::error(error.to_string())).await;
            record_terminal(&state, voice_session_id, "brain_open_error").await;
            return;
        }
    };
    state.evidence.record(VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::SessionOpened,
        voice_session_id.clone(),
        "session opened",
    ));
    let mut terminal_reason = "event_stream_closed";
    let mut cancelled_response_ids = HashSet::new();

    loop {
        tokio::select! {
            incoming = timeout(state.ws_timeouts.idle, receiver.next()) => {
                let incoming = match incoming {
                    Ok(incoming) => incoming,
                    Err(_) => {
                        let _ = send_json(&mut sender, &ServerFrame::error("idle timeout")).await;
                        let _ = session.input.send(BrainInput::Stop).await;
                        terminal_reason = "idle_timeout";
                        let _ = close_with(&mut sender, close_code::POLICY, "idle timeout").await;
                        break;
                    }
                };
                let Some(Ok(message)) = incoming else {
                    let _ = session.input.send(BrainInput::Stop).await;
                    state.evidence.record(VoiceEvidenceEvent::new(
                        VoiceEvidenceEventKind::StopReceived,
                        voice_session_id.clone(),
                        "disconnect sent stop",
                    ));
                    terminal_reason = "client_disconnect";
                    break;
                };
                match handle_client_message(message, &session.input, &session_binding).await {
                    Ok(action) => {
                        record_client_action(&state, voice_session_id.clone(), action);
                        if matches!(action, ClientAction::Stop) {
                            terminal_reason = "client_stop";
                            let _ = close_with(&mut sender, close_code::NORMAL, "client stop").await;
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = send_json(&mut sender, &ServerFrame::error(error.message)).await;
                        let _ = close_with(&mut sender, error.close_code, error.close_reason).await;
                        terminal_reason = error.terminal_reason;
                        break;
                    }
                }
            }
            event = session.events.recv() => {
                let Some(event) = event else {
                    break;
                };
                if should_suppress_cancelled_response(&mut cancelled_response_ids, &event) {
                    continue;
                }
                record_brain_event(
                    &state,
                    voice_session_id.clone(),
                    &event,
                    session_started_at.elapsed(),
                )
                .await;
                let Some(frame) = ServerFrame::browser_event(event) else {
                    continue;
                };
                if send_json(&mut sender, &frame).await.is_err() {
                    terminal_reason = "send_failed";
                    break;
                }
            }
        }
    }
    record_terminal(&state, voice_session_id, terminal_reason).await;
}

fn should_suppress_cancelled_response(
    cancelled_response_ids: &mut HashSet<String>,
    event: &agent_domain::BrainEvent,
) -> bool {
    if let agent_domain::BrainEvent::ResponseCancelledFor { response_id } = event {
        cancelled_response_ids.insert(response_id.clone());
        return false;
    }
    event
        .response_id()
        .is_some_and(|response_id| cancelled_response_ids.contains(response_id))
}

async fn validate_study_set_access(
    state: &AppState,
    config: &SessionConfig,
) -> Result<(), ClientFrameError> {
    let (Some(user_id), Some(study_set_id)) =
        (config.user_id.as_deref(), config.study_set_id.as_deref())
    else {
        return Err(ClientFrameError::invalid_session_identity());
    };
    match state.study_store.study_context(user_id, study_set_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) | Err(_) => Err(ClientFrameError::study_set_access_denied()),
    }
}

async fn handle_client_message(
    message: Message,
    input: &mpsc::Sender<BrainInput>,
    session_binding: &AuthorizedClientSession,
) -> Result<ClientAction, ClientFrameError> {
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
                    input
                        .send(BrainInput::SessionContextRefresh(
                            serde_json::to_value(sanitized)
                                .map_err(|_| ClientFrameError::invalid())?,
                        ))
                        .await
                        .map(|_| ClientAction::ConfigRefresh)
                        .map_err(|_| ClientFrameError::disconnected())
                }
                ClientFrame::Audio { frame, .. } => input
                    .send(BrainInput::Audio(frame))
                    .await
                    .map(|_| ClientAction::Audio)
                    .map_err(|_| ClientFrameError::disconnected()),
                ClientFrame::Text { text, .. } => input
                    .send(BrainInput::Text(text))
                    .await
                    .map(|_| ClientAction::AnswerText)
                    .map_err(|_| ClientFrameError::disconnected()),
                ClientFrame::ToolResult { .. } => Err(ClientFrameError::untrusted_tool_result()),
                ClientFrame::Cancel { .. } => input
                    .send(BrainInput::CancelResponse)
                    .await
                    .map(|_| ClientAction::Cancel)
                    .map_err(|_| ClientFrameError::disconnected()),
                ClientFrame::Stop { .. } => input
                    .send(BrainInput::Stop)
                    .await
                    .map(|_| ClientAction::Stop)
                    .map_err(|_| ClientFrameError::disconnected()),
            }
        }
        Message::Binary(bytes) => {
            if bytes.len() > VIVA_VOICE_MAX_BINARY_FRAME_BYTES {
                return Err(ClientFrameError::oversized_binary());
            }
            input
                .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(bytes)))
                .await
                .map(|_| ClientAction::Audio)
                .map_err(|_| ClientFrameError::disconnected())
        }
        Message::Close(_) => input
            .send(BrainInput::Stop)
            .await
            .map(|_| ClientAction::Stop)
            .map_err(|_| ClientFrameError::disconnected()),
        Message::Ping(_) | Message::Pong(_) => Ok(ClientAction::Keepalive),
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
    Ok(InitialSessionConfig {
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
    Ok(config)
}

fn authorize_initial_session_config(
    initial: InitialSessionConfig,
    state: &AppState,
) -> Result<SessionConfig, ClientFrameError> {
    let binding = if let Some(secret) = state.ws_access.session_token_secret.as_deref() {
        let token = initial
            .session_token
            .as_deref()
            .ok_or_else(ClientFrameError::invalid_session_token)?;
        let claims = SessionTokenClaims::verify(token, secret)
            .map_err(|_| ClientFrameError::invalid_session_token())?;
        AuthorizedClientSession {
            user_id: claims.user_id,
            study_set_id: claims.study_set_id,
            session_id: claims.session_id,
        }
    } else {
        AuthorizedClientSession {
            user_id: state.trusted_user_id.clone(),
            study_set_id: state.trusted_study_set_id.clone(),
            session_id: state.trusted_session_id.clone(),
        }
    };
    sanitize_client_session_config(initial.session, &binding)
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
    session: SessionConfig,
    session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InitialClientFrame {
    #[serde(rename = "type")]
    frame_type: String,
    version: u32,
    session: SessionConfig,
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
    ConfigRefresh,
    Keepalive,
    Stop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ClientFrameError {
    message: &'static str,
    close_code: u16,
    close_reason: &'static str,
    terminal_reason: &'static str,
}

impl ClientFrameError {
    fn invalid_first_frame() -> Self {
        Self {
            message: "first client frame must be session_config",
            close_code: close_code::PROTOCOL,
            close_reason: "session config required",
            terminal_reason: "invalid_first_frame",
        }
    }

    fn invalid() -> Self {
        Self {
            message: "invalid client frame",
            close_code: close_code::PROTOCOL,
            close_reason: "invalid client frame",
            terminal_reason: "invalid_client_frame",
        }
    }

    fn invalid_session_identity() -> Self {
        Self {
            message: "invalid session identity",
            close_code: close_code::POLICY,
            close_reason: "invalid session identity",
            terminal_reason: "invalid_session_identity",
        }
    }

    fn invalid_session_token() -> Self {
        Self {
            message: "invalid session token",
            close_code: close_code::POLICY,
            close_reason: "invalid session token",
            terminal_reason: "invalid_session_token",
        }
    }

    fn study_set_access_denied() -> Self {
        Self {
            message: "study set access denied",
            close_code: close_code::POLICY,
            close_reason: "study set access denied",
            terminal_reason: "study_set_access_denied",
        }
    }

    fn untrusted_tool_result() -> Self {
        Self {
            message: "browser tool_result frames are not trusted",
            close_code: close_code::POLICY,
            close_reason: "untrusted tool_result",
            terminal_reason: "untrusted_tool_result",
        }
    }

    fn oversized_text() -> Self {
        Self {
            message: "text frame exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "text frame too large",
            terminal_reason: "oversized_text_frame",
        }
    }

    fn oversized_binary() -> Self {
        Self {
            message: "binary frame exceeds maximum size",
            close_code: close_code::SIZE,
            close_reason: "binary frame too large",
            terminal_reason: "oversized_binary_frame",
        }
    }

    fn disconnected() -> Self {
        Self {
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

async fn record_brain_event(
    state: &AppState,
    voice_session_id: Option<String>,
    event: &agent_domain::BrainEvent,
    session_elapsed: Duration,
) {
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
        if let Err(error) = state.study_store.record_voice_usage(usage_record).await {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                voice_session_id,
                format!("usage_persist_failed: {error}"),
            ));
        }
        return;
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
        return;
    };
    state
        .evidence
        .record(VoiceEvidenceEvent::new(kind, voice_session_id, detail));
}

async fn record_terminal(state: &AppState, voice_session_id: Option<String>, reason: &str) {
    if let Some(session_id) = voice_session_id.as_deref() {
        if let Err(error) = state
            .study_store
            .close_voice_session(session_id, reason)
            .await
        {
            state.evidence.record(VoiceEvidenceEvent::new(
                VoiceEvidenceEventKind::StoreCounts,
                voice_session_id.clone(),
                format!("session_close_failed: {error}"),
            ));
        }
    }
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

    fn fixture_binding() -> AuthorizedClientSession {
        AuthorizedClientSession {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            session_id: "voice-session-1".to_owned(),
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
            Message::Text(r#"{"type":"text","version":1,"text":"quiz me"}"#.into()),
            &input,
            &binding,
        )
        .await
        .unwrap();
        handle_client_message(
            Message::Text(r#"{"type":"cancel","version":1}"#.into()),
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
            format!(r#"{{"type":"session_config","version":1,"session":{session}}}"#).into(),
        );
        let config = session_config_from_message(message).unwrap();

        assert_eq!(config.study_set_id.as_deref(), Some("biology-midterm"));
        assert!(session_config_from_message(Message::Text(
            r#"{"type":"text","version":1,"text":"quiz me"}"#.into()
        ))
        .is_err());
    }

    #[test]
    fn sanitizes_session_config_identity_and_strips_browser_source_context() {
        let session = include_str!("../../../fixtures/voice-protocol/session-config.json");
        let message = Message::Text(
            format!(r#"{{"type":"session_config","version":1,"session":{session}}}"#).into(),
        );
        let config = session_config_from_message(message).unwrap();
        let binding = fixture_binding();
        let sanitized = sanitize_client_session_config(config, &binding).unwrap();

        assert_eq!(sanitized.user_id.as_deref(), Some("user-1"));
        assert_eq!(sanitized.study_set_id.as_deref(), Some("biology-midterm"));
        assert_eq!(sanitized.session_id.as_deref(), Some("voice-session-1"));
        assert!(sanitized.source_context.is_empty());

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

    #[tokio::test]
    async fn rejects_unsupported_protocol_versions() {
        let (input, _received) = mpsc::channel(8);
        let binding = fixture_binding();

        let result = handle_client_message(
            Message::Text(r#"{"type":"text","version":2,"text":"quiz me"}"#.into()),
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
                r#"{"type":"tool_result","version":1,"result":{"proposal":{"name":"evaluate_spoken_answer","arguments":{}},"result":{}}}"#
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
    async fn records_usage_events_internally_without_browser_evidence() {
        use std::sync::Arc;

        use agent_adapters::SyntheticBrain;

        let state = AppState::new(
            Arc::new(SyntheticBrain::default()),
            "synthetic",
            crate::VoiceWsAccess::default(),
            1,
        );
        record_brain_event(
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

        let usage = state.usage.snapshot();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].provider, "synthetic");
        assert_eq!(usage[0].model, "synthetic-viva");
        assert_eq!(usage[0].duration_seconds, 2);
        assert_eq!(usage[0].answer_eval_latency_ms, Some(2_000));
        assert_eq!(usage[0].text_input_tokens, 20);
        assert!(state.evidence.snapshot().is_empty());
    }
}
