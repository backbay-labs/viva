use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
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
    CARTESIA_SAMPLE_RATE, DEFAULT_CARTESIA_VERSION, DEFAULT_SONIC_MODEL, DEFAULT_SONIC_VOICE_ID,
    DEFAULT_SONIC_WEBSOCKET_URL,
};

const CARTESIA_VERSION_HEADER: &str = "cartesia-version";
const SONIC_TRANSCRIPT_CHUNK_TARGET: usize = 96;
/// How many frames a cancelled context may still deliver before the connection
/// is closed. Cartesia documents that a cancel may not stop a request already
/// generating, so the drain is bounded rather than open-ended.
const SONIC_CANCEL_DRAIN_LIMIT: usize = 64;

/// `ADAPTER-01` / `A-13.2`: every Sonic failure is classified where it is
/// observed, and only a closed `error_kind` token travels. Assistant text, a
/// provider message, a close reason, a URL, or a credential never reaches the
/// metadata.
fn sonic_failure(
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
        model: "cartesia-sonic".to_owned(),
        metadata: format!("stage=cartesia_sonic error_kind={error_kind}"),
    })
}

fn sonic_transport_failure(error_kind: &'static str) -> BrainError {
    sonic_failure(
        BrainFailureClass::NetworkDisconnect,
        BrainFailureStage::Transport,
        true,
        error_kind,
    )
}

fn sonic_protocol_failure(error_kind: &'static str) -> BrainError {
    sonic_failure(
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Provider,
        true,
        error_kind,
    )
}

fn sonic_auth_failure(error_kind: &'static str) -> BrainError {
    sonic_failure(
        BrainFailureClass::ProviderAuthFailure,
        BrainFailureStage::ProviderAuth,
        false,
        error_kind,
    )
}

/// `ADAPTER-06`: a refused Sonic upgrade keeps only its numeric HTTP status and
/// one allowlisted diagnostic code. The refusal body, the request URL, and the
/// query are discarded whole.
fn sonic_handshake_failure(status: u16) -> BrainError {
    let (diagnostic, failure_class, stage) =
        cartesia_handshake_classification(ProviderStageLabel::CartesiaSonic, status);
    provider_diagnostic_failure(
        diagnostic,
        failure_class,
        stage,
        "cartesia-sonic",
        Duration::ZERO,
    )
}

/// A connected Sonic socket the provider closed. Only the numeric close code
/// survives; the close reason never leaves the transport.
fn sonic_close_failure(close_code: Option<u16>) -> BrainError {
    provider_diagnostic_failure(
        ProviderDiagnostic::new(ProviderDiagnosticCode::CartesiaSonicWsClosed, true)
            .with_close_code(close_code),
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Provider,
        "cartesia-sonic",
        Duration::ZERO,
    )
}

