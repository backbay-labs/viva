use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderName, HeaderValue, Request},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

use agent_domain::{
    AudioFrame, BrainError, BrainFailureClass, BrainFailureStage, BrainProviderFailureParts,
};

use super::{
    brain_failure, cartesia_handshake_classification, provider_diagnostic_failure,
    websocket_close_code, websocket_handshake_status, ProviderDiagnostic, ProviderDiagnosticCode,
    ProviderStageLabel,
};

use super::constants::{
    CARTESIA_SAMPLE_RATE, DEFAULT_CARTESIA_VERSION, DEFAULT_INK_MODEL,
    DEFAULT_INK_TURNS_WEBSOCKET_URL,
};

const CARTESIA_VERSION_HEADER: &str = "cartesia-version";
const INK_CLOSE_COMMAND: &str = r#"{"type":"close"}"#;

/// `ADAPTER-01` / `A-13.2`: Plan 06 collapsed `BrainError` to one classified
/// variant, so every Ink failure is classified where it is observed. Only a
/// closed `error_kind` token travels; a provider message, close reason, URL,
/// credential, or transcript never reaches the metadata.
fn ink_failure(
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    retry_eligible: bool,
    error_kind: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible,
        latency_ms: 0,
        provider: "cartesia".to_owned(),
        model: "cartesia-ink".to_owned(),
        metadata: format!("stage=cartesia_ink error_kind={error_kind}"),
    })
}

fn ink_transport_failure(error_kind: &'static str) -> BrainError {
    ink_failure(
        BrainFailureClass::NetworkDisconnect,
        BrainFailureStage::Transport,
        true,
        error_kind,
    )
}

fn ink_protocol_failure(error_kind: &'static str) -> BrainError {
    ink_failure(
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Provider,
        true,
        error_kind,
    )
}

fn ink_auth_failure(error_kind: &'static str) -> BrainError {
    ink_failure(
        BrainFailureClass::ProviderAuthFailure,
        BrainFailureStage::ProviderAuth,
        false,
        error_kind,
    )
}

/// `ADAPTER-06`: a refused Ink upgrade keeps only its numeric HTTP status and
/// one allowlisted diagnostic code. The refusal body, the request URL, and the
/// query are discarded whole.
fn ink_handshake_failure(status: u16) -> BrainError {
    let (diagnostic, failure_class, stage) =
        cartesia_handshake_classification(ProviderStageLabel::CartesiaInk, status);
    provider_diagnostic_failure(
        diagnostic,
        failure_class,
        stage,
        "cartesia-ink",
        Duration::ZERO,
    )
}

/// A connected Ink socket the provider closed. Only the numeric close code
/// survives; the close reason never leaves the transport.
fn ink_close_failure(close_code: Option<u16>) -> BrainError {
    provider_diagnostic_failure(
        ProviderDiagnostic::new(ProviderDiagnosticCode::CartesiaInkWsClosed, true)
            .with_close_code(close_code),
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Provider,
        "cartesia-ink",
        Duration::ZERO,
    )
}

