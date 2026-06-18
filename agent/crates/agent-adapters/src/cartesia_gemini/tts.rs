use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderName, HeaderValue, Request},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

use agent_domain::{AudioFrame, BrainError};

use super::constants::{
    CARTESIA_SAMPLE_RATE, DEFAULT_CARTESIA_VERSION, DEFAULT_SONIC_MODEL, DEFAULT_SONIC_VOICE_ID,
    DEFAULT_SONIC_WEBSOCKET_URL,
};

const CARTESIA_VERSION_HEADER: &str = "cartesia-version";
const SONIC_TRANSCRIPT_CHUNK_TARGET: usize = 96;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SonicConfig {
    pub websocket_url: String,
    pub model_id: String,
    pub voice_id: String,
    pub language: String,
    pub sample_rate: u32,
    pub cartesia_version: String,
    pub max_buffer_delay_ms: u32,
}

impl Default for SonicConfig {
    fn default() -> Self {
        Self {
            websocket_url: DEFAULT_SONIC_WEBSOCKET_URL.to_owned(),
            model_id: DEFAULT_SONIC_MODEL.to_owned(),
            voice_id: DEFAULT_SONIC_VOICE_ID.to_owned(),
            language: "en".to_owned(),
            sample_rate: CARTESIA_SAMPLE_RATE,
            cartesia_version: DEFAULT_CARTESIA_VERSION.to_owned(),
            max_buffer_delay_ms: 0,
        }
    }
}

impl SonicConfig {
    pub fn websocket_endpoint(&self) -> String {
        format!(
            "{}?cartesia_version={}",
            self.websocket_url, self.cartesia_version
        )
    }

    pub fn websocket_request(&self, api_key: &str) -> Result<Request<()>, BrainError> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err(BrainError::MissingApiKey);
        }

        let mut request = self
            .websocket_endpoint()
            .into_client_request()
            .map_err(|error| {
                BrainError::Protocol(format!("invalid Cartesia Sonic WebSocket URL: {error}"))
            })?;
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
            BrainError::Protocol("invalid Cartesia Sonic authorization header".to_owned())
        })?;
        let version = HeaderValue::from_str(self.cartesia_version.trim()).map_err(|_| {
            BrainError::Protocol("invalid Cartesia-Version header value".to_owned())
        })?;
        request.headers_mut().insert(AUTHORIZATION, authorization);
        request
            .headers_mut()
            .insert(HeaderName::from_static(CARTESIA_VERSION_HEADER), version);
        Ok(request)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SonicEvent {
    Audio {
        context_id: String,
        pcm16_base64: String,
    },
    Done {
        context_id: String,
    },
    FlushDone {
        context_id: String,
    },
    Error {
        context_id: Option<String>,
        message: String,
    },
}

pub fn sonic_generation_request(
    config: &SonicConfig,
    context_id: &str,
    transcript: &str,
    continue_context: bool,
) -> Value {
    json!({
        "model_id": config.model_id,
        "transcript": transcript,
        "voice": {
            "mode": "id",
            "id": config.voice_id,
        },
        "language": config.language,
        "context_id": context_id,
        "output_format": {
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": config.sample_rate,
        },
        "continue": continue_context,
        "max_buffer_delay_ms": config.max_buffer_delay_ms,
    })
}

pub fn sonic_cancel_request(context_id: &str) -> Value {
    json!({
        "context_id": context_id,
        "cancel": true,
    })
}

pub fn sonic_flush_request(config: &SonicConfig, context_id: &str) -> Value {
    let mut request = sonic_generation_request(config, context_id, "", true);
    request["flush"] = Value::Bool(true);
    request
}

pub(crate) async fn synthesize_sonic_websocket(
    config: &SonicConfig,
    api_key: &str,
    context_id: &str,
    transcript: &str,
) -> Result<Vec<AudioFrame>, BrainError> {
    synthesize_sonic_with_connector(
        &WebSocketSonicConnector,
        config,
        api_key,
        context_id,
        transcript,
    )
    .await
}

pub(crate) async fn synthesize_sonic_with_connector<C>(
    connector: &C,
    config: &SonicConfig,
    api_key: &str,
    context_id: &str,
    transcript: &str,
) -> Result<Vec<AudioFrame>, BrainError>
where
    C: SonicConnector,
{
    let request = config.websocket_request(api_key)?;
    let mut socket = connector.connect(request).await?;
    synthesize_sonic_context(&mut socket, config, context_id, transcript).await
}