/// A provider `error` frame. Its message and provider-authored code collapse
/// into the stage's one provider-error diagnostic.
fn sonic_provider_error_failure() -> BrainError {
    provider_diagnostic_failure(
        ProviderDiagnostic::new(ProviderDiagnosticCode::CartesiaSonicProviderError, true),
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Provider,
        "cartesia-sonic",
        Duration::ZERO,
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SonicConfig {
    pub websocket_url: String,
    pub model_id: String,
    pub voice_id: String,
    pub language: String,
    pub sample_rate: u32,
    pub cartesia_version: String,
    pub max_buffer_delay_ms: u32,
    pub stage_timeout: Duration,
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
            stage_timeout: Duration::from_secs(4),
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
            return Err(sonic_auth_failure("missing_api_key"));
        }

        let mut request = self
            .websocket_endpoint()
            .into_client_request()
            .map_err(|_| sonic_protocol_failure("invalid_endpoint"))?;
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| sonic_auth_failure("invalid_authorization_header"))?;
        let version = HeaderValue::from_str(self.cartesia_version.trim())
            .map_err(|_| sonic_protocol_failure("invalid_version_header"))?;
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

/// One response's speech on a connection that lives only for that response.
///
/// This is the single-shot shape the session connection replaced; it survives as
/// a test seam so the connect/deadline/cleanup contract can be driven directly
/// against a scripted connector.
#[cfg(test)]
pub(crate) async fn synthesize_sonic_with_connector<C>(
    connector: Arc<C>,
    config: &SonicConfig,
    api_key: &str,
    context_id: &str,
    transcript: &str,
    cancel: &CancellationToken,
    sink: &mut dyn SpeechFrameSink,
) -> Result<(), BrainError>
where
    C: SonicConnector + 'static,
    C::Socket: 'static,
{
    let voice = SonicSessionVoice::new(connector);
    let spoken = async {
        voice
            .extend(config, api_key, context_id, transcript)
            .await?;
        voice.finish(config, context_id, cancel, sink).await
    }
    .await;
    voice.close().await;
    spoken
}

/// Drive one already-connected socket through a whole response context.
#[cfg(test)]
pub(crate) async fn speak_sonic_on_socket<S>(
    socket: &mut S,
    config: &SonicConfig,
    context_id: &str,
    transcript: &str,
    cancel: &CancellationToken,
    sink: &mut dyn SpeechFrameSink,
) -> Result<SonicContextOutcome, BrainError>
where
    S: SonicSocket + ?Sized,
{
    write_sonic_continuations(socket, config, context_id, transcript)
        .await
        .map_err(|failure| failure.error)?;
    write_sonic_finalizer(socket, config, context_id).await?;
    stream_sonic_context(socket, config, context_id, cancel, sink).await
}

fn sonic_deadline_failure() -> BrainError {
    sonic_failure(
        BrainFailureClass::Timeout,
        BrainFailureStage::Provider,
        true,
        "deadline_elapsed",
    )
}

/// What one response context left behind.
#[derive(Debug)]
pub(crate) struct SonicContextOutcome {
    /// Whether the connection is still usable for the next response context.
    pub(crate) connection_open: bool,
}

/// A write that did not reach the provider, and how much of the context did.
///
/// `accepted_any` is what decides whether the context can be re-spoken on a
/// replacement connection: once the provider has taken any part of it, a fresh
/// dial would speak a truncated or duplicated response.
struct SonicWriteFailure {
    error: BrainError,
    accepted_any: bool,
}

async fn write_sonic_continuations<S>(
    socket: &mut S,
    config: &SonicConfig,
    context_id: &str,
    text: &str,
) -> Result<(), SonicWriteFailure>
where
    S: SonicSocket + ?Sized,
{
    let mut accepted_any = false;
    for request in sonic_continuation_requests(config, context_id, text) {
        if socket.send_json(request).await.is_err() {
            return Err(SonicWriteFailure {
                error: sonic_transport_failure("send_failed"),
                accepted_any,
            });
        }
        accepted_any = true;
    }
    Ok(())
}

/// The one explicit `continue: false` that tells the provider the response is
/// complete. It is written once, after the model has finished.
async fn write_sonic_finalizer<S>(
    socket: &mut S,
    config: &SonicConfig,
    context_id: &str,
) -> Result<(), BrainError>
where
    S: SonicSocket + ?Sized,
{
    socket
        .send_json(sonic_generation_request(config, context_id, "", false))
        .await
        .map_err(|_| sonic_transport_failure("send_failed"))
}

/// Read one context's audio, handing each decoded frame straight to the sink.
///
/// `ADAPTER-05`: nothing accumulates here. A frame reaches the learner as soon
/// as it is decoded, long before the provider's `done`.
pub(crate) async fn stream_sonic_context<S>(
    socket: &mut S,
    config: &SonicConfig,
    context_id: &str,
    cancel: &CancellationToken,
    sink: &mut dyn SpeechFrameSink,
) -> Result<SonicContextOutcome, BrainError>
where
    S: SonicSocket + ?Sized,
{
    let _ = config;
    let mut spoke = false;
    loop {
        // Cooperative: a barge-in does not wait for the provider to speak
        // again before the cancel control is written.
        if cancel.is_cancelled() {
            return cancel_sonic_context_and_drain(socket, context_id).await;
        }
        let received = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            received = socket.next_text() => Some(received),
        };
        let Some(received) = received else {
            return cancel_sonic_context_and_drain(socket, context_id).await;
        };
        let Some(text) = received.map_err(|_| sonic_transport_failure("receive_failed"))? else {
            let close_code = socket.last_close_code();
            close_quietly(socket).await;
            return Err(sonic_close_failure(close_code));
        };

        let Some(event) = parse_sonic_event(&text) else {
            continue;
        };
        match event {
            SonicEvent::Audio {
                context_id: event_context_id,
                pcm16_base64,
            } if event_context_id == context_id => {
                let frame = AudioFrame::from_base64(pcm16_base64)
                    .map_err(|_| sonic_protocol_failure("invalid_audio_chunk"))?;
                spoke = true;
                if !sink.frame(frame).await {
                    // The consumer stopped listening, so the context is
                    // cancelled and drained rather than left generating.
                    return cancel_sonic_context_and_drain(socket, context_id).await;
                }
            }
            SonicEvent::Done {
                context_id: event_context_id,
            } if event_context_id == context_id => {
                if !spoke {
                    close_quietly(socket).await;
                    return Err(sonic_protocol_failure("no_audio_chunks"));
                }
                return Ok(SonicContextOutcome {
                    connection_open: socket.is_open(),
                });
            }
            SonicEvent::FlushDone { .. } => {}
            SonicEvent::Error {
                context_id: None, ..
            } => {
                close_quietly(socket).await;
                return Err(sonic_provider_error_failure());
            }
            SonicEvent::Error {
                context_id: Some(event_context_id),
                ..
            } if event_context_id == context_id => {
                close_quietly(socket).await;
                return Err(sonic_provider_error_failure());
            }
            _ => {}
        }
    }
}

/// Write the documented context cancel, then suppress what the provider still
/// finishes for that context.
///
/// The cancel write is a request, never an acknowledgement: Cartesia documents
/// that an already-generating request may complete anyway, so the frames that
/// arrive afterwards are drained and discarded rather than surfacing as the
/// replacement response's audio. A cancelled context yields no audio and is not
/// a provider incident.
///
/// `ADAPTER-03` / `ADAPTER-04`: the plan closes the socket on "session stop,
/// stage timeout, fatal provider error, or failed cancel/drain". A cancel the
/// provider acknowledged inside the bounded drain leaves nothing unread on the
/// wire, so the multiplexed connection keeps serving the next response context;
/// only a drain that ran out, broke, or saw an error closes.
async fn cancel_sonic_context_and_drain<S>(
    socket: &mut S,
    context_id: &str,
) -> Result<SonicContextOutcome, BrainError>
where
    S: SonicSocket + ?Sized,
{
    let drained = cancel_sonic_context(socket, context_id).await.is_ok()
        && drain_cancelled_sonic_context(socket, context_id).await;
    if !drained {
        close_quietly(socket).await;
        return Ok(SonicContextOutcome {
            connection_open: false,
        });
    }
    Ok(SonicContextOutcome {
        connection_open: socket.is_open(),
    })
}

/// Read what the provider still finishes for a cancelled context.
///
/// Returns whether the context ended inside the bounded drain, i.e. whether the
/// connection is left with none of that context's frames still to come.
async fn drain_cancelled_sonic_context<S>(socket: &mut S, context_id: &str) -> bool
where
    S: SonicSocket + ?Sized,
{
    for _ in 0..SONIC_CANCEL_DRAIN_LIMIT {
        match socket.next_text().await {
            Ok(Some(text)) => match parse_sonic_event(&text) {
                Some(SonicEvent::Done {
                    context_id: event_context_id,
                }) if event_context_id == context_id => return true,
                Some(SonicEvent::Error { .. }) => return false,
                _ => {}
            },
            Ok(None) | Err(_) => return false,
        }
    }
    false
}

pub(crate) async fn cancel_sonic_context<S>(
    socket: &mut S,
    context_id: &str,
) -> Result<(), BrainError>
where
    S: SonicSocket + ?Sized,
{
    socket
        .send_json(sonic_cancel_request(context_id))
        .await
        .map_err(|_| sonic_transport_failure("cancel_failed"))
}

/// Where decoded speech frames go as the provider produces them.
///
/// `ADAPTER-05`: frames leave the adapter one at a time, before the provider
/// says it is done, so nothing accumulates a whole response's audio.
#[async_trait]
pub(crate) trait SpeechFrameSink: Send {
    /// Deliver one frame. Returning `false` stops the context: the consumer is
    /// gone, or the turn it belongs to was cancelled.
    async fn frame(&mut self, frame: AudioFrame) -> bool;
}