/// A provider `error` frame. Its message and provider-authored code collapse
/// into the stage's one provider-error diagnostic.
fn ink_provider_error_failure() -> BrainError {
    provider_diagnostic_failure(
        ProviderDiagnostic::new(ProviderDiagnosticCode::CartesiaInkProviderError, true),
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Provider,
        "cartesia-ink",
        Duration::ZERO,
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InkConfig {
    pub websocket_url: String,
    pub model: String,
    pub language: String,
    pub encoding: String,
    pub sample_rate: u32,
    pub min_volume: String,
    pub max_silence_duration_secs: String,
    pub cartesia_version: String,
    pub stage_timeout: Duration,
}

impl Default for InkConfig {
    fn default() -> Self {
        Self {
            websocket_url: DEFAULT_INK_TURNS_WEBSOCKET_URL.to_owned(),
            model: DEFAULT_INK_MODEL.to_owned(),
            language: "en".to_owned(),
            encoding: "pcm_s16le".to_owned(),
            sample_rate: CARTESIA_SAMPLE_RATE,
            min_volume: "0.05".to_owned(),
            max_silence_duration_secs: "0.7".to_owned(),
            cartesia_version: DEFAULT_CARTESIA_VERSION.to_owned(),
            stage_timeout: Duration::from_secs(4),
        }
    }
}

impl InkConfig {
    pub fn websocket_endpoint(&self) -> String {
        format!(
            "{}?model={}&language={}&encoding={}&sample_rate={}&min_volume={}&max_silence_duration_secs={}&cartesia_version={}",
            self.websocket_url,
            self.model,
            self.language,
            self.encoding,
            self.sample_rate,
            self.min_volume,
            self.max_silence_duration_secs,
            self.cartesia_version
        )
    }

    pub fn websocket_request(&self, api_key: &str) -> Result<Request<()>, BrainError> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err(ink_auth_failure("missing_api_key"));
        }

        let mut request = self
            .websocket_endpoint()
            .into_client_request()
            .map_err(|_| ink_protocol_failure("invalid_endpoint"))?;
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| ink_auth_failure("invalid_authorization_header"))?;
        let version = HeaderValue::from_str(self.cartesia_version.trim())
            .map_err(|_| ink_protocol_failure("invalid_version_header"))?;
        request.headers_mut().insert(AUTHORIZATION, authorization);
        request
            .headers_mut()
            .insert(HeaderName::from_static(CARTESIA_VERSION_HEADER), version);
        Ok(request)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InkEvent {
    TurnStart,
    TurnUpdate { text: String },
    TurnEagerEnd { text: String },
    TurnResume,
    TurnEnd { text: String },
    Error { message: String },
}

pub fn audio_frame_bytes(frame: &AudioFrame) -> Bytes {
    frame.pcm16_bytes_owned()
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InkTranscript {
    pub(crate) interim_text: String,
    pub(crate) final_text: String,
    pub(crate) confidence: Option<f32>,
}

#[async_trait]
pub(crate) trait InkSocket: Send {
    async fn send_binary(&mut self, bytes: Bytes) -> Result<(), BrainError>;
    async fn send_text(&mut self, text: &'static str) -> Result<(), BrainError>;
    async fn next_text(&mut self) -> Result<Option<String>, BrainError>;
    async fn close(&mut self) -> Result<(), BrainError>;

    /// The numeric close code the provider sent, once it has closed. The close
    /// reason is dropped at the transport and is never available here.
    fn last_close_code(&self) -> Option<u16> {
        None
    }
}

#[async_trait]
pub(crate) trait InkConnector: Send + Sync {
    type Socket: InkSocket;

    async fn connect(&self, request: Request<()>) -> Result<Self::Socket, BrainError>;
}

/// One turn's transcription, bounded by the stage deadline and cancellable.
///
/// `ADAPTER-03`: only the handshake runs outside the scope that owns the
/// socket. A deadline that fires after the connection exists closes it; a
/// deadline that fires before it has nothing to close.
pub(crate) async fn transcribe_ink_with_connector<C>(
    connector: &C,
    config: &InkConfig,
    api_key: &str,
    frame: &AudioFrame,
    cancel: &CancellationToken,
) -> Result<InkTranscript, BrainError>
where
    C: InkConnector,
{
    let request = config.websocket_request(api_key)?;
    let deadline = Instant::now() + config.stage_timeout;
    let mut socket = match timeout(config.stage_timeout, connector.connect(request)).await {
        Ok(socket) => socket?,
        Err(_) => return Err(ink_deadline_failure()),
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    match timeout(remaining, transcribe_ink_turn(&mut socket, frame, cancel)).await {
        Ok(transcript) => transcript,
        Err(_) => {
            // Cleanup is best-effort and never replaces the sanitized terminal
            // classification the deadline produced.
            close_quietly(&mut socket).await;
            Err(ink_deadline_failure())
        }
    }
}

fn ink_deadline_failure() -> BrainError {
    ink_failure(
        BrainFailureClass::Timeout,
        BrainFailureStage::Provider,
        true,
        "deadline_elapsed",
    )
}

/// A cancelled turn is the learner's own decision, not a provider incident.
fn ink_cancelled_failure() -> BrainError {
    ink_failure(
        BrainFailureClass::Cancellation,
        BrainFailureStage::Provider,
        false,
        "cancelled",
    )
}

pub(crate) async fn transcribe_ink_websocket(
    config: &InkConfig,
    api_key: &str,
    frame: &AudioFrame,
    cancel: &CancellationToken,
) -> Result<InkTranscript, BrainError> {
    transcribe_ink_with_connector(&WebSocketInkConnector, config, api_key, frame, cancel).await
}

pub(crate) async fn transcribe_ink_turn<S>(
    socket: &mut S,
    frame: &AudioFrame,
    cancel: &CancellationToken,
) -> Result<InkTranscript, BrainError>
where
    S: InkSocket + ?Sized,
{
    socket
        .send_binary(audio_frame_bytes(frame))
        .await
        .map_err(|_| ink_transport_failure("send_failed"))?;
    socket
        .send_text(INK_CLOSE_COMMAND)
        .await
        .map_err(|_| ink_transport_failure("close_command_failed"))?;

    let mut accumulator = InkTranscriptAccumulator::default();
    loop {
        if cancel.is_cancelled() {
            close_quietly(socket).await;
            return Err(ink_cancelled_failure());
        }
        let received = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            received = socket.next_text() => Some(received),
        };
        let Some(received) = received else {
            close_quietly(socket).await;
            return Err(ink_cancelled_failure());
        };
        let Some(text) = received.map_err(|_| ink_transport_failure("receive_failed"))? else {
            let close_code = socket.last_close_code();
            close_quietly(socket).await;
            return Err(ink_close_failure(close_code));
        };
        let Some(event) = parse_ink_event(&text) else {
            continue;
        };
        match event {
            InkEvent::TurnStart => {}
            InkEvent::TurnUpdate { text } | InkEvent::TurnEagerEnd { text } => {
                accumulator.interim_text = text;
            }
            InkEvent::TurnResume => {
                accumulator.interim_text.clear();
            }
            InkEvent::TurnEnd { text } => {
                accumulator.final_text = Some(text);
                let transcript = accumulator.finish()?;
                // The Ink turn endpoint is short-lived by design: the socket is
                // closed with the turn rather than kept idle against Cartesia's
                // documented STT concurrency limits.
                close_quietly(socket).await;
                return Ok(transcript);
            }
            InkEvent::Error { .. } => {
                close_quietly(socket).await;
                return Err(ink_provider_error_failure());
            }
        }
    }
}

#[derive(Default)]
struct InkTranscriptAccumulator {
    interim_text: String,
    final_text: Option<String>,
}

impl InkTranscriptAccumulator {
    fn finish(self) -> Result<InkTranscript, BrainError> {
        let final_text = self
            .final_text
            .ok_or_else(|| ink_protocol_failure("missing_final_transcript"))?;
        Ok(InkTranscript {
            interim_text: self.interim_text,
            final_text,
            confidence: None,
        })
    }
}

async fn close_quietly<S>(socket: &mut S)
where
    S: InkSocket + ?Sized,
{
    let _ = socket.close().await;
}

#[derive(Clone, Copy, Debug, Default)]
struct WebSocketInkConnector;

#[async_trait]
impl InkConnector for WebSocketInkConnector {
    type Socket = TungsteniteInkSocket;

    async fn connect(&self, request: Request<()>) -> Result<Self::Socket, BrainError> {
        let (socket, _) = connect_async(request).await.map_err(|error| {
            // A refused upgrade is an HTTP fact; only its status survives.
            websocket_handshake_status(&error).map_or_else(
                || ink_transport_failure("connect_failed"),
                ink_handshake_failure,
            )
        })?;
        Ok(TungsteniteInkSocket {
            socket,
            close_code: None,
        })
    }
}

struct TungsteniteInkSocket {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    close_code: Option<u16>,
}

#[async_trait]
impl InkSocket for TungsteniteInkSocket {
    async fn send_binary(&mut self, bytes: Bytes) -> Result<(), BrainError> {
        self.socket
            .send(Message::Binary(bytes))
            .await
            .map_err(|_| ink_transport_failure("send_failed"))
    }

    async fn send_text(&mut self, text: &'static str) -> Result<(), BrainError> {
        self.socket
            .send(Message::Text(text.into()))
            .await
            .map_err(|_| ink_transport_failure("close_command_failed"))
    }

    async fn next_text(&mut self) -> Result<Option<String>, BrainError> {
        loop {
            let Some(message) = self.socket.next().await else {
                return Ok(None);
            };
            match message {
                Ok(Message::Text(text)) => return Ok(Some(text.to_string())),
                Ok(Message::Ping(payload)) => self
                    .socket
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|_| ink_transport_failure("pong_failed"))?,
                Ok(Message::Close(frame)) => {
                    self.close_code = websocket_close_code(frame.as_ref());
                    return Ok(None);
                }
                Ok(Message::Binary(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                Err(_) => return Err(ink_transport_failure("receive_failed")),
            }
        }
    }

    async fn close(&mut self) -> Result<(), BrainError> {
        self.socket
            .close(None)
            .await
            .map_err(|_| ink_transport_failure("close_failed"))
    }

    fn last_close_code(&self) -> Option<u16> {
        self.close_code
    }
}

pub fn parse_ink_event(text: &str) -> Option<InkEvent> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    parse_ink_value(&value)
}

pub fn parse_ink_value(value: &Value) -> Option<InkEvent> {
    let message_type = value.get("type").and_then(Value::as_str)?;
    match message_type {
        "turn.start" => Some(InkEvent::TurnStart),
        "turn.update" => transcript_text(value).map(|text| InkEvent::TurnUpdate { text }),
        "turn.eager_end" => transcript_text(value).map(|text| InkEvent::TurnEagerEnd { text }),
        "turn.resume" => Some(InkEvent::TurnResume),
        "turn.end" => transcript_text(value).map(|text| InkEvent::TurnEnd { text }),
        "transcript" => transcript_text(value).map(|text| {
            if value
                .get("is_final")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                InkEvent::TurnEnd { text }
            } else {
                InkEvent::TurnUpdate { text }
            }
        }),
        "error" => Some(InkEvent::Error {
            message: value
                .get("message")
                .or_else(|| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Cartesia Ink error")
                .to_owned(),
        }),
        _ => None,
    }
}

fn transcript_text(value: &Value) -> Option<String> {
    value
        .get("text")
        .or_else(|| value.get("transcript"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[test]
    fn parses_turn_events() {
        assert_eq!(
            parse_ink_value(&json!({ "type": "turn.start" })),
            Some(InkEvent::TurnStart)
        );
        assert_eq!(
            parse_ink_value(&json!({ "type": "turn.update", "text": "explain NADH" })),
            Some(InkEvent::TurnUpdate {
                text: "explain NADH".to_owned()
            })
        );
        assert_eq!(
            parse_ink_value(
                &json!({ "type": "transcript", "is_final": true, "text": "ATP synthase" })
            ),
            Some(InkEvent::TurnEnd {
                text: "ATP synthase".to_owned()
            })
        );
    }

    #[test]
    fn endpoint_includes_low_latency_pcm_parameters() {
        let endpoint = InkConfig::default().websocket_endpoint();

        assert!(endpoint.starts_with("wss://api.cartesia.ai/stt/turns/websocket?"));
        assert!(endpoint.contains("model=ink-2"));
        assert!(endpoint.contains("encoding=pcm_s16le"));
        assert!(endpoint.contains("sample_rate=24000"));
    }

    #[test]
    fn authenticated_request_uses_server_headers_and_required_query() {
        let request = InkConfig::default()
            .websocket_request("sk_car_test_secret")
            .unwrap();
        let uri = request.uri().to_string();

        assert!(uri.starts_with("wss://api.cartesia.ai/stt/turns/websocket?"));
        assert!(uri.contains("model=ink-2"));
        assert!(uri.contains("encoding=pcm_s16le"));
        assert!(uri.contains("sample_rate=24000"));
        assert!(uri.contains("cartesia_version=2026-03-01"));
        assert_eq!(
            request.headers().get("Authorization").unwrap(),
            "Bearer sk_car_test_secret"
        );
        assert_eq!(
            request.headers().get("Cartesia-Version").unwrap(),
            "2026-03-01"
        );
    }

    #[tokio::test]
    async fn turn_runner_forwards_binary_audio_and_closes_session() {
        let mut socket = FakeInkSocket::new(vec![r#"{"type":"turn.end","transcript":"ATP"}"#]);
        let transcript = transcribe_ink_turn(
            &mut socket,
            &AudioFrame::from_pcm16_bytes(vec![1, 2, 3, 4]),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(transcript.final_text, "ATP");
        assert_eq!(socket.sent_binary, vec![Bytes::from_static(&[1, 2, 3, 4])]);
        assert_eq!(socket.sent_text, vec![r#"{"type":"close"}"#]);
        assert!(socket.closed);
    }

    #[tokio::test]
    async fn turn_runner_maps_turn_events_to_interim_and_final_transcripts() {
        let mut socket = FakeInkSocket::new(vec![
            r#"{"type":"turn.start"}"#,
            r#"{"type":"turn.update","transcript":"starts wrong"}"#,
            r#"{"type":"turn.eager_end","transcript":"proton gradient"}"#,
            r#"{"type":"turn.resume"}"#,
            r#"{"type":"turn.update","transcript":"NADH"}"#,
            r#"{"type":"turn.end","transcript":"NADH donates electrons"}"#,
        ]);

        let transcript = transcribe_ink_turn(
            &mut socket,
            &AudioFrame::from_pcm16_bytes(vec![1, 2]),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(transcript.interim_text, "NADH");
        assert_eq!(transcript.final_text, "NADH donates electrons");
        assert_eq!(transcript.confidence, None);
    }

    #[tokio::test]
    async fn turn_runner_sanitizes_provider_and_transport_errors() {
        let mut provider_error = FakeInkSocket::new(vec![
            r#"{"type":"turn.update","transcript":"do not leak this transcript"}"#,
            r#"{"type":"error","message":"provider included do not leak this transcript"}"#,
        ]);

        let error = transcribe_ink_turn(
            &mut provider_error,
            &AudioFrame::from_pcm16_bytes(vec![9, 8, 7, 6]),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(failure.stage(), BrainFailureStage::Provider);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_ink error_kind=cartesia_ink_provider_error retry_eligible=true"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("do not leak this transcript"));
        assert!(!rendered.contains("9, 8, 7, 6"));

        let mut backpressure = FakeInkSocket::with_send_error("writer closed after PCM [9,8]");
        let error = transcribe_ink_turn(
            &mut backpressure,
            &AudioFrame::from_pcm16_bytes(vec![9, 8, 7, 6]),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(failure.stage(), BrainFailureStage::Transport);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_ink error_kind=send_failed"
        );
        assert!(!format!("{error} {failure:?}").contains("[9,8]"));
    }

    #[tokio::test]
    async fn turn_runner_rejects_socket_close_without_final_transcript() {
        let mut socket =
            FakeInkSocket::new(vec![r#"{"type":"turn.update","transcript":"partial"}"#]);

        let error = transcribe_ink_turn(
            &mut socket,
            &AudioFrame::from_pcm16_bytes(vec![1, 2]),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(
            error.failure().metadata(),
            "stage=cartesia_ink error_kind=cartesia_ink_ws_closed retry_eligible=true"
        );
        assert!(!format!("{error} {:?}", error.failure()).contains("partial"));
    }

    #[tokio::test]
    async fn connector_transport_uses_authenticated_request_and_fake_socket() {
        let record = Arc::new(Mutex::new(SocketRecord::default()));
        let connector = RecordingInkConnector {
            record: record.clone(),
        };

        let transcript = transcribe_ink_with_connector(
            &connector,
            &InkConfig::default(),
            "sk_car_connector_secret",
            &AudioFrame::from_pcm16_bytes(vec![3, 2, 1]),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(transcript.final_text, "connected transport");
        let record = record.lock().expect("record lock poisoned");
        assert!(record
            .request_uri
            .as_ref()
            .unwrap()
            .contains("wss://api.cartesia.ai/stt/turns/websocket?"));
        assert_eq!(
            record.authorization.as_deref(),
            Some("Bearer sk_car_connector_secret")
        );
        assert_eq!(record.sent_binary, vec![Bytes::from_static(&[3, 2, 1])]);
        assert_eq!(record.sent_text, vec![r#"{"type":"close"}"#]);
        assert!(record.closed);
    }

    #[tokio::test]
    async fn connector_transport_times_out_without_leaking_audio_or_credentials() {
        let connector = DelayedInkConnector;
        let config = InkConfig {
            stage_timeout: Duration::from_millis(5),
            ..InkConfig::default()
        };

        let error = transcribe_ink_with_connector(
            &connector,
            &config,
            "sk_car_timeout_secret",
            &AudioFrame::from_pcm16_bytes(vec![9, 8, 7, 6]),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_ink error_kind=deadline_elapsed"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("sk_car_timeout_secret"));
        assert!(!rendered.contains("9, 8, 7, 6"));
    }

    struct FakeInkSocket {
        incoming: VecDeque<&'static str>,
        sent_binary: Vec<Bytes>,
        sent_text: Vec<&'static str>,
        send_error: Option<&'static str>,
        closed: bool,
    }

    #[derive(Default)]
    struct SocketRecord {
        request_uri: Option<String>,
        authorization: Option<String>,
        handshake_attempts: u32,
        connected: bool,
        sent_binary: Vec<Bytes>,
        sent_text: Vec<&'static str>,
        closed: bool,
    }

    struct RecordingInkConnector {
        record: Arc<Mutex<SocketRecord>>,
    }

    struct DelayedInkConnector;

    #[async_trait]
    impl InkConnector for RecordingInkConnector {
        type Socket = RecordingInkSocket;

        async fn connect(
            &self,
            request: Request<()>,
        ) -> Result<Self::Socket, agent_domain::BrainError> {
            let mut record = self.record.lock().expect("record lock poisoned");
            record.request_uri = Some(request.uri().to_string());
            record.authorization = request
                .headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned);
            record.connected = true;
            drop(record);
            Ok(RecordingInkSocket {
                record: self.record.clone(),
                incoming: VecDeque::from([
                    r#"{"type":"turn.end","transcript":"connected transport"}"#,
                ]),
            })
        }
    }

    #[async_trait]
    impl InkConnector for DelayedInkConnector {
        type Socket = FakeInkSocket;

        async fn connect(&self, _request: Request<()>) -> Result<Self::Socket, BrainError> {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(FakeInkSocket::new(vec![
                r#"{"type":"turn.end","transcript":"too late"}"#,
            ]))
        }
    }

    struct RecordingInkSocket {
        record: Arc<Mutex<SocketRecord>>,
        incoming: VecDeque<&'static str>,
    }

    #[async_trait]
    impl InkSocket for RecordingInkSocket {
        async fn send_binary(&mut self, bytes: Bytes) -> Result<(), agent_domain::BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent_binary
                .push(bytes);
            Ok(())
        }

        async fn send_text(&mut self, text: &'static str) -> Result<(), agent_domain::BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent_text
                .push(text);
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, agent_domain::BrainError> {
            Ok(self.incoming.pop_front().map(ToOwned::to_owned))
        }

        async fn close(&mut self) -> Result<(), agent_domain::BrainError> {
            self.record.lock().expect("record lock poisoned").closed = true;
            Ok(())
        }
    }

    impl FakeInkSocket {
        fn new(incoming: Vec<&'static str>) -> Self {
            Self {
                incoming: incoming.into(),
                sent_binary: Vec::new(),
                sent_text: Vec::new(),
                send_error: None,
                closed: false,
            }
        }

        fn with_send_error(message: &'static str) -> Self {
            Self {
                incoming: VecDeque::new(),
                sent_binary: Vec::new(),
                sent_text: Vec::new(),
                send_error: Some(message),
                closed: false,
            }
        }
    }

    // -----------------------------------------------------------------
    // Task 3 (`ADAPTER-03`): the Ink stage deadline lives inside the scope that
    // owns the connected socket, so a timeout can close it. A timeout before
    // connect has no socket to close and must not claim one.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn ink_timeout_after_connect_closes_the_socket() {
        let record = Arc::new(Mutex::new(SocketRecord::default()));
        let connector = StallingInkConnector {
            record: record.clone(),
        };
        let config = InkConfig {
            stage_timeout: Duration::from_millis(30),
            ..InkConfig::default()
        };

        let error = transcribe_ink_with_connector(
            &connector,
            &config,
            "sk_car_cleanup_secret",
            &AudioFrame::from_pcm16_bytes(vec![9, 8, 7, 6]),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_ink error_kind=deadline_elapsed"
        );
        {
            let after_connect = record.lock().expect("record lock poisoned");
            assert!(after_connect.connected);
            assert!(
                after_connect.closed,
                "a stage timeout after connect must close the provider socket"
            );
        }
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("sk_car_cleanup_secret"));
        assert!(!rendered.contains("9, 8, 7, 6"));

        // Control: the deadline can also fire before the handshake completes.
        // There is no socket then, and cleanup must not pretend otherwise.
        let before_connect = Arc::new(Mutex::new(SocketRecord::default()));
        let error = transcribe_ink_with_connector(
            &SlowHandshakeInkConnector {
                record: before_connect.clone(),
            },
            &config,
            "sk_car_cleanup_secret",
            &AudioFrame::from_pcm16_bytes(vec![9, 8, 7, 6]),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(error.failure().failure_class(), BrainFailureClass::Timeout);
        let before_connect = before_connect.lock().expect("record lock poisoned");
        assert_eq!(
            before_connect.handshake_attempts, 1,
            "the handshake was attempted and the deadline fired inside it"
        );
        assert!(!before_connect.connected);
        assert!(!before_connect.closed);
    }

    /// Connects immediately, then never transcribes. Only the deadline ends it.
    struct StallingInkConnector {
        record: Arc<Mutex<SocketRecord>>,
    }

    #[async_trait]
    impl InkConnector for StallingInkConnector {
        type Socket = StallingInkSocket;

        async fn connect(&self, _request: Request<()>) -> Result<Self::Socket, BrainError> {
            let mut record = self.record.lock().expect("record lock poisoned");
            record.handshake_attempts += 1;
            record.connected = true;
            drop(record);
            Ok(StallingInkSocket {
                record: self.record.clone(),
            })
        }
    }

    struct StallingInkSocket {
        record: Arc<Mutex<SocketRecord>>,
    }

    #[async_trait]
    impl InkSocket for StallingInkSocket {
        async fn send_binary(&mut self, bytes: Bytes) -> Result<(), agent_domain::BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent_binary
                .push(bytes);
            Ok(())
        }

        async fn send_text(&mut self, text: &'static str) -> Result<(), agent_domain::BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent_text
                .push(text);
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, agent_domain::BrainError> {
            std::future::pending().await
        }

        async fn close(&mut self) -> Result<(), agent_domain::BrainError> {
            self.record.lock().expect("record lock poisoned").closed = true;
            Ok(())
        }
    }

    /// The handshake itself outlives the stage deadline.
    struct SlowHandshakeInkConnector {
        record: Arc<Mutex<SocketRecord>>,
    }

    #[async_trait]
    impl InkConnector for SlowHandshakeInkConnector {
        type Socket = StallingInkSocket;

        async fn connect(&self, _request: Request<()>) -> Result<Self::Socket, BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .handshake_attempts += 1;
            std::future::pending::<()>().await;
            unreachable!("the stage deadline fires before the handshake completes")
        }
    }

    #[async_trait]
    impl InkSocket for FakeInkSocket {
        async fn send_binary(&mut self, bytes: Bytes) -> Result<(), agent_domain::BrainError> {
            if self.send_error.is_some() {
                return Err(ink_transport_failure("send_failed"));
            }
            self.sent_binary.push(bytes);
            Ok(())
        }

        async fn send_text(&mut self, text: &'static str) -> Result<(), agent_domain::BrainError> {
            self.sent_text.push(text);
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, agent_domain::BrainError> {
            Ok(self.incoming.pop_front().map(ToOwned::to_owned))
        }

        async fn close(&mut self) -> Result<(), agent_domain::BrainError> {
            self.closed = true;
            Ok(())
        }
    }
}