pub(crate) async fn synthesize_sonic_context<S>(
    socket: &mut S,
    config: &SonicConfig,
    context_id: &str,
    transcript: &str,
) -> Result<Vec<AudioFrame>, BrainError>
where
    S: SonicSocket + ?Sized,
{
    for request in sonic_generation_requests(config, context_id, transcript) {
        socket
            .send_json(request)
            .await
            .map_err(|_| BrainError::Connection("Cartesia Sonic send failed".to_owned()))?;
    }

    let mut frames = Vec::new();
    loop {
        let Some(text) = socket
            .next_text()
            .await
            .map_err(|_| BrainError::Connection("Cartesia Sonic receive failed".to_owned()))?
        else {
            close_quietly(socket).await;
            return Err(BrainError::Protocol(
                "Cartesia Sonic socket closed before done".to_owned(),
            ));
        };

        let Some(event) = parse_sonic_event(&text) else {
            continue;
        };
        match event {
            SonicEvent::Audio {
                context_id: event_context_id,
                pcm16_base64,
            } if event_context_id == context_id => {
                let frame = AudioFrame::from_base64(pcm16_base64).map_err(|_| {
                    BrainError::Protocol("Cartesia Sonic invalid audio chunk".to_owned())
                })?;
                frames.push(frame);
            }
            SonicEvent::Done {
                context_id: event_context_id,
            } if event_context_id == context_id => {
                socket.close().await.map_err(|_| {
                    BrainError::Connection("Cartesia Sonic close failed".to_owned())
                })?;
                if frames.is_empty() {
                    return Err(BrainError::Protocol(
                        "Cartesia Sonic returned no audio chunks".to_owned(),
                    ));
                }
                return Ok(frames);
            }
            SonicEvent::FlushDone { .. } => {}
            SonicEvent::Error {
                context_id: None, ..
            } => {
                close_quietly(socket).await;
                return Err(BrainError::Protocol(
                    "Cartesia Sonic provider error".to_owned(),
                ));
            }
            SonicEvent::Error {
                context_id: Some(event_context_id),
                ..
            } if event_context_id == context_id => {
                close_quietly(socket).await;
                return Err(BrainError::Protocol(
                    "Cartesia Sonic provider error".to_owned(),
                ));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
async fn cancel_sonic_context<S>(socket: &mut S, context_id: &str) -> Result<(), BrainError>
where
    S: SonicSocket + ?Sized,
{
    socket
        .send_json(sonic_cancel_request(context_id))
        .await
        .map_err(|_| BrainError::Connection("Cartesia Sonic cancel failed".to_owned()))
}

#[async_trait]
pub(crate) trait SonicSocket: Send {
    async fn send_json(&mut self, value: Value) -> Result<(), BrainError>;
    async fn next_text(&mut self) -> Result<Option<String>, BrainError>;
    async fn close(&mut self) -> Result<(), BrainError>;
}

#[async_trait]
pub(crate) trait SonicConnector: Send + Sync {
    type Socket: SonicSocket;

    async fn connect(&self, request: Request<()>) -> Result<Self::Socket, BrainError>;
}

fn sonic_generation_requests(
    config: &SonicConfig,
    context_id: &str,
    transcript: &str,
) -> Vec<Value> {
    let chunks = sonic_transcript_chunks(transcript);
    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            sonic_generation_request(config, context_id, chunk, index + 1 < chunks.len())
        })
        .collect()
}

fn sonic_transcript_chunks(transcript: &str) -> Vec<String> {
    if transcript.trim().is_empty() {
        return vec![String::new()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    for token in transcript.split_inclusive(' ') {
        if !current.is_empty() && current.len() + token.len() > SONIC_TRANSCRIPT_CHUNK_TARGET {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(token);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

async fn close_quietly<S>(socket: &mut S)
where
    S: SonicSocket + ?Sized,
{
    let _ = socket.close().await;
}

#[derive(Clone, Copy, Debug, Default)]
struct WebSocketSonicConnector;

#[async_trait]
impl SonicConnector for WebSocketSonicConnector {
    type Socket = TungsteniteSonicSocket;

    async fn connect(&self, request: Request<()>) -> Result<Self::Socket, BrainError> {
        let (socket, _) = connect_async(request).await.map_err(|_| {
            BrainError::Connection("Cartesia Sonic WebSocket connect failed".to_owned())
        })?;
        Ok(TungsteniteSonicSocket { socket })
    }
}

struct TungsteniteSonicSocket {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

#[async_trait]
impl SonicSocket for TungsteniteSonicSocket {
    async fn send_json(&mut self, value: Value) -> Result<(), BrainError> {
        self.socket
            .send(Message::Text(value.to_string().into()))
            .await
            .map_err(|_| BrainError::Connection("Cartesia Sonic send failed".to_owned()))
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
                    .map_err(|_| BrainError::Connection("Cartesia Sonic pong failed".to_owned()))?,
                Ok(Message::Close(_)) => return Ok(None),
                Ok(Message::Binary(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                Err(_) => {
                    return Err(BrainError::Connection(
                        "Cartesia Sonic receive failed".to_owned(),
                    ))
                }
            }
        }
    }

    async fn close(&mut self) -> Result<(), BrainError> {
        self.socket
            .close(None)
            .await
            .map_err(|_| BrainError::Connection("Cartesia Sonic close failed".to_owned()))
    }
}

pub fn parse_sonic_event(text: &str) -> Option<SonicEvent> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    parse_sonic_value(&value)
}

pub fn parse_sonic_value(value: &Value) -> Option<SonicEvent> {
    let message_type = value.get("type").and_then(Value::as_str)?;
    match message_type {
        "chunk" => Some(SonicEvent::Audio {
            context_id: context_id(value)?.to_owned(),
            pcm16_base64: value.get("data")?.as_str()?.to_owned(),
        }),
        "done" => Some(SonicEvent::Done {
            context_id: context_id(value)?.to_owned(),
        }),
        "flush_done" => Some(SonicEvent::FlushDone {
            context_id: context_id(value)?.to_owned(),
        }),
        "error" => Some(SonicEvent::Error {
            context_id: context_id(value).map(ToOwned::to_owned),
            message: value
                .get("message")
                .or_else(|| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Cartesia Sonic error")
                .to_owned(),
        }),
        _ => None,
    }
}

fn context_id(value: &Value) -> Option<&str> {
    value.get("context_id").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;

    #[test]
    fn builds_streaming_generation_cancel_and_flush_requests() {
        let config = SonicConfig::default();
        let delta = sonic_generation_request(&config, "ctx-1", "Explain ", true);
        let flush = sonic_flush_request(&config, "ctx-1");

        assert_eq!(delta["model_id"], "sonic-3.5");
        assert_eq!(delta["context_id"], "ctx-1");
        assert_eq!(delta["transcript"], "Explain ");
        assert_eq!(delta["continue"], true);
        assert_eq!(
            delta["output_format"],
            json!({
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": 24000
            })
        );
        assert_eq!(
            sonic_cancel_request("ctx-1"),
            json!({ "context_id": "ctx-1", "cancel": true })
        );
        assert_eq!(flush["context_id"], "ctx-1");
        assert_eq!(flush["transcript"], "");
        assert_eq!(flush["continue"], true);
        assert_eq!(flush["flush"], true);
        assert_eq!(flush["model_id"], "sonic-3.5");
    }

    #[test]
    fn parses_audio_done_and_error_events() {
        assert_eq!(
            parse_sonic_value(&json!({ "type": "chunk", "context_id": "ctx-1", "data": "AAAA" })),
            Some(SonicEvent::Audio {
                context_id: "ctx-1".to_owned(),
                pcm16_base64: "AAAA".to_owned()
            })
        );
        assert_eq!(
            parse_sonic_value(&json!({ "type": "done", "context_id": "ctx-1" })),
            Some(SonicEvent::Done {
                context_id: "ctx-1".to_owned()
            })
        );
    }

    #[test]
    fn authenticated_request_uses_server_headers_and_required_query() {
        let request = SonicConfig::default()
            .websocket_request("sk_car_test_secret")
            .unwrap();
        let uri = request.uri().to_string();

        assert!(uri.starts_with("wss://api.cartesia.ai/tts/websocket?"));
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
    async fn synthesizer_streams_chunked_transcript_audio_and_closes() {
        let record = Arc::new(Mutex::new(SocketRecord::default()));
        let connector = RecordingSonicConnector {
            record: record.clone(),
            incoming: VecDeque::from([
                r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#,
                r#"{"type":"flush_done","context_id":"response-1","flush_id":1}"#,
                r#"{"type":"chunk","context_id":"response-1","data":"AwQ="}"#,
                r#"{"type":"done","context_id":"response-1"}"#,
            ]),
        };
        let long_transcript = "Connect the electron transport chain to proton pumping. Then explain why ATP synthase needs the gradient before it can make ATP. Finish with the role of oxygen as the final electron acceptor.";

        let frames = synthesize_sonic_with_connector(
            &connector,
            &SonicConfig::default(),
            "sk_car_connector_secret",
            "response-1",
            long_transcript,
        )
        .await
        .unwrap();

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].pcm16_bytes(), [1, 2]);
        assert_eq!(frames[1].pcm16_bytes(), [3, 4]);
        let record = record.lock().expect("record lock poisoned");
        assert!(record
            .request_uri
            .as_ref()
            .unwrap()
            .contains("wss://api.cartesia.ai/tts/websocket?"));
        assert_eq!(
            record.authorization.as_deref(),
            Some("Bearer sk_car_connector_secret")
        );
        assert!(record.sent_json.len() > 1);
        assert!(record
            .sent_json
            .iter()
            .take(record.sent_json.len() - 1)
            .all(|request| request["continue"] == true));
        assert_eq!(
            record.sent_json.last().unwrap()["continue"],
            serde_json::Value::Bool(false)
        );
        assert!(record.closed);
    }

    #[tokio::test]
    async fn synthesizer_sends_cancel_command_without_leaking_context_payloads() {
        let mut socket = FakeSonicSocket::new(vec![]);

        cancel_sonic_context(&mut socket, "response-1")
            .await
            .unwrap();

        assert_eq!(
            socket.sent_json,
            vec![json!({ "context_id": "response-1", "cancel": true })]
        );
    }

    #[tokio::test]
    async fn synthesizer_sanitizes_provider_and_transport_errors() {
        let mut provider_error = FakeSonicSocket::new(vec![
            r#"{"type":"error","context_id":"response-1","message":"provider leaked assistant text"}"#,
        ]);

        let error = synthesize_sonic_context(
            &mut provider_error,
            &SonicConfig::default(),
            "response-1",
            "assistant text must not appear in errors",
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("Cartesia Sonic provider error"));
        assert!(!error.contains("provider leaked assistant text"));
        assert!(!error.contains("assistant text must not appear"));

        let mut send_error = FakeSonicSocket::with_send_error("writer leaked transcript");
        let error = synthesize_sonic_context(
            &mut send_error,
            &SonicConfig::default(),
            "response-1",
            "another assistant payload",
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("Cartesia Sonic send failed"));
        assert!(!error.contains("writer leaked transcript"));
        assert!(!error.contains("another assistant payload"));
    }

    #[tokio::test]
    async fn synthesizer_rejects_socket_close_before_done() {
        let mut socket = FakeSonicSocket::new(vec![
            r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#,
        ]);

        let error = synthesize_sonic_context(
            &mut socket,
            &SonicConfig::default(),
            "response-1",
            "partial assistant text",
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("closed before done"));
        assert!(!error.contains("partial assistant text"));
        assert!(socket.closed);
    }

    struct FakeSonicSocket {
        incoming: VecDeque<&'static str>,
        sent_json: Vec<serde_json::Value>,
        send_error: Option<&'static str>,
        closed: bool,
    }

    #[derive(Default)]
    struct SocketRecord {
        request_uri: Option<String>,
        authorization: Option<String>,
        sent_json: Vec<serde_json::Value>,
        closed: bool,
    }

    struct RecordingSonicConnector {
        record: Arc<Mutex<SocketRecord>>,
        incoming: VecDeque<&'static str>,
    }

    #[async_trait]
    impl SonicConnector for RecordingSonicConnector {
        type Socket = RecordingSonicSocket;

        async fn connect(
            &self,
            request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, agent_domain::BrainError> {
            let mut record = self.record.lock().expect("record lock poisoned");
            record.request_uri = Some(request.uri().to_string());
            record.authorization = request
                .headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned);
            drop(record);
            Ok(RecordingSonicSocket {
                record: self.record.clone(),
                incoming: self.incoming.clone(),
            })
        }
    }

    struct RecordingSonicSocket {
        record: Arc<Mutex<SocketRecord>>,
        incoming: VecDeque<&'static str>,
    }

    #[async_trait]
    impl SonicSocket for RecordingSonicSocket {
        async fn send_json(
            &mut self,
            value: serde_json::Value,
        ) -> Result<(), agent_domain::BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent_json
                .push(value);
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

    impl FakeSonicSocket {
        fn new(incoming: Vec<&'static str>) -> Self {
            Self {
                incoming: incoming.into(),
                sent_json: Vec::new(),
                send_error: None,
                closed: false,
            }
        }

        fn with_send_error(message: &'static str) -> Self {
            Self {
                incoming: VecDeque::new(),
                sent_json: Vec::new(),
                send_error: Some(message),
                closed: false,
            }
        }
    }

    #[async_trait]
    impl SonicSocket for FakeSonicSocket {
        async fn send_json(
            &mut self,
            value: serde_json::Value,
        ) -> Result<(), agent_domain::BrainError> {
            if let Some(message) = self.send_error {
                return Err(agent_domain::BrainError::Connection(message.to_owned()));
            }
            self.sent_json.push(value);
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