#[async_trait]
pub(crate) trait SonicSocket: Send {
    async fn send_json(&mut self, value: Value) -> Result<(), BrainError>;
    async fn next_text(&mut self) -> Result<Option<String>, BrainError>;
    async fn close(&mut self) -> Result<(), BrainError>;

    /// The numeric close code the provider sent, once it has closed. The close
    /// reason is dropped at the transport and is never available here.
    fn last_close_code(&self) -> Option<u16> {
        None
    }

    /// Whether this connection is still usable for another response context.
    ///
    /// `ADAPTER-04`: a session-scoped connection is only reused while the
    /// provider still holds it open. A socket the provider hung up on is
    /// replaced, never written to again.
    fn is_open(&self) -> bool {
        true
    }
}

#[async_trait]
pub(crate) trait SonicConnector: Send + Sync {
    type Socket: SonicSocket;

    async fn connect(&self, request: Request<()>) -> Result<Self::Socket, BrainError>;
}

/// The object-safe half of [`SonicConnector`], so one session can hold a
/// connector without the runner being generic over its socket type.
#[async_trait]
pub(crate) trait DynSonicConnector: Send + Sync {
    async fn connect_boxed(&self, request: Request<()>)
        -> Result<Box<dyn SonicSocket>, BrainError>;
}

#[async_trait]
impl<C> DynSonicConnector for C
where
    C: SonicConnector,
    C::Socket: 'static,
{
    async fn connect_boxed(
        &self,
        request: Request<()>,
    ) -> Result<Box<dyn SonicSocket>, BrainError> {
        Ok(Box::new(self.connect(request).await?))
    }
}

/// One Viva realtime session's speech connection.
///
/// `ADAPTER-04`: Cartesia documents one multiplexed Sonic WebSocket serving many
/// generations, a new context per conversational turn, and idle sockets counting
/// against concurrency limits. So the connection is opened on first speech,
/// reused across the session's response contexts, replaced when the provider
/// closes it, and closed once when the session ends. It is per learner session,
/// never a process-global pool keyed by learner id.
pub(crate) struct SonicSessionVoice {
    connector: Arc<dyn DynSonicConnector>,
    held: tokio::sync::Mutex<Option<HeldSonicConnection>>,
}

/// The session's live speech connection, and how much of the current response
/// context the provider has already taken from it.
struct HeldSonicConnection {
    socket: Box<dyn SonicSocket>,
    /// The response context this connection has already accepted input for.
    /// `None` means nothing of any context is part-delivered on it.
    written_context: Option<String>,
}

impl fmt::Debug for SonicSessionVoice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SonicSessionVoice")
            .finish_non_exhaustive()
    }
}

impl SonicSessionVoice {
    pub(crate) fn new<C>(connector: Arc<C>) -> Self
    where
        C: DynSonicConnector + 'static,
    {
        Self {
            connector,
            held: tokio::sync::Mutex::new(None),
        }
    }

    pub(crate) fn websocket() -> Self {
        Self::new(Arc::new(WebSocketSonicConnector))
    }

    /// Feed more final-pass text into this response's context.
    ///
    /// `ADAPTER-05`: each part is written as a `continue: true` input the moment
    /// the model produces it, so the provider starts generating before the model
    /// has finished writing.
    ///
    /// `ADAPTER-04`: the connection is opened on first speech and reused. A
    /// connection held from an earlier context may already be gone — Cartesia
    /// closes idle sockets at documented limits, and a peer-initiated close is
    /// invisible to a socket nobody is reading, so `is_open()` sampled when the
    /// last context ended cannot see it. The first write of a *new* context into
    /// a held connection is therefore retried once on a fresh dial: none of that
    /// context has reached the provider, so the replacement speaks it whole.
    /// Once any part of the context has been accepted there is no retry, because
    /// re-speaking it elsewhere would truncate or duplicate the response.
    pub(crate) async fn extend(
        &self,
        config: &SonicConfig,
        api_key: &str,
        context_id: &str,
        text: &str,
    ) -> Result<(), BrainError> {
        let mut held = self.held.lock().await;
        if let Some(connection) = held.as_mut() {
            let untouched_context = connection.written_context.as_deref() != Some(context_id);
            match write_sonic_continuations(connection.socket.as_mut(), config, context_id, text)
                .await
            {
                Ok(()) => {
                    connection.written_context = Some(context_id.to_owned());
                    return Ok(());
                }
                Err(failure) => {
                    close_quietly(connection.socket.as_mut()).await;
                    *held = None;
                    if !untouched_context || failure.accepted_any {
                        return Err(failure.error);
                    }
                }
            }
        }

        let mut socket = self.dial(config, api_key).await?;
        match write_sonic_continuations(socket.as_mut(), config, context_id, text).await {
            Ok(()) => {
                *held = Some(HeldSonicConnection {
                    socket,
                    written_context: Some(context_id.to_owned()),
                });
                Ok(())
            }
            Err(failure) => {
                close_quietly(socket.as_mut()).await;
                Err(failure.error)
            }
        }
    }

    async fn dial(
        &self,
        config: &SonicConfig,
        api_key: &str,
    ) -> Result<Box<dyn SonicSocket>, BrainError> {
        let request = config.websocket_request(api_key)?;
        match timeout(config.stage_timeout, self.connector.connect_boxed(request)).await {
            Ok(socket) => socket,
            Err(_) => Err(sonic_deadline_failure()),
        }
    }

    /// Close this response's input and stream its audio out, frame by frame.
    pub(crate) async fn finish(
        &self,
        config: &SonicConfig,
        context_id: &str,
        cancel: &CancellationToken,
        sink: &mut dyn SpeechFrameSink,
    ) -> Result<(), BrainError> {
        let mut held = self.held.lock().await;
        let Some(connection) = held.as_mut() else {
            return Err(sonic_protocol_failure("no_open_context"));
        };
        let socket = connection.socket.as_mut();
        if let Err(error) = write_sonic_finalizer(socket, config, context_id).await {
            close_quietly(socket).await;
            *held = None;
            return Err(error);
        }
        match timeout(
            config.stage_timeout,
            stream_sonic_context(socket, config, context_id, cancel, sink),
        )
        .await
        {
            Ok(Ok(outcome)) => {
                if outcome.connection_open {
                    // The context is over, so nothing of it is part-delivered on
                    // the connection the next context will reuse.
                    connection.written_context = None;
                } else {
                    *held = None;
                }
                Ok(())
            }
            // The context already closed the connection on its terminal paths.
            Ok(Err(error)) => {
                *held = None;
                Err(error)
            }
            Err(_) => {
                let _ = cancel_sonic_context(socket, context_id).await;
                close_quietly(socket).await;
                *held = None;
                Err(sonic_deadline_failure())
            }
        }
    }

    /// Cancel one response's context on the session connection.
    ///
    /// `ADAPTER-03`: a turn replaced between its last text and its finalizer
    /// still has an open context on the provider. It is told and drained before
    /// the next turn writes anything. A drain that saw the context finish leaves
    /// a clean wire and keeps the connection; one that ran out, broke, or saw an
    /// error closes it, so no unread frame is ever handed to the next context.
    pub(crate) async fn cancel_context(&self, context_id: &str) {
        let mut held = self.held.lock().await;
        let Some(connection) = held.as_mut() else {
            return;
        };
        if connection.written_context.as_deref() != Some(context_id) {
            // This context is not the one open on the connection: it already
            // finished, or was already cancelled. Cancelling it again would only
            // make the provider's next reply unreadable for the context that is
            // open now.
            return;
        }
        let reusable = cancel_sonic_context_and_drain(connection.socket.as_mut(), context_id)
            .await
            .is_ok_and(|outcome| outcome.connection_open);
        if reusable {
            connection.written_context = None;
        } else {
            *held = None;
        }
    }

    /// The single close path: session stop, session drop, or fatal error.
    pub(crate) async fn close(&self) {
        let mut held = self.held.lock().await;
        if let Some(connection) = held.as_mut() {
            close_quietly(connection.socket.as_mut()).await;
        }
        *held = None;
    }
}

/// Every part of one continuation, all of them `continue: true`. Only
/// [`write_sonic_finalizer`] ever writes `continue: false`.
fn sonic_continuation_requests(config: &SonicConfig, context_id: &str, text: &str) -> Vec<Value> {
    sonic_transcript_chunks(text)
        .iter()
        .map(|chunk| sonic_generation_request(config, context_id, chunk, true))
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
        let (socket, _) = connect_async(request).await.map_err(|error| {
            // A refused upgrade is an HTTP fact; only its status survives.
            websocket_handshake_status(&error).map_or_else(
                || sonic_transport_failure("connect_failed"),
                sonic_handshake_failure,
            )
        })?;
        Ok(TungsteniteSonicSocket {
            socket,
            open: true,
            close_code: None,
        })
    }
}

struct TungsteniteSonicSocket {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    open: bool,
    close_code: Option<u16>,
}

#[async_trait]
impl SonicSocket for TungsteniteSonicSocket {
    async fn send_json(&mut self, value: Value) -> Result<(), BrainError> {
        self.socket
            .send(Message::Text(value.to_string().into()))
            .await
            .inspect_err(|_| self.open = false)
            .map_err(|_| sonic_transport_failure("send_failed"))
    }

    async fn next_text(&mut self) -> Result<Option<String>, BrainError> {
        loop {
            let Some(message) = self.socket.next().await else {
                self.open = false;
                return Ok(None);
            };
            match message {
                Ok(Message::Text(text)) => return Ok(Some(text.to_string())),
                Ok(Message::Ping(payload)) => self
                    .socket
                    .send(Message::Pong(payload))
                    .await
                    .inspect_err(|_| self.open = false)
                    .map_err(|_| sonic_transport_failure("pong_failed"))?,
                Ok(Message::Close(frame)) => {
                    self.open = false;
                    self.close_code = websocket_close_code(frame.as_ref());
                    return Ok(None);
                }
                Ok(Message::Binary(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                Err(_) => {
                    self.open = false;
                    return Err(sonic_transport_failure("receive_failed"));
                }
            }
        }
    }

    async fn close(&mut self) -> Result<(), BrainError> {
        self.open = false;
        self.socket
            .close(None)
            .await
            .map_err(|_| sonic_transport_failure("close_failed"))
    }

    fn is_open(&self) -> bool {
        self.open
    }

    fn last_close_code(&self) -> Option<u16> {
        self.close_code
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
    use std::time::Duration;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;

    /// Collects what the provider actually spoke, so a test can assert on the
    /// frames without the transport ever accumulating them.
    #[derive(Default)]
    struct RecordedFrames {
        heard: Vec<AudioFrame>,
    }

    #[async_trait]
    impl SpeechFrameSink for RecordedFrames {
        async fn frame(&mut self, frame: AudioFrame) -> bool {
            self.heard.push(frame);
            true
        }
    }

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

        let mut heard = RecordedFrames::default();
        synthesize_sonic_with_connector(
            Arc::new(connector),
            &SonicConfig::default(),
            "sk_car_connector_secret",
            "response-1",
            long_transcript,
            &CancellationToken::new(),
            &mut heard,
        )
        .await
        .unwrap();

        assert_eq!(heard.heard.len(), 2);
        assert_eq!(heard.heard[0].pcm16_bytes(), [1, 2]);
        assert_eq!(heard.heard[1].pcm16_bytes(), [3, 4]);
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
    async fn synthesizer_times_out_without_leaking_transcript_or_credentials() {
        let connector = DelayedSonicConnector;
        let config = SonicConfig {
            stage_timeout: Duration::from_millis(5),
            ..SonicConfig::default()
        };
        let transcript = "assistant text must not appear in timeout evidence";

        let error = synthesize_sonic_with_connector(
            Arc::new(connector),
            &config,
            "sk_car_timeout_secret",
            "response-1",
            transcript,
            &CancellationToken::new(),
            &mut RecordedFrames::default(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_sonic error_kind=deadline_elapsed"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("sk_car_timeout_secret"));
        assert!(!rendered.contains(transcript));
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

        let error = speak_sonic_on_socket(
            &mut provider_error,
            &SonicConfig::default(),
            "response-1",
            "assistant text must not appear in errors",
            &CancellationToken::new(),
            &mut RecordedFrames::default(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_sonic error_kind=cartesia_sonic_provider_error retry_eligible=true"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("provider leaked assistant text"));
        assert!(!rendered.contains("assistant text must not appear"));

        let mut send_error = FakeSonicSocket::with_send_error("writer leaked transcript");
        let error = speak_sonic_on_socket(
            &mut send_error,
            &SonicConfig::default(),
            "response-1",
            "another assistant payload",
            &CancellationToken::new(),
            &mut RecordedFrames::default(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_sonic error_kind=send_failed"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("writer leaked transcript"));
        assert!(!rendered.contains("another assistant payload"));
    }

    #[tokio::test]
    async fn synthesizer_rejects_socket_close_before_done() {
        let mut socket = FakeSonicSocket::new(vec![
            r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#,
        ]);

        let error = speak_sonic_on_socket(
            &mut socket,
            &SonicConfig::default(),
            "response-1",
            "partial assistant text",
            &CancellationToken::new(),
            &mut RecordedFrames::default(),
        )
        .await
        .unwrap_err();

        assert_eq!(
            error.failure().metadata(),
            "stage=cartesia_sonic error_kind=cartesia_sonic_ws_closed retry_eligible=true"
        );
        assert!(!format!("{error} {:?}", error.failure()).contains("partial assistant text"));
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
        connected: bool,
        sent_json: Vec<serde_json::Value>,
        closed: bool,
    }

    struct RecordingSonicConnector {
        record: Arc<Mutex<SocketRecord>>,
        incoming: VecDeque<&'static str>,
    }

    struct DelayedSonicConnector;

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
            record.connected = true;
            drop(record);
            Ok(RecordingSonicSocket {
                record: self.record.clone(),
                incoming: self.incoming.clone(),
            })
        }
    }

    #[async_trait]
    impl SonicConnector for DelayedSonicConnector {
        type Socket = FakeSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, agent_domain::BrainError> {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(FakeSonicSocket::new(vec![
                r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#,
                r#"{"type":"done","context_id":"response-1"}"#,
            ]))
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

    // -----------------------------------------------------------------
    // Task 3 (`ADAPTER-03`): a barge-in writes the documented context cancel for
    // the response it replaces *before* the replacement context is opened.
    //
    // Cartesia documents that a cancel may not stop a request that is already
    // generating, so the cancelled context's late frames are drained and
    // discarded rather than treated as replacement audio.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn sonic_barge_in_sends_context_cancel_before_replacement_context() {
        let record = Arc::new(Mutex::new(SocketRecord::default()));
        let connector = Arc::new(BargeInSonicConnector::new(record.clone()));
        let config = SonicConfig::default();
        let cancel = CancellationToken::new();

        let speaking = tokio::spawn({
            let connector = Arc::clone(&connector);
            let config = config.clone();
            let cancel = cancel.clone();
            async move {
                let mut heard = RecordedFrames::default();
                synthesize_sonic_with_connector(
                    Arc::clone(&connector),
                    &config,
                    "sk_car_barge_secret",
                    "response-1",
                    "first response text",
                    &cancel,
                    &mut heard,
                )
                .await
                .map(|()| heard.heard)
            }
        });

        // Barrier, not a sleep: the barge-in happens once the replaced context
        // is genuinely open on the provider.
        connector.first_generation_written().await;
        cancel.cancel();
        let cancelled = speaking
            .await
            .expect("the cancelled synthesis task completes")
            .expect("a cancelled context is not a provider incident");
        assert!(
            cancelled.is_empty(),
            "a cancelled context yields no audio, even when the provider finishes it"
        );

        let replacement = CancellationToken::new();
        let mut heard = RecordedFrames::default();
        synthesize_sonic_with_connector(
            Arc::clone(&connector),
            &config,
            "sk_car_barge_secret",
            "response-2",
            "second response text",
            &replacement,
            &mut heard,
        )
        .await
        .unwrap();
        assert_eq!(heard.heard.len(), 1);
        assert_eq!(heard.heard[0].pcm16_bytes(), [3, 4]);

        let record = record.lock().expect("record lock poisoned");
        let written = record
            .sent_json
            .iter()
            .map(|value| {
                (
                    value["context_id"]
                        .as_str()
                        .expect("every Sonic control names its context")
                        .to_owned(),
                    value
                        .get("cancel")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
            })
            .collect::<Vec<_>>();
        let cancel_index = written
            .iter()
            .position(|(_, cancel)| *cancel)
            .unwrap_or_else(|| panic!("a barge-in must write a context cancel: {written:?}"));

        // 1. generation message(s) for response-1.
        assert!(!written[..cancel_index].is_empty());
        assert!(written[..cancel_index]
            .iter()
            .all(|(context_id, _)| context_id == "response-1"));
        // 2. the cancel for response-1.
        assert_eq!(written[cancel_index].0, "response-1");
        // 3. generation message(s) for response-2 on a fresh context.
        assert!(!written[cancel_index + 1..].is_empty());
        assert!(written[cancel_index + 1..]
            .iter()
            .all(|(context_id, cancel)| context_id == "response-2" && !cancel));
    }

    /// Hands out one scripted socket per connect. The replaced context stays
    /// silent until its cancel is written, then delivers the frames the provider
    /// had already generated.
    struct BargeInSonicConnector {
        record: Arc<Mutex<SocketRecord>>,
        connects: std::sync::atomic::AtomicUsize,
        released: Arc<std::sync::atomic::AtomicBool>,
        release: Arc<tokio::sync::Notify>,
        first_generation: Arc<tokio::sync::Notify>,
    }

    impl BargeInSonicConnector {
        fn new(record: Arc<Mutex<SocketRecord>>) -> Self {
            Self {
                record,
                connects: std::sync::atomic::AtomicUsize::new(0),
                released: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                release: Arc::new(tokio::sync::Notify::new()),
                first_generation: Arc::new(tokio::sync::Notify::new()),
            }
        }

        async fn first_generation_written(&self) {
            self.first_generation.notified().await;
        }
    }

    #[async_trait]
    impl SonicConnector for BargeInSonicConnector {
        type Socket = BargeInSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, agent_domain::BrainError> {
            let index = self
                .connects
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.record.lock().expect("record lock poisoned").connected = true;
            let incoming = if index == 0 {
                VecDeque::from([
                    r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#.to_owned(),
                    r#"{"type":"done","context_id":"response-1"}"#.to_owned(),
                ])
            } else {
                VecDeque::from([
                    r#"{"type":"chunk","context_id":"response-2","data":"AwQ="}"#.to_owned(),
                    r#"{"type":"done","context_id":"response-2"}"#.to_owned(),
                ])
            };
            Ok(BargeInSonicSocket {
                record: self.record.clone(),
                incoming,
                gated: index == 0,
                released: Arc::clone(&self.released),
                release: Arc::clone(&self.release),
                first_generation: Arc::clone(&self.first_generation),
            })
        }
    }

    struct BargeInSonicSocket {
        record: Arc<Mutex<SocketRecord>>,
        incoming: VecDeque<String>,
        gated: bool,
        released: Arc<std::sync::atomic::AtomicBool>,
        release: Arc<tokio::sync::Notify>,
        first_generation: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl SonicSocket for BargeInSonicSocket {
        async fn send_json(
            &mut self,
            value: serde_json::Value,
        ) -> Result<(), agent_domain::BrainError> {
            let cancelled = value.get("cancel").and_then(Value::as_bool) == Some(true);
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent_json
                .push(value);
            if cancelled {
                self.released
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                self.release.notify_waiters();
            } else if self.gated {
                self.first_generation.notify_one();
            }
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, agent_domain::BrainError> {
            while self.gated && !self.released.load(std::sync::atomic::Ordering::SeqCst) {
                self.release.notified().await;
            }
            Ok(self.incoming.pop_front())
        }

        async fn close(&mut self) -> Result<(), agent_domain::BrainError> {
            self.record.lock().expect("record lock poisoned").closed = true;
            Ok(())
        }
    }

    // -----------------------------------------------------------------
    // Task 3 (`ADAPTER-03`): a stage deadline that fires after the socket is
    // connected must still write the documented context cancel and close the
    // connection. Dropping the socket is not cleanup.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn sonic_timeout_sends_cancel_and_clean_close() {
        let record = Arc::new(Mutex::new(SocketRecord::default()));
        let connector = StallingSonicConnector {
            record: record.clone(),
        };
        let config = SonicConfig {
            stage_timeout: Duration::from_millis(30),
            ..SonicConfig::default()
        };
        let transcript = "assistant text must not appear in cleanup evidence";

        let error = synthesize_sonic_with_connector(
            Arc::new(connector),
            &config,
            "sk_car_cleanup_secret",
            "response-1",
            transcript,
            &CancellationToken::new(),
            &mut RecordedFrames::default(),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(
            failure.metadata(),
            "stage=cartesia_sonic error_kind=deadline_elapsed"
        );

        let record = record.lock().expect("record lock poisoned");
        assert!(record.connected);
        assert!(
            record
                .sent_json
                .iter()
                .any(|value| value == &json!({ "context_id": "response-1", "cancel": true })),
            "a stage timeout must write the documented context cancel: {:?}",
            record.sent_json
        );
        assert!(
            record.closed,
            "a stage timeout after connect must close the provider socket"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("sk_car_cleanup_secret"));
        assert!(!rendered.contains(transcript));
    }

    /// Task 5 (`ADAPTER-05`) cancellation control: a cancel that lands after the
    /// first frame stops the audio there, and the Task 3 cleanup still runs.
    #[tokio::test]
    async fn cancelling_after_the_first_frame_stops_audio_and_still_cleans_up() {
        let record = Arc::new(Mutex::new(SocketRecord::default()));
        let connector = RecordingSonicConnector {
            record: record.clone(),
            incoming: VecDeque::from([
                r#"{"type":"chunk","context_id":"response-1","data":"AQI="}"#,
                r#"{"type":"chunk","context_id":"response-1","data":"AwQ="}"#,
                r#"{"type":"done","context_id":"response-1"}"#,
            ]),
        };
        let cancel = CancellationToken::new();
        let mut sink = CancellingAfterFirstFrame {
            heard: Vec::new(),
            cancel: cancel.clone(),
        };

        synthesize_sonic_with_connector(
            Arc::new(connector),
            &SonicConfig::default(),
            "sk_car_cancel_secret",
            "response-1",
            "a response the learner interrupts",
            &cancel,
            &mut sink,
        )
        .await
        .expect("a cancelled context is not a provider incident");

        assert_eq!(sink.heard.len(), 1, "no frame may follow the cancel");
        assert_eq!(sink.heard[0].pcm16_bytes(), [1, 2]);
        let record = record.lock().expect("record lock poisoned");
        assert!(
            record
                .sent_json
                .iter()
                .any(|value| value == &json!({ "context_id": "response-1", "cancel": true })),
            "the Task 3 cleanup still writes the documented cancel: {:?}",
            record.sent_json
        );
        assert!(
            record.closed,
            "the connection is closed on terminal cleanup"
        );
    }

    /// Cancels the turn the instant its first frame is heard.
    struct CancellingAfterFirstFrame {
        heard: Vec<AudioFrame>,
        cancel: CancellationToken,
    }

    #[async_trait]
    impl SpeechFrameSink for CancellingAfterFirstFrame {
        async fn frame(&mut self, frame: AudioFrame) -> bool {
            self.heard.push(frame);
            self.cancel.cancel();
            true
        }
    }

    /// Connects immediately, then never speaks. Only the stage deadline ends it.
    struct StallingSonicConnector {
        record: Arc<Mutex<SocketRecord>>,
    }

    #[async_trait]
    impl SonicConnector for StallingSonicConnector {
        type Socket = StallingSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, agent_domain::BrainError> {
            self.record.lock().expect("record lock poisoned").connected = true;
            Ok(StallingSonicSocket {
                record: self.record.clone(),
            })
        }
    }

    struct StallingSonicSocket {
        record: Arc<Mutex<SocketRecord>>,
    }

    #[async_trait]
    impl SonicSocket for StallingSonicSocket {
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
            std::future::pending().await
        }

        async fn close(&mut self) -> Result<(), agent_domain::BrainError> {
            self.record.lock().expect("record lock poisoned").closed = true;
            Ok(())
        }
    }

    #[async_trait]
    impl SonicSocket for FakeSonicSocket {
        async fn send_json(
            &mut self,
            value: serde_json::Value,
        ) -> Result<(), agent_domain::BrainError> {
            if self.send_error.is_some() {
                return Err(sonic_transport_failure("send_failed"));
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

    // -----------------------------------------------------------------
    // Task 3 / Task 4 (`ADAPTER-03`, `ADAPTER-04`): what a cancel does to the
    // session connection.
    //
    // The plan's close list is "session stop, stage timeout, fatal provider
    // error, or failed cancel/drain". A cancel the provider acknowledges within
    // the bounded drain leaves nothing unread on the wire, so the multiplexed
    // connection carries on serving the next response context; barge-in is the
    // commonest reason to cancel, and re-dialling on every interruption would
    // give back exactly what the multiplexed-context design exists to buy.
    // A cancel the provider never finishes is the opposite case and still
    // closes.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn a_clean_barge_in_cancel_keeps_the_session_connection() {
        let connector = Arc::new(SessionSonicConnector::acknowledging_cancels());
        let voice = SonicSessionVoice::new(Arc::clone(&connector));
        let config = SonicConfig::default();

        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-1",
                "first response text",
            )
            .await
            .unwrap();
        // The learner barges in before response-1 reached its finalizer.
        voice.cancel_context("response-1").await;

        let mut heard = RecordedFrames::default();
        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-2",
                "second response text",
            )
            .await
            .unwrap();
        voice
            .finish(&config, "response-2", &CancellationToken::new(), &mut heard)
            .await
            .unwrap();

        assert_eq!(heard.heard.len(), 1);
        assert_eq!(heard.heard[0].pcm16_bytes(), [1, 2]);
        let record = connector.record();
        assert_eq!(
            record.dials, 1,
            "a cancel the provider acknowledged keeps the multiplexed session connection"
        );
        assert_eq!(
            record.closes, 0,
            "a successful cancel/drain is not on the plan's close list"
        );

        let written = record.context_and_cancel();
        let cancel_index = written
            .iter()
            .position(|(_, cancel)| *cancel)
            .unwrap_or_else(|| panic!("a barge-in must write a context cancel: {written:?}"));
        assert!(!written[..cancel_index].is_empty());
        assert!(written[..cancel_index]
            .iter()
            .all(|(context_id, _)| context_id == "response-1"));
        assert_eq!(written[cancel_index].0, "response-1");
        assert!(!written[cancel_index + 1..].is_empty());
        assert!(written[cancel_index + 1..]
            .iter()
            .all(|(context_id, cancel)| context_id == "response-2" && !cancel));

        voice.close().await;
        assert_eq!(
            connector.record().closes,
            1,
            "the session closes its own connection exactly once"
        );
    }

    #[tokio::test]
    async fn a_cancel_the_provider_never_finishes_closes_the_connection() {
        let connector = Arc::new(SessionSonicConnector::never_acknowledging_cancels());
        let voice = SonicSessionVoice::new(Arc::clone(&connector));
        let config = SonicConfig::default();

        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-1",
                "first response text",
            )
            .await
            .unwrap();
        voice.cancel_context("response-1").await;

        assert_eq!(
            connector.record().closes,
            1,
            "a cancel the bounded drain never sees finished leaves unread frames, so it closes"
        );

        let mut heard = RecordedFrames::default();
        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-2",
                "second response text",
            )
            .await
            .unwrap();
        voice
            .finish(&config, "response-2", &CancellationToken::new(), &mut heard)
            .await
            .unwrap();

        assert_eq!(heard.heard.len(), 1);
        let record = connector.record();
        assert_eq!(
            record.dials, 2,
            "the replacement context is served by a replacement connection"
        );
        assert!(
            record
                .sent
                .iter()
                .filter(|(socket, _)| *socket == 1)
                .all(|(_, value)| value["context_id"] == "response-2"),
            "the un-drained connection is never written to again: {:?}",
            record.sent
        );
    }

    /// A cancel is for the context that is still open. A turn whose speech
    /// already finished has nothing to cancel, and telling the provider anyway
    /// would leave the drain waiting for a `done` that never comes — eating the
    /// frames of the context that *is* open, then closing a healthy connection.
    #[tokio::test]
    async fn a_cancel_for_an_already_finished_context_leaves_the_connection_alone() {
        let connector = Arc::new(SessionSonicConnector::acknowledging_cancels());
        let voice = SonicSessionVoice::new(Arc::clone(&connector));
        let config = SonicConfig::default();

        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-1",
                "first response text",
            )
            .await
            .unwrap();
        voice
            .finish(
                &config,
                "response-1",
                &CancellationToken::new(),
                &mut RecordedFrames::default(),
            )
            .await
            .unwrap();

        // The turn's cleanup path fires after the response already completed.
        voice.cancel_context("response-1").await;

        let mut heard = RecordedFrames::default();
        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-2",
                "second response text",
            )
            .await
            .unwrap();
        voice
            .finish(&config, "response-2", &CancellationToken::new(), &mut heard)
            .await
            .unwrap();

        assert_eq!(heard.heard.len(), 1);
        let record = connector.record();
        assert!(
            !record
                .context_and_cancel()
                .iter()
                .any(|(_, cancel)| *cancel),
            "a context that already finished is never cancelled: {:?}",
            record.sent
        );
        assert_eq!(
            record.dials, 1,
            "the healthy session connection survives the late cleanup"
        );
        assert_eq!(record.closes, 0);
    }

    /// The boundary of the Task 4 redial: a context the provider has already
    /// accepted part of is never re-spoken on a fresh connection, because the
    /// learner would hear a truncated or duplicated response.
    #[tokio::test]
    async fn a_half_written_context_is_never_redialled() {
        let mut connector = SessionSonicConnector::acknowledging_cancels();
        connector.failing_context = Some("response-2");
        connector.accepted_writes_before_failure = 1;
        let connector = Arc::new(connector);
        let voice = SonicSessionVoice::new(Arc::clone(&connector));
        let config = SonicConfig::default();

        voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-1",
                "first response text",
            )
            .await
            .unwrap();
        voice
            .finish(
                &config,
                "response-1",
                &CancellationToken::new(),
                &mut RecordedFrames::default(),
            )
            .await
            .unwrap();

        let long_transcript = "Connect the electron transport chain to proton pumping. Then explain why ATP synthase needs the gradient before it can make ATP. Finish with the role of oxygen as the final electron acceptor.";
        let error = voice
            .extend(
                &config,
                "sk_car_multiplex_secret",
                "response-2",
                long_transcript,
            )
            .await
            .unwrap_err();

        assert_eq!(
            error.failure().metadata(),
            "stage=cartesia_sonic error_kind=send_failed"
        );
        let record = connector.record();
        assert_eq!(
            record.dials, 1,
            "a context the provider already accepted part of is never re-spoken on a fresh dial"
        );
        assert_eq!(
            record.closes, 1,
            "the connection that failed mid-context is closed rather than reused"
        );
        assert_eq!(
            record
                .sent
                .iter()
                .filter(|(_, value)| value["context_id"] == "response-2")
                .count(),
            2,
            "exactly the accepted chunk and the refused chunk: {:?}",
            record.sent
        );
        let rendered = format!("{error} {:?}", error.failure());
        assert!(!rendered.contains(long_transcript));
    }

    #[derive(Clone, Default)]
    struct SessionSonicRecord {
        dials: u32,
        closes: u32,
        /// Every write, tagged with the index of the socket it was written to.
        sent: Vec<(u32, Value)>,
    }

    impl SessionSonicRecord {
        /// Each write as `(context_id, is_cancel)`, in order.
        fn context_and_cancel(&self) -> Vec<(String, bool)> {
            self.sent
                .iter()
                .map(|(_, value)| {
                    (
                        value["context_id"]
                            .as_str()
                            .expect("every Sonic control names its context")
                            .to_owned(),
                        value.get("cancel").and_then(Value::as_bool) == Some(true),
                    )
                })
                .collect()
        }
    }

    /// A multiplexed session connection: every finalized generation is answered
    /// with one chunk plus `done` for that context, so one socket can serve many
    /// response contexts.
    struct SessionSonicConnector {
        record: Arc<Mutex<SessionSonicRecord>>,
        /// Whether a context cancel is answered with that context's `done`.
        acknowledges_cancel: bool,
        /// Writes naming this context are refused once the provider has accepted
        /// `accepted_writes_before_failure` of them.
        failing_context: Option<&'static str>,
        accepted_writes_before_failure: usize,
    }

    impl SessionSonicConnector {
        fn acknowledging_cancels() -> Self {
            Self {
                record: Arc::new(Mutex::new(SessionSonicRecord::default())),
                acknowledges_cancel: true,
                failing_context: None,
                accepted_writes_before_failure: 0,
            }
        }

        fn never_acknowledging_cancels() -> Self {
            Self {
                acknowledges_cancel: false,
                ..Self::acknowledging_cancels()
            }
        }

        fn record(&self) -> SessionSonicRecord {
            self.record.lock().expect("record lock poisoned").clone()
        }
    }

    #[async_trait]
    impl SonicConnector for SessionSonicConnector {
        type Socket = SessionSonicSocket;

        async fn connect(
            &self,
            _request: tokio_tungstenite::tungstenite::http::Request<()>,
        ) -> Result<Self::Socket, agent_domain::BrainError> {
            let index = {
                let mut record = self.record.lock().expect("record lock poisoned");
                let index = record.dials;
                record.dials += 1;
                index
            };
            Ok(SessionSonicSocket {
                index,
                record: Arc::clone(&self.record),
                pending: VecDeque::new(),
                acknowledges_cancel: self.acknowledges_cancel,
                failing_context: self.failing_context,
                accepted_writes_before_failure: self.accepted_writes_before_failure,
                accepted_for_failing_context: 0,
                finished: Vec::new(),
            })
        }
    }

    struct SessionSonicSocket {
        index: u32,
        record: Arc<Mutex<SessionSonicRecord>>,
        pending: VecDeque<String>,
        acknowledges_cancel: bool,
        failing_context: Option<&'static str>,
        accepted_writes_before_failure: usize,
        accepted_for_failing_context: usize,
        /// Contexts the provider has already finished generating.
        finished: Vec<String>,
    }

    #[async_trait]
    impl SonicSocket for SessionSonicSocket {
        async fn send_json(&mut self, value: Value) -> Result<(), agent_domain::BrainError> {
            self.record
                .lock()
                .expect("record lock poisoned")
                .sent
                .push((self.index, value.clone()));
            let context_id = value["context_id"]
                .as_str()
                .expect("every Sonic control names its context")
                .to_owned();
            if self.failing_context == Some(context_id.as_str()) {
                if self.accepted_for_failing_context >= self.accepted_writes_before_failure {
                    return Err(sonic_transport_failure("send_failed"));
                }
                self.accepted_for_failing_context += 1;
            }
            if value.get("cancel").and_then(Value::as_bool) == Some(true) {
                // A context that already ended has nothing left to cancel, so
                // the provider says nothing back — exactly as it would on the
                // wire. Only a context still generating is acknowledged.
                if self.acknowledges_cancel && !self.finished.contains(&context_id) {
                    self.pending
                        .push_back(format!(r#"{{"type":"done","context_id":"{context_id}"}}"#));
                }
                return Ok(());
            }
            if value.get("continue").and_then(Value::as_bool) == Some(false) {
                self.pending.push_back(format!(
                    r#"{{"type":"chunk","context_id":"{context_id}","data":"AQI="}}"#
                ));
                self.pending
                    .push_back(format!(r#"{{"type":"done","context_id":"{context_id}"}}"#));
                self.finished.push(context_id);
            }
            Ok(())
        }

        async fn next_text(&mut self) -> Result<Option<String>, agent_domain::BrainError> {
            if let Some(next) = self.pending.pop_front() {
                return Ok(Some(next));
            }
            // A provider that never finishes the cancelled context keeps
            // generating for it, so the bounded drain runs out rather than
            // seeing a `done`.
            Ok(Some(
                r#"{"type":"chunk","context_id":"response-1","data":"AwQ="}"#.to_owned(),
            ))
        }

        async fn close(&mut self) -> Result<(), agent_domain::BrainError> {
            self.record.lock().expect("record lock poisoned").closes += 1;
            Ok(())
        }
    }
}
